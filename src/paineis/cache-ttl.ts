/** Cache em memória com validade fixa. Uma instância por processo. */
export class CacheTtl<T> {
  private readonly itens = new Map<string, { expira: number; valor: T }>();
  constructor(private readonly ttlMs: number) {}

  get(chave: string): T | undefined {
    const item = this.itens.get(chave);
    if (!item) return undefined;
    if (item.expira <= Date.now()) {
      this.itens.delete(chave);
      return undefined;
    }
    return item.valor;
  }

  set(chave: string, valor: T): void {
    const agora = Date.now();
    // Limpa os vencidos aqui para o Map não crescer com chaves que ninguém relê.
    for (const [k, v] of this.itens) if (v.expira <= agora) this.itens.delete(k);
    this.itens.set(chave, { expira: agora + this.ttlMs, valor });
  }

  apagarPrefixo(prefixo: string): void {
    for (const k of this.itens.keys()) if (k.startsWith(prefixo)) this.itens.delete(k);
  }
}
