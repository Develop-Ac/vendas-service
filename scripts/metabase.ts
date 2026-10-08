/**
 * Cliente mínimo da API do Metabase para os scripts dos painéis nativos.
 *
 * Chave: METABASE_API_KEY do ambiente ou, sem ela, a ÚLTIMA linha METABASE_API_KEY do
 * .env do cotacao-frontend (o arquivo tem duas; a última é a que vale). A chave nunca é
 * impressa. URL: METABASE_SITE_URL (padrão https://bi.acacessorios.local, certificado
 * da CA interna → sem validação do certificado).
 */
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

/** Raiz do repositório (os scripts ficam em <raiz>/scripts). */
export const RAIZ = path.resolve(path.dirname(process.argv[1]), '..');

const ENV_FRONT =
  process.env.METABASE_ENV_FILE ??
  path.resolve(RAIZ, '../../_workspaces/intranet-workspace/cotacao-frontend/.env');

function doEnvDoFront(nome: string): string | undefined {
  if (!fs.existsSync(ENV_FRONT)) return undefined;
  const linhas = [...fs.readFileSync(ENV_FRONT, 'utf8').matchAll(new RegExp(`^${nome}=(.*)$`, 'gm'))];
  const ultima = linhas.at(-1)?.[1]?.trim();
  return ultima?.replace(/^["']|["']$/g, '') || undefined;
}

const URL_BASE = (process.env.METABASE_SITE_URL || doEnvDoFront('METABASE_SITE_URL') || 'https://bi.acacessorios.local')
  .replace(/^http:\/\//i, 'https://')
  .replace(/\/$/, '');
const CHAVE = process.env.METABASE_API_KEY || doEnvDoFront('METABASE_API_KEY') || '';
const agente = new https.Agent({ rejectUnauthorized: false });

function requisicao(metodo: 'GET' | 'POST', caminho: string, corpo?: unknown): Promise<any> {
  if (!CHAVE) throw new Error(`METABASE_API_KEY não encontrada (ambiente ou ${ENV_FRONT}).`);
  const u = new URL(URL_BASE + caminho);
  const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: metodo,
        agent: agente,
        headers: {
          'x-api-key': CHAVE,
          'Content-Type': 'application/json',
          ...(dados ? { 'Content-Length': Buffer.byteLength(dados) } : {}),
        },
      },
      (res) => {
        let txt = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (txt += c));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode >= 300) {
            return reject(new Error(`Metabase ${metodo} ${caminho}: HTTP ${res.statusCode} ${txt.slice(0, 200)}`));
          }
          try {
            resolve(txt ? JSON.parse(txt) : null);
          } catch (e) {
            reject(e as Error);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error(`Metabase timeout: ${caminho}`)));
    if (dados) req.write(dados);
    req.end();
  });
}

export const mbGet = (caminho: string) => requisicao('GET', caminho);
export const mbPost = (caminho: string, corpo: unknown) => requisicao('POST', caminho, corpo);

/** IDs dos parâmetros do dashboard (iguais nos dashboards 7, 13, 18 e 5). */
export const PARAM_DATA = '2c141d49';
export const PARAM_VENDEDOR = '29d85853';

/**
 * Dashboard por hub — os mesmos defaults do cotacao-frontend (lib/vendas/metabasePainel.ts);
 * o .env do frontend não sobrescreve METABASE_DASH_* (conferido em 07/10/2026).
 */
export const DASH_POR_HUB: Record<string, number> = {
  VAREJO: 7,
  ATACADO: 13,
  SUPERVISAO_ATACADO: 18,
  GERENCIA: 5,
};
