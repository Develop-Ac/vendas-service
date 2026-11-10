import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { CarteirizacaoSqlServerRepository } from './carteirizacao.sqlserver.repository';
import { REP_DISPONIVEL } from './carteirizacao.service';
import { analyticsAtacadoGet } from '../common/analytics/analytics-atacado';
import { degrauMix1 } from '../orcamento/regua';
import { envNum, Kpi, SupervisaoService } from './supervisao.service';
import {
  Cor,
  diaDaSemana,
  fimDia,
  hojeYmd,
  inicioDia,
  mesComissionalDe,
  metaVigente,
  pct,
  periodoComissional,
  somarDias,
} from './supervisao.indicadores';
import { mesesAnteriores } from '../orcamento/orcamento.bi.repository';
import { OrcamentoService } from '../orcamento/orcamento.service';
import { ehGerenciaVendas } from './papel';
import {
  contarDias,
  disciplina,
  margemMes,
  nivel,
  notasDoOrcamento,
  PESOS,
  pisoVenda,
  pontosIndicador,
  premio,
  resumirAuxiliares,
  resumirMotivosPerda,
  ritmoNecessario,
  ritmoPrevisao,
  serieAcumulada,
  veredito,
  Veredito,
} from './gestao';

/**
 * Tela única de gestão do atacado (/vendas/atacado). O faturado é o número
 * oficial do canal no BI (`vw_analise_vendas`, local_venda ATACADO, sem
 * canceladas, por mês comissional); as regras de ritmo, previsão, piso e
 * veredito ficam em `gestao.ts`. "Hoje" é o dia de Cuiabá, nunca o relógio do
 * SQL Server.
 */
/** Fração do ambiente: zero vale (ex.: despesa variável 0); vazio ou inválido, o padrão. */
const fracaoEnv = (nome: string, padrao: number) => {
  const v = process.env[nome];
  const n = Number(v);
  return v != null && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : padrao;
};

/** Mix 1 do canal em p.p. (0–100): participação, degrau da escada e quanto falta para o próximo. */
function mix1(participacao: number | null) {
  if (participacao == null) return { participacao: 0, degrau_atual: null, proximo_minimo: null, falta_pp: null };
  const d = degrauMix1(participacao);
  return {
    participacao: Math.round(participacao * 10000) / 100,
    degrau_atual: d.degrau,
    proximo_minimo: d.proximo_minimo == null ? null : d.proximo_minimo * 100,
    falta_pp: d.proximo_minimo == null ? null : Math.round(d.falta_pp * 10000) / 100,
  };
}

@Injectable()
export class GestaoService {
  constructor(
    private readonly bi: CarteirizacaoSqlServerRepository,
    private readonly repo: CarteirizacaoPrismaRepository,
    private readonly supervisao: SupervisaoService,
    private readonly orcamento: OrcamentoService,
  ) {}

