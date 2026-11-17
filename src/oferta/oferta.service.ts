import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { mesComissionalDe, periodoComissional } from '../carteirizacao/supervisao.indicadores';
import { hojeYmd } from '../orcamento/orcamento.erp.repository';
import { OrcamentoService } from '../orcamento/orcamento.service';
import { round2 } from '../orcamento/regua';
import { EncomendaPecasErpRepository } from '../venda-casada/encomenda-pecas.erp.repository';
import { conferirItem, conflito, minimoOferta, montarPorMarca, motivoEncerramento, precoT5Sugerido, reaprova, restam, type ItemEditavel, type ItemExistente, type StatusOfertaItem, type TipoOferta } from './oferta';
import { apurarGanhos, contaNoPeriodo, resultadoDoGrupo, vendasDaOferta, type VendaOferta } from './ganhos';
import { OfertaRepository } from './oferta.repository';
import { conferirPremio, premioDe } from './premio';
import type { AlterarItemOfertaDto, AlterarPremioDto, CriarOfertaDto, ItemOfertaDto } from './dto/oferta.dto';

/* =============================================================================
   OFERTAS DO ATACADO — grupos (promoção, liquidação, campanha) e itens com preço por tabela.
   -----------------------------------------------------------------------------
   Permissão por tela da intranet (x-user-id): ler exige /estoque/promocoes
   (visualizar); montar exige /estoque/promocoes (editar ou criar); aprovar,
   encerrar e trocar o prêmio exigem /estoque/promocoes/aprovar (editar ou criar); os ganhos do mês
   exigem /estoque/promocoes/ganhos (visualizar).
   Custo, tabelas 2/5, saldo e o mínimo da régua vêm do mesmo cálculo do
   orçamento (OrcamentoService.produtosPorCodigo, empresa 3), sem promoção.
   Campanha nasce com origem (empresa ou fornecedor) e prêmio conferidos por
   conferirPremio; o nome do fornecedor vem do ERP (nome fantasia ou razão).
   ============================================================================= */

export const TELA_OFERTAS = '/estoque/promocoes';
export const TELA_OFERTAS_APROVAR = '/estoque/promocoes/aprovar';
export const TELA_OFERTAS_GANHOS = '/estoque/promocoes/ganhos';

type Acao = 'visualizar' | 'gravar';

/** Piso da liquidação e da campanha: custo × OFERTA_PISO (padrão 1,30). */
const pisoOferta = () => {
  const v = Number(process.env.OFERTA_PISO);
  return Number.isFinite(v) && v > 0 ? v : 1.3;
};

/** 'AAAA-MM-DD' + n dias. */
const somaDias = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

type DadosErp = Awaited<ReturnType<OfertaService['dadosErp']>> extends Map<number, infer T> ? T : never;

/** Mínimo do item em cada tabela (null = sem custo ou sem preço próprio naquela tabela). */
function minimos(tipo: TipoOferta, e: DadosErp | undefined, piso: number) {
  const custo = e?.custo ?? null;
  const minimo = (regua: number | null | undefined) => (custo != null && custo > 0 ? minimoOferta(tipo, custo, regua ?? null, piso) : null);
  return { minimo_t2: e?.tabela_2 != null ? minimo(e.regua_t2) : null, minimo_t5: e?.tabela_5 != null ? minimo(e.regua_t5) : null };
}

const conferir = (tipo: TipoOferta, e: DadosErp | undefined, i: ItemEditavel, piso: number) =>
  conferirItem({
    tipo,
    custo: e?.custo ?? null,
    piso,
    t2: { preco: i.preco_t2, tabela: e?.tabela_2 ?? null, minimoRegua: e?.regua_t2 ?? null },
    t5: { preco: i.preco_t5, tabela: e?.tabela_5 ?? null, minimoRegua: e?.regua_t5 ?? null },
    inicio: i.inicio,
    fim: i.fim,
  });

/** Preço que só vale abaixo da tabela; senão a oferta não vale naquela tabela. */
const abaixoDa = (preco: number | null, tabela: number | null) => (preco != null && tabela != null && preco < tabela ? preco : null);

@Injectable()
export class OfertaService {
  private readonly logger = new Logger(OfertaService.name);
  private apuracaoEm = 0;

