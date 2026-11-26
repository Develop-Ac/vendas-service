import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { CarteirizacaoErpRepository } from './carteirizacao.erp.repository';
import { CarteirizacaoService } from './carteirizacao.service';
import { GestaoService } from './gestao.service';
import { SupervisaoService, envNum } from './supervisao.service';
import { ehGestaoVendas } from './papel';
import {
  montarCurvaASemCompra,
  montarEmRisco,
  montarOrcamentosEquipe,
  montarRecuperacao,
  recebeComissao,
  resumoPerdidos,
  totalComissao,
  validarAviso,
} from './gestao-hoje';
import { hojeRetorno } from '../orcamento/orcamento.prisma.repository';
import { analyticsAtacadoGet } from '../common/analytics/analytics-atacado';
import { MssqlService } from '../common/mssql/mssql.service';
import { montarConsulta } from '../paineis/painel-sql';
import { AvisosVendasService } from '../common/avisos/avisos-vendas.service';

type Aviso = { bloco: string; motivo: string };

/**
 * Tela inicial do gestor do atacado (supervisão, gerência, admin/diretoria), sempre do
 * mês comissional corrente e só leitura. Cada bloco é independente
 * (`Promise.allSettled`): o que falhar vem null com o motivo em `avisos`. Nada de
 * custo, markup, margem, lucro nem prêmio: os itens são montados campo a campo nas
 * funções de `gestao-hoje.ts`.
 */
@Injectable()
export class GestaoHojeService {
  private readonly logger = new Logger(GestaoHojeService.name);
  /** Consulta do card 420 (Comissão por mix e faixa), a mesma do painel da supervisão. */
  private readonly sqlComissao: string;

  constructor(
    private readonly repo: CarteirizacaoPrismaRepository,
    private readonly carteirizacao: CarteirizacaoService,
    private readonly gestao: GestaoService,
    private readonly supervisao: SupervisaoService,
    private readonly erp: CarteirizacaoErpRepository,
    private readonly mssql: MssqlService,
    private readonly avisosVendas: AvisosVendasService,
  ) {
    this.sqlComissao = fs.readFileSync(path.join(__dirname, '..', 'paineis', 'sql', 'comissao-por-mix-e-faixa-420.sql'), 'utf8');
  }

  /** Usuário do x-user-id, só se for da gestão de vendas. */
  private async gestor(usuarioId: string | undefined) {
    const u = await this.repo.usuarioVendas(usuarioId);
    if (!u) throw new ForbiddenException('Usuário não identificado: entre de novo na intranet e tente outra vez.');
    if (!ehGestaoVendas(u)) throw new ForbiddenException('Tela só para a supervisão e a gerência do atacado.');
    return u;
  }

  async hoje(usuarioId: string | undefined) {
    const u = await this.gestor(usuarioId);
    const p = this.gestao.validarPeriodo();
    const avisos: Aviso[] = [];

    // Uma leitura dos indicadores (KPIs + carteira que os mediu) serve os três blocos de cliente.
    const indicadores = this.supervisao.indicadoresDoMes(p.ano, p.mes);
    indicadores.catch(() => undefined);
    const fimEf = p.padrao.fim < p.hoje ? p.padrao.fim : p.hoje;

    const blocos = {
      recuperacao: Promise.all([indicadores, this.repo.resgatesAbertos()]).then(([ind, abertos]) =>
        montarRecuperacao({
          abertos,
          clientes: ind.clientes,
          detalhe: ind.kpis.find((k) => k.chave === 'RECUPERACAO_AB_PCT')?.detalhe,
        }),
      ),
      // ponytail: segunda leitura do faturamento do mesmo período (o indicador CURVA_A_COMPRANDO_PCT
      // já leu); o caminho de melhoria é o SupervisaoService devolver o mapa junto dos KPIs.
      curva_a_sem_compra: Promise.all([indicadores, this.erp.faturamentoPorClientePeriodo(p.padrao.inicio, fimEf)]).then(
        ([ind, faturamento]) => montarCurvaASemCompra({ clientes: ind.clientes, faturamento }),
      ),
      em_risco: this.emRisco(indicadores, avisos),
      orcamentos: this.orcamentos(avisos),
      perdidos: this.gestao.motivosPerda(p.hoje.slice(0, 7)).then(resumoPerdidos),
      comissao: recebeComissao(u) ? this.comissao() : Promise.resolve(null),
    };
    const nomes = Object.keys(blocos) as Array<keyof typeof blocos>;
    const lidos = await Promise.allSettled(nomes.map((n) => blocos[n]));
    const valor = <K extends keyof typeof blocos>(n: K) => {
      const r = lidos[nomes.indexOf(n)];
      if (r.status === 'fulfilled') return r.value as Awaited<(typeof blocos)[K]>;
      const motivo = r.reason instanceof Error ? r.reason.message : String(r.reason);
      this.logger.warn(`Tela do gestor: bloco ${n} indisponível: ${motivo}`);
      // A mensagem do driver (host, usuário, tabela) fica só no log.
      avisos.push({ bloco: n, motivo: 'indisponível' });
      return null;
    };

    return {
      recuperacao: valor('recuperacao'),
      curva_a_sem_compra: valor('curva_a_sem_compra'),
      em_risco: valor('em_risco'),
      orcamentos: valor('orcamentos'),
      perdidos: valor('perdidos'),
      comissao: valor('comissao'),
      avisos,
    };
  }

