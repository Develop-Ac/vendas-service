import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { CarteirizacaoSqlServerRepository } from './carteirizacao.sqlserver.repository';
import { GestaoService } from './gestao.service';
import { ehGerenciaVendas } from './papel';
import { montarEmpresa } from './gestao-empresa';
import { MssqlService } from '../common/mssql/mssql.service';
import { montarConsulta } from '../paineis/painel-sql';

type Bloco = 'venda' | 'orcamentos' | 'clientes';

const lerSql = (arquivo: string) => fs.readFileSync(path.join(__dirname, '..', 'paineis', 'sql', arquivo), 'utf8');

/** Valor da coluna `nome` na primeira linha (null sem linha, sem coluna ou valor nulo). */
const coluna = (r: { colunas: Array<{ name: string }>; linhas: unknown[][] }, nome: string): number | null => {
  const i = r.colunas.findIndex((c) => c.name === nome);
  const v = i < 0 ? null : r.linhas[0]?.[i];
  return v == null ? null : Number(v);
};

/**
 * Tela inicial da gerência de vendas (GET gestao/empresa): empresa toda, todos os canais,
 * do mês comissional pedido. Só gerência/diretoria. Três leituras independentes
 * (`Promise.allSettled`): venda (vendedores, canais, empresa, kpis, série), orçamentos e
 * clientes; a que falhar vem null com aviso, e a mensagem do driver fica só no log.
 * Orçamentos e clientes usam os SQLs do catálogo da gerência (`paineis/sql`), sem filtro.
 */
@Injectable()
export class GestaoEmpresaService {
  private readonly logger = new Logger(GestaoEmpresaService.name);
  private readonly sqlConversao = lerSql('taxa-de-conversao-de-orcamento.sql');
  private readonly sqlPositivacao = lerSql('positivacao-de-carteira.sql');

  constructor(
    private readonly repo: CarteirizacaoPrismaRepository,
    private readonly bi: CarteirizacaoSqlServerRepository,
    private readonly gestao: GestaoService,
    private readonly mssql: MssqlService,
  ) {}

  async empresa(ano?: number, mes?: number, usuarioId?: string) {
    const u = await this.repo.usuarioVendas(usuarioId);
    if (!u) throw new ForbiddenException('Usuário não identificado: entre de novo na intranet e tente outra vez.');
    if (!ehGerenciaVendas(u)) throw new ForbiddenException('Tela só para a gerência de vendas.');

    const p = this.gestao.validarPeriodo(ano, mes);
    const { inicio, fim, dias, encerrado, periodo } = this.gestao.montarPeriodo(p, await this.bi.diasUteisPeriodo(p.ano, p.mes));
    const filtro = { de: inicio, ate: fim, vendedores: [], canais: [] };

    const blocos = {
      venda: Promise.all([
        this.bi.vendaVendedoresPorDia(p.ano, p.mes),
        this.bi.metasDw(p.ano, p.mes),
        this.repo.listarMetasPeriodo(p.ano, p.mes),
        this.bi.papeisPorRep(),
        this.bi.vendedoresAtivosComissao(),
      ]).then(([linhas, metasDw, manuais, papeis, ativos]) =>
        montarEmpresa({
          linhas,
          metasDw,
          metasManuais: manuais.map((m) => ({ rep_codigo: m.rep_codigo, valor_meta: Number(m.valor_meta) })),
          papeis,
          ativos,
          dias,
          encerrado,
          hoje: p.hoje,
        }),
      ),
      // Numerador e denominador saem da mesma consulta da taxa: o "X de Y" bate com o percentual.
      orcamentos: this.consultar(this.sqlConversao, filtro).then((conv) => {
        const rel = coluna(conv, 'conversao_rel');
        return {
          quantidade: coluna(conv, 'qtd_orcamentos') ?? 0,
          convertidos: coluna(conv, 'qtd_vendas') ?? 0,
          pct: rel == null ? null : rel * 100,
        };
      }),
      clientes: this.consultar(this.sqlPositivacao, filtro).then((r) => ({
        carteira: coluna(r, 'clientes_carteira') ?? 0,
        com_venda: coluna(r, 'clientes_unicos') ?? 0,
        pct: coluna(r, 'razao_percentual'),
      })),
    };
    const nomes = Object.keys(blocos) as Bloco[];
    const lidos = await Promise.allSettled(nomes.map((n) => blocos[n]));
    const avisos: Array<{ bloco: Bloco; motivo: 'indisponível' }> = [];
    const valor = <K extends Bloco>(n: K) => {
      const r = lidos[nomes.indexOf(n)];
      if (r.status === 'fulfilled') return r.value as Awaited<(typeof blocos)[K]>;
      const motivo = r.reason instanceof Error ? r.reason.message : String(r.reason);
      this.logger.warn(`Tela da gerência: bloco ${n} indisponível: ${motivo}`);
      avisos.push({ bloco: n, motivo: 'indisponível' });
      return null;
    };

    const venda = valor('venda');
    return {
      periodo,
      vendedores: venda?.vendedores ?? null,
      canais: venda?.canais ?? null,
      empresa: venda?.empresa ?? null,
      kpis: venda?.kpis ?? null,
      serie: venda?.serie ?? null,
      orcamentos: valor('orcamentos'),
      clientes: valor('clientes'),
      avisos,
      gerado_em: new Date().toISOString(),
    };
  }

  private consultar(sql: string, filtro: Parameters<typeof montarConsulta>[1]) {
    const { texto, params } = montarConsulta(sql, filtro);
    return this.mssql.queryLinhas(texto, params);
  }
}