  constructor(
    private readonly repo: OfertaRepository,
    private readonly orcamento: OrcamentoService,
    private readonly fornecedores: EncomendaPecasErpRepository,
  ) {}

  /* ------------------------------------------------------------ permissão */

  /** Exige a permissão na tela; devolve quem age, se pode aprovar e se pode ver os ganhos. */
  async exigirTela(userId: string | null | undefined, tela: string, acao: Acao) {
    const u = await this.repo.permissoes(userId, [TELA_OFERTAS, TELA_OFERTAS_APROVAR, TELA_OFERTAS_GANHOS]);
    const pode = (t: string, a: Acao) => !!u?.sis_permissoes.some((p) => p.tela === t && (a === 'visualizar' ? p.visualizar || p.editar || p.criar : p.editar || p.criar));
    if (!u || !pode(tela, acao)) {
      throw new ForbiddenException(`Sem permissão para ${acao === 'gravar' ? 'alterar' : 'ver'} as ofertas (${tela}).`);
    }
    return { id: u.id, nome: u.nome, pode_aprovar: pode(TELA_OFERTAS_APROVAR, 'gravar'), pode_ver_ganhos: pode(TELA_OFERTAS_GANHOS, 'visualizar') };
  }

  /* ------------------------------------------------------------- ERP */

  /**
   * Por produto: custo, saldo, preço normal das tabelas 2 e 5 e o mínimo que a
   * régua dá em cada uma (avaliação sem promoção). Tabela 5 sem preço próprio
   * (o orçamento cairia no PRECO2) = a oferta não vale para ela.
   */
  async dadosErp(codigos: number[]) {
    const saida = new Map<number, { descricao: string; custo: number | null; saldo: number; tabela_2: number | null; tabela_5: number | null; regua_t2: number | null; regua_t5: number | null }>();
    if (!codigos.length) return saida;
    const [t2, t5] = await Promise.all([this.orcamento.produtosPorCodigo(codigos, '2'), this.orcamento.produtosPorCodigo(codigos, '5')]);
    const minimo = (p: (typeof t2)[number] | undefined) => (p ? (p.sem_promocao?.avaliacao ?? p.avaliacao).preco_minimo : null);
    const porCodigo5 = new Map(t5.map((p) => [p.pro_codigo, p]));
    for (const p of t2) {
      const p5 = porCodigo5.get(p.pro_codigo);
      const tem5 = Number(p.preco_tabela_5) > 0;
      saida.set(p.pro_codigo, {
        descricao: p.descricao,
        custo: p.custo,
        saldo: Number(p.estoque_disponivel ?? 0),
        tabela_2: Number(p.preco_tabela_2) > 0 ? Number(p.preco_tabela_2) : null,
        tabela_5: tem5 ? Number(p.preco_tabela_5) : null,
        regua_t2: minimo(p),
        regua_t5: tem5 ? minimo(p5) : null,
      });
    }
    return saida;
  }

  /* ------------------------------------------------- fonte da promoção */

  /** De onde o orçamento do atacado lê a promoção (Celta ou intranet) e se quem pede pode trocar. */
  async fonte(userId: string | undefined) {
    const u = await this.exigirTela(userId, TELA_OFERTAS, 'visualizar');
    return { ...(await this.repo.fonte()), pode_alterar: u.pode_aprovar };
  }

  /** Troca a fonte na hora, para todos os vendedores; só a gestão (/estoque/promocoes/aprovar). */
  async definirFonte(userId: string | undefined, intranet: boolean) {
    const u = await this.exigirTela(userId, TELA_OFERTAS_APROVAR, 'gravar');
    await this.repo.definirFonte(intranet, u.nome);
    this.logger.log(`Fonte da promoção do atacado: ${intranet ? 'intranet' : 'Celta'} (por ${u.nome})`);
    return { ...(await this.repo.fonte()), pode_alterar: true };
  }

  /* ------------------------------------------------------------- grupos */

