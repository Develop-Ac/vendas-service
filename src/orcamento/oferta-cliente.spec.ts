import PDFDocument from 'pdfkit';
import { OrcamentoService } from './orcamento.service';
import { mensagemWhatsapp } from './orcamento.mensagem';
import { gerarPdfOrcamento, type PdfOrcamento } from './orcamento.pdf';

/* Oferta para o cliente: PDF e WhatsApp dizem só "oferta até dd/mm"; a pesquisa
   "só itens em oferta" devolve só o que levou o preço da oferta. */

const orcamento: PdfOrcamento = {
  numero: '123',
  emissao: '17/11/2026',
  validade: '16/12/2026',
  vendedor: 'V',
  cliente: { codigo: 1, nome: 'Cliente', cpf_cnpj: null, rg_ie: null, fone: null, endereco: null, bairro: null, cep: null, cidade: null, uf: null, tabela_nome: null },
  itens: [
    { pro_codigo: 10, descricao: 'Palheta', marca: null, unidade: 'UN', quantidade: 2, preco_tabela: 10, desc_pct: 0, preco_unit: 8, total: 16, promocao_fim: '16/12/2026', preco_original: 10, qtd_encomenda: 0 },
  ],
  subtotal: 16,
  desconto: 0,
  desc_pct: 0,
  total: 16,
  observacao: null,
  pagamento: null,
};

describe('oferta para o cliente (critério 20)', () => {
  it('mensagem do WhatsApp: "oferta até dd/mm", sem promoção nem liquidação', () => {
    const m = mensagemWhatsapp(orcamento);
    expect(m).toContain('Palheta — oferta até 16/12');
    expect(m.toLowerCase()).not.toMatch(/promo|liquida/);
  });

  it('PDF: "oferta até dd/mm", sem promoção nem liquidação', async () => {
    const textos: string[] = [];
    const orig = PDFDocument.prototype.text;
    const spy = jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function (this: PDFKit.PDFDocument, ...args: unknown[]) {
      textos.push(String(args[0]));
      return (orig as (...a: unknown[]) => PDFKit.PDFDocument).apply(this, args);
    });
    try {
      await gerarPdfOrcamento(orcamento);
    } finally {
      spy.mockRestore();
    }
    const tudo = textos.join('\n');
    expect(tudo).toContain('oferta até 16/12 · de R$');
    expect(tudo.toLowerCase()).not.toMatch(/promo|liquida/);
  });

  it('critério 12: item de campanha não leva prêmio, bônus nem nome de campanha ao cliente', async () => {
    const textos: string[] = [];
    const orig = PDFDocument.prototype.text;
    const spy = jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function (this: PDFKit.PDFDocument, ...args: unknown[]) {
      textos.push(String(args[0]));
      return (orig as (...a: unknown[]) => PDFKit.PDFDocument).apply(this, args);
    });
    try {
      await gerarPdfOrcamento(orcamento);
    } finally {
      spy.mockRestore();
    }
    for (const t of [textos.join(' '), mensagemWhatsapp(orcamento)]) {
      expect(t).toContain('oferta até 16/12');
      expect(t).not.toMatch(/Prêmio|Bônus|Campanha/i);
    }
  });
});

describe('produtosEmOferta (pesquisa "só itens em oferta")', () => {
  const montar = (ligada: boolean) => {
    const ofertas = { fonteIntranet: jest.fn(async () => ligada), aprovados: jest.fn(async () => [{ pro_codigo: 1 }, { pro_codigo: 2 }, { pro_codigo: 1 }]) };
    const service = new OrcamentoService({} as never, {} as never, {} as never, {} as never, {} as never, ofertas as never);
    const produtosPorCodigo = jest.fn(async () => [
      { pro_codigo: 1, promocao: { oferta_item_id: 7 } },
      { pro_codigo: 2, promocao: null }, // vencida/sem saldo: não levou a oferta
    ]);
    Object.assign(service as unknown as Record<string, unknown>, { produtosPorCodigo });
    return { service, ofertas, produtosPorCodigo };
  };

  it('fonte na intranet e atacado: só os que voltaram com oferta_item_id', async () => {
    const { service, produtosPorCodigo } = montar(true);
    const r = await service.produtosEmOferta('2', 99);
    expect(produtosPorCodigo).toHaveBeenCalledWith([1, 2], '2', 99);
    expect(r.map((p) => p.pro_codigo)).toEqual([1]);
  });

  it('fonte no Celta ou tabela fora do atacado: lista vazia sem consultar', async () => {
    for (const [ligada, tabela] of [[false, '2'], [true, '1'], [true, null]] as const) {
      const { service, ofertas } = montar(ligada);
      expect(await service.produtosEmOferta(tabela)).toEqual([]);
      expect(ofertas.aprovados).not.toHaveBeenCalled();
    }
  });
});
