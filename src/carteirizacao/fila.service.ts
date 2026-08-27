import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CarteirizacaoService, ClienteCarteira } from './carteirizacao.service';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { DesfechoOrcamentoDto } from './dto/carteirizacao.dto';

/**
 * Fila do dia do CRM do Atacado (fase 1) — o princípio inegociável é ESFORÇO DO
 * VENDEDOR ZERO: a fila se gera sozinha pela régua por curva e a tarefa fecha
 * sozinha quando o sinal observado aparece (orçamento novo ou venda do cliente
 * depois da geração). Ninguém marca checkbox; prazo estourado sem sinal vira
 * ESCALADA e fica visível ao supervisor.
 *
 * A régua (dias sem contato por curva ABC) e os prazos são configuráveis por
 * env — a calibração com o supervisor muda configuração, não código:
 *   FILA_REGUA_A / FILA_REGUA_B / FILA_REGUA_C   (padrão 15 / 30 / 60 dias)
 *   FILA_PRAZO_CONTATO_DIAS                       (padrão 3 dias)
 *   FILA_PRAZO_RESGATE_HORAS                      (padrão 48h — resgate curva A)
 *
 * "Contato" hoje = compra ou orçamento (os dois sinais que o ERP enxerga).
 * Quando o sensor WhatsApp entrar (piloto WAHA), a mensagem enviada vira o
 * terceiro sinal — mesmo mecanismo, mais um comparando.
 */

export const MOTIVOS_DESFECHO = [
  'PRECO',
  'PRAZO_FRETE',
  'SEM_ESTOQUE',
  'CONCORRENTE',
  'CLIENTE_ADIOU',
  'CREDITO_BLOQUEADO',
] as const;
export type MotivoDesfecho = (typeof MOTIVOS_DESFECHO)[number];

const envNum = (nome: string, padrao: number): number => {
  const n = Number(process.env[nome]);
  return Number.isFinite(n) && n > 0 ? n : padrao;
};

const DIA_MS = 86_400_000;

@Injectable()
export class FilaService {
  private readonly logger = new Logger(FilaService.name);

  constructor(
    private readonly carteirizacao: CarteirizacaoService,
    private readonly repo: CarteirizacaoPrismaRepository,
  ) {}

  private get regua(): Record<'A' | 'B' | 'C', number> {
    return {
      A: envNum('FILA_REGUA_A', 15),
      B: envNum('FILA_REGUA_B', 30),
      C: envNum('FILA_REGUA_C', 60),
    };
  }

  private get prazoContatoDias(): number {
    return envNum('FILA_PRAZO_CONTATO_DIAS', 3);
  }

  private get prazoResgateHoras(): number {
    return envNum('FILA_PRAZO_RESGATE_HORAS', 48);
  }

