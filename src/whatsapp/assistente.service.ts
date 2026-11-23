import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AvisosService } from '../common/avisos/avisos.module';
import { SessoesService } from './sessoes.service';

/**
 * Monitor do assistente do WhatsApp (runner da .146, porta 9200).
 *
 * A cada 30 s lê `GET {url}/assistente/saude` e guarda o último retrato em memória.
 * Endereço e senha lidos a cada leitura: ASSISTENTE_RUNNER_URL (padrão: origem de
 * WA_TRANSCRICAO_URL, o mesmo runner) e ASSISTENTE_RUNNER_TOKEN (padrão:
 * WA_TRANSCRICAO_TOKEN só quando a URL também veio do padrão), enviada como
 * `Authorization: Bearer`. Sem os dois, nada roda.
 *
 * Runner recém-subido ainda sem teste do Claude (`claude.ultimo_teste` <= `subiu_em`) diz
 * 'ok' por padrão: essa leitura não encerra queda nem resolve aviso de antes do boot.
 *
 * Avisos à tela /sistema/whatsapp (ref fixa `runner`):
 *  - `assistente.mudo`: 3 leituras seguidas sem resposta, runner que reiniciou 3 vezes
 *    em 30 minutos e não voltou, ou Claude indisponível por cota/API/outro;
 *  - `assistente.precisa_login`: Claude indisponível por login vencido;
 *  - `assistente.voltou`: saiu da queda; leva quantas mensagens guardadas foram
 *    reenviadas (evento `reenvio` do runner depois do início da queda; sem ele em
 *    até 4 leituras, vai com 0).
 * Troca de tipo de queda resolve o aviso anterior e emite o novo; queda nova resolve
 * o `voltou` anterior. A primeira leitura boa depois do boot, sem queda, resolve aviso
 * que tenha ficado de antes do restart.
 *
 * Rotas da tela (permissão da tela de sessões): `ler` devolve o estado guardado sem
 * chamar o runner; `reiniciar` e `resgatar` repassam ao runner com o nome de quem agiu.
 */
const REF = 'runner';
const LINK = '/sistema/whatsapp';
const FALHAS_MUDO = 3;
const LEITURAS_ESPERA_REENVIO = 4;

export interface EventoAssistente {
  id: number;
  quando: string;
  tipo: string;
  origem: string | null;
  motivo: string | null;
  por: string | null;
  achadas: number;
  reenviadas: number;
  vencidas: number;
}

/** Retrato de `GET /assistente/saude` do runner. */
export interface SaudeAssistente {
  estado: 'ok' | 'claude_indisponivel' | 'nao_voltou';
  claude: {
    estado: 'ok' | 'indisponivel';
    motivo: 'login' | 'cota' | 'api' | 'outro' | null;
    desde: string | null;
    detalhe: string | null;
    ultimo_teste: string | null;
  };
  subiu_em: string;
  ultima_resposta_ok: string | null;
  ultima_falha: { quando: string; motivo: string } | null;
  reinicios_24h: number;
  pendentes: { quantidade: number; mais_antiga: string | null };
  vencidas: { quem: string; quando: string; trecho: string }[];
  reenviadas: { quem: string; quando: string; trecho: string }[];
  eventos: EventoAssistente[];
}

type TipoQueda = 'mudo' | 'login';
interface Queda {
  tipo: TipoQueda;
  motivo: string;
  desde: Date;
}

const EVENTO: Record<TipoQueda, string> = { mudo: 'assistente.mudo', login: 'assistente.precisa_login' };
const SEM_RESPOSTA = 'O assistente não responde. O vigia reinicia sozinho em até 90 segundos.';
const semTesteDesdeASubida = (r: SaudeAssistente) =>
  !r.claude?.ultimo_teste || new Date(r.claude.ultimo_teste) <= new Date(r.subiu_em);
const hora = (d: Date) => d.toLocaleString('pt-BR', { timeZone: 'America/Cuiaba' });

