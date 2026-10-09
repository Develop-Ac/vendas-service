import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { CarteirizacaoService, ClienteCarteira, REP_DISPONIVEL } from './carteirizacao.service';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { CarteirizacaoCeltaClient } from './carteirizacao.celta.client';
import { ehGestaoVendas } from './papel';
import { ConfirmarCarteirizacaoDto, TransferirCarteiraDto, TrocarVendedorDto } from './dto/carteirizacao.dto';

/** Observação gravada no histórico de quem sai do pool pela tela "Para carteirizar". */
export const MOTIVO_RECUPERADO = 'Cliente recuperado pelo vendedor';

const DIA_MS = 86_400_000;
const LOTE_PARALELO = 4;

const envNum = (nome: string, padrao: number): number => {
  const n = Number(process.env[nome]);
  return Number.isFinite(n) && n > 0 ? n : padrao;
};

export interface ResultadoTroca {
  ok: boolean;
  lote_id: string;
  rep_codigo: number;
  rep_nome: string | null;
  trocados: number[];
  falhas: Array<{ cli_codigo: number; erro: string }>;
}

/**
 * Troca de vendedor da carteira, feita pela supervisão/gerência na tela de
 * Carteirização. O ERP continua sendo a fonte da verdade: cada cliente é
 * gravado PRIMEIRO no Celta (api-vendas), e só o que o Celta aceitou é
 * espelhado aqui — assim a sincronização diária encontra o mesmo vendedor e
 * não desfaz nada. Na mesma hora, a fila e o resgate passam a seguir o novo
 * dono (sem esperar a carga das 5h):
 *  - tarefas abertas do vendedor antigo são canceladas;
 *  - o resgate em andamento troca de dono e, se ainda não houve contato, ganha
 *    prazo de SLA novo (curva A);
 *  - o novo vendedor recebe a tarefa de contato "cliente novo na carteira".
 * Em lote, cada cliente é independente: o que falhar volta na lista e o resto segue.
 */
@Injectable()
export class TrocaVendedorService {
  private readonly logger = new Logger(TrocaVendedorService.name);

  constructor(
    private readonly carteirizacao: CarteirizacaoService,
    private readonly repo: CarteirizacaoPrismaRepository,
    private readonly celta: CarteirizacaoCeltaClient,
  ) {}

  private get empresa(): number {
    return envNum('CARTEIRA_EMPRESA', 3);
  }

  private get prazoContatoDias(): number {
    return envNum('FILA_PRAZO_CONTATO_DIAS', 3);
  }

  private get prazoResgateHoras(): number {
    return envNum('FILA_PRAZO_RESGATE_HORAS', 48);
  }

