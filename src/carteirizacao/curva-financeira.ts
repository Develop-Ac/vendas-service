/* =============================================================================
   CURVA FINANCEIRA DO CLIENTE (A/B/C) — "esse cliente paga?"

   Até out/2026 a curva era um Pareto do faturamento de 12 meses. O faturamento
   já pesa 35 pontos no score do cliente, então a curva repetia a mesma leitura
   — e um cliente AA (score A, curva A) podia estar inadimplente. A curva passa
   a medir o perfil de PAGAMENTO, e é ela que comanda a régua da fila, o resgate
   de 48h e o "Curva A fora da régua" da supervisão: contato prioritário vai
   para quem compra E paga.

   Mesmas definições do parecer de crédito do financeiro-service
   (engine/indicadores.js), para os dois módulos não divergirem:
     - só boleto (TT_CODIGO = 'BOL') — é onde existe crédito concedido;
     - título A PRAZO = vencimento depois da emissão OU pago em dia diferente da
       emissão. Venda à vista não demonstra comportamento de crédito e NÃO
       pontua: cliente que só compra à vista fica sem pontos (curva C);
     - tolerância de 5 dias: até 5 dias depois do vencimento ainda é "em dia".

   Pontos (0-100):
     Pontualidade   40  % dos boletos a prazo pagos em 12m que foram em dia
     Atraso médio   25  média dos dias de atraso dos pagos (0d = 25, 30d+ = 0)
     Pior atraso    10  maior atraso pago em 12m (até 5d = 10, 60d+ = 0)
     Uso do limite  15  saldo de boletos em aberto ÷ limite (até 50% = 15,
                        100%+ = 0; sem limite cadastrado = 0)
     Tendência      10  atraso médio dos últimos 90d vs 12m (igual ou melhor =
                        10, 15d pior = 0)

   Faixas: A >= 80, B >= 60, C abaixo. Por cima dos pontos, três travas:
     - boleto VENCIDO EM ABERTO além da tolerância  -> C (inadimplente agora);
     - conceito 8 no ERP (CLIENTE INADIMPLENTE)     -> C;
     - menos de 3 boletos a prazo pagos em 12m      -> no máximo B (amostra
       pequena: um boleto em dia não faz um cliente A).
   ============================================================================= */

export type Curva = 'A' | 'B' | 'C';

/** Boleto do cliente, como vem do contas a receber. */
export interface TituloBoleto {
  emissao: Date | string | null;
  vencimento: Date | string | null;
  data_pagto: Date | string | null;
  valor: number;
}

export interface PerfilFinanceiro {
  curva: Curva;
  pontos: number;
  /** Por que a curva não seguiu os pontos (trava), ou por que não há pontos. */
  motivo: string | null;
  boletos_pagos_12m: number;
  pct_boletos_em_dia: number | null; // 0-100
  atraso_medio_dias: number | null;
  pior_atraso_dias: number | null;
  uso_limite_pct: number | null; // 0-100+
  valor_vencido_aberto: number;
  maior_atraso_aberto_dias: number;
  detalhe: Record<IndicadorFinanceiro, number>;
}

export type IndicadorFinanceiro = 'pontualidade' | 'atraso_medio' | 'pior_atraso' | 'uso_limite' | 'tendencia';

export const PESOS_FINANCEIRO: Record<IndicadorFinanceiro, number> = {
  pontualidade: 40,
  atraso_medio: 25,
  pior_atraso: 10,
  uso_limite: 15,
  tendencia: 10,
};

/** Igual ao financeiro-service (REGRAS.toleranciaAtrasoDias). */
export const TOLERANCIA_ATRASO_DIAS = 5;
export const MIN_BOLETOS_PARA_A = 3;
export const CONCEITO_INADIMPLENTE = 8;
const FAIXA_A = 80;
const FAIXA_B = 60;

const DIA_MS = 86_400_000;

