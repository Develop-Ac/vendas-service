import { ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { CarteirizacaoSqlServerRepository } from './carteirizacao.sqlserver.repository';
import { CARENCIA_DIAS, CarteirizacaoService, type ClienteCarteira } from './carteirizacao.service';
import { GestaoService } from './gestao.service';
import { diaEmissao, menosDias } from './supervisao.service';
import { fimDia, inicioDia, pct } from './supervisao.indicadores';
import { notasDoOrcamento, resumirAuxiliares } from './gestao';
import { blocoMeta, blocoMetaAuxiliar, blocoPeriodo, montarCarteira, montarOfertas, montarRetornar } from './painel-vendedor';
import { FilaService } from './fila.service';
import { OrcamentoService } from '../orcamento/orcamento.service';
import { hojeRetorno } from '../orcamento/orcamento.prisma.repository';
import { OfertaRepository } from '../oferta/oferta.repository';

/**
 * Painel do vendedor do atacado (tela inicial), sempre do mês comissional corrente.
 * Cada bloco é independente (`Promise.allSettled`): o que falhar vem null com o motivo
 * em `avisos`. Período, meta e veredito saem das mesmas contas da gestão
 * (/vendas/atacado). Nada de custo, markup, margem ou lucro: cada bloco escolhe campo a
 * campo o que sai das outras leituras.
 */
@Injectable()
export class PainelVendedorService {
  private readonly logger = new Logger(PainelVendedorService.name);

  constructor(
    private readonly bi: CarteirizacaoSqlServerRepository,
    private readonly repo: CarteirizacaoPrismaRepository,
    private readonly carteirizacao: CarteirizacaoService,
    private readonly gestao: GestaoService,
    private readonly orcamento: OrcamentoService,
    private readonly fila: FilaService,
    private readonly ofertaRepo: OfertaRepository,
  ) {}

  /**
   * Painel de quem está logado: o rep sai do cadastro do usuário do `x-user-id`, nunca da
   * query (qualquer proxy com o token alcançaria o painel de outro vendedor).
   */
  async painelDoUsuario(usuarioId: string | undefined) {
    const u = await this.repo.usuarioVendas(usuarioId);
    if (!u) throw new ForbiddenException('Usuário não identificado: entre de novo na intranet e tente outra vez.');
    if ((u.vendas_hub_inicial ?? '').toUpperCase() !== 'ATACADO' || u.vendas_rep_codigo == null) {
      throw new ConflictException('Painel só para vendedor do atacado com vendedor vinculado no cadastro de usuário.');
    }
    return this.painel(u.vendas_rep_codigo);
  }

  async painel(rep: number) {
    const p = this.gestao.validarPeriodo();
    const { ano, mes, hoje } = p;
    // Sem calendário do BI, as datas padrão do mês comissional e nenhum dia útil (como na gestão).
    const cal = await this.bi.diasUteisPeriodo(ano, mes).catch(() => null);
    const { inicio, fim, diasUteis } = this.gestao.montarPeriodo(p, cal);

    // Uma leitura da bolsa serve bolsa, comissão e o "em aberto" da conversão.
    const bolsaLida = this.orcamento.bolsa(rep);
    bolsaLida.catch(() => undefined);

    // Uma montagem da carteira serve contatos (fila), telefones do retornar e a carteira.
    const snapshot = this.carteirizacao.snapshotCarteira();
    snapshot.catch(() => undefined);
    const contatos = snapshot.then((s) => this.contatos(rep, s));
    contatos.catch(() => undefined);
    const avisos: Array<{ bloco: string; motivo: string }> = [];

    const blocos = {
      meta: this.meta(rep, ano, mes, { inicio, fim, diasUteis, hoje }),
      positivacao: this.carteirizacao.painelCarteira(rep, inicio, fim).then((r) => ({
        clientes_carteira: r.clientes_carteira,
        clientes_com_venda: r.clientes_com_venda,
        positivacao: r.positivacao,
      })),
      conversao: this.conversao(rep, p.padrao, hoje, bolsaLida),
      bolsa: bolsaLida.then((b) => ({ saldo: b.bolsa.saldo, premio_estimado: b.bolsa.premio_estimado })),
      comissao: bolsaLida.then((b) => (b.comissao ? { atual: b.comissao.atual.comissao } : null)),
      contatos,
      retornar: this.retornar(rep, snapshot, avisos),
      // Quem já está nos contatos de hoje conta na situação, mas sai da lista.
      carteira: Promise.all([snapshot, contatos.catch(() => [])]).then(([s, c]) =>
        montarCarteira({ clientes: s, rep, inicioMes: inicio, foraDaLista: new Set(c.map((x) => x.cli_codigo)) }),
      ),
      ofertas: this.ofertas(),
      ultimos: this.repo.ultimosOrcamentos(rep),
    };
    const nomes = Object.keys(blocos) as Array<keyof typeof blocos>;
    const lidos = await Promise.allSettled(nomes.map((n) => blocos[n]));
    const valor = <K extends keyof typeof blocos>(n: K) => {
      const r = lidos[nomes.indexOf(n)];
      if (r.status === 'fulfilled') return r.value as Awaited<(typeof blocos)[K]>;
      const motivo = r.reason instanceof Error ? r.reason.message : String(r.reason);
      this.logger.warn(`Painel do vendedor ${rep}: bloco ${n} indisponível: ${motivo}`);
      // A mensagem do driver (host, usuário, tabela) fica só no log.
      avisos.push({ bloco: n, motivo: 'indisponível' });
      return null;
    };

    return {
      periodo: { ano, mes, ...blocoPeriodo({ inicio, fim, diasUteis, hoje }) },
      meta: valor('meta'),
      positivacao: valor('positivacao'),
      conversao: valor('conversao'),
      bolsa: valor('bolsa'),
      comissao: valor('comissao'),
      contatos: valor('contatos'),
      retornar: valor('retornar'),
      carteira: valor('carteira'),
      ofertas: valor('ofertas'),
      ultimos: valor('ultimos'),
      avisos,
    };
  }

  /**
   * Contatos de hoje: tarefas da fila em andamento (ABERTA/ESCALADA) e os grupos
   * "Produto chegou" (tipo PRODUTO_CHEGOU), campo a campo.
   */
  private async contatos(rep: number, snapshot: ClienteCarteira[]) {
    const f = await this.fila.listar({ rep_codigo: rep }, snapshot);
    const tarefas = f.itens.map((t) => ({
      id: t.id,
      tipo: t.tipo,
      status: t.status,
      cli_codigo: t.cli_codigo,
      cli_nome: t.cli_nome,
      fone: t.fone,
      curva: t.curva,
      motivo_geracao: t.motivo_geracao,
    }));
    const chegou = f.retornos.map((g) => ({
      id: null,
      tipo: 'PRODUTO_CHEGOU' as const,
      status: g.atrasada ? 'ATRASADA' : 'ABERTA',
      cli_codigo: g.cli_codigo,
      cli_nome: g.cli_nome,
      fone: g.fone,
      curva: null,
      motivo_geracao: null,
      produtos: g.produtos.map((p) => ({ id: p.id, pro_codigo: p.pro_codigo, descricao: p.descricao, quantidade_pedida: p.quantidade_pedida })),
    }));
    return [...tarefas, ...chegou];
  }

  /**
   * Orçamentos para retornar: adiados vencidos e enviados perto da validade (intranet)
   * mais os sem desfecho. ERP fora: segue só com os da intranet, com aviso.
   */
  private async retornar(
    rep: number,
    snapshot: Promise<ClienteCarteira[]>,
    avisos: Array<{ bloco: string; motivo: string }>,
  ) {
    const hoje = hojeRetorno();
    const [intranet, sem, clientes] = await Promise.all([
      this.repo.orcamentosParaRetornar(rep, hoje),
      this.carteirizacao.orcamentosSemDesfecho({ rep_codigo: rep }).catch((e) => {
        const motivo = e instanceof Error ? e.message : String(e);
        this.logger.warn(`Painel do vendedor ${rep}: orçamentos sem desfecho indisponíveis: ${motivo}`);
        avisos.push({ bloco: 'retornar.sem_desfecho', motivo: 'indisponível' });
        return null;
      }),
      snapshot.catch((): ClienteCarteira[] => []),
    ]);
    return montarRetornar({
      intranet,
      semDesfecho: sem?.itens ?? [],
      fonePorCliente: new Map(clientes.map((c) => [c.cli_codigo, c.fone])),
      hoje,
    });
  }

  /** Ofertas vigentes nas tabelas 2 e 5. Fonte no Celta: null sem aviso (a tela some com o bloco). */
  private async ofertas() {
    if (!(await this.ofertaRepo.fonteIntranet())) return null;
    const [t2, t5] = await Promise.all([this.orcamento.produtosEmOferta('2'), this.orcamento.produtosEmOferta('5')]);
    return montarOfertas(t2, t5);
  }

  /**
   * Meta do vendedor pela série do BI; rep sem meta no mês (auxiliar) mostra o que
   * vendeu pelos orçamentos fechados, o mesmo `vendeu` da aba Equipe.
   */
  private async meta(rep: number, ano: number, mes: number, per: { inicio: string; fim: string; diasUteis: string[]; hoje: string }) {
    const { metas } = await this.gestao.metasDoCanal(ano, mes);
    const meta = metas.get(rep);
    if (meta) return blocoMeta({ meta, serie: await this.bi.faturadoVendedorPorDia(ano, mes, rep), ...per });

    const [fechados, casamento] = await Promise.all([
      this.repo.orcamentosFechadosNoMes(inicioDia(per.inicio), fimDia(per.fim)),
      this.orcamento.casamentoDoRep(rep).catch(() => null),
    ]);
    const casados = fechados
      .filter((o) => o.rep_codigo === rep)
      .sort((a, b) => a.desfecho_em.getTime() - b.desfecho_em.getTime())
      .map((o) => ({
        orcamento: { id: o.id, rep_codigo: o.rep_codigo, total: o.total },
        notas: casamento ? notasDoOrcamento(casamento.porOrcamento.get(o.id) ?? [], casamento.linhas) : [],
      }));
    return blocoMetaAuxiliar(resumirAuxiliares(casados).auxiliares[0]?.vendeu ?? 0);
  }

  /**
   * Conversão do indicador da supervisão, só do vendedor: orçamentos emitidos no mês com
   * a carência já vencida, fechados ÷ total. "Em aberto" vem da bolsa (null se ela falhar).
   */
  private async conversao(
    rep: number,
    periodo: { inicio: string; fim: string },
    hoje: string,
    bolsaLida: ReturnType<OrcamentoService['bolsa']>,
  ) {
    const fimEf = periodo.fim < hoje ? periodo.fim : hoje;
    const limite = menosDias(hoje, CARENCIA_DIAS);
    const [orcs, b] = await Promise.all([
      this.carteirizacao.orcamentosComFechamento(menosDias(periodo.inicio, CARENCIA_DIAS), fimEf, CARENCIA_DIAS),
      bolsaLida.catch(() => null),
    ]);
    const contados = orcs.filter((o) => {
      const e = diaEmissao(o);
      return o.rep_codigo === rep && e >= periodo.inicio && e <= periodo.fim && e <= limite;
    });
    const fechados = contados.filter((o) => o.fechou).length;
    return {
      pct: pct(fechados, contados.length),
      orcamentos: contados.length,
      fechados,
      em_aberto: b ? { quantidade: b.em_aberto.quantidade, total: b.em_aberto.total } : null,
    };
  }
}
