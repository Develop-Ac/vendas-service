import { Injectable } from '@nestjs/common';
import {
  CriterioMaisVendidos,
  MaisVendidosSqlServerRepository,
  criterioValido,
} from './mais-vendidos.sqlserver.repository';
import { MaisVendidosPortalRepository } from './mais-vendidos.portal.repository';

/**
 * Quantos itens apurar e enviar.
 *
 * Não é o tamanho da vitrine (30). O mesmo ranking ordena o **catálogo inteiro**
 * do portal quando ele é navegado sem recorte, então precisa cobrir tudo o que
 * vendeu na janela e tem estoque — hoje ~3.900 peças. Quem ficar de fora não
 * some da listagem: vai para depois das que venderam, em ordem alfabética.
 *
 * 5.000 é o teto que o portal aceita, e a folga também é o que mantém a vitrine
 * cheia (parte do ranking não tem correspondente ativo lá e cai na leitura).
 */
const LIMITE = 5000;

/** Janela de apuração, em meses. */
const MESES_PADRAO = 12;

export interface ResultadoSincronizacao {
  criterio: CriterioMaisVendidos;
  meses: number;
  apurados: number;
  gravados: number;
  apuradoEm: string;
}

@Injectable()
export class MaisVendidosService {
  constructor(
    private readonly bi: MaisVendidosSqlServerRepository,
    private readonly portal: MaisVendidosPortalRepository,
  ) {}

  /**
   * Apura no BI e empurra para o portal.
   *
   * O que vai no campo `quantidade` da carga depende do critério: com `notas`
   * (o padrão) vai o número de pedidos distintos, que é o que ordenou a lista.
   * Mandar sempre `unidades` faria o portal guardar um número que não explica
   * a ordem que ele recebeu.
   */
  async sincronizar(): Promise<ResultadoSincronizacao> {
    const criterio = criterioValido(process.env.MAIS_VENDIDOS_CRITERIO);
    const meses = Number(process.env.MAIS_VENDIDOS_MESES) || MESES_PADRAO;
    const apuradoEm = new Date();

    const linhas = await this.bi.apurar(criterio, meses, LIMITE);

    const gravados = await this.portal.enviar(
      apuradoEm,
      linhas.map((l) => ({
        proCodigo: String(l.pro_codigo),
        quantidade: criterio === 'notas' ? l.notas : Math.round(l.unidades),
        estoque: l.estoque,
      })),
    );

    return {
      criterio,
      meses,
      apurados: linhas.length,
      gravados,
      apuradoEm: apuradoEm.toISOString(),
    };
  }
}