  async listar(userId: string | undefined, situacao: 'ativos' | 'encerrados' = 'ativos') {
    await this.exigirTela(userId, TELA_OFERTAS, 'visualizar');
    await this.apurar();
    const grupos = await this.repo.grupos();
    const vendidas = await this.repo.vendidas(grupos.flatMap((g) => g.item_ids));
    return grupos
      .filter((g) => {
        const total = g.itens.rascunho + g.itens.pendente + g.itens.aprovado + g.itens.encerrado;
        const encerrado = total > 0 && g.itens.encerrado === total;
        return situacao === 'encerrados' ? encerrado : !encerrado;
      })
      .map(({ item_ids, ...g }) => ({
        ...g,
        vendido_qtd: item_ids.reduce((s, id) => s + (vendidas.get(id)?.qtd ?? 0), 0),
        vendido_valor: item_ids.reduce((s, id) => s + (vendidas.get(id)?.valor ?? 0), 0),
      }));
  }

  /** Campanha nasce com o prêmio escolhido na criação: só a gestão (/estoque/promocoes/aprovar), como na troca do prêmio. */
  async criar(userId: string | undefined, dto: CriarOfertaDto) {
    const u = await this.exigirTela(userId, dto.tipo === 'CAMPANHA' ? TELA_OFERTAS_APROVAR : TELA_OFERTAS, 'gravar');
    const campanha = dto.tipo === 'CAMPANHA' ? await this.dadosDaCampanha(dto) : undefined;
    const o = await this.repo.criar({ nome: dto.nome.trim(), tipo: dto.tipo, criado_por: u.nome, campanha });
    const recusados = dto.itens?.length ? await this.incluirNoGrupo(o, dto.itens) : [];
    return { ...(await this.montarDetalhe(o.id, u)), recusados };
  }

  /** Origem e prêmio da campanha conferidos; fornecedor resolvido no ERP. Erro = 400. */
  private async dadosDaCampanha(dto: CriarOfertaDto) {
    const faixas = dto.premio_faixas ?? [];
    const erros = conferirPremio({ tipo: 'CAMPANHA', origem: dto.origem, fornecedor_codigo: dto.fornecedor_codigo, premio_tipo: dto.premio_tipo, premio_valor: dto.premio_valor, faixas });
    if (erros.length) throw new BadRequestException(erros);
    let fornecedor_nome: string | null = null;
    if (dto.origem === 'FORNECEDOR') {
      const f = await this.fornecedores.fornecedorPorCodigo(dto.fornecedor_codigo!);
      if (!f) throw new BadRequestException([`Fornecedor ${dto.fornecedor_codigo} não encontrado no ERP.`]);
      fornecedor_nome = f.NOME_FANTASIA ?? f.FOR_NOME;
    }
    return {
      origem: dto.origem!,
      fornecedor_codigo: dto.origem === 'FORNECEDOR' ? dto.fornecedor_codigo! : null,
      fornecedor_nome,
      premio_tipo: dto.premio_tipo!,
      premio_valor: dto.premio_valor!,
      premio_faixas: faixas,
    };
  }

  async renomear(userId: string | undefined, id: number, nome: string) {
    const u = await this.exigirTela(userId, TELA_OFERTAS, 'gravar');
    if (!(await this.repo.detalhe(id))) throw new NotFoundException(`Oferta ${id} não encontrada.`);
    await this.repo.renomear(id, nome.trim());
    return this.montarDetalhe(id, u);
  }

  async detalhe(userId: string | undefined, id: number) {
    const u = await this.exigirTela(userId, TELA_OFERTAS, 'visualizar');
    await this.apurar();
    return this.montarDetalhe(id, u);
  }

  /* -------------------------------------------------------------- itens */

  async incluirItens(userId: string | undefined, id: number, itens: ItemOfertaDto[]) {
    const u = await this.exigirTela(userId, TELA_OFERTAS, 'gravar');
    const o = await this.repo.detalhe(id);
    if (!o) throw new NotFoundException(`Oferta ${id} não encontrada.`);
    const recusados = await this.incluirNoGrupo(o, itens);
    return { ...(await this.montarDetalhe(id, u)), recusados };
  }