  // ------------------------------------------------------------------ gerar
  /**
   * Geração pela régua. Roda depois da carga diária (scheduler) e no botão da
   * tela; é idempotente — cliente que já tem tarefa em andamento não entra de
   * novo. Também é aqui que tarefa órfã (cliente saiu da carteira ou trocou de
   * vendedor) é cancelada, para a fila nunca cobrar a pessoa errada.
   */
  async gerar() {
    const clientes = await this.carteirizacao.snapshotCarteira();

    // Sem a leitura de orçamentos a régua não sabe quem já foi trabalhado e
    // geraria tarefa para quem orçou ontem. Melhor falhar claro que gerar errado.
    if (!clientes.some((c) => c.quadrante != null)) {
      throw new ServiceUnavailableException(
        'A geração da fila precisa da leitura de orçamentos (erp-firebird-api). ' +
          'Sem ela, a régua cobraria contato de cliente que acabou de ser orçado.',
      );
    }

    const mapa = new Map(clientes.map((c) => [c.cli_codigo, c]));
    const [emAndamento, msgEnviada] = await Promise.all([
      this.repo.tarefasEmAndamento(),
      // Terceiro sinal (sensor WAHA): mensagem enviada também é contato — sem o
      // piloto no ar o mapa vem vazio e a régua segue só com compra/orçamento.
      this.repo.ultimaMensagemEnviadaPorCliente(),
    ]);

    // 1) Cancela tarefas órfãs (a fila segue a carteira, que é do ERP).
    let canceladas = 0;
    const clientesComTarefa = new Set<number>();
    for (const t of emAndamento) {
      const cli = mapa.get(t.cli_codigo);
      if (!cli || !cli.em_carteira || cli.status === 'DISPONIVEL') {
        await this.repo.cancelarTarefa(t.id, 'Cliente saiu da carteira do atacado');
        canceladas++;
        continue;
      }
      if (cli.rep_codigo !== t.rep_codigo) {
        await this.repo.cancelarTarefa(
          t.id,
          `Carteira trocou de vendedor (${t.rep_nome ?? t.rep_codigo} → ${cli.rep_nome ?? cli.rep_codigo})`,
        );
        canceladas++;
        continue;
      }
      clientesComTarefa.add(t.cli_codigo);
    }

    // 2) Gera pela régua.
    const agora = Date.now();
    const regua = this.regua;
    const novas: Parameters<CarteirizacaoPrismaRepository['criarTarefas']>[0] = [];
    for (const cli of clientes) {
      if (!cli.em_carteira || cli.rep_codigo == null) continue;
      if (cli.status === 'DISPONIVEL' || cli.revisao) continue;
      if (clientesComTarefa.has(cli.cli_codigo)) continue;

      const diasCompra = cli.dias_sem_compra ?? Infinity;
      const diasOrc = cli.dias_sem_orcamento ?? Infinity;
      const ultimaMsg = msgEnviada.get(cli.cli_codigo);
      const diasMsg = ultimaMsg
        ? Math.floor((agora - ultimaMsg.getTime()) / DIA_MS)
        : Infinity;
      const diasSemContato = Math.min(diasCompra, diasOrc, diasMsg);
      const limite = regua[cli.curva_abc];

      // Resgate: curva A entrando na zona de inativação — prioridade com prazo curto.
      if (cli.risco_inativacao && cli.curva_abc === 'A') {
        novas.push({
          tipo: 'RESGATE',
          cli_codigo: cli.cli_codigo,
          cli_nome: cli.cli_nome,
          rep_codigo: cli.rep_codigo,
          rep_nome: cli.rep_nome,
          curva: cli.curva_abc,
          motivo_geracao: `Curva A a ${diasCompra}d sem compra — janela de resgate de ${this.prazoResgateHoras}h antes de inativar`,
          prazo_em: new Date(agora + this.prazoResgateHoras * 3_600_000),
        });
        continue;
      }

      if (diasSemContato > limite) {
        const semCompra = diasCompra === Infinity ? 'nunca comprou' : `${diasCompra}d sem compra`;
        const semOrc = diasOrc === Infinity ? 'nunca orçado' : `${diasOrc}d sem orçamento`;
        novas.push({
          tipo: 'CONTATO',
          cli_codigo: cli.cli_codigo,
          cli_nome: cli.cli_nome,
          rep_codigo: cli.rep_codigo,
          rep_nome: cli.rep_nome,
          curva: cli.curva_abc,
          motivo_geracao: `Curva ${cli.curva_abc}: ${semCompra}, ${semOrc} (régua ${limite}d)`,
          prazo_em: new Date(agora + this.prazoContatoDias * DIA_MS),
        });
      }
    }

    await this.repo.criarTarefas(novas);
    const resumo = {
      geradas: novas.length,
      resgates: novas.filter((n) => n.tipo === 'RESGATE').length,
      canceladas,
      ja_em_andamento: clientesComTarefa.size,
      regua,
    };
    this.logger.log(
      `Fila gerada: ${resumo.geradas} novas (${resumo.resgates} resgates), ` +
        `${resumo.canceladas} canceladas, ${resumo.ja_em_andamento} já em andamento.`,
    );
    return resumo;
  }

  // ------------------------------------------------------------ reconciliar
  /**
   * Auto-conclusão + escalonamento — roda em toda leitura da fila, então o
   * estado que a tela mostra é sempre o constatado agora:
   *  - sinal depois da geração (venda ou orçamento do cliente) -> CONCLUIDA,
   *    com `concluida_em` = a data do próprio sinal;
   *  - prazo estourado sem sinal -> ESCALADA (vira pauta do supervisor).
   */
  private async reconciliar(clientes: ClienteCarteira[]) {
    const mapa = new Map(clientes.map((c) => [c.cli_codigo, c]));
    const [emAndamento, msgEnviada] = await Promise.all([
      this.repo.tarefasEmAndamento(),
      this.repo.ultimaMensagemEnviadaPorCliente(),
    ]);
    const agora = new Date();

    for (const t of emAndamento) {
      const cli = mapa.get(t.cli_codigo);
      if (cli) {
        const gerada = new Date(t.gerada_em).getTime();
        const depois = (d: Date | null | undefined) =>
          d && new Date(d).getTime() > gerada ? new Date(d) : null;
        const compra = depois(cli.data_ult_compra);
        const orc = depois(cli.ult_orcamento);
        const msg = depois(msgEnviada.get(t.cli_codigo));
        if (compra || orc || msg) {
          // No rótulo, o sinal mais forte vence: venda (resultado) > orçamento
          // (proposta) > mensagem (contato, via sensor WAHA).
          const sinal = compra ? 'VENDA' : orc ? 'ORCAMENTO' : 'MENSAGEM';
          await this.repo.concluirTarefa(t.id, sinal, compra ?? orc ?? msg!);
          continue;
        }
      }
      if (t.status === 'ABERTA' && new Date(t.prazo_em) < agora) {
        await this.repo.escalarTarefa(t.id);
      }
    }
  }

