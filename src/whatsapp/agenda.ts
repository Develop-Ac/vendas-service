/**
 * Código do cliente no nome salvo na agenda do celular corporativo.
 *
 * O vendedor salva o contato como "40289 João" (ou "João 40289", "C40289"): o
 * bloco de 3 a 6 dígitos é o código do cliente e o resto é o nome da pessoa.
 * Só vale quando EXATAMENTE um bloco é código de cliente do atacado — nenhum ou
 * dois não vinculam. Número longo (telefone, CNPJ) salvo no nome não é cortado
 * em blocos: só conta o bloco de 3 a 6 dígitos sem dígito colado.
 * Função pura, sem banco nem WAHA.
 */
export function codigoDaAgenda(
  nome: string | null | undefined,
  codigosValidos: Set<number>,
): { cli_codigo: number; contato_nome: string | null } | null {
  const texto = String(nome ?? '');
  const validos = (texto.match(/(?<!\d)\d{3,6}(?!\d)/g) ?? []).filter((b) => codigosValidos.has(Number(b)));
  if (validos.length !== 1) return null;
  // a letra colada na frente do código é prefixo ("C40289"), não nome
  const resto = texto.replace(new RegExp(String.raw`(?<![\p{L}\d])\p{L}?` + validos[0] + String.raw`(?!\d)`, 'u'), ' ').replace(/\s+/g, ' ').trim();
  return { cli_codigo: Number(validos[0]), contato_nome: resto || null };
}