function ts(v: Date | string | null): number | null {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Dias inteiros de b até a (a − b). */
function diasEntre(a: Date | string | null, b: Date | string | null): number | null {
  const ta = ts(a);
  const tb = ts(b);
  if (ta == null || tb == null) return null;
  return Math.floor((ta - tb) / DIA_MS);
}

/** Interpolação de x em [x0, x1] para [y0, y1], com clamp. */
function lerp(x: number, x0: number, x1: number, y0: number, y1: number): number {
  const t = Math.max(0, Math.min(1, (x - x0) / (x1 - x0)));
  return y0 + t * (y1 - y0);
}

const media = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** Mesma regra de "a prazo" do financeiro-service (`_ehAPrazo`). */
export function ehAPrazo(t: TituloBoleto): boolean {
  const prazo = diasEntre(t.vencimento, t.emissao);
  if (prazo != null && prazo >= 1) return true;
  if (t.data_pagto) {
    const g = diasEntre(t.data_pagto, t.emissao);
    return g != null && g >= 1;
  }
  return false;
}

/**
 * @param pagos12m boletos pagos nos últimos 12 meses (por data de pagamento)
 * @param abertos  boletos em aberto (STATUS 0 e sem pagamento)
 * @param limite   limite de crédito do cadastro (< R$ 1 = sem limite)
 * @param conceito CON_CODIGO do cadastro
 */
export function perfilFinanceiro(
  pagos12m: TituloBoleto[],
  abertos: TituloBoleto[],
  limite: number,
  conceito: number | null,
  hoje: Date = new Date(),
): PerfilFinanceiro {
  const tol = TOLERANCIA_ATRASO_DIAS;
  // Atraso efetivo: dentro da tolerância conta como em dia (0); acima, conta cheio.
  const efetivo = (d: number | null) => {
    const late = Math.max(0, d ?? 0);
    return late > tol ? late : 0;
  };

  const pagos = pagos12m.filter(ehAPrazo);
  const atrasos = pagos.map((t) => efetivo(diasEntre(t.data_pagto, t.vencimento)));
  const atrasos90 = pagos
    .filter((t) => (diasEntre(hoje, t.data_pagto) ?? Infinity) <= 90)
    .map((t) => efetivo(diasEntre(t.data_pagto, t.vencimento)));

  const saldoAberto = abertos.reduce((s, t) => s + (Number(t.valor) || 0), 0);
  const vencidos = abertos.filter((t) => (diasEntre(hoje, t.vencimento) ?? 0) > tol);
  const valorVencido = vencidos.reduce((s, t) => s + (Number(t.valor) || 0), 0);
  const maiorAtrasoAberto = vencidos.reduce((m, t) => Math.max(m, diasEntre(hoje, t.vencimento) ?? 0), 0);
  const usoLimite = limite >= 1 ? saldoAberto / limite : null;

  const n = pagos.length;
  const pctEmDia = n ? atrasos.filter((d) => d === 0).length / n : null;
  const atrasoMedio = n ? media(atrasos) : null;
  const piorAtraso = n ? Math.max(...atrasos) : null;

  const P = PESOS_FINANCEIRO;
  const detalhe: Record<IndicadorFinanceiro, number> = {
    pontualidade: 0,
    atraso_medio: 0,
    pior_atraso: 0,
    uso_limite: 0,
    tendencia: 0,
  };
  // Sem boleto a prazo pago não há comportamento de crédito para pontuar.
  if (n > 0) {
    detalhe.pontualidade = P.pontualidade * (pctEmDia as number);
    detalhe.atraso_medio = lerp(atrasoMedio as number, 0, 30, P.atraso_medio, 0);
    detalhe.pior_atraso = lerp(piorAtraso as number, tol, 60, P.pior_atraso, 0);
    detalhe.uso_limite = usoLimite == null ? 0 : lerp(usoLimite, 0.5, 1, P.uso_limite, 0);
    // Sem pagamento nos últimos 90 dias, não há tendência a medir: neutro (metade).
    detalhe.tendencia = atrasos90.length
      ? lerp(media(atrasos90) - (atrasoMedio as number), 0, 15, P.tendencia, 0)
      : P.tendencia / 2;
  }
  for (const k of Object.keys(detalhe) as IndicadorFinanceiro[]) detalhe[k] = Math.round(detalhe[k] * 10) / 10;
  const pontos = Math.round(Object.values(detalhe).reduce((s, x) => s + x, 0));

  let curva: Curva = pontos >= FAIXA_A ? 'A' : pontos >= FAIXA_B ? 'B' : 'C';
  let motivo: string | null = null;
  if (vencidos.length > 0) {
    curva = 'C';
    motivo = `Inadimplente: ${vencidos.length} boleto(s) vencido(s) em aberto, o mais antigo há ${maiorAtrasoAberto}d`;
  } else if (conceito === CONCEITO_INADIMPLENTE) {
    curva = 'C';
    motivo = 'Conceito CLIENTE INADIMPLENTE no ERP';
  } else if (n === 0) {
    curva = 'C';
    motivo = 'Sem boleto a prazo pago em 12 meses (só à vista não pontua)';
  } else if (curva === 'A' && n < MIN_BOLETOS_PARA_A) {
    curva = 'B';
    motivo = `Só ${n} boleto(s) pago(s) em 12 meses — mínimo ${MIN_BOLETOS_PARA_A} para curva A`;
  }

  const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
  return {
    curva,
    pontos,
    motivo,
    boletos_pagos_12m: n,
    pct_boletos_em_dia: pctEmDia == null ? null : r1(pctEmDia * 100),
    atraso_medio_dias: r1(atrasoMedio),
    pior_atraso_dias: piorAtraso,
    uso_limite_pct: usoLimite == null ? null : r1(usoLimite * 100),
    valor_vencido_aberto: Math.round(valorVencido * 100) / 100,
    maior_atraso_aberto_dias: maiorAtrasoAberto,
    detalhe,
  };
}
