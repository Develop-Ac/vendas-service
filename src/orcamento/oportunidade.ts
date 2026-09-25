import { round2, round4 } from './regua';

/* =============================================================================
   COMPRA DE OPORTUNIDADE — reserva da empresa na bolsa do vendedor.
   -----------------------------------------------------------------------------
   A bolsa é a sobra acima do piso: preço − custo × piso. Quando a empresa compra
   um lote muito abaixo do custo normal e mantém o preço perto do mercado, essa
   sobra cresce e iria inteira para o vendedor. A gestão registra a nota e diz
   quanto da sobra (a preço de tabela) fica com ele; o resto é reserva da empresa.

   O sistema guarda um único número por produto, o CUSTO PARA A BOLSA: o custo
   que faz a conta da bolsa devolver só a parte do vendedor quando o item sai a
   preço de tabela. Fixo em reais — se a tabela subir depois, a diferença é do
   vendedor. Só a bolsa usa esse custo; régua, faixa (comissão), piso absoluto
   custo × 1,25, Celta e nota seguem com o custo real.
   ============================================================================= */

/** Fração da sobra que fica com o vendedor quando a tela não diz outra. */
export const PCT_VENDEDOR_PADRAO = 0.2;

export function custoParaBolsa(custo: number, precoTabela: number, piso: number, pctVendedor: number) {
  const pct = Math.min(1, Math.max(0, pctVendedor));
  const sobra = Math.max(0, precoTabela - custo * piso);
  const reserva = sobra * (1 - pct);
  return {
    /** o que iria para a bolsa por unidade vendida a preço de tabela */
    sobra: round2(sobra),
    vendedor: round2(sobra - reserva),
    reserva: round2(reserva),
    /** custo que a bolsa passa a usar: preço − custo_bolsa × piso = parte do vendedor */
    custo_bolsa: round4(piso > 0 ? custo + reserva / piso : custo),
  };
}
