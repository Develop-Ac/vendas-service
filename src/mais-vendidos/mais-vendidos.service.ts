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
 * A vitrine do portal mostra 30, mas parte do ranking não tem correspondente
 * ativo no catálogo de lá (produto não importado, ou desativado) e cai na
 * leitura. Mandar 90 é o que faz a lista chegar cheia. O portal aceita até 200.
 */
const LIMITE = 90;

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
