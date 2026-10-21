import { Injectable, Logger } from '@nestjs/common';
import { ErpApiService } from '../common/erp-api/erp-api.service';
import { B2bRepository, ClienteCeltaPortal } from './b2b.repository';
import { B2bPrismaRepository } from './b2b.prisma.repository';

/* =============================================================================
   CARTEIRA NO PORTAL B2B
   -----------------------------------------------------------------------------
   O portal não alcança a intranet (a rede só abre daqui para a nuvem). Para o
   cadastro de lá mostrar o cliente e o vendedor na hora em que o admin digita
   o código, a intranet envia a carteira: cada cliente do atacado com o
   vendedor da carteirização (ven_carteira_cliente, o espelho do ERP), mais os
   clientes já vinculados a empresas do portal que não são do atacado.

   Ao receber, o portal reescreve a carteira dos usuários vinculados — é assim
   que a troca de vendedor feita na carteirização chega lá.
   ============================================================================= */

const EMPRESA = 3;
/** Mesmas tabelas de preço que a carteirização chama de atacado. */
const TABELAS_ATACADO = ['2', '5'];
const LIMITE_ERP = 20_000;
/** Clientes por PUT: ~1,2 mil cabem em dois, bem abaixo do 1 MB do portal. */
const LOTE_ENVIO = 1000;
const LOTE_ERP = 500;

interface CadastroErp {
  CLI_CODIGO: number;
  CLI_NOME: string | null;
  CPF_CNPJ: string | null;
  CIDADE: string | null;
  UF: string | null;
}

const CAMPOS = ['CLI_CODIGO', 'CLI_NOME', 'CPF_CNPJ', 'CIDADE', 'UF'];

/** Só dígitos no documento: é assim que a busca do portal compara. */
function documento(valor: string | null | undefined): string | null {
  const d = (valor ?? '').replace(/\D/g, '');
  return d ? d.slice(0, 20) : null;
}

function texto(valor: string | null | undefined, max: number): string | null {
  const t = (valor ?? '').trim();
  return t ? t.slice(0, max) : null;
}

@Injectable()
export class B2bCarteiraService {
  private readonly logger = new Logger(B2bCarteiraService.name);

  constructor(
    private readonly erp: ErpApiService,
    private readonly portal: B2bRepository,
    private readonly db: B2bPrismaRepository,
  ) {}

  /**
   * Carga completa: atacado + clientes vinculados fora dele. Devolve quantos
   * clientes foram e quantos usuários do portal tiveram a carteira trocada.
   */
  async enviarTudo(): Promise<{ clientes: number; usuarios: number }> {
    const atacado = await this.erp.consultar<CadastroErp>('clientes', {
      empresa: EMPRESA,
      campos: CAMPOS,
      filtros: [{ campo: 'TABELA_PRECO', op: 'em', valor: TABELAS_ATACADO }],
      limite: LIMITE_ERP,
    });

    // Vinculados: pelos pedidos gravados aqui e pelas empresas do portal (o
    // vínculo feito no cadastro de lá ainda pode não ter pedido).
    const vinculados = new Set(await this.db.clientesVinculados());
    for (const e of await this.portal.listarEmpresas(false)) {
      if (e.cliCodigo != null) vinculados.add(e.cliCodigo);
    }
    const jaVieram = new Set(atacado.map((c) => Number(c.CLI_CODIGO)));
    const foraDoAtacado = [...vinculados].filter((cli) => !jaVieram.has(cli));
    const extras: CadastroErp[] = [];
    for (let i = 0; i < foraDoAtacado.length; i += LOTE_ERP) {
      const lote = foraDoAtacado.slice(i, i + LOTE_ERP);
      extras.push(
        ...(await this.erp.consultar<CadastroErp>('clientes', {
          empresa: EMPRESA,
          campos: CAMPOS,
          filtros: [{ campo: 'CLI_CODIGO', op: 'em', valor: lote }],
          limite: lote.length + 10,
        })),
      );
    }

    const cadastro = [...atacado, ...extras];
    const carteira = await this.db.vendedoresDaCarteira(
      cadastro.map((c) => Number(c.CLI_CODIGO)),
    );
    const clientes = cadastro
      .map((c) => this.paraPortal(c, carteira.get(Number(c.CLI_CODIGO))))
      .filter((c): c is ClienteCeltaPortal => c !== null);

    let usuarios = 0;
    for (let i = 0; i < clientes.length; i += LOTE_ENVIO) {
      const r = await this.portal.enviarCarteira(
        clientes.slice(i, i + LOTE_ENVIO),
      );
      usuarios += r.usuarios;
    }
    this.logger.log(
      `Carteira enviada ao portal B2B: ${clientes.length} clientes, ${usuarios} usuários com carteira trocada.`,
    );
    return { clientes: clientes.length, usuarios };
  }

  /**
   * Um cliente só — usado no vínculo, antes de gravar o código na empresa, para
   * o portal já ter o cliente e acertar a carteira na mesma hora.
   */
  async enviarCliente(cliente: {
    cli_codigo: number;
    cli_nome: string | null;
    cpf_cnpj?: string | null;
    cidade?: string | null;
    uf?: string | null;
  }): Promise<void> {
    const vendedor = (
      await this.db.vendedoresDaCarteira([cliente.cli_codigo])
    ).get(cliente.cli_codigo);
    const linha = this.paraPortal(
      {
        CLI_CODIGO: cliente.cli_codigo,
        CLI_NOME: cliente.cli_nome,
        CPF_CNPJ: cliente.cpf_cnpj ?? null,
        CIDADE: cliente.cidade ?? null,
        UF: cliente.uf ?? null,
      },
      vendedor,
    );
    if (linha) await this.portal.enviarCarteira([linha]);
  }

  private paraPortal(
    c: CadastroErp,
    vendedor: { rep_codigo: number; rep_nome: string | null } | undefined,
  ): ClienteCeltaPortal | null {
    const cliCodigo = Number(c.CLI_CODIGO);
    if (!Number.isInteger(cliCodigo) || cliCodigo <= 0) return null;
    return {
      cliCodigo,
      nome: texto(c.CLI_NOME, 200) ?? `Cliente ${cliCodigo}`,
      cpfCnpj: documento(c.CPF_CNPJ),
      cidade: texto(c.CIDADE, 120),
      uf: texto(c.UF, 2),
      repCodigo: vendedor?.rep_codigo ?? null,
      repNome: texto(vendedor?.rep_nome, 255),
    };
  }
}