  /**
   * "Onde agir" da Visão geral: até quatro alertas, só os que têm dado. Cada leitura
   * tem o próprio catch (falha some com o alerta, não com a resposta) e nada aqui
   * reconcilia fila nem resgate.
   */
  private async blocoAlertas(
    ano: number,
    mes: number,
    hoje: string,
    metas: Map<number, number>,
    reps: Map<number, string>,
    negociacao: Array<{ rep_codigo: number | null; valor: number; quantidade: number }>,
    kpis: Kpi[],
  ) {
    const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
    const minimo = envNum('FILA_CICLO_MINIMO_12M', 50_000);
    const [porVendedor, resgates, escaladas, ciclo] = await Promise.all([
      this.bi.faturadoCanalPorVendedor(ano, mes, hoje).catch(() => null),
      this.repo.resgatesAbertos().catch(() => null),
      this.repo.escaladasPorRep().catch(() => null),
      analyticsAtacadoGet<unknown[]>(`/alertas/ciclo-atrasado?minimo=${minimo}`).catch(() => null),
    ]);
    const alertas: Array<{ tipo: 'VENDEDOR_DISTANTE' | 'CURVA_A_SEM_COMPRA' | 'RESGATES' | 'FORA_DO_CICLO'; texto: string; aba: 'equipe' | 'carteira' }> = [];

    // Vendedor (rep ativo do atacado com nota no próprio código e meta) com o maior falta-para-a-meta.
    const distante = (porVendedor ?? [])
      .filter((v) => (metas.get(v.rep_codigo) ?? 0) > 0)
      .map((v) => ({ ...v, falta: metas.get(v.rep_codigo)! - v.total }))
      .filter((v) => v.falta > 0)
      .sort((a, b) => b.falta - a.falta)[0];
    if (distante) {
      const neg = negociacao.find((n) => n.rep_codigo === distante.rep_codigo)?.valor ?? 0;
      const nome = reps.get(distante.rep_codigo) ?? distante.rep_nome ?? `Rep ${distante.rep_codigo}`;
      alertas.push({ tipo: 'VENDEDOR_DISTANTE', texto: `${nome}: faltam ${brl(distante.falta)} para a meta; ${brl(neg)} em negociação`, aba: 'equipe' });
    }

    const curvaA = kpis.find((k) => k.chave === 'CURVA_A_COMPRANDO_PCT')?.detalhe;
    const semCompra = curvaA ? (curvaA.curva_a ?? 0) - (curvaA.comprando ?? 0) : 0;
    if (semCompra > 0) alertas.push({ tipo: 'CURVA_A_SEM_COMPRA', texto: `${semCompra} clientes curva A sem compra no mês`, aba: 'carteira' });

    const abertos = resgates?.length ?? 0;
    const esc = (escaladas ?? []).reduce((s, e) => s + e._count._all, 0);
    if (abertos + esc > 0) alertas.push({ tipo: 'RESGATES', texto: `${abertos} resgates abertos · ${esc} tarefas escaladas`, aba: 'carteira' });

    if (ciclo?.length) alertas.push({ tipo: 'FORA_DO_CICLO', texto: `${ciclo.length} clientes fora do ciclo de compra`, aba: 'carteira' });

    return alertas.slice(0, 4);
  }

  /**
   * Bloco do prêmio do supervisor: os quatro indicadores com peso (disciplina =
   * SLA de resgate + motivos apontados), pontos pelo semáforo e a trava da
   * bolsa do canal (saldo < 0 zera o valor, não o nível).
   */
  private blocoPremio(kpis: Kpi[], bolsaCanal: number | null) {
    const kpi = (chave: string) => kpis.find((k) => k.chave === chave);
    const medido = (chave: keyof typeof PESOS, num?: string, den?: string) => {
      const k = kpi(chave);
      const cor: Cor | null = k?.semaforo ?? null;
      return {
        chave,
        nome: k?.nome ?? chave,
        unidade: (k?.unidade === 'pct' ? 'pct' : 'qtd') as 'qtd' | 'pct',
        valor: k?.valor ?? null,
        meta: k?.meta ?? 0,
        ...(num && den && k?.detalhe ? { num: k.detalhe[num] ?? 0, den: k.detalhe[den] ?? 0 } : {}),
        peso: PESOS[chave],
        semaforo: cor,
        pontos: pontosIndicador(cor, PESOS[chave]),
      };
    };
    const sla = kpi('RESGATE_SLA_PCT');
    const motivos = kpi('MOTIVOS_APONTADOS_PCT');
    const d = disciplina({ sla: sla?.valor ?? null, metaSla: sla?.meta ?? 0, motivos: motivos?.valor ?? null, metaMotivos: motivos?.meta ?? 0 });
    const indicadores = [
      medido('CLIENTES_ATIVOS_MES'),
      medido('RECUPERACAO_AB_PCT', 'recuperados', 'fechados'),
      medido('CURVA_A_COMPRANDO_PCT', 'comprando', 'curva_a'),
      {
        chave: 'DISCIPLINA' as const,
        nome: 'Disciplina da equipe',
        unidade: 'pct' as const,
        valor: d.valor,
        meta: 100,
        peso: PESOS.DISCIPLINA,
        semaforo: d.cor,
        pontos: pontosIndicador(d.cor, PESOS.DISCIPLINA),
        componentes: [sla, motivos].map((k, i) => ({
          chave: i === 0 ? 'RESGATE_SLA_PCT' : 'MOTIVOS_APONTADOS_PCT',
          nome: k?.nome ?? '',
          valor: k?.valor ?? null,
          meta: k?.meta ?? 0,
        })),
      },
    ];
    return {
      indicadores,
      pontos: indicadores.reduce((s, i) => s + i.pontos, 0),
      trava_bolsa: bolsaCanal != null && bolsaCanal < 0,
    };
  }

