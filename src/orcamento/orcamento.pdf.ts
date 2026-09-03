import PDFDocument from 'pdfkit';
import { LOGO_AC } from './orcamento.logo';

/**
 * PDF DO ORÇAMENTO — o leiaute que o cliente já conhece.
 *
 * Reproduz a anatomia do orçamento impresso pelo ERP (empresa e telefones à
 * esquerda, número/emissão/validade à direita, faixa do vendedor, bloco do
 * cliente, tabela cinza, totais, condição de pagamento), com a marca da AC no
 * cabeçalho e SEM menção ao sistema de origem. Diferenças de conteúdo em
 * relação ao ERP: a tabela mostra o preço de tabela, o desconto % e o unitário
 * líquido de cada item (o que a mensagem do WhatsApp não mostra), e o bloco de
 * totais traz DESCONTO no lugar de "Acréscimo".
 *
 * A4 retrato, fontes internas do pdfkit (Helvetica) — sem dependência de
 * fonte instalada no container.
 */

/** Dados da empresa impressos no cabeçalho (empresa 3, atacado). */
export const EMPRESA_PDF = {
  razao: 'C. M. SIQUEIRA E CIA LTDA - AC ACESSORIOS',
  endereco: 'AV PERIMETRAL SUDESTE, 10187 - CENTRO',
  cidade: 'SORRISO - MT',
  fones: '66-3544-6545   3544-2620',
};

export interface PdfCliente {
  codigo: number;
  nome: string;
  cpf_cnpj: string | null;
  rg_ie: string | null;
  fone: string | null;
  endereco: string | null;
  bairro: string | null;
  cep: string | null;
  cidade: string | null;
  uf: string | null;
  tabela_nome: string | null;
}

export interface PdfItem {
  pro_codigo: number;
  descricao: string;
  marca: string | null;
  unidade: string | null;
  quantidade: number;
  preco_tabela: number;
  desc_pct: number;
  preco_unit: number;
  total: number;
  promocao_fim: string | null; // dd/mm/aaaa
  /** preço "de" quando o item está em promoção (preço original da tabela). */
  preco_original: number | null;
}

export interface PdfOrcamento {
  numero: string;
  emissao: string; // dd/mm/aaaa
  validade: string | null;
  vendedor: string;
  cliente: PdfCliente;
  itens: PdfItem[];
  subtotal: number;
  desconto: number;
  desc_pct: number;
  total: number;
  observacao: string | null;
}

const A4 = { w: 595.28, h: 841.89 };
const M = 30; // margem
const LARG = A4.w - 2 * M;
const CINZA = '#d9d9d9';
const TEXTO = '#111111';
const SUAVE = '#555555';

/** Corta o texto para caber na largura numa linha só (pdfkit quebraria em duas). */
function caber(doc: PDFKit.PDFDocument, txt: string, largura: number): string {
  if (doc.widthOfString(txt) <= largura) return txt;
  let t = txt;
  while (t.length > 1 && doc.widthOfString(t + '...') > largura) t = t.slice(0, -1);
  return t + '...';
}

/**
 * Texto numa célula, numa linha só. Alinhamento à direita calculado na mão:
 * o `align` do pdfkit exige `width`, e com `width` ele volta a quebrar linha.
 */
function celula(doc: PDFKit.PDFDocument, txt: string, x: number, w: number, al: 'left' | 'right', y: number) {
  const xx = al === 'right' ? x + w - 2 - doc.widthOfString(txt) : x + 2;
  doc.text(txt, xx, y, { lineBreak: false });
}

const brl = (v: number) => (v ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtd = (v: number) => (Number.isInteger(v) ? String(v) : v.toLocaleString('pt-BR', { maximumFractionDigits: 3 }));

/** Colunas da tabela: [rótulo, x, largura, alinhamento]. */
const COLS: Array<[string, number, number, 'left' | 'right']> = [
  ['P r o d u t o', M, 225, 'left'],
  ['Marca', M + 225, 57, 'left'],
  ['Un.', M + 282, 25, 'left'],
  ['Qtde.', M + 307, 32, 'right'],
  ['Tabela', M + 339, 50, 'right'],
  ['Desc.%', M + 389, 40, 'right'],
  ['Unitário', M + 429, 50, 'right'],
  ['T O T A L', M + 479, LARG - 479, 'right'],
];


export function gerarPdfOrcamento(o: PdfOrcamento): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: M, info: { Title: `Orçamento ${o.numero}`, Author: 'AC Acessórios' } });
    const partes: Buffer[] = [];
    doc.on('data', (c: Buffer) => partes.push(c));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);

    let y = cabecalho(doc, o);
    y = tabelaCabecalho(doc, y);
    for (const it of o.itens) {
      const altura = it.promocao_fim ? 36 : 26;
      if (y + altura > A4.h - 120) {
        rodape(doc, o);
        doc.addPage();
        y = cabecalho(doc, o);
        y = tabelaCabecalho(doc, y);
      }
      y = linhaItem(doc, y, it);
    }
    y = totais(doc, y + 6, o);
    rodape(doc, o);
    doc.end();
  });
}

