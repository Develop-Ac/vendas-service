import { Injectable } from '@nestjs/common';
import { ErpApiService } from '../common/erp-api/erp-api.service';

/** Empresa padrão (matriz) — mesma usada no restante da Encomenda de Peças. */
export const EMPRESA_PADRAO = 3;

/** Recorte de `produtos` que a tela de encomenda usa para identificar a peça. */
export interface ProdutoEncomenda {
  PRO_CODIGO: number;
  PRO_DESCRICAO: string | null;
  REFERENCIA: string | null;
  REF_FABRICANTE: string | null;
  REF_FORNECEDOR: string | null;
}

/** Recorte de `clientes` — só o que a encomenda precisa para contato. */
export interface ClienteEncomenda {
  CLI_CODIGO: number;
  CLI_NOME: string | null;
  FONE: string | null;
  CELULAR: string | null;
}

/** Fornecedor do Celta. A tela mostra o nome fantasia; a razão social fica de reserva. */
export interface FornecedorEncomenda {
  FOR_CODIGO: number;
  FOR_NOME: string | null;
  NOME_FANTASIA: string | null;
}

/** Recorte da ordem de serviço — só o que decide se a encomenda é de oficina. */
export interface OrdemServicoEncomenda {
  ORDEM_SERVICO: number;
  STATUS: number | null;
}

/**
 * Leitura por chave no ERP via erp-firebird-api. As rotas de lá devolvem a
 * linha inteira do ERP; o recorte para os campos da tela é feito aqui para a
 * resposta não carregar preço e custo, que a Encomenda de Peças não usa.
 */
@Injectable()
export class EncomendaPecasErpRepository {
  constructor(private readonly erp: ErpApiService) {}

  async produtoPorCodigo(
    proCodigo: number,
    empresa = EMPRESA_PADRAO,
  ): Promise<ProdutoEncomenda | null> {
    const r = await this.erp.buscar<Record<string, any>>(
      `/erp/encomenda-pecas/produtos/${proCodigo}?empresa=${empresa}`,
    );
    const linha = r.dados?.[0];
    if (!linha) return null;

    return {
      PRO_CODIGO: Number(linha.PRO_CODIGO),
      PRO_DESCRICAO: linha.PRO_DESCRICAO ?? null,
      REFERENCIA: linha.REFERENCIA ?? null,
      REF_FABRICANTE: linha.REF_FABRICANTE ?? null,
      REF_FORNECEDOR: linha.REF_FORNECEDOR ?? null,
    };
  }

  async clientePorCodigo(
    cliCodigo: number,
    empresa = EMPRESA_PADRAO,
  ): Promise<ClienteEncomenda | null> {
    const r = await this.erp.buscar<Record<string, any>>(
      `/erp/encomenda-pecas/clientes/${cliCodigo}?empresa=${empresa}`,
    );
    const linha = r.dados?.[0];
    if (!linha) return null;

    return {
      CLI_CODIGO: Number(linha.CLI_CODIGO),
      CLI_NOME: linha.CLI_NOME ?? null,
      FONE: linha.FONE ?? null,
      CELULAR: linha.CELULAR ?? null,
    };
  }

  async fornecedorPorCodigo(
    forCodigo: number,
    empresa = EMPRESA_PADRAO,
  ): Promise<FornecedorEncomenda | null> {
    const r = await this.erp.buscar<Record<string, any>>(
      `/erp/encomenda-pecas/fornecedores/${forCodigo}?empresa=${empresa}`,
    );
    const linha = r.dados?.[0];
    if (!linha) return null;

    // CHAR do Firebird volta preenchido com espaços até o tamanho declarado
    const texto = (v: unknown) => (v == null ? null : String(v).trim() || null);
    return {
      FOR_CODIGO: Number(linha.FOR_CODIGO),
      FOR_NOME: texto(linha.FOR_NOME),
      NOME_FANTASIA: texto(linha.NOME_FANTASIA),
    };
  }

  async ordemServicoPorNumero(
    os: number,
    empresa = EMPRESA_PADRAO,
  ): Promise<OrdemServicoEncomenda | null> {
    const r = await this.erp.buscar<Record<string, any>>(
      `/erp/encomenda-pecas/os/${os}?empresa=${empresa}`,
    );
    const linha = r.dados?.[0];
    if (!linha) return null;

    return {
      ORDEM_SERVICO: Number(linha.ORDEM_SERVICO),
      STATUS: linha.STATUS === null || linha.STATUS === undefined ? null : Number(linha.STATUS),
    };
  }
}
