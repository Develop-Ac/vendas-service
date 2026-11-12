/**
 * Cache que devolve o último valor bom enquanto recalcula por trás.
 *
 * - idade < ttl: devolve o valor guardado.
 * - ttl <= idade < maxVelho: devolve o valor guardado e dispara um recálculo
 *   sem esperar (erro vai para `aoFalhar`).
 * - sem valor ou idade >= maxVelho: espera o cálculo (rejeita se falhar).
 *
 * Só grava quando o cálculo termina bem; falha não apaga o valor guardado.
 * Cálculos simultâneos da mesma chave são um só.
 */
export class CacheVelho<V> {
  private readonly valores = new Map<string, { em: number; v: V }>();
  private readonly emAndamento = new Map<string, Promise<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxVelhoMs = ttlMs,
    private readonly aoFalhar?: (chave: string, e: Error) => void,
  ) {}

  ler(chave: string, calcular: () => Promise<V>): Promise<V> {
    const g = this.valores.get(chave);
    const idade = g ? Date.now() - g.em : Infinity;
    if (!g || idade >= this.maxVelhoMs) return this.renovar(chave, calcular);
    if (idade >= this.ttlMs) {
      this.renovar(chave, calcular).catch((e: Error) => this.aoFalhar?.(chave, e));
    }
    return Promise.resolve(g.v);
  }

  renovar(chave: string, calcular: () => Promise<V>): Promise<V> {
    const andando = this.emAndamento.get(chave);
    if (andando) return andando;
    const p = (async () => {
      try {
        const v = await calcular();
        const agora = Date.now();
        for (const [k, e] of this.valores) {
          if (agora - e.em >= this.maxVelhoMs) this.valores.delete(k);
        }
        this.valores.set(chave, { em: agora, v });
        return v;
      } finally {
        this.emAndamento.delete(chave);
      }
    })();
    this.emAndamento.set(chave, p);
    return p;
  }
}