  /**
   * Inclui os itens em RASCUNHO, de hoje a hoje + 30 dias (Cuiabá). Com preço da
   * tabela 2 (sugestão), a tabela 5 sai pelo mesmo desconto e o limite = qtd; só
   * com o código, cada tabela nasce no mínimo. Item com erro ou sobreposição é
   * recusado com o motivo; os demais entram.
   */
  private async incluirNoGrupo(o: { id: number; nome: string; tipo: TipoOferta }, itens: ItemOfertaDto[]) {
    const codigos = [...new Set(itens.map((i) => i.pro_codigo))];
    const [erp, existentes] = await Promise.all([this.dadosErp(codigos), this.repo.naoEncerradosDosProdutos(codigos)]);
    const outros: ItemExistente[] = [...existentes];
    const piso = pisoOferta();
    const inicio = hojeYmd();
    const fim = somaDias(inicio, 30);
    const novos: Parameters<OfertaRepository['incluirItens']>[1] = [];
    const recusados: Array<{ pro_codigo: number; motivo: string }> = [];
    for (const it of itens) {
      const e = erp.get(it.pro_codigo);
      if (!e) {
        recusados.push({ pro_codigo: it.pro_codigo, motivo: 'Produto não encontrado no ERP.' });
        continue;
      }
      const { minimo_t2, minimo_t5 } = minimos(o.tipo, e, piso);
      const preco_t2 = it.preco_t2 ?? abaixoDa(minimo_t2, e.tabela_2);
      const preco_t5 = abaixoDa(it.preco_t5 ?? (it.preco_t2 != null ? precoT5Sugerido(it.preco_t2, e.tabela_2 ?? 0, e.tabela_5, minimo_t5) : minimo_t5), e.tabela_5);
      const novo = { pro_codigo: it.pro_codigo, descricao: e.descricao, preco_t2, preco_t5, inicio, fim, limite_qtd: it.qtd ?? null };
      const erros = conferir(o.tipo, e, novo, piso);
      const choque = conflito(novo, outros);
      if (choque) erros.push(choque);
      if (erros.length) {
        recusados.push({ pro_codigo: it.pro_codigo, motivo: erros.join(' ') });
        continue;
      }
      novos.push(novo);
      outros.push({ id: -novos.length, pro_codigo: it.pro_codigo, status: 'RASCUNHO', grupo: o.nome, inicio, fim });
    }
    await this.repo.incluirItens(o.id, novos);
    return recusados;
  }

  /**
   * Prévia da campanha por marca: produtos ativos com estoque da marca, com o
   * desconto `pct` nas tabelas 2 e 5 limitado ao mínimo. Não grava — a confirmação
   * vai por POST :id/itens, que confere mínimo e sobreposição.
   */
  async previaMarca(userId: string | undefined, id: number, dto: { marca: string; pct: number }) {
    await this.exigirTela(userId, TELA_OFERTAS, 'gravar');
    const o = await this.repo.detalhe(id);
    if (!o) throw new NotFoundException(`Oferta ${id} não encontrada.`);
    if (o.tipo !== 'CAMPANHA') throw new BadRequestException('Montagem por marca só vale para campanha.');
    const marca = dto.marca.trim();
    const { codigos, truncado } = await this.orcamento.produtosDaMarca(marca);
    const erp = await this.dadosErp(codigos);
    const piso = pisoOferta();
    const produtos = codigos.flatMap((c) => {
      const e = erp.get(c);
      return e ? [{ pro_codigo: c, descricao: e.descricao, custo: e.custo, saldo: e.saldo, tabela_2: e.tabela_2, tabela_5: e.tabela_5, ...minimos(o.tipo, e, piso) }] : [];
    });
    return { marca, pct: dto.pct, truncado, ...montarPorMarca(produtos, dto.pct) };
  }

  /** Item da oferta com o grupo. */
  private async itemComGrupo(itemId: number) {
    const i = await this.repo.item(itemId);
    const o = i && (await this.repo.detalhe(i.oferta_id));
    if (!i || !o) throw new NotFoundException(`Item de oferta ${itemId} não encontrado.`);
    return { i, o };
  }

