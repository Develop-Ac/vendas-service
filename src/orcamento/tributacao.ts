import { round2 } from './regua';

/* =============================================================================
   ICMS NA VENDA PARA FORA DO ESTADO — o que a nota de saída vai cobrar ou custar.
   -----------------------------------------------------------------------------
   A empresa 1 emite a venda interestadual em duas operações, e o orçamento
   precisa mostrar o mesmo número que a nota:

     cliente contribuinte (indicador 1)          -> ICMS-ST, somado ao total da
        operação 165, CFOP 6.403, situação 010     nota: o cliente paga.
     cliente não contribuinte (9) ou isento (2)  -> DIFAL: a AC recolhe por GNRE e,
        operação 158, CFOP 6.108, situação 158     por acordo com os clientes do
                                                   atacado, cobra dele como despesa
                                                   acessória — somado ao total do
                                                   orçamento e da nota. Repasse, não
                                                   custo: bolsa e margem não mudam.
        Só quando a venda NÃO é presencial: cliente que retira na loja sai em
        operação interna, sem DIFAL — o mesmo indicador de presença da NF-e.

   Fórmulas por item, arredondando a 2 casas em cada passo (conferidas ao centavo
   nas notas 155592 e 155277):
     ICMS próprio = total × aliq_interestadual
     base ST      = total × (1 + mva)
     ST           = base ST × aliq_interna − ICMS próprio
     base DIFAL   = total ÷ (1 − a)          DIFAL = base × a
   Os parâmetros (MVA, alíquotas, `a` por produto) vêm do Celta a cada orçamento;
   nada é fixo aqui. A UF liberada é configuração (ORCAMENTO_TRIBUTACAO_UFS): a
   situação 010 é cadastrada para o Pará, e outro estado só entra quando o fiscal
   cadastrar a situação dele e liberar.
   ============================================================================= */

export type RegimeInterestadual =
  /** cliente do mesmo estado: nada muda */
  | 'NENHUM'
  /** contribuinte fora do estado: ICMS-ST somado ao total */
  | 'ST'
  /** não contribuinte/isento fora do estado, venda não presencial: DIFAL somado ao total (despesa acessória) */
  | 'DIFAL'
  /** não contribuinte/isento fora do estado, venda presencial: operação interna */
  | 'PRESENCIAL'
  /** UF fora do estado ainda sem situação tributária cadastrada: a tela avisa e não calcula */
  | 'FORA_ESCOPO';

/** Parâmetros da situação tributária do ST, em FRAÇÃO (0.7178, 0.19, 0.12). */
export interface ParametrosSt {
  mva: number;
  aliq_interna: number;
  aliq_interestadual: number;
}

export interface ClienteTributacao {
  uf: string | null;
  /** CLIENTES.INDICADOR_IE_DESTINATARIO: 1 contribuinte, 2 isento, 9 não contribuinte */
  indicador_ie: number | null;
}

/** UF da empresa que emite a nota. */
export const UF_ORIGEM = 'MT';

export function regimeInterestadual(c: ClienteTributacao, presencial: boolean, ufsLiberadas: string[]): RegimeInterestadual {
  const uf = (c.uf ?? '').trim().toUpperCase();
  if (!uf || uf === UF_ORIGEM) return 'NENHUM';
  if (!ufsLiberadas.includes(uf)) return 'FORA_ESCOPO';
  if (c.indicador_ie === 1) return 'ST';
  return presencial ? 'PRESENCIAL' : 'DIFAL';
}

export function calcularSt(total: number, p: ParametrosSt): number {
  if (!(total > 0)) return 0;
  const icmsProprio = round2(total * p.aliq_interestadual);
  const baseSt = round2(total * (1 + p.mva));
  return Math.max(0, round2(round2(baseSt * p.aliq_interna) - icmsProprio));
}

/** `aliquota` em fração (0.07). */
export function calcularDifal(total: number, aliquota: number): number {
  if (!(total > 0) || !(aliquota > 0) || aliquota >= 1) return 0;
  const base = round2(total / (1 - aliquota));
  return round2(base * aliquota);
}

/** Texto curto para o selo do cliente na tela, no PDF interno e nos avisos. */
export function seloTributacao(regime: RegimeInterestadual, uf: string | null): string | null {
  const u = (uf ?? '').trim().toUpperCase();
  switch (regime) {
    case 'ST': return `${u} · revenda: ICMS-ST somado ao total`;
    case 'DIFAL': return `${u} · não contribuinte: DIFAL somado ao total`;
    case 'PRESENCIAL': return `${u} · venda presencial: sem DIFAL`;
    case 'FORA_ESCOPO': return `${u} · fora do escopo: imposto interestadual não calculado`;
    default: return null;
  }
}

/** Rótulo do indicador de IE do cadastro. */
export function descricaoIndicadorIe(i: number | null): string | null {
  return i === 1 ? 'contribuinte' : i === 2 ? 'isento de IE' : i === 9 ? 'não contribuinte' : null;
}
