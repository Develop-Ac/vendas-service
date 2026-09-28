import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrcamentoService } from './orcamento.service';
import { OrcamentoBiRepository } from './orcamento.bi.repository';
import { OrcamentoPrismaRepository } from './orcamento.prisma.repository';
import { AvisosVendasService } from '../common/avisos/avisos-vendas.service';
import { analyticsAtacadoGet } from '../common/analytics/analytics-atacado';
import { chaveItem, ClienteDevido, CONFIG_PADRAO, ConfigProdutosDia, montarProdutosDia } from './produtos-dia';

/**
 * PRODUTOS DO DIA — a lista que o supervisor do atacado recebe toda manhã
 * (regras em produtos-dia.ts). Aqui só a orquestração:
 *
 *  1. apurar: cada lista anterior sem apuração recebe a venda do atacado do
 *     seu dia (BI); sábado é apurado na segunda, o próximo dia com cron;
 *  2. gerar: lotes abertos → giro/ponto de pedido (análise de estoque) →
 *     giro do atacado e clientes devidos (analytics, OPCIONAL: fora do ar
 *     a lista sai só por giro e bolsa) → grava o dia inteiro;
 *  3. avisar: sino e mural para supervisão e gerência, só com item na lista.
 *
 * Falha numa etapa não impede as outras. Regenerar pela tela refaz o dia.
 */
const ymdCuiaba = (d = new Date()) => new Date(d.getTime() - 4 * 3_600_000).toISOString().slice(0, 10);
const somarDias = (ymd: string, n: number) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const envNum = (nome: string, padrao: number) => {
  const v = Number(process.env[nome]);
  return Number.isFinite(v) && v > 0 ? v : padrao;
};

@Injectable()
export class ProdutosDiaService {
  private readonly logger = new Logger(ProdutosDiaService.name);

  constructor(
    private readonly orcamento: OrcamentoService,
    private readonly db: OrcamentoPrismaRepository,
    private readonly bi: OrcamentoBiRepository,
    private readonly avisosVendas: AvisosVendasService,
  ) {}

  private config(): ConfigProdutosDia {
    return { ...CONFIG_PADRAO, coberturaDias: envNum('PRODUTOS_DIA_COBERTURA_DIAS', CONFIG_PADRAO.coberturaDias) };
  }

  @Cron(process.env.PRODUTOS_DIA_CRON ?? '0 7 * * 1-6', { name: 'produtos-dia', timeZone: 'America/Cuiaba' })
  async diario() {
    const hoje = ymdCuiaba();
    try {
      await this.apurar(hoje);
    } catch (e) {
      this.logger.error(`Apuração dos produtos do dia falhou: ${(e as Error).message}`);
    }
    try {
      const r = await this.gerar(hoje, null);
      this.logger.log(`Produtos do dia ${hoje}: ${r.itens.length} item(ns), ${r.fora.length} de fora por estoque.`);
    } catch (e) {
      this.logger.error(`Geração dos produtos do dia falhou: ${(e as Error).message}`);
    }
  }

  /** Grava a venda do atacado de cada item das listas anteriores a `antesDe` ainda sem apuração. */
  async apurar(antesDe: string) {
    const pendentes = await this.db.produtosDiaSemApuracao(antesDe);
    if (!pendentes.length) return 0;
    const porDia = new Map<string, typeof pendentes>();
    for (const p of pendentes) porDia.set(p.data, [...(porDia.get(p.data) ?? []), p]);
    const rows: Array<{ id: number; vendida_qtd: number; vendida_valor: number }> = [];
    for (const [dia, itens] of porDia) {
      const venda = await this.bi.vendaAtacadoNoDia(itens.map((i) => i.pro_codigo), dia.replace(/-/g, ''));
      for (const i of itens) {
        const v = venda.get(i.pro_codigo) ?? { qtd: 0, valor: 0 };
        rows.push({ id: i.id, vendida_qtd: v.qtd, vendida_valor: v.valor });
      }
    }
    await this.db.apurarProdutosDia(rows);
    return rows.length;
  }

  /** Monta e grava a lista de `data`; `geradoPor` = usuário do botão (null = cron). Avisa se houver item. */
  async gerar(data: string, geradoPor: string | null) {
    const cfg = this.config();
    const lotes = (await this.orcamento.listarOportunidades()).filter((l) => !l.encerrado_em && l.restante > 0);
    const codigos = lotes.map((l) => l.pro_codigo);
    const giro = await this.db.giro(codigos);
    const chaves = [...new Set(codigos.map((c) => chaveItem(c, giro.get(c)?.grupo_chave)))];

    const de = somarDias(data, -envNum('PRODUTOS_DIA_JANELA_ATRAS', 30));
    const ate = somarDias(data, envNum('PRODUTOS_DIA_JANELA_FRENTE', 3));
    const [devidosRaw, perfis, vendedores] = await Promise.all([
      chaves.length ? analyticsAtacadoGet<Record<string, ClienteDevido[]>>(`/itens/devidos?de=${de}&ate=${ate}&chaves=${encodeURIComponent(chaves.join(','))}`) : null,
      Promise.all(codigos.map((c) => analyticsAtacadoGet<{ vendas?: { qtd_12m?: number } }>(`/produtos/${c}/perfil`).then((p) => [c, p] as const))),
      this.orcamento.vendedores().catch(() => [] as Array<{ rep_codigo: number; rep_nome: string }>),
    ]);
    const nomeRep = new Map<number, string>();
    for (const v of vendedores) nomeRep.set(v.rep_codigo, v.rep_nome);
    const devidos = new Map<string, ClienteDevido[]>();
    for (const [chave, clientes] of Object.entries(devidosRaw ?? {})) {
      devidos.set(chave, clientes.map((c) => ({ ...c, rep_nome: c.rep_codigo != null ? (nomeRep.get(c.rep_codigo) ?? null) : null })));
    }
    const giroAtacado = new Map<number, number>();
    for (const [c, p] of perfis) {
      const q = p?.vendas?.qtd_12m;
      if (q != null && Number.isFinite(q)) giroAtacado.set(c, q / 365);
    }

    const r = montarProdutosDia(lotes, giro, giroAtacado, devidos, cfg);
    await this.db.salvarProdutosDia(data, [...r.itens, ...r.fora], geradoPor);
    void this.avisosVendas.produtosDia(data, {
      total: r.itens.length,
      bolsa: r.itens.reduce((s, i) => s + i.bolsa_unidade * i.demanda_esperada, 0),
      fora: r.fora.length,
    });
    return r;
  }

  async listar(data?: string) {
    const dia = data ?? ymdCuiaba();
    const rows = await this.db.produtosDia(dia);
    return {
      data: dia,
      gerado_em: rows[0]?.gerado_em ?? null,
      gerado_por: rows[0]?.gerado_por ?? null,
      itens: rows.filter((r) => r.posicao != null),
      fora: rows.filter((r) => r.posicao == null),
    };
  }

  datas() {
    return this.db.datasProdutosDia();
  }

  /** Botão da tela: refaz a lista de hoje. */
  async regenerar(geradoPor: string | null) {
    const hoje = ymdCuiaba();
    await this.gerar(hoje, geradoPor);
    return this.listar(hoje);
  }
}