  /** Preço, datas ou limite; aprovado que muda algo disso volta a PENDENTE (os outros itens do grupo ficam como estão). */
  async alterarItem(userId: string | undefined, itemId: number, dto: AlterarItemOfertaDto) {
    const u = await this.exigirTela(userId, TELA_OFERTAS, 'gravar');
    const { i, o } = await this.itemComGrupo(itemId);
    if (i.status === 'ENCERRADO') throw new BadRequestException('Item encerrado não pode ser alterado.');
    const depois: ItemEditavel = {
      preco_t2: dto.preco_t2 !== undefined ? dto.preco_t2 : i.preco_t2,
      preco_t5: dto.preco_t5 !== undefined ? dto.preco_t5 : i.preco_t5,
      inicio: dto.inicio ?? i.inicio,
      fim: dto.fim ?? i.fim,
      limite_qtd: dto.limite_qtd !== undefined ? dto.limite_qtd : i.limite_qtd,
    };
    const [erp, existentes] = await Promise.all([this.dadosErp([i.pro_codigo]), this.repo.naoEncerradosDosProdutos([i.pro_codigo])]);
    const erros = conferir(o.tipo, erp.get(i.pro_codigo), depois, pisoOferta());
    const choque = conflito({ id: i.id, pro_codigo: i.pro_codigo, inicio: depois.inicio, fim: depois.fim }, existentes);
    if (choque) erros.push(choque);
    if (erros.length) throw new BadRequestException(erros);
    await this.repo.alterarItens([{ id: i.id, dados: depois, voltaPendente: i.status === 'APROVADO' && reaprova(i, depois) }]);
    return (await this.montarDetalhe(o.id, u)).itens.find((x) => x.id === itemId);
  }

  async removerItem(userId: string | undefined, itemId: number) {
    await this.exigirTela(userId, TELA_OFERTAS, 'gravar');
    const { i } = await this.itemComGrupo(itemId);
    if (i.status !== 'RASCUNHO') throw new BadRequestException('Só item em rascunho pode ser removido; os demais se encerram.');
    await this.repo.removerItem(itemId);
  }

  /**
   * Copia início e fim de um item para todos os não encerrados do grupo, numa
   * transação. Aprovado que muda volta a PENDENTE. Qualquer sobreposição recusa
   * tudo, com a lista.
   */
  async replicarDatas(userId: string | undefined, id: number, itemId: number) {
    const u = await this.exigirTela(userId, TELA_OFERTAS, 'gravar');
    const o = await this.repo.detalhe(id);
    if (!o) throw new NotFoundException(`Oferta ${id} não encontrada.`);
    const fonte = o.itens.find((x) => x.id === itemId);
    if (!fonte) throw new NotFoundException(`Item ${itemId} não pertence à oferta ${id}.`);
    const { inicio, fim } = fonte;
    const alvos = o.itens.filter((x) => x.status !== 'ENCERRADO' && (x.inicio !== inicio || x.fim !== fim));
    const ids = new Set(alvos.map((x) => x.id));
    // os itens do próprio grupo entram na conferência já com as datas novas
    const outros = (await this.repo.naoEncerradosDosProdutos([...new Set(alvos.map((x) => x.pro_codigo))])).map((x) => (ids.has(x.id) ? { ...x, inicio, fim } : x));
    const conflitos = alvos.map((x) => conflito({ id: x.id, pro_codigo: x.pro_codigo, inicio, fim }, outros)).filter((m): m is string => !!m);
    if (conflitos.length) throw new BadRequestException(conflitos);
    await this.repo.alterarItens(alvos.map((x) => ({ id: x.id, dados: { inicio, fim }, voltaPendente: x.status === 'APROVADO' })));
    return this.montarDetalhe(id, u);
  }

  /* -------------------------------------------------------------- fluxo */

