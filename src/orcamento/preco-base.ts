/**
 * Preço base acima da tabela: o vendedor fecha o unitário ACIMA da tabela (B) e dá um
 * desconto sobre ele (d). O cliente — PDF, mensagem e o Celta/NF — vê "B com d%"; régua,
 * alçada, bolsa e comissão continuam medindo o preço final (L = B × (1 − d)) contra a tabela.
 *
 * `preco_base` só é gravado quando B > tabela (nulo = a base é a própria tabela) e
 * `desc_base_pct` é o d sobre ele. Unitário digitado ABAIXO da tabela não é base: é a
 * tabela com desconto. Orçamento anterior com acréscimo (cobrado acima da tabela, sem base
 * gravada) é lido como B = cobrado e d = 0.
 */
import { round2 } from './regua';

export interface LinhaComBase {
  preco_tabela: number | string;
  preco_unit?: number | string | null;
  desc_pct: number | string;
  preco_base?: number | string | null;
  desc_base_pct?: number | string | null;
}

/** Unitário cobrado (L): o fechado pelo vendedor ou tabela × (1 − desconto). */
export function cobradoDe(i: LinhaComBase): number {
  return Number(i.preco_unit ?? 0) > 0 ? Number(i.preco_unit) : round2(Number(i.preco_tabela) * (1 - Number(i.desc_pct)));
}

/** O que o cliente vê na linha: o unitário base e o desconto (fração) sobre ele. */
export function baseDoCliente(i: LinhaComBase): { base: number; desc: number } {
  const tabela = Number(i.preco_tabela);
  const base = Number(i.preco_base ?? 0);
  if (base > 0) return { base, desc: Number(i.desc_base_pct ?? 0) };
  const cobrado = cobradoDe(i);
  if (cobrado > tabela + 0.005) return { base: cobrado, desc: 0 };
  return { base: tabela, desc: Number(i.desc_pct) };
}

/** Desconto (fração, 4 casas) que leva de `base` a `preco`; nunca negativo. */
export function descSobre(base: number, preco: number): number {
  return base > 0 ? Math.min(1, Math.max(0, Math.round((1 - preco / base) * 10000) / 10000)) : 0;
}

/** Item com base acima da tabela cujo desconto sobre ela passa do máximo em vigor: vai para aprovação. */
export function descBaseAcimaDoMaximo(i: { preco_base?: number | string | null; desc_base_pct?: number | string | null; desc_max_pct?: number | string | null }): boolean {
  return Number(i.preco_base ?? 0) > 0 && i.desc_max_pct != null && Number(i.desc_base_pct ?? 0) > Number(i.desc_max_pct) + 0.00005;
}