  /**
   * Reps ativos do atacado (código → nome) e suas metas de `ven_meta_vendedor`; a meta
   * do canal é a soma dessas metas (sem fallback do DW).
   */
  private async metasDoCanal(ano: number, mes: number) {
    const [reps, metas] = await Promise.all([this.bi.vendedoresAtivosComissao(), this.repo.listarMetasPeriodo(ano, mes)]);
    const atacado = new Map(
      reps
        .filter((r) => (r.local_venda ?? '').trim().toUpperCase() === 'ATACADO')
        .map((r) => [Number(r.rep_codigo), r.nome] as const),
    );
    const porRep = new Map<number, number>();
    for (const m of metas) if (atacado.has(m.rep_codigo)) porRep.set(m.rep_codigo, Number(m.valor_meta));
    return { reps: atacado, metas: porRep, total: [...porRep.values()].reduce((s, v) => s + v, 0) };
  }

  /** Mês pedido (ou o comissional corrente); 400 para mês inválido ou que ainda não começou. */
  private validarPeriodo(ano?: number, mes?: number) {
    const hoje = hojeYmd();
    const atual = mesComissionalDe(hoje);
    ano = ano ?? atual.ano;
    mes = mes ?? atual.mes;
    if (!Number.isInteger(ano) || !Number.isInteger(mes) || mes < 1 || mes > 12) {
      throw new BadRequestException('Período inválido.');
    }
    const padrao = periodoComissional(ano, mes);
    if (padrao.inicio > hoje) throw new BadRequestException('Período ainda não começou.');
    return { ano, mes, hoje, padrao };
  }

  /** Período da resposta a partir do calendário do BI (sem calendário, as datas padrão do mês comissional). */
  private montarPeriodo(
    p: ReturnType<GestaoService['validarPeriodo']>,
    cal: { inicio: string; fim: string; dias: string[] } | null,
  ) {
    const inicio = cal?.inicio ?? p.padrao.inicio;
    const fim = cal?.fim ?? p.padrao.fim;
    const diasUteis = cal?.dias ?? [];
    const dias = contarDias(diasUteis, inicio, fim, p.hoje);
    return {
      inicio,
      fim,
      diasUteis,
      dias,
      encerrado: p.hoje > fim,
      periodo: {
        ano: p.ano,
        mes: p.mes,
        inicio,
        fim,
        corrente: dias.corrente,
        fechado: false,
        dias_uteis_total: dias.total,
        dias_uteis_fechados: dias.fechados,
        dias_uteis_restantes: dias.restantes,
        dia_util_corrente: dias.dia_util_corrente,
      },
    };
  }

  /**
   * Foto gravada do mês já encerrado (com o filtro de `gerencia` do usuário), ou null
   * para calcular ao vivo. Mês corrente nunca lê foto.
   */
  private async fotoDoMes(p: ReturnType<GestaoService['validarPeriodo']>, usuarioId?: string) {
    if (p.padrao.fim >= p.hoje) return null;
    return (await this.fechamento(p.ano, p.mes, usuarioId))?.foto ?? null;
  }

  /** Período do mês (dias úteis pelo calendário do BI) para o cabeçalho da tela, qualquer que seja a aba. */
  async periodo(anoPedido?: number, mesPedido?: number) {
    const p = this.validarPeriodo(anoPedido, mesPedido);
    return this.montarPeriodo(p, await this.bi.diasUteisPeriodo(p.ano, p.mes)).periodo;
  }

  /** Marca na resposta lida da foto que ela veio do fechamento. */
  private daFoto(parte: unknown) {
    const r = parte as { periodo: Record<string, unknown> };
    return { ...r, periodo: { ...r.periodo, fechado: true } };
  }