  // ------------------------------------------------------------------ listar
  /** A fila do dia de um vendedor (ou de todos, no gerencial). */
  async listar(params: { rep_codigo?: number }) {
    const clientes = await this.carteirizacao.snapshotCarteira();
    await this.reconciliar(clientes);

    const hoje0h = new Date();
    hoje0h.setHours(0, 0, 0, 0);
    const [tarefas, concluidasHoje] = await Promise.all([
      this.repo.tarefasEmAndamento(params.rep_codigo),
      this.repo.tarefasConcluidasDesde(hoje0h, params.rep_codigo),
    ]);

    const mapa = new Map(clientes.map((c) => [c.cli_codigo, c]));
    const enriquecer = (t: (typeof tarefas)[number]) => {
      const cli = mapa.get(t.cli_codigo);
      return {
        id: t.id,
        tipo: t.tipo,
        status: t.status,
        cli_codigo: t.cli_codigo,
        cli_nome: cli?.cli_nome ?? t.cli_nome,
        rep_codigo: t.rep_codigo,
        rep_nome: t.rep_nome,
        curva: t.curva,
        motivo_geracao: t.motivo_geracao,
        gerada_em: t.gerada_em,
        prazo_em: t.prazo_em,
        escalada_em: t.escalada_em,
        concluida_em: t.concluida_em,
        conclusao_sinal: t.conclusao_sinal,
        // contexto do cliente para agir sem trocar de tela
        fone: cli?.fone ?? null,
        cidade: cli?.cidade ?? null,
        uf: cli?.uf ?? null,
        dias_sem_compra: cli?.dias_sem_compra ?? null,
        dias_sem_orcamento: cli?.dias_sem_orcamento ?? null,
        faturamento_3m: cli?.faturamento_3m ?? 0,
        faturamento_total: cli?.faturamento_total ?? 0,
        valor_orcado_90d: cli?.valor_orcado_90d ?? 0,
        score: cli?.score ?? null,
        quadrante: cli?.quadrante ?? null,
        crediario_bloqueado: cli != null && cli.crediario != null && !cli.crediario_liberado,
      };
    };

    // Escaladas primeiro (pauta do supervisor), depois pelo prazo mais apertado.
    const itens = tarefas.map(enriquecer).sort((a, b) => {
      if (a.status !== b.status) return a.status === 'ESCALADA' ? -1 : 1;
      return new Date(a.prazo_em).getTime() - new Date(b.prazo_em).getTime();
    });

    return {
      resumo: {
        abertas: itens.filter((t) => t.status === 'ABERTA').length,
        escaladas: itens.filter((t) => t.status === 'ESCALADA').length,
        resgates: itens.filter((t) => t.tipo === 'RESGATE').length,
        concluidas_hoje: concluidasHoje.length,
        regua: this.regua,
        prazo_contato_dias: this.prazoContatoDias,
        prazo_resgate_horas: this.prazoResgateHoras,
      },
      itens,
      concluidas_hoje: concluidasHoje.map(enriquecer),
    };
  }

  // ------------------------------------------------------ desfecho (motivo)
  /**
   * A única digitação nova do vendedor em toda a fase 1: o motivo do orçamento
   * que não fechou (1 toque, 6 opções). Upsert — remarcar corrige o motivo.
   */
  async registrarDesfecho(orcamento: number, dto: DesfechoOrcamentoDto) {
    if (!MOTIVOS_DESFECHO.includes(dto.motivo as MotivoDesfecho)) {
      throw new BadRequestException(
        `Motivo inválido. Use um de: ${MOTIVOS_DESFECHO.join(', ')}.`,
      );
    }
    if (dto.cli_codigo == null) {
      throw new BadRequestException('cli_codigo é obrigatório.');
    }
    const salvo = await this.repo.upsertDesfecho({
      orcamento,
      emissao: dto.emissao ? new Date(dto.emissao) : null,
      cli_codigo: Number(dto.cli_codigo),
      cli_nome: dto.cli_nome ?? null,
      rep_codigo: dto.rep_codigo ?? null,
      rep_nome: dto.rep_nome ?? null,
      total: dto.total ?? 0,
      motivo: dto.motivo,
      observacao: dto.observacao ?? null,
      usuario_id: dto.usuario_id ?? null,
      usuario_nome: dto.usuario_nome ?? null,
    });
    return { ok: true, orcamento, motivo: salvo.motivo };
  }
}
