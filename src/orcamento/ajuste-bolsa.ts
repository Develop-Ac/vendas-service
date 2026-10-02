import { round2, round4 } from './regua';

/* =============================================================================
   AJUSTE DA BOLSA NEGATIVA — produto avariado, usado ou com embalagem danificada.
   -----------------------------------------------------------------------------
   O item entra pelo custo normal e só vende com desconto extra, deixando a linha
   negativa na bolsa do vendedor. Quem tem permissão diz quanto da linha AINDA sai
   da bolsa (entre o negativo e zero); a diferença, por unidade, é o que a empresa
   assume (`assumido_unit`). O ajuste só entra na bolsa quando a NF sai, casada
   com o orçamento importado no Celta — e nunca além do negativo real da NF.
   ============================================================================= */

export type MotivoAjuste = 'AVARIADO' | 'USADO' | 'EMBALAGEM' | 'OUTRO';
export const MOTIVOS_AJUSTE: MotivoAjuste[] = ['AVARIADO', 'USADO', 'EMBALAGEM', 'OUTRO'];
export interface NfChave { empresa: number; serie: string; nfs: number }

export const JANELA_DIAS_PADRAO = 30;
const DIA_MS = 86_400_000;

export function validarAjuste(e: {
  negativo_linha: number;
  valor: number;
  quantidade: number;
  motivo: string;
  justificativa: string;
  proprio: boolean;
  servico: boolean;
}): { ok: true; assumido_unit: number } | { ok: false; erro: string } {
  if (e.servico) return { ok: false, erro: 'Serviço não tem ajuste de bolsa.' };
  if (e.proprio) return { ok: false, erro: 'Não é permitido ajustar o próprio orçamento.' };
  if (!MOTIVOS_AJUSTE.includes(e.motivo as MotivoAjuste)) return { ok: false, erro: 'Motivo inválido.' };
  if ((e.justificativa ?? '').trim().length < 10) return { ok: false, erro: 'Justificativa obrigatória (mínimo 10 caracteres).' };
  if (!(e.quantidade > 0)) return { ok: false, erro: 'Quantidade inválida.' };
  const negativo = round2(e.negativo_linha);
  if (!(negativo < 0)) return { ok: false, erro: 'A linha não está negativa na bolsa.' };
  const valor = round2(e.valor);
  if (!Number.isFinite(valor) || valor > 0) return { ok: false, erro: 'O valor não pode ser positivo: no máximo zera a linha.' };
  if (valor < negativo) return { ok: false, erro: `O valor não pode ser menor que o negativo da linha (${negativo.toFixed(2)}).` };
  // valor = negativo: a empresa não assume nada, não há ajuste a gravar.
  if (valor === negativo) return { ok: false, erro: 'O valor é igual ao negativo da linha: nada a ajustar.' };
  // por unidade com 4 casas, para que assumido_unit × qtd devolva o valor digitado em centavos
  return { ok: true, assumido_unit: round4((valor - negativo) / e.quantidade) };
}

export interface AjusteParaCasar {
  id: string; pro_codigo: number; cli_codigo: number; rep_codigo: number;
  quantidade: number; assumido_unit: number; preco_unit: number;
  importado_em: Date | null;
  nf_orcamento: NfChave | null;
  nfs_condicional: NfChave[];
}
export interface LinhaNf extends NfChave {
  pro_codigo: number; cli_codigo: number; rep_codigo: number;
  emissao: Date; devolucao: boolean; quantidade: number;
  preco_unit: number; liquido: number; custo: number;
  promocao: boolean;
}
export type SituacaoAjuste = 'AGUARDANDO_NF' | 'APLICADO' | 'PARCIAL' | 'EXPIRADO' | 'SEM_CELTA';

type NfDoAjuste = NfChave & { emissao: Date; quantidade: number; efetivo: number; devolucao: boolean };

export const mesmaNf = (a: NfChave, b: NfChave) => a.empresa === b.empresa && String(a.serie).trim() === String(b.serie).trim() && a.nfs === b.nfs;
const chave = (l: LinhaNf): NfChave => ({ empresa: l.empresa, serie: l.serie, nfs: l.nfs });

/** Janela do fallback em dias de calendário: do dia da importação até o fim do dia importação + janela
 *  (a NF traz só a data; a importação traz hora — NF do mesmo dia tem de casar). */
export function janela(importado: Date, dias: number) {
  const inicio = new Date(importado);
  inicio.setHours(0, 0, 0, 0);
  return { inicio: inicio.getTime(), fim: inicio.getTime() + (dias + 1) * DIA_MS };
}