  /**
   * Mês com foto em `ven_atacado_fechamento` devolve a foto; sem foto, calcula ao vivo
   * (mês encerrado: previsão = faturado; metas pela vigência do início do mês).
   * `comoGerencia` inclui o bloco `gerencia` sem olhar o usuário e calcula sempre ao
   * vivo (é a leitura que monta a foto).
   */
  async visaoGeral(anoPedido?: number, mesPedido?: number, usuarioId?: string, comoGerencia = false) {
    const p = this.validarPeriodo(anoPedido, mesPedido);
    const { ano, mes, hoje } = p;
    const foto = comoGerencia ? null : await this.fotoDoMes(p, usuarioId);
    // A foto é a própria resposta ao vivo serializada: mesmo formato.
    if (foto) return this.daFoto(foto.visao_geral) as never;

    const anteriores = mesesAnteriores(ano, mes, 5).reverse();
    const [cal, porDia, meses, metasCanal, metasAtacado, { kpis, clientes: carteira }, bolsaCanal, usuario, negociacao] = await Promise.all([
      this.bi.diasUteisPeriodo(ano, mes),
      this.bi.faturadoCanalPorDia(ano, mes),
      this.bi.faturadoCanalMeses(anteriores[0], anteriores[anteriores.length - 1]),
      this.metasDoCanal(ano, mes),
      this.repo.metasAtacado(),
      this.supervisao.indicadoresDoMes(ano, mes),
      this.orcamento.bolsaCanal({ ano, mes }).catch(() => null),
      this.repo.usuarioVendas(usuarioId),
      this.repo.emNegociacaoPorRep(hoje).catch(() => [] as Awaited<ReturnType<CarteirizacaoPrismaRepository['emNegociacaoPorRep']>>),
    ]);
    const meta = metasCanal.total;
    const alertas = await this.blocoAlertas(ano, mes, hoje, metasCanal.metas, metasCanal.reps, negociacao, kpis);
    const { inicio, fim, diasUteis, dias, encerrado, periodo } = this.montarPeriodo(p, cal);

    const faturado = porDia.reduce((s, d) => s + d.venda, 0);
    const faturado_hoje = porDia.filter((d) => d.dia === hoje).reduce((s, d) => s + d.venda, 0);
    const custo = porDia.reduce((s, d) => s + d.custo, 0);
    const markup = custo > 0 ? faturado / custo : null;
    const { ritmo, previsao } = ritmoPrevisao({ faturado, faturado_hoje, dias, encerrado });

    const custoDepto = metaVigente(metasAtacado,'CUSTO_DEPARTAMENTO', inicio).valor;
    const fator = fracaoEnv('GESTAO_ATACADO_FATOR_RECEITA', 0.9955);
    const despesa = fracaoEnv('GESTAO_ATACADO_DESPESA_VARIAVEL', 0.0467);
    const piso = pisoVenda(custoDepto, markup, fator, despesa);
    const margem = margemMes(faturado, markup, fator, despesa);
    const nivel_atual = nivel({ venda: faturado, margem, custoDepto, meta });
    const nivel_previsto =
      previsao == null ? null : nivel({ venda: previsao, margem: margemMes(previsao, markup, fator, despesa), custoDepto, meta });
    const bloco = this.blocoPremio(kpis, bolsaCanal);
    const valorNivel = (k: string) => metaVigente(metasAtacado, k, inicio).valor;
    const niveis = { n1: valorNivel('PREMIO_N1'), n2: valorNivel('PREMIO_N2'), n3: valorNivel('PREMIO_N3') };

    return {
      periodo,
      pool_rep: REP_DISPONIVEL,
      canal: {
        faturado,
        faturado_hoje,
        ritmo,
        previsao,
        meta,
        piso,
        alvo_n3: meta * 1.15,
        ritmo_para_piso: ritmoNecessario(piso, faturado, dias.restantes),
        ritmo_para_meta: ritmoNecessario(meta, faturado, dias.restantes),
        veredito: veredito(previsao, meta, piso),
        serie: serieAcumulada(
          porDia.map((d) => ({ dia: d.dia, valor: d.venda })),
          diasUteis.filter((d) => d >= inicio && d <= fim),
          hoje,
        ),
        historico: anteriores.map((c) => ({
          ...c,
          faturado: meses.find((m) => m.ano === c.ano && m.mes === c.mes)?.faturado ?? 0,
        })),
      },
      premio: { nivel_atual, nivel_previsto, ...bloco },
      kpis: {
        em_negociacao: {
          valor: negociacao.reduce((s, n) => s + n.valor, 0),
          quantidade: negociacao.reduce((s, n) => s + n.quantidade, 0),
        },
        mix1: mix1(faturado > 0 ? porDia.reduce((s, d) => s + d.mix1, 0) / faturado : null),
        bolsa_canal: bolsaCanal,
        clientes: {
          pool: carteira.filter((c) => c.em_carteira && c.rep_codigo === REP_DISPONIVEL).length,
          carteira: carteira.filter((c) => c.em_carteira && c.rep_codigo !== REP_DISPONIVEL).length,
        },
      },
      alertas,
      // Valores de margem, custo e prêmio em reais: a chave só existe para a gerência.
      ...(comoGerencia || ehGerenciaVendas(usuario)
        ? {
            gerencia: {
              markup,
              margem_mes: margem,
              custo_departamento: custoDepto,
              niveis,
              premio: premio({ nivel: nivel_atual, pontos: bloco.pontos, valores: niveis, travaBolsa: bloco.trava_bolsa }),
            },
          }
        : {}),
      gerado_em: new Date().toISOString(),
    };
  }

