/**
 * Retorno de venda perdida ("produto chegou"): a venda perdida por falta de saldo
 * vira sugestão de contato para o vendedor quando o produto volta a ter estoque.
 * Funções puras — o RetornoVendaPerdidaService lê as fontes e grava; a regra fica aqui.
 *
 * Ciclo de um retorno (`ven_venda_perdida_retorno`):
 *   ABERTA → CONTATADA (sinal no prazo) | CANCELADA (saldo zerou dentro do prazo)
 *          → NEGLIGENCIADA (prazo venceu; segue na lista até contato, saldo zerar ou
 *            fim da janela de conversão).
 * `encerrada_em` preenchido = fora da lista do vendedor. Datas do negócio em Cuiabá.
 */
import { hojeYmd, inicioDia, somarDias } from './supervisao.indicadores';

const DIA_MS = 86_400_000;

export interface CfgRetorno {
  /** Dias para o vendedor fazer o contato. */
  prazoDias: number;
  /** Idade máxima da venda perdida para virar retorno. */
  validadeDias: number;
  /** Janela (dias depois da geração) em que uma venda do par conta como conversão. */
  conversaoDias: number;
  /** Data (aaaa-mm-dd) de implantação: venda perdida anterior não gera retorno. */
  inicio: string;
}

export type StatusRetorno = 'ABERTA' | 'CONTATADA' | 'NEGLIGENCIADA' | 'CANCELADA';
export type SinalContato = 'VENDA' | 'ORCAMENTO' | 'MENSAGEM';
type Num = number | { toString(): string };

export interface VendaPerdida {
  id: string;
  cli_codigo: number | null;
  pro_codigo: number;
  descricao: string | null;
  quantidade: Num;
  rep_codigo: number | null;
  created_at: Date;
  ven_orcamento?: { cli_nome: string | null } | null;
}

export interface Candidato {
  venda_perdida_id: string;
  venda_perdida_em: Date;
  cli_codigo: number;
  cli_nome: string | null;
  pro_codigo: number;
  descricao: string | null;
  quantidade_pedida: number;
  rep_codigo: number | null;
}

/** Linha de NF do par (venda ou devolução), emissão aaaa-mm-dd. */
export interface LinhaNf {
  cli_codigo: number;
  pro_codigo: number;
  emissao: string;
  devolucao: boolean;
  quantidade: number;
  liquido: number;
}

export interface Retorno {
  id: string;
  cli_codigo: number;
  cli_nome: string | null;
  pro_codigo: number;
  descricao: string | null;
  quantidade_pedida: Num;
  saldo_na_geracao: Num;
  venda_perdida_em: Date;
  rep_codigo: number;
  rep_nome: string | null;
  gerada_em: Date;
  prazo_em: Date;
  status: string;
  contato_em: Date | null;
  contato_sinal: string | null;
  encerrada_em: Date | null;
  convertida_em: Date | null;
  convertida_qtd: Num | null;
  convertida_valor: Num | null;
}

const par = (cli: number, pro: number) => `${cli}:${pro}`;
const ymd = (d: Date) => new Date(d).toISOString().slice(0, 10);

/**
 * Vendas perdidas que podem virar retorno: com cliente, dentro da validade e a partir do
 * dia de implantação; a mais recente por par cliente+produto. Sai o par com retorno aberto
 * ou com retorno gerado depois dessa venda perdida (CANCELADA não conta: o saldo zerou
 * antes do contato e o produto pode chegar de novo).
 */