  /** Troca de 1..N clientes para um vendedor. */
  async trocar(dto: TrocarVendedorDto): Promise<ResultadoTroca> {
    const clis = [...new Set((dto?.cli_codigos ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!clis.length) throw new BadRequestException('Informe ao menos um cliente.');
    return this.executar(clis, dto, clis.length > 1 ? 'LOTE' : 'ALTERACAO');
  }

  /** Toda a carteira de um vendedor para outro (ex.: vendedor saiu). */
  async transferir(dto: TransferirCarteiraDto): Promise<ResultadoTroca> {
    const origem = Number(dto?.rep_origem);
    if (!Number.isInteger(origem)) throw new BadRequestException('Informe o vendedor de origem.');
    if (origem === Number(dto.rep_codigo)) throw new BadRequestException('Origem e destino são o mesmo vendedor.');
    const carteira = await this.repo.listarCarteira();
    const clis = carteira.filter((c) => c.rep_codigo === origem).map((c) => c.cli_codigo);
    if (!clis.length) throw new BadRequestException('O vendedor de origem não tem clientes na carteira.');
    return this.executar(clis, dto, 'TRANSFERENCIA');
  }

  /**
   * "Para carteirizar": cliente do pool que voltou a comprar vai para o vendedor
   * que vendeu. O vendedor de cada um é o SUGERIDO recalculado aqui (ativo no
   * cadastro, venda mais recente depois de entrar no pool) — a tela só diz
   * quais clientes. Sem tarefa de contato: o vendedor acabou de vender.
   */
  async confirmarCarteirizacao(dto: ConfirmarCarteirizacaoDto): Promise<ResultadoTroca[]> {
    const pedidos = new Set((dto?.cli_codigos ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0));
    if (!pedidos.size) throw new BadRequestException('Informe ao menos um cliente.');
    const { itens } = await this.carteirizacao.clientesParaCarteirizar();
    const porRep = new Map<number, number[]>();
    const fora: ResultadoTroca['falhas'] = [];
    for (const cli of pedidos) {
      const item = itens.find((i) => i.cli_codigo === cli);
      if (!item) {
        fora.push({ cli_codigo: cli, erro: 'Não está mais na lista para carteirizar (já saiu do pool ou o vendedor ficou inativo).' });
        continue;
      }
      porRep.set(item.rep_sugerido_codigo, [...(porRep.get(item.rep_sugerido_codigo) ?? []), cli]);
    }
    const resultados: ResultadoTroca[] = [];
    for (const [rep, clis] of porRep) {
      resultados.push(
        await this.executar(clis, { cli_codigos: clis, rep_codigo: rep, motivo: MOTIVO_RECUPERADO, usuario_id: dto.usuario_id, usuario_nome: dto.usuario_nome }, 'RECUPERACAO'),
      );
    }
    if (fora.length) {
      if (resultados[0]) resultados[0].falhas.push(...fora);
      else resultados.push({ ok: false, lote_id: '', rep_codigo: 0, rep_nome: null, trocados: [], falhas: fora });
      resultados[0].ok = false;
    }
    return resultados;
  }

  private async executar(
    clis: number[],
    dto: TrocarVendedorDto,
    acao: 'ALTERACAO' | 'LOTE' | 'TRANSFERENCIA' | 'RECUPERACAO',
  ): Promise<ResultadoTroca> {
    const rep = Number(dto.rep_codigo);
    if (!Number.isInteger(rep) || rep <= 0) throw new BadRequestException('Informe o vendedor de destino.');
    const motivo = (dto.motivo ?? '').trim();
    if (motivo.length < 3) throw new BadRequestException('O motivo da troca é obrigatório.');

    const u = await this.repo.usuarioVendas(dto.usuario_id);
    if (!u) throw new ForbiddenException('Usuário não identificado: entre de novo na intranet e tente outra vez.');
    if (!ehGestaoVendas(u)) throw new ForbiddenException('Só a supervisão e a gerência trocam o vendedor da carteira.');

    const rep_nome = await this.carteirizacao.resolverNomeRep(rep);
    const snapshot = await this.carteirizacao.snapshotCarteira().catch(() => [] as ClienteCarteira[]);
    const porCli = new Map(snapshot.map((c) => [c.cli_codigo, c]));
    const lote_id = `troca_${Date.now()}`;
    const origem = acao === 'ALTERACAO' ? 'MANUAL' : acao;

    const trocados: number[] = [];
    const falhas: ResultadoTroca['falhas'] = [];
    const trocarUm = async (cli: number) => {
      const atual = await this.repo.obterCliente(cli);
      if (atual && atual.trash === 0 && atual.rep_codigo === rep) {
        falhas.push({ cli_codigo: cli, erro: 'Já está na carteira deste vendedor.' });
        return;
      }
      // 1) ERP primeiro: se o Celta recusar, nada muda aqui.
      try {
        await this.celta.trocarRepresentante(this.empresa, cli, rep);
      } catch (e) {
        falhas.push({ cli_codigo: cli, erro: (e as Error).message });
        return;
      }

      // 2) Espelho + histórico. O Celta já gravou: se isto falhar, a carga diária
      // corrige o espelho — a mensagem diz isso para ninguém repetir às cegas.
      const tinhaRep = !!atual && atual.trash === 0 && atual.rep_codigo != null;
      try {
        await this.repo.upsertAtribuicao({ cli_codigo: cli, rep_codigo: rep, rep_nome, origem, atribuido_por: u.id });
        await this.repo.registrarHistorico({
          cli_codigo: cli,
          rep_codigo_anterior: tinhaRep ? atual!.rep_codigo : null,
          rep_nome_anterior: tinhaRep ? atual!.rep_nome : null,
          rep_codigo_novo: rep,
          rep_nome_novo: rep_nome,
          acao: tinhaRep ? acao : 'ATRIBUICAO',
          motivo,
          usuario_id: u.id,
          usuario_nome: dto.usuario_nome ?? u.nome,
          lote_id: clis.length > 1 ? lote_id : null,
        });
      } catch (e) {
        falhas.push({
          cli_codigo: cli,
          erro: `Gravado no Celta, mas o espelho da intranet falhou (a carga diária corrige; não repita): ${(e as Error).message}`,
        });
        return;
      }
      trocados.push(cli);

      // 3) Fila e resgate seguem o novo dono. Falha aqui não desfaz a troca já
      // gravada no ERP: a carga diária reconcilia o que sobrar.
      try {
        await this.seguirNovoDono(cli, rep, rep_nome, porCli.get(cli), motivo, acao !== 'RECUPERACAO');
      } catch (e) {
        this.logger.warn(`Troca do cliente ${cli} gravada, mas fila/resgate não acompanharam: ${(e as Error).message}`);
      }
    };

    // Poucos em paralelo: transferir a carteira inteira (100+ clientes) não pode
    // estourar o tempo da requisição, nem martelar o Celta.
    const fila = [...clis];
    await Promise.all(
      Array.from({ length: Math.min(LOTE_PARALELO, fila.length) }, async () => {
        for (let cli = fila.shift(); cli != null; cli = fila.shift()) await trocarUm(cli);
      }),
    );

    this.logger.log(`Troca de vendedor (${acao}) para ${rep}: ${trocados.length} trocados, ${falhas.length} falhas.`);
    return { ok: falhas.length === 0, lote_id, rep_codigo: rep, rep_nome, trocados, falhas };
  }

  private async seguirNovoDono(
    cli: number,
    rep: number,
    rep_nome: string | null,
    snap: ClienteCarteira | undefined,
    motivo: string,
    gerarTarefa = true,
  ) {
    const agora = Date.now();
    for (const t of await this.repo.tarefasEmAndamentoDoCliente(cli)) {
      await this.repo.cancelarTarefa(t.id, `Carteira trocou de vendedor (${t.rep_nome ?? t.rep_codigo} → ${rep_nome ?? rep}): ${motivo}`);
    }

    const resgate = await this.repo.resgateAbertoDoCliente(cli);
    if (resgate) {
      const semContato = !resgate.contatado_em;
      await this.repo.atualizarResgate(resgate.id, {
        rep_codigo: rep,
        rep_nome,
        // Prazo novo só se ninguém falou com o cliente ainda: o SLA passa a ser do novo dono.
        ...(semContato && resgate.curva === 'A'
          ? { sla_em: new Date(agora + this.prazoResgateHoras * 3_600_000), sla_cumprido: null }
          : {}),
      });
    }

    // O pool não trabalha cliente: nada de tarefa para ele. Nem para quem
    // recuperou o cliente vendendo — o contato já aconteceu.
    if (rep === REP_DISPONIVEL || !gerarTarefa) return;
    await this.repo.criarTarefas([
      {
        tipo: resgate ? 'RESGATE' : 'CONTATO',
        cli_codigo: cli,
        cli_nome: snap?.cli_nome ?? null,
        rep_codigo: rep,
        rep_nome,
        curva: snap?.curva_abc ?? resgate?.curva ?? null,
        motivo_geracao: `Cliente novo na sua carteira (${motivo})`,
        prazo_em: new Date(
          agora +
            (resgate && resgate.curva === 'A' ? this.prazoResgateHoras * 3_600_000 : this.prazoContatoDias * DIA_MS),
        ),
      },
    ]);
  }
}