  /**
   * Semana do esforço: a pedida; sem pedido, num mês já encerrado, a última semana
   * dele (segunda até o fim); no mês corrente, o padrão da supervisão (esta semana).
   */
  private semanaDoEsforco(p: ReturnType<GestaoService['validarPeriodo']>, desde?: string, ate?: string) {
    if (desde && ate) return { desde, ate };
    const fim = p.padrao.fim;
    if (fim >= p.hoje) return {};
    return { desde: somarDias(fim, -((diaDaSemana(fim) + 6) % 7)), ate: fim };
  }

  /**
   * Aba Equipe: vendedores (reps ativos do atacado com nota no próprio código no mês)
   * com meta, atingimento, previsão e veredito pela regra do canal (sem piso); o
   * faturado do canal que não saiu nesses códigos fica em `totais.outros`, para a
   * soma fechar com o faturado oficial. O esforço da semana é o mesmo da supervisão.
   * Mês com foto devolve a foto; com semana pedida, o esforço dela é medido na hora (o
   * gravado é o da última semana do mês). `aoVivo` (fechamento) ignora a foto e mede o
   * esforço sem reconciliar fila nem resgate.
   */
  async equipe(anoPedido?: number, mesPedido?: number, semanaDesde?: string, semanaAte?: string, usuarioId?: string, aoVivo = false) {
    const p = this.validarPeriodo(anoPedido, mesPedido);
    const { ano, mes, hoje } = p;
    const foto = aoVivo ? null : await this.fotoDoMes(p, usuarioId);
    if (foto) {
      const gravada = foto.equipe as Record<string, unknown>;
      if (!semanaDesde || !semanaAte) return this.daFoto(gravada) as never;
      return this.daFoto({ ...gravada, esforco: await this.supervisao.esforco({ desde: semanaDesde, ate: semanaAte }, false) }) as never;
    }
    const [cal, porVendedor, metasCanal, negociacao, esforco] = await Promise.all([
      this.bi.diasUteisPeriodo(ano, mes),
      this.bi.faturadoCanalPorVendedor(ano, mes, hoje),
      this.metasDoCanal(ano, mes),
      this.repo.emNegociacaoPorRep(hoje),
      this.supervisao.esforco(this.semanaDoEsforco(p, semanaDesde, semanaAte), !aoVivo),
    ]);
    const { inicio, fim, dias, encerrado, periodo } = this.montarPeriodo(p, cal);

    // Auxiliar: rep ativo do atacado sem nota no próprio código no mês e com orçamento
    // fechado no mês. A venda dele aparece nas notas dos vendedores; aqui só se mostra
    // de onde veio (não soma no faturado do canal).
    const comNota = new Set(porVendedor.map((v) => v.rep_codigo));
    const fechados = (await this.repo.orcamentosFechadosNoMes(inicioDia(inicio), fimDia(fim))).filter(
      (o) => metasCanal.reps.has(o.rep_codigo) && !comNota.has(o.rep_codigo),
    );
    // Nota de cada orçamento: o casamento do extrato da bolsa do auxiliar (mesma leitura,
    // para a Equipe bater com o extrato). Casamento indisponível = orçamentos sem nota.
    const repsAux = [...new Set(fechados.map((o) => o.rep_codigo))];
    const casamento = new Map(
      await Promise.all(repsAux.map(async (r) => [r, await this.orcamento.casamentoDoRep(r).catch(() => null)] as const)),
    );
    const casados = [...fechados]
      .sort((a, b) => a.desfecho_em.getTime() - b.desfecho_em.getTime())
      .map((o) => {
        const c = casamento.get(o.rep_codigo);
        return {
          orcamento: { id: o.id, rep_codigo: o.rep_codigo, total: o.total },
          notas: c ? notasDoOrcamento(c.porOrcamento.get(o.id) ?? [], c.linhas) : [],
        };
      });
    const resumo = resumirAuxiliares(casados);
    const nomeRep = (c: number) => metasCanal.reps.get(c) ?? porVendedor.find((v) => v.rep_codigo === c)?.rep_nome ?? `Rep ${c}`;
    const orcPorId = new Map(fechados.map((o) => [o.id, o]));
    const auxiliares = resumo.auxiliares
      .map((a) => {
        const meta = metasCanal.metas.get(a.rep_codigo) ?? null;
        return {
          rep_codigo: a.rep_codigo,
          rep_nome: nomeRep(a.rep_codigo),
          orcamentos_fechados: a.orcamentos_fechados,
          vendeu: a.vendeu,
          meta,
          pct_da_meta: meta ? pct(a.vendeu, meta) : null,
          por_vendedor: a.por_vendedor.map((v) => ({ ...v, rep_nome: nomeRep(v.rep_codigo) })),
          sem_nota: a.sem_nota,
          orcamentos: casados
            .filter((c) => c.orcamento.rep_codigo === a.rep_codigo)
            .map(({ orcamento, notas }) => {
              const o = orcPorId.get(orcamento.id)!;
              return {
                id: o.id,
                numero: o.numero,
                cli_codigo: o.cli_codigo,
                fechado_em: o.desfecho_em.toISOString(),
                total: o.total,
                notas: notas.map((n) => ({
                  empresa: n.empresa,
                  serie: n.serie,
                  nfs: n.nfs,
                  emissao: n.emissao_ymd,
                  valor: n.valor,
                  rep_codigo: n.rep_codigo,
                  rep_nome: nomeRep(n.rep_codigo),
                })),
              };
            }),
        };
      })
      .sort((a, b) => b.vendeu - a.vendeu);
    const veioDe = new Map(resumo.veio_dos_auxiliares.map((v) => [v.rep_codigo, v.valor]));

    const previsaoDe = (total: number, ateOntem: number) =>
      ritmoPrevisao({ faturado: total, faturado_hoje: total - ateOntem, dias, encerrado }).previsao;

    const vendedores = porVendedor
      .filter((v) => metasCanal.reps.has(v.rep_codigo))
      .map((v) => {
        const meta = metasCanal.metas.get(v.rep_codigo) ?? 0;
        const previsao = previsaoDe(v.total, v.ate_ontem);
        const neg = negociacao.find((n) => n.rep_codigo === v.rep_codigo);
        return {
          rep_codigo: v.rep_codigo,
          rep_nome: metasCanal.reps.get(v.rep_codigo) ?? v.rep_nome ?? `Rep ${v.rep_codigo}`,
          meta,
          faturado: v.total,
          atingimento: pct(v.total, meta),
          previsao,
          // Sem piso por vendedor: o veredito nunca é ABAIXO_DO_PISO.
          veredito: veredito(previsao, meta) as Exclude<Veredito, 'ABAIXO_DO_PISO'> | null,
          veio_dos_auxiliares: veioDe.get(v.rep_codigo) ?? 0,
          em_negociacao: { valor: neg?.valor ?? 0, quantidade: neg?.quantidade ?? 0 },
        };
      })
      .sort((a, b) => b.faturado - a.faturado);

    const faturado_canal = porVendedor.reduce((s, v) => s + v.total, 0);
    const ateOntemCanal = porVendedor.reduce((s, v) => s + v.ate_ontem, 0);
    const conta = (v: Veredito) => vendedores.filter((x) => x.veredito === v).length;
    return {
      periodo,
      pool_rep: REP_DISPONIVEL,
      vendedores,
      auxiliares,
      totais: {
        meta_vendedores: vendedores.reduce((s, v) => s + v.meta, 0),
        meta_auxiliares: auxiliares.reduce((s, a) => s + (a.meta ?? 0), 0),
        meta_canal: metasCanal.total,
        faturado_canal,
        outros: faturado_canal - vendedores.reduce((s, v) => s + v.faturado, 0),
        previsao_canal: previsaoDe(faturado_canal, ateOntemCanal),
        vendido_auxiliares: auxiliares.reduce((s, a) => s + a.vendeu, 0),
        em_negociacao: {
          valor: negociacao.reduce((s, n) => s + n.valor, 0),
          quantidade: negociacao.reduce((s, n) => s + n.quantidade, 0),
        },
        vao_bater: conta('VAI_BATER'),
        em_risco: conta('EM_RISCO'),
        nao_batem: conta('NAO_BATE'),
      },
      esforco,
    };
  }