export function candidatos(
  vendas: VendaPerdida[],
  existentes: Array<{ cli_codigo: number; pro_codigo: number; gerada_em: Date; status: string; encerrada_em: Date | null }>,
  cfg: CfgRetorno,
  agora: Date,
): Candidato[] {
  const corte = Math.max(agora.getTime() - cfg.validadeDias * DIA_MS, inicioDia(cfg.inicio).getTime());
  const recente = new Map<string, VendaPerdida & { cli_codigo: number }>();
  for (const v of vendas) {
    if (v.cli_codigo == null || new Date(v.created_at).getTime() < corte) continue;
    const k = par(v.cli_codigo, v.pro_codigo);
    const atual = recente.get(k);
    if (!atual || new Date(v.created_at) > new Date(atual.created_at)) recente.set(k, v as VendaPerdida & { cli_codigo: number });
  }
  const r: Candidato[] = [];
  for (const [k, v] of recente) {
    const bloqueia = existentes.some(
      (e) =>
        par(e.cli_codigo, e.pro_codigo) === k &&
        (e.encerrada_em == null || (e.status !== 'CANCELADA' && new Date(e.gerada_em) > new Date(v.created_at))),
    );
    if (bloqueia) continue;
    r.push({
      venda_perdida_id: v.id,
      venda_perdida_em: new Date(v.created_at),
      cli_codigo: v.cli_codigo,
      cli_nome: v.ven_orcamento?.cli_nome ?? null,
      pro_codigo: v.pro_codigo,
      descricao: v.descricao,
      quantidade_pedida: Number(v.quantidade),
      rep_codigo: v.rep_codigo,
    });
  }
  return r;
}

/**
 * Gera quando o saldo é conhecido e positivo, o produto está ativo e o cliente não comprou
 * o produto depois do dia da venda perdida. Produto fora da consulta de saldo = desconhecido.
 */
export function elegivel(
  c: Candidato,
  produto: { saldo: number; inativo: boolean } | undefined,
  linhas: LinhaNf[],
): boolean {
  if (!produto || !(produto.saldo > 0) || produto.inativo) return false;
  const dia = hojeYmd(c.venda_perdida_em);
  return !linhas.some((l) => l.cli_codigo === c.cli_codigo && l.pro_codigo === c.pro_codigo && !l.devolucao && l.emissao > dia);
}

/**
 * Para quem vai o retorno: dono da carteira (ou o substituto, com cobertura ativa do dono);
 * cliente fora de carteira vai a quem registrou a venda perdida, se ainda for do atacado.
 * `rep_nome` nulo no último caso: o serviço resolve o nome.
 */
export function destino(
  c: Candidato,
  cliente: { em_carteira: boolean; status: string; rep_codigo: number | null; rep_nome: string | null } | undefined,
  cobertura: { rep_substituto_codigo: number; rep_substituto_nome: string | null } | undefined,
  ativos: Set<number>,
): { rep_codigo: number; rep_nome: string | null } | null {
  if (cliente?.em_carteira && cliente.status !== 'DISPONIVEL' && cliente.rep_codigo != null) {
    if (cobertura) return { rep_codigo: cobertura.rep_substituto_codigo, rep_nome: cobertura.rep_substituto_nome };
    return { rep_codigo: cliente.rep_codigo, rep_nome: cliente.rep_nome };
  }
  if (c.rep_codigo != null && ativos.has(c.rep_codigo)) return { rep_codigo: c.rep_codigo, rep_nome: null };
  return null;
}

/**
 * Sinal de contato depois da geração, como na fila: venda (resultado) > orçamento
 * (proposta) > mensagem (WhatsApp). A data é a do sinal mais forte.
 */
export function sinalDeContato(
  gerada_em: Date,
  s: { data_ult_compra?: Date | null; ult_orcamento?: Date | null; mensagem?: Date | null },
): { sinal: SinalContato; em: Date } | null {
  const gerada = new Date(gerada_em).getTime();
  const depois = (d: Date | null | undefined) => (d && new Date(d).getTime() > gerada ? new Date(d) : null);
  const compra = depois(s.data_ult_compra);
  const orc = depois(s.ult_orcamento);
  const msg = depois(s.mensagem);
  if (compra) return { sinal: 'VENDA', em: compra };
  if (orc) return { sinal: 'ORCAMENTO', em: orc };
  if (msg) return { sinal: 'MENSAGEM', em: msg };
  return null;
}

export interface MudancaRetorno {
  status?: StatusRetorno;
  contato_em?: Date;
  contato_sinal?: SinalContato;
  cancelada_em?: Date;
  encerrada_em?: Date;
}

/**
 * Próximo estado de um retorno da lista (encerrada_em nulo); null = nada a gravar.
 * `saldo` undefined = desconhecido (leitura da fila, ERP fora): nunca cancela nem encerra por saldo.
 */