  /**
   * Itens do grupo na etapa `de` (os informados, ou todos): os que não estão nela
   * ou falham na conferência com custo e tabela de agora são recusados com o motivo.
   */
  private async conferidos(id: number, itens: number[] | undefined, de: StatusOfertaItem) {
    const o = await this.repo.detalhe(id);
    if (!o) throw new NotFoundException(`Oferta ${id} não encontrada.`);
    const pedidos = itens?.length ? new Set(itens) : null;
    const recusados: Array<{ item_id: number; pro_codigo: number | null; motivo: string }> = [];
    for (const itemId of pedidos ?? []) {
      const x = o.itens.find((i) => i.id === itemId);
      if (!x) recusados.push({ item_id: itemId, pro_codigo: null, motivo: `Item não pertence à oferta ${id}.` });
      else if (x.status !== de) recusados.push({ item_id: itemId, pro_codigo: x.pro_codigo, motivo: `Item está ${x.status}, não ${de}.` });
    }
    const alvos = o.itens.filter((i) => i.status === de && (!pedidos || pedidos.has(i.id)));
    const erp = await this.dadosErp([...new Set(alvos.map((i) => i.pro_codigo))]);
    const piso = pisoOferta();
    const ok: number[] = [];
    for (const i of alvos) {
      const erros = conferir(o.tipo, erp.get(i.pro_codigo), i, piso);
      if (erros.length) recusados.push({ item_id: i.id, pro_codigo: i.pro_codigo, motivo: erros.join(' ') });
      else ok.push(i.id);
    }
    return { ok, recusados };
  }

  /** RASCUNHO → PENDENTE (os itens informados ou o grupo todo); grava quem enviou. */
  async enviar(userId: string | undefined, id: number, itens?: number[]) {
    const u = await this.exigirTela(userId, TELA_OFERTAS, 'gravar');
    const { ok, recusados } = await this.conferidos(id, itens, 'RASCUNHO');
    await this.repo.avancar(ok, 'PENDENTE', u.nome);
    return { ...(await this.montarDetalhe(id, u)), recusados };
  }

  /** PENDENTE → APROVADO, reconferindo com custo e tabela de agora; só a gestão (/estoque/promocoes/aprovar). */
  async aprovar(userId: string | undefined, id: number, itens?: number[]) {
    const u = await this.exigirTela(userId, TELA_OFERTAS_APROVAR, 'gravar');
    const { ok, recusados } = await this.conferidos(id, itens, 'PENDENTE');
    await this.repo.avancar(ok, 'APROVADO', u.nome);
    return { ...(await this.montarDetalhe(id, u)), recusados };
  }

  /** Encerra os itens informados (ou o grupo todo) com motivo MANUAL; só a gestão. */
  async encerrar(userId: string | undefined, id: number, itens?: number[]) {
    const u = await this.exigirTela(userId, TELA_OFERTAS_APROVAR, 'gravar');
    const o = await this.repo.detalhe(id);
    if (!o) throw new NotFoundException(`Oferta ${id} não encontrada.`);
    const pedidos = itens?.length ? new Set(itens) : null;
    const alvos = o.itens.filter((i) => i.status !== 'ENCERRADO' && (!pedidos || pedidos.has(i.id)));
    await this.repo.encerrar(alvos.map((i) => ({ id: i.id, motivo: 'MANUAL' as const, por: u.nome })));
    return this.montarDetalhe(id, u);
  }

  /**
   * Encerra sozinho o item aprovado que passou do fim (DATA), atingiu o limite (LIMITE)
   * ou ficou sem saldo no ERP (SALDO). Roda no máximo a cada 10 min, puxado pela leitura
   * das ofertas — não há job. Falha só loga: o item segue como estava. Item que ainda
   * não começou não é apurado (o saldo pode chegar até o início); produto fora do ERP também não.
   */
  async apurar() {
    if (Date.now() - this.apuracaoEm < 10 * 60_000) return;
    this.apuracaoEm = Date.now();
    try {
      const hoje = hojeYmd();
      const aprovados = (await this.repo.aprovados()).filter((i) => i.inicio <= hoje);
      if (!aprovados.length) return;
      const [erp, vendidas] = await Promise.all([
        this.dadosErp([...new Set(aprovados.map((i) => i.pro_codigo))]),
        this.repo.vendidas(aprovados.map((i) => i.id)),
      ]);
      const encerrar = aprovados.flatMap((i) => {
        const e = erp.get(i.pro_codigo);
        const motivo = e ? motivoEncerramento(i, hoje, vendidas.get(i.id)?.qtd ?? 0, e.saldo) : null;
        return motivo ? [{ id: i.id, motivo }] : [];
      });
      await this.repo.encerrar(encerrar);
    } catch (e) {
      this.logger.warn(`Apuração do encerramento das ofertas falhou: ${(e as Error).message}`);
    }
  }