  /**
   * Motivos de perda da aba Canal: orçamentos emitidos no mês calendário (o mesmo corte do
   * funil da foto mensal) com motivo apontado, o placar por motivo e a lista por trás dele.
   * "Cliente adiou" com retorno marcado entra: é motivo apontado, mesmo com o orçamento vivo.
   */
  async motivosPerda(mes?: string) {
    if (!mes || !/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw new BadRequestException('Mês inválido (AAAA-MM).');
    const inicio = `${mes}-01`;
    const proximo = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5)), 1)).toISOString().slice(0, 10);
    const orcamentos = await this.repo.motivosPerdaEmitidos(
      { de: inicioDia(inicio), ate: inicioDia(proximo) },
      { de: new Date(inicio), ate: new Date(proximo) },
    );
    return { mes, ...resumirMotivosPerda(orcamentos), orcamentos: orcamentos.sort((a, b) => b.total - a.total) };
  }

  /** Quem reapura o fechamento: só a gerência de vendas. Devolve o nome para `fechado_por`. */
  async gerenteDoFechamento(usuarioId: string | undefined) {
    const u = await this.repo.usuarioVendas(usuarioId);
    if (!u) throw new ForbiddenException('Usuário não identificado: entre de novo na intranet e tente outra vez.');
    if (!ehGerenciaVendas(u)) throw new ForbiddenException('Só a gerência reapura o fechamento do mês.');
    return u.nome || u.codigo || u.id;
  }

  /**
   * Fecha (ou reapura) o mês comissional: calcula visão geral e equipe com o bloco de
   * gerência e grava a foto em `ven_atacado_fechamento` (uma linha por mês; reapurar
   * regrava a mesma). Recusa mês que ainda não terminou.
   */
  async fechar(ano: number, mes: number, por: string) {
    const p = this.validarPeriodo(ano, mes);
    if (p.padrao.fim >= p.hoje) throw new BadRequestException('O mês comissional ainda não terminou.');
    const [visao_geral, equipe] = await Promise.all([this.visaoGeral(ano, mes, undefined, true), this.equipe(ano, mes, undefined, undefined, undefined, true)]);
    const linha = await this.repo.gravarFechamentoAtacado({
      ano,
      mes,
      nivel: visao_geral.premio.nivel_atual,
      pontos: visao_geral.premio.pontos,
      venda: visao_geral.canal.faturado,
      meta: visao_geral.canal.meta,
      foto: JSON.parse(JSON.stringify({ visao_geral, equipe })),
      fechado_por: por,
    });
    return { ano, mes, nivel: linha.nivel, pontos: Number(linha.pontos), venda: Number(linha.venda), meta: Number(linha.meta), fechado_em: linha.fechado_em, fechado_por: linha.fechado_por };
  }

  /** Meses já fechados (sem a foto). */
  async fechamentos() {
    const rows = await this.repo.fechamentosAtacado();
    return rows.map((r) => ({ ...r, pontos: Number(r.pontos), venda: Number(r.venda), meta: Number(r.meta) }));
  }

  /** Foto de um mês fechado (null se não houver); sem gerência, a foto sai sem `visao_geral.gerencia`. */
  async fechamento(ano: number, mes: number, usuarioId?: string) {
    if (!Number.isInteger(ano) || !Number.isInteger(mes) || mes < 1 || mes > 12) throw new BadRequestException('Período inválido.');
    const [r, usuario] = await Promise.all([this.repo.fechamentoAtacado(ano, mes), this.repo.usuarioVendas(usuarioId)]);
    if (!r) return null;
    const foto = r.foto as { visao_geral: Record<string, unknown>; equipe: unknown };
    const visao_geral = { ...foto.visao_geral };
    if (!ehGerenciaVendas(usuario)) delete visao_geral.gerencia;
    return {
      ano: r.ano,
      mes: r.mes,
      nivel: r.nivel,
      pontos: Number(r.pontos),
      venda: Number(r.venda),
      meta: Number(r.meta),
      fechado_em: r.fechado_em,
      fechado_por: r.fechado_por,
      foto: { visao_geral, equipe: foto.equipe },
    };
  }
}