export function transicao(
  r: Pick<Retorno, 'status' | 'gerada_em' | 'prazo_em' | 'encerrada_em'>,
  e: { sinal: { sinal: SinalContato; em: Date } | null; saldo?: number; agora: Date },
  cfg: CfgRetorno,
): MudancaRetorno | null {
  if (r.encerrada_em != null) return null;
  const { sinal, saldo, agora } = e;
  const prazo = new Date(r.prazo_em).getTime();
  if (sinal) {
    return {
      status: sinal.em.getTime() <= prazo ? 'CONTATADA' : 'NEGLIGENCIADA',
      contato_em: sinal.em,
      contato_sinal: sinal.sinal,
      encerrada_em: agora,
    };
  }
  const semSaldo = saldo != null && saldo <= 0;
  if (r.status === 'ABERTA' && agora.getTime() <= prazo) {
    return semSaldo ? { status: 'CANCELADA', cancelada_em: agora, encerrada_em: agora } : null;
  }
  // Prazo vencido: NEGLIGENCIADA segue na lista até o saldo zerar ou a janela de conversão fechar.
  const m: MudancaRetorno = r.status === 'ABERTA' ? { status: 'NEGLIGENCIADA' } : {};
  if (semSaldo || agora.getTime() >= new Date(r.gerada_em).getTime() + cfg.conversaoDias * DIA_MS) m.encerrada_em = agora;
  return Object.keys(m).length ? m : null;
}

/**
 * Conversão: vendas do par do dia (Cuiabá) da geração até `conversaoDias` depois, líquidas
 * de devolução. Quantidade líquida <= 0 = não converteu (campos nulos).
 */
export function conversao(
  r: Pick<Retorno, 'cli_codigo' | 'pro_codigo' | 'gerada_em'>,
  linhas: LinhaNf[],
  cfg: CfgRetorno,
): { convertida_em: Date | null; convertida_qtd: number | null; convertida_valor: number | null } {
  const de = hojeYmd(new Date(r.gerada_em));
  const ate = somarDias(de, cfg.conversaoDias);
  let qtd = 0;
  let valor = 0;
  let primeira: string | null = null;
  for (const l of linhas) {
    if (l.cli_codigo !== r.cli_codigo || l.pro_codigo !== r.pro_codigo || l.emissao < de || l.emissao > ate) continue;
    const s = l.devolucao ? -1 : 1;
    qtd += s * Number(l.quantidade);
    valor += s * Number(l.liquido);
    if (!l.devolucao && (primeira == null || l.emissao < primeira)) primeira = l.emissao;
  }
  if (qtd <= 0 || primeira == null) return { convertida_em: null, convertida_qtd: null, convertida_valor: null };
  return { convertida_em: new Date(`${primeira}T00:00:00Z`), convertida_qtd: qtd, convertida_valor: valor };
}

/** Vendeu sem o vendedor ter feito o contato antes (ou o "contato" foi a própria venda). */
export function converteuSemContato(
  r: Pick<Retorno, 'status' | 'contato_em' | 'contato_sinal' | 'convertida_em' | 'convertida_qtd'>,
): boolean {
  if (r.status !== 'NEGLIGENCIADA' || r.convertida_em == null || !(Number(r.convertida_qtd) > 0)) return false;
  if (r.contato_em == null || r.contato_sinal === 'VENDA') return true;
  return hojeYmd(new Date(r.contato_em)) > ymd(r.convertida_em);
}

export interface GrupoRetorno {
  cli_codigo: number;
  cli_nome: string | null;
  fone: string | null;
  rep_codigo: number | null;
  rep_nome: string | null;
  prazo_em: string;
  atrasada: boolean;
  produtos: Array<{
    id: string;
    pro_codigo: number;
    descricao: string | null;
    quantidade_pedida: number;
    saldo_na_geracao: number;
    venda_perdida_em: string;
    gerada_em: string;
    prazo_em: string;
    status: 'ABERTA' | 'NEGLIGENCIADA';
  }>;
}