  /** Grupo com os itens: dados do ERP, mínimos por tabela, vendidas, restam e as conferências. */
  private async montarDetalhe(id: number, u: { pode_aprovar: boolean; pode_ver_ganhos: boolean }) {
    const o = await this.repo.detalhe(id);
    if (!o) throw new NotFoundException(`Oferta ${id} não encontrada.`);
    const [erp, vendidas] = await Promise.all([
      this.dadosErp([...new Set(o.itens.map((i) => i.pro_codigo))]),
      this.repo.vendidas(o.itens.map((i) => i.id)),
    ]);
    const piso = pisoOferta();
    const itens = o.itens.map((i) => {
      const e = erp.get(i.pro_codigo);
      const { minimo_t2, minimo_t5 } = minimos(o.tipo, e, piso);
      const vendidasQtd = vendidas.get(i.id)?.qtd ?? 0;
      const erros = i.status === 'ENCERRADO' ? [] : conferir(o.tipo, e, i, piso);
      return {
        ...i,
        custo: e?.custo ?? null,
        saldo: e?.saldo ?? 0,
        tabela_2: e?.tabela_2 ?? null,
        tabela_5: e?.tabela_5 ?? null,
        minimo_t2,
        minimo_t5,
        vendidas: vendidasQtd,
        restam: restam(i.limite_qtd, vendidasQtd),
        erros,
      };
    });
    const aprovado_por = [...new Set(o.itens.map((i) => i.aprovado_por).filter((x): x is string => !!x))];
    return { ...o, aprovado_por, pode_aprovar: u.pode_aprovar, pode_ver_ganhos: u.pode_ver_ganhos, itens };
  }

  /* ------------------------------------------------------------- ganhos */

  /** Vendas faturadas casadas que saíram de item desses grupos, de todos os vendedores que venderam algum. */
  private async vendasCasadas(grupos: Array<{ id: number; itens: Array<{ id: number }> }>) {
    const ofertaDoItem = new Map(grupos.flatMap((g) => g.itens.map((i) => [i.id, g.id] as [number, number])));
    const reps = await this.repo.repsComOferta([...ofertaDoItem.keys()]);
    const vendas: VendaOferta[] = [];
    // ponytail: um vendedor por vez sobre o cache do casamento (aquecido pela bolsa); com muitos vendedores frios fica lento — paralelizar em lotes se pesar.
    for (const rep of reps) {
      const c = await this.orcamento.casamentoDoRep(rep);
      vendas.push(...vendasDaOferta(rep, c.linhas, c.porLinha, ofertaDoItem));
    }
    return vendas;
  }

  /**
   * Resultado do grupo: faturado por item (venda casada com NF) e, para quem tem
   * /estoque/promocoes/ganhos, o ganho de cada vendedor; promoção não tem prêmio
   * (vendedores = null). O fim do grupo é o maior fim dos itens fora do rascunho.
   */
  async resultado(userId: string | undefined, id: number) {
    const u = await this.exigirTela(userId, TELA_OFERTAS, 'visualizar');
    const o = await this.repo.detalhe(id);
    if (!o) throw new NotFoundException(`Oferta ${id} não encontrada.`);
    const fins = o.itens.filter(contaNoPeriodo).map((i) => i.fim).sort();
    const grupo = { ...o, premio: premioDe(o), inicio: '', fim: fins[fins.length - 1] ?? '' };
    const r = resultadoDoGrupo(grupo, await this.vendasCasadas([o]), hojeYmd());
    const descricao = new Map(o.itens.map((i) => [i.id, i.descricao]));
    const faturado = r.faturado.map((f) => ({ ...f, descricao: descricao.get(f.oferta_item_id) ?? null }));
    if (!u.pode_ver_ganhos || o.tipo === 'PROMOCAO') return { faturado, vendedores: null };
    const nomes = await this.orcamento.nomesDosVendedores();
    return { faturado, vendedores: r.vendedores.map((v) => ({ ...v, rep_nome: nomes.get(v.rep_codigo) ?? null })) };
  }