  /**
   * Recado do gestor a um vendedor ativo do atacado, pelo avisos-service (badge e/ou
   * WhatsApp). Nada é gravado aqui além do próprio aviso.
   */
  async avisarVendedor(usuarioId: string | undefined, corpo: unknown) {
    const u = await this.gestor(usuarioId);
    const a = validarAviso(corpo);
    const ativos = await this.carteirizacao.vendedoresAtivosAtacado();
    if (!ativos.has(a.rep_codigo)) throw new BadRequestException('Vendedor fora da equipe ativa do atacado.');
    const usuarios = await this.avisosVendas.usuariosDoRep(a.rep_codigo);
    if (!usuarios.length) throw new ConflictException('Este vendedor não tem usuário na intranet: não há para quem enviar o aviso.');
    this.avisosVendas.avisoDoGestor({
      usuarios,
      gestor: u.nome || u.codigo || u.id,
      texto: a.texto,
      canais: a.canais,
      link: a.link,
      ref: `${a.rep_codigo}:${Date.now()}`,
    });
    return { ok: true };
  }

  /**
   * Escalados da fila mais os fora do ciclo de compra (analytics-atacado-service, mesmo
   * mínimo de 12 meses da fila). Serviço de análise fora: só escalados, com aviso.
   */
  private async emRisco(indicadores: ReturnType<SupervisaoService['indicadoresDoMes']>, avisos: Aviso[]) {
    const minimo = envNum('FILA_CICLO_MINIMO_12M', 50_000);
    const [ind, escaladas, ciclo] = await Promise.all([
      indicadores,
      this.repo.tarefasEscaladas(),
      analyticsAtacadoGet<{ cli: number; dias_sem_compra: number; intervalo_dias: number }[]>(`/alertas/ciclo-atrasado?minimo=${minimo}`),
    ]);
    if (ciclo == null) avisos.push({ bloco: 'em_risco.ciclo', motivo: 'indisponível' });
    return montarEmRisco({ clientes: ind.clientes, ciclo, escaladas });
  }

  /**
   * Comissão da equipe no período comissional vigente: mesmo filtro (equipe do atacado,
   * todos os canais) que o painel da supervisão manda para o card 420.
   */
  private async comissao() {
    const { vendedores, data_inicio, data_fim } = await this.carteirizacao.painelSupervisao();
    // Lista vazia viraria `1 = 1` na consulta: a comissão da empresa toda.
    if (!vendedores.length) throw new Error('equipe do atacado vazia no período');
    const { texto, params } = montarConsulta(this.sqlComissao, { de: data_inicio, ate: data_fim, vendedores, canais: [] });
    const { colunas, linhas } = await this.mssql.queryLinhas(texto, params);
    const atual = totalComissao(colunas, linhas);
    return atual == null ? null : { atual };
  }

  /**
   * Orçamentos da equipe ativa do atacado para retornar (o de quem saiu da equipe fica
   * de fora, como no sem desfecho). ERP fora: segue só com os da intranet, com aviso.
   */
  private async orcamentos(avisos: Aviso[]) {
    const hoje = hojeRetorno();
    const [todos, ativos, sem] = await Promise.all([
      this.repo.orcamentosParaRetornar(null, hoje),
      this.carteirizacao.vendedoresAtivosAtacado(),
      this.carteirizacao.orcamentosSemDesfecho({}).catch((e) => {
        const motivo = e instanceof Error ? e.message : String(e);
        this.logger.warn(`Tela do gestor: orçamentos sem desfecho indisponíveis: ${motivo}`);
        avisos.push({ bloco: 'orcamentos.sem_desfecho', motivo: 'indisponível' });
        return null;
      }),
    ]);
    const intranet = todos.filter((o) => o.rep_codigo != null && ativos.has(o.rep_codigo));
    return montarOrcamentosEquipe({ intranet, semDesfecho: sem?.itens ?? [], hoje });
  }
}
