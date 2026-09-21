import { Logger } from '@nestjs/common';

const logger = new Logger('AnalyticsAtacado');

/**
 * Leitura do analytics-atacado-service (perfis calculados toda noite). É sempre
 * OPCIONAL para quem chama: sem ANALYTICS_ATACADO_URL, com o serviço fora ou lento,
 * devolve `null` e a tela segue sem o enriquecimento — sugestão e alerta nunca
 * podem travar orçamento nem fila.
 */
export async function analyticsAtacadoGet<T>(rota: string): Promise<T | null> {
  const base = process.env.ANALYTICS_ATACADO_URL;
  if (!base) return null;
  const ms = Number(process.env.ANALYTICS_ATACADO_TIMEOUT_MS);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number.isFinite(ms) && ms > 0 ? ms : 3000);
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}${rota}`, {
      headers: { 'x-app-token': process.env.ANALYTICS_ATACADO_TOKEN ?? '' },
      signal: ctrl.signal,
    });
    if (r.status === 404) return null; // cliente sem perfil: não é falha
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } catch (e) {
    logger.warn(`${rota} indisponível: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