function cabecalho(doc: PDFKit.PDFDocument, o: PdfOrcamento): number {
  let y = M;
  let xTexto = M;
  try {
    doc.image(LOGO_AC(), M, y - 2, { width: 64 });
    xTexto = M + 76;
  } catch {
    /* logo ilegível: segue sem ela */
  }
  doc.fillColor(TEXTO).font('Helvetica-Bold').fontSize(12).text(EMPRESA_PDF.razao, xTexto, y, { width: 330, lineBreak: false });
  doc.font('Helvetica').fontSize(8.5).text(EMPRESA_PDF.endereco, xTexto, y + 15).text(EMPRESA_PDF.cidade, xTexto, y + 26);
  doc.font('Helvetica-Bold').fontSize(10).text(`Fone: ${EMPRESA_PDF.fones}`, xTexto, y + 39);

  // bloco à direita: número em caixa cinza, emissão e validade
  const xR = M + LARG - 190;
  doc.font('Helvetica-Bold').fontSize(13).text('Orçamento:', xR, y + 1, { width: 90, align: 'right' });
  doc.rect(xR + 96, y - 3, 94, 20).fill(CINZA).fillColor(TEXTO);
  doc.font('Helvetica-Bold').fontSize(14).text(o.numero, xR + 96, y, { width: 94, align: 'center' });
  doc.font('Helvetica').fontSize(9.5);
  doc.text('Emissão:', xR, y + 24, { width: 90, align: 'right' }).text(o.emissao, xR + 96, y + 24, { width: 94, align: 'right' });
  doc.text('Validade:', xR, y + 36, { width: 90, align: 'right' }).text(o.validade ?? '—', xR + 96, y + 36, { width: 94, align: 'right' });

  // faixa do vendedor
  y += 56;
  doc.rect(M - 4, y, LARG + 8, 15).fill(CINZA).fillColor(TEXTO);
  doc.font('Helvetica').fontSize(9.5).text(`Vendedor: ${o.vendedor}`, M, y + 3);
  y += 19;

  // bloco do cliente (3 linhas × 3 colunas)
  const c = o.cliente;
  const col = [M, M + LARG * 0.5, M + LARG * 0.78];
  const par = (rot: string, val: string | null, x: number, yy: number, w?: number) => {
    doc.fillColor(SUAVE).font('Helvetica').fontSize(8.5).text(`${rot}`, x, yy, { lineBreak: false });
    const xv = x + doc.widthOfString(`${rot}`) + 4;
    doc.fillColor(TEXTO).fontSize(8.5).text(w ? caber(doc, val ?? '', w - (xv - x)) : val ?? '', xv, yy, { lineBreak: false });
  };
  par('Cliente:', `${c.nome} (${c.codigo})`, col[0], y, LARG * 0.48);
  par('Fone:', c.fone, col[1], y);
  par('CPF/CNPJ:', c.cpf_cnpj, col[2], y);
  y += 12;
  par('Endereço:', c.endereco, col[0], y, LARG * 0.48);
  par('Bairro:', c.bairro, col[1], y);
  par('CEP:', c.cep, col[2], y);
  y += 12;
  par('Cidade/UF:', [c.cidade, c.uf].filter(Boolean).join(' - '), col[0], y);
  par('Tabela:', c.tabela_nome, col[1], y);
  par('RG/IE:', c.rg_ie, col[2], y);
  y += 14;
  doc.moveTo(M - 4, y).lineTo(M + LARG + 4, y).lineWidth(1.2).strokeColor('#999999').stroke();
  return y + 4;
}

function tabelaCabecalho(doc: PDFKit.PDFDocument, y: number): number {
  doc.rect(M - 4, y, LARG + 8, 14).fill(CINZA).fillColor(TEXTO);
  doc.font('Helvetica').fontSize(9);
  for (const [rot, x, w, al] of COLS) celula(doc, caber(doc, rot, w - 4), x, w, al, y + 3);
  return y + 17;
}

