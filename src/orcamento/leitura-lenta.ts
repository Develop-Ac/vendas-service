/**
 * Cronômetro das leituras da tela (lista, card, extrato, casamento): mede cada etapa e, se o
 * total passar de `limiteMs` (ORCAMENTO_LOG_LENTO_MS; 0 desliga), avisa numa linha só com o
 * tempo de cada etapa. Só nomes e milissegundos — nada de cliente nem valor.
 */
export function cronometro(limiteMs: number) {
  const inicio = Date.now();
  const etapas: Array<[string, number]> = [];
  return {
    /** Mede a Promise sem alterar valor nem erro. */
    etapa<T>(nome: string, p: Promise<T>): Promise<T> {
      const t = Date.now();
      return p.finally(() => etapas.push([nome, Date.now() - t]));
    },
    fim(leitura: string, avisar: (m: string) => void) {
      const total = Date.now() - inicio;
      if (limiteMs <= 0 || total <= limiteMs) return;
      avisar([`Leitura lenta: ${leitura} ${total}ms`, ...etapas.map(([n, ms]) => `${n} ${ms}ms`)].join(' · '));
    },
  };
}