export function configRunner(): { url: string; token: string } | null {
  let url = process.env.ASSISTENTE_RUNNER_URL;
  let token = process.env.ASSISTENTE_RUNNER_TOKEN;
  // a senha da transcrição só vale para o runner da transcrição: URL própria exige token próprio
  if (!url && process.env.WA_TRANSCRICAO_URL) {
    try {
      url = new URL(process.env.WA_TRANSCRICAO_URL).origin;
      token ||= process.env.WA_TRANSCRICAO_TOKEN;
    } catch {
      url = undefined;
    }
  }
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

@Injectable()
export class AssistenteService {
  private readonly logger = new Logger(AssistenteService.name);
  private rodando = false;

  retrato: SaudeAssistente | null = null;
  lidoEm: Date | null = null;
  semRespostaDesde: Date | null = null;
  private falhas = 0;
  private queda: Queda | null = null;
  private lidoDepoisDoBoot = false;
  /** Saída da queda esperando o evento `reenvio` do runner para emitir `voltou`. */
  private volta: { foraDe: Date; ate: Date; leituras: number } | null = null;

  constructor(
    private readonly avisos: AvisosService,
    private readonly sessoes: SessoesService,
  ) {}

  /** Estado do monitor para a tela; não chama o runner. */
  async ler(userId?: string) {
    await this.sessoes.exigirTela(userId, 'visualizar');
    if (!configRunner()) {
      return { configurado: false, alcancavel: false, sem_resposta_desde: null, lido_em: null, retrato: null };
    }
    return {
      configurado: true,
      alcancavel: this.semRespostaDesde === null && this.lidoEm !== null,
      sem_resposta_desde: this.semRespostaDesde?.toISOString() ?? null,
      lido_em: this.lidoEm?.toISOString() ?? null,
      retrato: this.retrato,
    };
  }

  reiniciar(userId?: string) {
    return this.acao(userId, 'reiniciar');
  }

  resgatar(userId?: string) {
    return this.acao(userId, 'resgatar');
  }

  /** POST no runner com `{ por }`; sem resposta ou erro dele vira 502. */
  private async acao(userId: string | undefined, rota: 'reiniciar' | 'resgatar') {
    const { nome } = await this.sessoes.exigirTela(userId, 'editar');
    const cfg = configRunner();
    if (!cfg) throw new BadGatewayException(SEM_RESPOSTA);
    try {
      const r = await fetch(`${cfg.url}/assistente/${rota}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ por: nome }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      this.logger.warn(`Assistente: ${rota} falhou: ${(e as Error).message}`);
      throw new BadGatewayException(SEM_RESPOSTA);
    }
    return { ok: true };
  }

  @Cron('*/30 * * * * *', { name: 'assistente-monitor' })
  async monitorar() {
    if (this.rodando) return;
    this.rodando = true;
    try {
      await this.tick();
    } catch (e) {
      this.logger.error(`Ciclo do monitor do assistente falhou: ${(e as Error).message}`);
    } finally {
      this.rodando = false;
    }
  }

  async tick() {
    const cfg = configRunner();
    if (!cfg) return;
    const agora = new Date();

    let retrato: SaudeAssistente;
    try {
      const r = await fetch(`${cfg.url}/assistente/saude`, {
        headers: { Authorization: `Bearer ${cfg.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      retrato = (await r.json()) as SaudeAssistente;
    } catch (e) {
      this.falhas++;
      this.semRespostaDesde ??= agora;
      this.logger.warn(`Assistente sem resposta (${this.falhas}x): ${(e as Error).message}`);
      if (this.falhas >= FALHAS_MUDO) {
        this.entrarEmQueda({ tipo: 'mudo', motivo: 'runner não responde', desde: this.semRespostaDesde });
      }
      return;
    }

    this.falhas = 0;
    this.semRespostaDesde = null;
    this.retrato = retrato;
    this.lidoEm = agora;

    const nova = this.quedaDoRetrato(retrato, agora);
    if (!nova && semTesteDesdeASubida(retrato)) return;
    if (nova) {
      this.entrarEmQueda(nova);
    } else if (this.queda) {
      this.avisos.resolver(EVENTO[this.queda.tipo], REF);
      this.volta = { foraDe: this.queda.desde, ate: agora, leituras: 0 };
      this.queda = null;
    } else if (!this.lidoDepoisDoBoot) {
      this.avisos.resolver(EVENTO.mudo, REF);
      this.avisos.resolver(EVENTO.login, REF);
      this.avisos.resolver('assistente.voltou', REF);
    }
    this.lidoDepoisDoBoot = true;

    if (this.volta) this.avisarVolta(retrato);
  }

  private quedaDoRetrato(r: SaudeAssistente, agora: Date): Queda | null {
    if (r.estado === 'nao_voltou') {
      const ev = r.eventos?.find((e) => e.tipo === 'nao_voltou');
      return {
        tipo: 'mudo',
        motivo: 'reiniciou 3 vezes em 30 minutos e não voltou',
        desde: ev ? new Date(ev.quando) : agora,
      };
    }
    if (r.claude?.estado === 'indisponivel') {
      const desde = r.claude.desde ? new Date(r.claude.desde) : agora;
      if (r.claude.motivo === 'login') return { tipo: 'login', motivo: 'login vencido', desde };
      return { tipo: 'mudo', motivo: `Claude indisponível (${r.claude.motivo ?? 'outro'})`, desde };
    }
    return null;
  }

  private entrarEmQueda(nova: Queda) {
    if (this.queda?.tipo === nova.tipo) return;
    if (this.queda) this.avisos.resolver(EVENTO[this.queda.tipo], REF);
    this.avisos.resolver('assistente.voltou', REF);
    this.volta = null;
    this.queda = nova;
    const guardadas = String(this.retrato?.pendentes?.quantidade ?? 0);
    this.avisos.emitir(EVENTO[nova.tipo], {
      ref: REF,
      vars: { motivo: nova.motivo, desde: hora(nova.desde), guardadas },
      link: LINK,
    });
  }

  private avisarVolta(r: SaudeAssistente) {
    const v = this.volta!;
    v.leituras++;
    // eventos vêm do mais novo para o mais antigo
    const reenvio = r.eventos?.find((e) => e.tipo === 'reenvio' && new Date(e.quando) >= v.foraDe);
    if (!reenvio && v.leituras < LEITURAS_ESPERA_REENVIO) return;
    this.avisos.emitir('assistente.voltou', {
      ref: REF,
      vars: { fora_de: hora(v.foraDe), ate: hora(v.ate), reenviadas: String(reenvio?.reenviadas ?? 0) },
      link: LINK,
    });
    this.volta = null;
  }
}
