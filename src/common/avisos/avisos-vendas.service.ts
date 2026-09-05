import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AvisosService } from './avisos.module';

/**
 * Emissores do VENDAS (catálogo em src/avisos.catalogo.ts).
 *
 * O alvo é sempre o VENDEDOR dono da carteira: `sis_usuarios.vendas_rep_codigo`
 * liga o representante do ERP ao usuário da intranet (cache de 10 min). Sem
 * usuário ligado ao rep, o aviso não é emitido — não existe "vendedor sem
 * login" para notificar. Tudo fire-and-forget: nada aqui pode travar a fila,
 * o resgate ou a carga diária.
 */
const brl = (v: unknown) => `R$ ${Number(v ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ymdHoje = () => new Date(Date.now() - 4 * 3_600_000).toISOString().slice(0, 10); // Cuiabá UTC-4

@Injectable()
export class AvisosVendasService {
  private readonly logger = new Logger(AvisosVendasService.name);
  private readonly cache = new Map<number, { ids: string[]; em: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly avisos: AvisosService,
  ) {}

  async usuariosDoRep(rep: number | null | undefined): Promise<string[]> {
    if (rep == null) return [];
    const c = this.cache.get(rep);
    if (c && Date.now() - c.em < 600_000) return c.ids;
    let ids: string[] = [];
    try {
      const rows = await this.prisma.sis_usuarios.findMany({ where: { vendas_rep_codigo: rep, trash: 0 }, select: { id: true } });
      ids = rows.map((r) => r.id);
    } catch (e) {
      this.logger.warn(`usuários do rep ${rep}: ${(e as Error).message}`);
    }
    this.cache.set(rep, { ids, em: Date.now() });
    return ids;
  }

  /** Fila do dia gerada para o vendedor (uma vez por dia por rep — ref = rep:data). */
  async filaDia(rep: number, resumo: { total: number; resgates: number; escaladas: number }) {
    const usuarios = await this.usuariosDoRep(rep);
    if (!usuarios.length || !resumo.total) return;
    this.avisos.emitir('fila.dia', { ref: `${rep}:${ymdHoje()}`, vars: resumo, usuarios });
  }

  /** Tarefa passou do prazo e virou ESCALADA. */
  async filaEscalada(t: { id: string; cli_codigo: number; cli_nome: string | null; rep_codigo: number | null; motivo_geracao: string | null; gerada_em: Date | string }) {
    const usuarios = await this.usuariosDoRep(t.rep_codigo);
    if (!usuarios.length) return;
    const dias = Math.max(1, Math.floor((Date.now() - new Date(t.gerada_em).getTime()) / 86_400_000));
    this.avisos.emitir('fila.escalada', {
      ref: t.id,
      vars: { cliente: t.cli_nome ?? `Cliente ${t.cli_codigo}`, cli: t.cli_codigo, dias, motivo: t.motivo_geracao ?? '' },
      usuarios,
    });
  }

  /** Curva A em risco sem contato dentro do SLA. */
  async resgateSla(cli: { cli_codigo: number; cli_nome: string | null; rep_codigo: number | null }, resgateId: string, horasAtraso: number, slaHoras: number) {
    const usuarios = await this.usuariosDoRep(cli.rep_codigo);
    if (!usuarios.length) return;
    this.avisos.emitir('resgate.sla', {
      ref: resgateId,
      vars: { cliente: cli.cli_nome ?? `Cliente ${cli.cli_codigo}`, cli: cli.cli_codigo, horas: slaHoras + Math.max(0, horasAtraso), sla: slaHoras },
      usuarios,
    });
  }

  /** Orçamento enviado vence amanhã sem venda nem desfecho. */
  async orcamentoVencendo(o: { id: string; numero: number; cli_codigo: number; cli_nome: string | null; rep_codigo: number | null; usuario_id: string | null; total: unknown }) {
    const usuarios = o.usuario_id ? [o.usuario_id] : await this.usuariosDoRep(o.rep_codigo);
    if (!usuarios.length) return;
    this.avisos.emitir('orcamento.vencendo', {
      ref: o.id,
      vars: { numero: String(o.numero).padStart(6, '0'), cliente: o.cli_nome ?? `Cliente ${o.cli_codigo}`, total: brl(o.total), cli: o.cli_codigo, id: o.id },
      usuarios,
    });
  }
}