/** Lista "Produto chegou" da fila: um grupo por cliente + vendedor; atrasadas primeiro, depois o prazo mais próximo. */
export function agruparPorCliente(abertos: Retorno[], fone: Map<number, string | null>): GrupoRetorno[] {
  const grupos = new Map<string, GrupoRetorno>();
  for (const r of [...abertos].sort((a, b) => new Date(a.prazo_em).getTime() - new Date(b.prazo_em).getTime())) {
    const k = `${r.cli_codigo}:${r.rep_codigo}`;
    const prazo = new Date(r.prazo_em).toISOString();
    let g = grupos.get(k);
    if (!g) {
      g = { cli_codigo: r.cli_codigo, cli_nome: r.cli_nome, fone: fone.get(r.cli_codigo) ?? null, rep_codigo: r.rep_codigo, rep_nome: r.rep_nome, prazo_em: prazo, atrasada: false, produtos: [] };
      grupos.set(k, g);
    }
    g.cli_nome ??= r.cli_nome;
    g.rep_nome ??= r.rep_nome;
    if (r.status === 'NEGLIGENCIADA') g.atrasada = true;
    g.produtos.push({
      id: r.id,
      pro_codigo: r.pro_codigo,
      descricao: r.descricao,
      quantidade_pedida: Number(r.quantidade_pedida),
      saldo_na_geracao: Number(r.saldo_na_geracao),
      venda_perdida_em: new Date(r.venda_perdida_em).toISOString(),
      gerada_em: new Date(r.gerada_em).toISOString(),
      prazo_em: prazo,
      status: r.status === 'NEGLIGENCIADA' ? 'NEGLIGENCIADA' : 'ABERTA',
    });
  }
  return [...grupos.values()].sort((a, b) => Number(b.atrasada) - Number(a.atrasada) || a.prazo_em.localeCompare(b.prazo_em));
}

export interface LinhaRetorno {
  geradas: number;
  contatadas_no_prazo: number;
  negligenciadas: number;
  canceladas: number;
  em_aberto: number;
  convertidas: { valor: number; quantidade: number };
  convertidas_sem_contato: { valor: number; quantidade: number };
}

const linhaVazia = (): LinhaRetorno => ({
  geradas: 0,
  contatadas_no_prazo: 0,
  negligenciadas: 0,
  canceladas: 0,
  em_aberto: 0,
  convertidas: { valor: 0, quantidade: 0 },
  convertidas_sem_contato: { valor: 0, quantidade: 0 },
});

/**
 * Quadro da aba Equipe: retornos gerados no período por vendedor e total.
 * geradas = contatadas_no_prazo + negligenciadas + canceladas + em_aberto (ABERTA).
 * `quantidade` das convertidas = número de retornos convertidos.
 */
export function resumirRetornos(retornos: Retorno[]): {
  vendedores: Array<{ rep_codigo: number; rep_nome: string | null } & LinhaRetorno>;
  total: LinhaRetorno;
} {
  const porRep = new Map<number, { rep_codigo: number; rep_nome: string | null } & LinhaRetorno>();
  const total = linhaVazia();
  for (const r of retornos) {
    let v = porRep.get(r.rep_codigo);
    if (!v) {
      v = { rep_codigo: r.rep_codigo, rep_nome: r.rep_nome, ...linhaVazia() };
      porRep.set(r.rep_codigo, v);
    }
    v.rep_nome ??= r.rep_nome;
    const convertida = r.convertida_em != null && Number(r.convertida_qtd) > 0;
    const semContato = converteuSemContato(r);
    for (const l of [v, total]) {
      l.geradas++;
      if (r.status === 'CONTATADA') l.contatadas_no_prazo++;
      else if (r.status === 'NEGLIGENCIADA') l.negligenciadas++;
      else if (r.status === 'CANCELADA') l.canceladas++;
      else l.em_aberto++;
      if (convertida) {
        l.convertidas.quantidade++;
        l.convertidas.valor += Number(r.convertida_valor ?? 0);
      }
      if (semContato) {
        l.convertidas_sem_contato.quantidade++;
        l.convertidas_sem_contato.valor += Number(r.convertida_valor ?? 0);
      }
    }
  }
  return { vendedores: [...porRep.values()].sort((a, b) => b.geradas - a.geradas), total };
}