  /**
   * Troca o prêmio do grupo (só a gestão). Liquidação só muda o percentual (PCT_CUSTO);
   * campanha mantém a origem. Recusa se o grupo já tem venda faturada. Não mexe nos itens.
   */
  async alterarPremio(userId: string | undefined, id: number, dto: AlterarPremioDto) {
    const u = await this.exigirTela(userId, TELA_OFERTAS_APROVAR, 'gravar');
    const o = await this.repo.detalhe(id);
    if (!o) throw new NotFoundException(`Oferta ${id} não encontrada.`);
    if (o.tipo === 'PROMOCAO') throw new BadRequestException('Promoção não tem prêmio.');
    const premio = { premio_tipo: dto.premio_tipo ?? o.premio_tipo ?? '', premio_valor: dto.premio_valor, premio_faixas: dto.premio_faixas ?? o.premio_faixas ?? [] };
    const erros = conferirPremio({ tipo: o.tipo, origem: o.origem, fornecedor_codigo: o.fornecedor_codigo, premio_tipo: premio.premio_tipo, premio_valor: premio.premio_valor, faixas: premio.premio_faixas });
    if (erros.length) throw new BadRequestException(erros);
    // nada vendido em orçamento fechado = nada faturado; só então lê o casamento com as NFs
    const vendidas = await this.repo.vendidas(o.itens.map((i) => i.id));
    if ([...vendidas.values()].some((v) => v.qtd > 0) && (await this.vendasCasadas([o])).some((v) => v.quantidade > 0)) {
      throw new BadRequestException('Prêmio não pode ser alterado: grupo já tem venda faturada.');
    }
    await this.repo.alterarPremio(id, premio);
    return this.montarDetalhe(id, u);
  }

  /**
   * Ganhos do mês comissional (AAAA-MM; ausente = o corrente): bônus de liquidação e
   * prêmios de campanha por vendedor, com cada NF, e o que cobrar dos fornecedores.
   * Exige /estoque/promocoes/ganhos (visualizar). Nº impresso da NF vem do ERP (empresa 3);
   * ERP fora = nota_fiscal null.
   */
  async ganhos(userId: string | undefined, mes?: string) {
    await this.exigirTela(userId, TELA_OFERTAS_GANHOS, 'visualizar');
    if (mes && !/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw new BadRequestException('mes: use AAAA-MM.');
    const ref = mes ? { ano: Number(mes.slice(0, 4)), mes: Number(mes.slice(5, 7)) } : mesComissionalDe(hojeYmd());
    const periodo = periodoComissional(ref.ano, ref.mes);
    const grupos = (await this.repo.gruposComPremio()).filter((g): g is typeof g & { inicio: string; fim: string } => g.inicio != null && g.fim != null);
    const vendas = await this.vendasCasadas(grupos);
    const { vendedores, fornecedores } = apurarGanhos(grupos, vendas, periodo, hojeYmd());
    const descricao = new Map(grupos.flatMap((g) => g.itens.map((i) => [i.id, i.descricao] as [number, string | null])));
    const nfs = [...new Set(vendedores.flatMap((v) => v.linhas.filter((l) => l.empresa === 3).map((l) => l.nfs)))];
    const [nomes, numeros] = await Promise.all([this.orcamento.nomesDosVendedores(), nfs.length ? this.orcamento.numerosNf(nfs) : new Map<number, { nota_fiscal: number | null }>()]);
    const soma = (k: 'bonus_liquidacao' | 'premios_campanha' | 'total' | 'em_andamento') => round2(vendedores.reduce((s, v) => s + v[k], 0));
    return {
      mes: periodo,
      vendedores: vendedores.map((v) => ({
        ...v,
        rep_nome: nomes.get(v.rep_codigo) ?? null,
        linhas: v.linhas.map((l) => ({ ...l, descricao: descricao.get(l.oferta_item_id) ?? null, nota_fiscal: l.empresa === 3 ? (numeros.get(l.nfs)?.nota_fiscal ?? null) : null })),
      })),
      fornecedores,
      totais: {
        bonus_liquidacao: soma('bonus_liquidacao'),
        premios_campanha: soma('premios_campanha'),
        total: soma('total'),
        em_andamento: soma('em_andamento'),
        a_cobrar: round2(fornecedores.reduce((s, f) => s + f.valor, 0)),
      },
    };
  }
}