function linhaItem(doc: PDFKit.PDFDocument, y: number, it: PdfItem): number {
  doc.fillColor(TEXTO).font('Helvetica').fontSize(9);
  const cel = (i: number, txt: string) => {
    const [, x, w, al] = COLS[i];
    celula(doc, caber(doc, txt, w - 4), x, w, al, y);
  };
  // A descrição não é cortada: quebra em até duas linhas (a linha cresce junto).
  const descr = `${it.pro_codigo}   ${it.descricao}`;
  const wDescr = COLS[0][2] - 4;
  const hDescr = Math.min(doc.heightOfString(descr, { width: wDescr }), 24);
  doc.text(descr, COLS[0][1] + 2, y, { width: wDescr, height: 24, ellipsis: true });
  cel(1, it.marca ?? '');
  cel(2, it.unidade ?? 'UN');
  cel(3, qtd(it.quantidade));
  cel(4, brl(it.preco_original ?? it.preco_tabela));
  cel(5, it.promocao_fim ? '—' : it.desc_pct > 0 ? (it.desc_pct * 100).toFixed(2).replace('.', ',') : '');
  cel(6, brl(it.preco_unit));
  cel(7, brl(it.total));
  y += Math.max(12, hDescr + 1);
  if (it.promocao_fim) {
    doc.fillColor(SUAVE).fontSize(7.5).text(
      `promoção válida até ${it.promocao_fim}${it.preco_original ? ` · de R$ ${brl(it.preco_original)} por R$ ${brl(it.preco_unit)}` : ''}`,
      COLS[0][1] + 44, y, { lineBreak: false },
    );
    doc.fillColor(TEXTO);
    y += 10;
  }
  return y + 2;
}

function totais(doc: PDFKit.PDFDocument, y: number, o: PdfOrcamento): number {
  const qtdTotal = o.itens.reduce((s, i) => s + i.quantidade, 0);
  doc.fillColor(TEXTO).font('Helvetica').fontSize(9.5);
  doc.text(`Qtde. Total:   ${qtd(qtdTotal)}`, M + 260, y + 2, { lineBreak: false });
  const xRot = M + LARG - 210;
  const xVal = M + LARG - 100;
  const linha = (rot: string, val: string, yy: number, negrito = false) => {
    doc.font(negrito ? 'Helvetica-Bold' : 'Helvetica').fontSize(negrito ? 11 : 9.5);
    doc.text(rot, xRot, yy, { width: 105, align: 'right', lineBreak: false });
    doc.text(val, xVal, yy, { width: 100, align: 'right', lineBreak: false });
  };
  linha('Subtotal:', brl(o.subtotal), y);
  linha(`Desconto (${(o.desc_pct * 100).toFixed(2).replace('.', ',')}%):`, brl(o.desconto), y + 12);
  y += 30;
  doc.rect(xVal - 6, y - 3, 106, 17).fill(CINZA).fillColor(TEXTO);
  linha('Total Líquido:', brl(o.total), y, true);
  y += 26;
  doc.moveTo(M - 4, y).lineTo(M + LARG + 4, y).lineWidth(0.8).strokeColor('#999999').stroke();
  y += 6;
  doc.font('Helvetica').fontSize(9.5).fillColor(TEXTO);
  doc.text('Condição de Pagto.: A COMBINAR', M, y, { lineBreak: false });
  doc.text(`Validade da proposta: ${o.validade ?? '—'}`, M + LARG - 200, y, { width: 200, align: 'right', lineBreak: false });
  y += 14;
  if (o.observacao) {
    doc.fillColor(SUAVE).fontSize(8.5).text(`Obs.: ${o.observacao}`, M, y, { width: LARG });
    y = doc.y + 4;
  }
  return y;
}

function rodape(doc: PDFKit.PDFDocument, o: PdfOrcamento) {
  const y = A4.h - M - 24;
  doc.moveTo(M - 4, y).lineTo(M + LARG + 4, y).lineWidth(1.2).strokeColor('#999999').stroke();
  doc.fillColor(SUAVE).font('Helvetica').fontSize(8);
  doc.text('Preços sujeitos a disponibilidade de estoque na data do pedido. Frete a combinar.', M, y + 6, { lineBreak: false });
  doc.text(`Informe o nº ${o.numero} ao fazer o pedido.`, M + LARG - 200, y + 6, { width: 200, align: 'right', lineBreak: false });
  doc.fillColor(TEXTO);
}
