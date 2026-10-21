import { ErpApiService } from '../common/erp-api/erp-api.service';
import { B2bCarteiraService } from './b2b.carteira.service';
import { B2bPrismaRepository } from './b2b.prisma.repository';
import { B2bRepository } from './b2b.repository';

function montar() {
  const erp = { consultar: jest.fn() };
  const portal = {
    enviarCarteira: jest.fn().mockResolvedValue({ clientes: 0, usuarios: 1 }),
    listarEmpresas: jest.fn().mockResolvedValue([]),
  };
  const db = {
    clientesVinculados: jest.fn().mockResolvedValue([]),
    vendedoresDaCarteira: jest.fn().mockResolvedValue(new Map()),
  };
  return {
    service: new B2bCarteiraService(
      erp as unknown as ErpApiService,
      portal as unknown as B2bRepository,
      db as unknown as B2bPrismaRepository,
    ),
    erp,
    portal,
    db,
  };
}

describe('B2bCarteiraService', () => {
  it('envia o atacado com o vendedor da carteira e os vinculados fora do atacado', async () => {
    const { service, erp, portal, db } = montar();
    erp.consultar
      .mockResolvedValueOnce([
        { CLI_CODIGO: 1, CLI_NOME: ' LOJA UM ', CPF_CNPJ: '12.345.678/0001-99', CIDADE: 'Cuiabá', UF: 'MT' },
      ])
      .mockResolvedValueOnce([
        { CLI_CODIGO: 9, CLI_NOME: 'NOVO', CPF_CNPJ: null, CIDADE: null, UF: null },
      ]);
    db.clientesVinculados.mockResolvedValue([1]);
    portal.listarEmpresas.mockResolvedValue([{ cliCodigo: 9 }, { cliCodigo: null }]);
    db.vendedoresDaCarteira.mockResolvedValue(
      new Map([[1, { rep_codigo: 7, rep_nome: 'Alison' }]]),
    );

    const r = await service.enviarTudo();

    // o 2º ERP só pede quem não veio no atacado
    expect(erp.consultar.mock.calls[1][1].filtros).toEqual([
      { campo: 'CLI_CODIGO', op: 'em', valor: [9] },
    ]);
    expect(portal.enviarCarteira).toHaveBeenCalledWith([
      {
        cliCodigo: 1,
        nome: 'LOJA UM',
        cpfCnpj: '12345678000199',
        cidade: 'Cuiabá',
        uf: 'MT',
        repCodigo: 7,
        repNome: 'Alison',
      },
      {
        cliCodigo: 9,
        nome: 'NOVO',
        cpfCnpj: null,
        cidade: null,
        uf: null,
        repCodigo: null,
        repNome: null,
      },
    ]);
    expect(r).toEqual({ clientes: 2, usuarios: 1 });
  });

  it('manda em lotes de 1000', async () => {
    const { service, erp, portal } = montar();
    erp.consultar.mockResolvedValueOnce(
      Array.from({ length: 2500 }, (_, i) => ({ CLI_CODIGO: i + 1, CLI_NOME: `C${i}` })),
    );

    await service.enviarTudo();

    expect(portal.enviarCarteira.mock.calls.map((c) => c[0].length)).toEqual([
      1000, 1000, 500,
    ]);
  });
});