export function casarAjustes(ajustes: AjusteParaCasar[], linhas: LinhaNf[], o: { piso: number; hoje: Date; janela_dias?: number }) {
  const dias = o.janela_dias ?? JANELA_DIAS_PADRAO;
  const porEmissao = (a: number, b: number) => linhas[a].emissao.getTime() - linhas[b].emissao.getTime();
  // unidades de cada linha de NF ainda livres: cada unidade recebe ajuste uma vez
  const livre = linhas.map((l) => l.quantidade);
  const efetivoLinha = new Map<number, number>();
  const somaLinha = (i: number, v: number) => efetivoLinha.set(i, (efetivoLinha.get(i) ?? 0) + v);

  // disputa pela mesma linha: o orçamento importado antes leva
  const ordem = ajustes
    .map((a, i) => i)
    .sort((a, b) => (ajustes[a].importado_em?.getTime() ?? Infinity) - (ajustes[b].importado_em?.getTime() ?? Infinity));

  const res = ajustes.map((a) => ({
    id: a.id, qtd_casada: 0, efetivo: 0, situacao: 'SEM_CELTA' as SituacaoAjuste,
    nfs: [] as NfDoAjuste[],
    vendas: [] as { emissao: number; qtd: number; efetivo: number }[],
  }));

  for (const k of ordem) {
    const a = ajustes[k];
    const r = res[k];
    if (!a.importado_em) continue;
    const vendas = linhas.map((_, i) => i).filter((i) => !linhas[i].devolucao && linhas[i].pro_codigo === a.pro_codigo);
    const j = janela(a.importado_em, dias);
    // prioridade: NF gravada no orçamento → NFs do condicional → NF do cliente/vendedor na janela a preço cheio.
    // Uma prioridade sem linha do produto cede à próxima.
    const candidatos = [
      a.nf_orcamento ? vendas.filter((i) => mesmaNf(linhas[i], a.nf_orcamento!)) : [],
      vendas.filter((i) => a.nfs_condicional.some((n) => mesmaNf(linhas[i], n))),
      vendas.filter((i) => {
        const l = linhas[i];
        const t = l.emissao.getTime();
        return l.cli_codigo === a.cli_codigo && l.rep_codigo === a.rep_codigo && t >= j.inicio && t < j.fim && l.preco_unit >= a.preco_unit - 0.01;
      }),
    ].find((c) => c.length > 0) ?? [];

    let falta = a.quantidade;
    for (const i of candidatos.sort(porEmissao)) {
      if (falta <= 0) break;
      const q = Math.min(falta, livre[i]);
      if (q <= 0) continue;
      livre[i] -= q;
      falta -= q;
      const l = linhas[i];
      // negativo real da parte casada da linha; na promoção a empresa já absorve a metade
      let negReal = Math.max(0, l.custo * o.piso - l.liquido) * (q / l.quantidade);
      if (l.promocao) negReal /= 2;
      const efetivo = round2(Math.min(a.assumido_unit * q, negReal));
      r.qtd_casada += q;
      r.vendas.push({ emissao: l.emissao.getTime(), qtd: q, efetivo });
      r.nfs.push({ ...chave(l), emissao: l.emissao, quantidade: q, efetivo, devolucao: false });
      somaLinha(i, efetivo);
    }

    r.situacao = r.qtd_casada >= a.quantidade ? 'APLICADO'
      : r.qtd_casada > 0 ? 'PARCIAL'
      : o.hoje.getTime() >= j.fim ? 'EXPIRADO' : 'AGUARDANDO_NF';
  }

  // Devolução do mesmo cliente + produto, a partir da venda casada: estorna o assumido das unidades
  // devolvidas (até a qtd casada), sem nunca devolver mais do que foi creditado.
  const estornadoQtd = res.map(() => 0);
  const estornadoValor = res.map(() => 0);
  const devolucoes = linhas.map((_, i) => i).filter((i) => linhas[i].devolucao).sort(porEmissao);
  for (const i of devolucoes) {
    const d = linhas[i];
    let resta = d.quantidade;
    for (const k of ordem) {
      if (resta <= 0) break;
      const a = ajustes[k];
      const r = res[k];
      if (a.cli_codigo !== d.cli_codigo || a.pro_codigo !== d.pro_codigo) continue;
      const antes = r.vendas.filter((v) => v.emissao <= d.emissao.getTime());
      const qtd = Math.min(resta, antes.reduce((s, v) => s + v.qtd, 0) - estornadoQtd[k]);
      if (qtd <= 0) continue;
      const creditado = r.vendas.reduce((s, v) => s + v.efetivo, 0);
      const valor = round2(Math.min(a.assumido_unit * qtd, creditado - estornadoValor[k]));
      resta -= qtd;
      estornadoQtd[k] += qtd;
      estornadoValor[k] += valor;
      r.nfs.push({ ...chave(d), emissao: d.emissao, quantidade: qtd, efetivo: -valor, devolucao: true });
      somaLinha(i, -valor);
    }
  }

  return {
    ajustes: res.map(({ vendas, ...r }) => ({ ...r, efetivo: round2(r.nfs.reduce((s, n) => s + n.efetivo, 0)) })),
    linhas: [...efetivoLinha].map(([i, efetivo]) => {
      const l = linhas[i];
      return { ...chave(l), pro_codigo: l.pro_codigo, cli_codigo: l.cli_codigo, rep_codigo: l.rep_codigo, emissao: l.emissao, efetivo: round2(efetivo) };
    }),
  };
}
