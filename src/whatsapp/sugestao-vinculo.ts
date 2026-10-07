/**
 * Sugestão de cliente para número de WhatsApp sem vínculo.
 *
 * Função pura: recebe as conversas sem cliente, os orçamentos dos mesmos
 * vendedores na janela e o cadastro de clientes, e devolve os candidatos com a
 * evidência de cada voto. Quem confirma é uma pessoa (1 toque na tela); aqui só
 * se ordena e se explica.
 *
 * Três sinais, cada um vale um voto:
 *  - PRODUTO: no mesmo dia (Cuiabá) em que o vendedor orçou para o cliente, a
 *    conversa citou um termo distintivo da descrição dos itens (ex.: "HB20").
 *    Peso do termo = raridade entre as descrições orçadas (idf); termo comum
 *    ("para-brisa", "dianteiro") não conta. Medido nos números já vinculados:
 *    acerta 70% sozinho.
 *  - ENTREGA: o orçamento da intranet foi entregue pelo WhatsApp e, no mesmo
 *    instante (±3 min), a mensagem enviada mais próxima da sessão do vendedor foi
 *    para esta conversa. Sozinho acerta 57% (o vendedor atende várias ao mesmo
 *    tempo) — por isso é voto, não decisão.
 *  - NOME: o nome salvo na agenda do celular corporativo casa com o nome ou o
 *    contato do cliente no ERP por termo distintivo.
 * Dia em comum, sozinho, NÃO vota: o vendedor orça para dezenas de clientes por
 * dia (medido: 8% de acerto).
 *
 * Confiança: ALTA = 2+ votos e 60%+ deles no mesmo cliente (medido 91% nos já
 * vinculados); MEDIA = 1+ voto e MAIS da metade (empate não é palpite); o
 * resto fica sem sugestão.
 */

export type TipoEvidencia = 'PRODUTO' | 'ENTREGA' | 'NOME';

export interface ConversaSemCliente {
  chave: string;
  rep: number | null;
  /** Texto da conversa (corpo + transcrição) por dia 'aaaa-mm-dd' de Cuiabá. */
  textoPorDia: Map<string, string>;
  nomeAgenda: string | null;
}

export interface OrcamentoJanela {
  origem: 'CELTA' | 'INTRANET';
  numero: string;
  rep: number;
  cli: number;
  cliNome: string | null;
  /** 'aaaa-mm-dd' de Cuiabá. */
  dia: string;
  itens: string[];
}

/** Orçamento da intranet entregue pelo WhatsApp → conversa da msg mais próxima. */
export interface EntregaCasada {
  chave: string;
  rep: number;
  cli: number;
  cliNome: string | null;
  numero: string;
  entregueEm: Date;
}

export interface ClienteCadastro {
  cli: number;
  nome: string;
  contato: string | null;
}

export interface Sugestao {
  cli_codigo: number;
  cli_nome: string | null;
  votos: number;
  evidencias: Array<{ tipo: TipoEvidencia; texto: string }>;
}

export interface ResultadoSugestao {
  confianca: 'ALTA' | 'MEDIA' | null;
  sugestoes: Sugestao[];
}

const LIMIAR_PRODUTO = 5;
const LIMIAR_NOME = 4;

/** Termos genéricos do ramo e da conversa: não distinguem cliente nem produto. */
const GENERICOS = new Set(
  (
    'PARA BRISA DIANT DIANTEIRO DIANTEIRA TRAS TRASEIRO TRASEIRA PRETO PRETA LISO LISA COM SEM PORTA ' +
    'VIDRO VIDROS LADO ESQ DIR ESQUERDO DIREITO DIREITA ESQUERDA CAPA GRADE FAROL LANTERNA MOTOR ' +
    'BORRACHA JOGO KIT PECA PECAS UNIDADE MODELO ANO QUE NAO SIM TEM VOCE BOM DIA TARDE NOITE OBRIGADO ' +
    'OBRIGADA VALOR PRECO QUANTO FICA PODE MANDA MANDAR ESSE ESSA ESTE ESTA AQUI ELE ELA MAS POR FAVOR ' +
    'TUDO BEM OLA CHOQUE LAMA PROTETOR TAMPA CENTRAL FURO VIDRACARIA AUTO AUTOPECAS AUTOMOTIVO ' +
    'AUTOMOTIVA COMERCIO LTDA EIRELI CIA DOS DAS SERVICOS INSTALACAO INSTALADORA DISTRIBUIDORA ' +
    'ACESSORIOS OFICINA MECANICA FUNILARIA'
  ).split(' '),
);

export function normalizar(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
}

/** Termos distintivos: 3+ caracteres, começa por letra, fora da lista genérica. */
export function termos(s: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const t of normalizar(s).match(/[A-Z][A-Z0-9]{2,}/g) ?? []) {
    if (!GENERICOS.has(t)) out.add(t);
  }
  return out;
}

/** idf de cada termo sobre uma coleção de documentos (cada doc = conjunto de termos). */
function idf(docs: Array<Set<string>>): Map<string, number> {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d) df.set(t, (df.get(t) ?? 0) + 1);
  const n = Math.max(docs.length, 1);
  return new Map([...df].map(([t, k]) => [t, Math.log(n / k)]));
}

const fmtDia = (dia: string) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;

export function sugerirVinculos(
  conversas: ConversaSemCliente[],
  orcamentos: OrcamentoJanela[],
  entregas: EntregaCasada[],
  clientes: ClienteCadastro[],
): Map<string, ResultadoSugestao> {
  const termosOrc = orcamentos.map((o) => termos(o.itens.join(' ')));
  const idfProd = idf(termosOrc);
  const termosCli = clientes.map((c) => termos(`${c.nome} ${c.contato ?? ''}`));
  const idfNome = idf(termosCli);
  const nomeDe = new Map<number, string | null>();
  for (const c of clientes) nomeDe.set(c.cli, c.nome);
  for (const o of orcamentos) if (o.cliNome) nomeDe.set(o.cli, o.cliNome);

  // orçamentos por vendedor+dia (o laço só olha o que pode casar)
  const porRepDia = new Map<string, number[]>();
  orcamentos.forEach((o, i) => {
    const k = `${o.rep}|${o.dia}`;
    (porRepDia.get(k) ?? porRepDia.set(k, []).get(k)!).push(i);
  });
  const entregasPorChave = new Map<string, EntregaCasada[]>();
  for (const e of entregas) (entregasPorChave.get(e.chave) ?? entregasPorChave.set(e.chave, []).get(e.chave)!).push(e);

  const resultado = new Map<string, ResultadoSugestao>();
  for (const conv of conversas) {
    const votos = new Map<number, Sugestao>();
    const votar = (cli: number, cliNome: string | null, tipo: TipoEvidencia, texto: string) => {
      const s = votos.get(cli) ?? { cli_codigo: cli, cli_nome: cliNome ?? nomeDe.get(cli) ?? null, votos: 0, evidencias: [] };
      s.votos += 1;
      s.evidencias.push({ tipo, texto });
      votos.set(cli, s);
    };

    // PRODUTO: um voto por orçamento cujo item foi citado no mesmo dia
    if (conv.rep != null) {
      for (const [dia, texto] of conv.textoPorDia) {
        const citados = termos(texto);
        if (!citados.size) continue;
        for (const i of porRepDia.get(`${conv.rep}|${dia}`) ?? []) {
          const comuns = [...termosOrc[i]].filter((t) => citados.has(t));
          const peso = comuns.reduce((s, t) => s + (idfProd.get(t) ?? 0), 0);
          if (peso < LIMIAR_PRODUTO) continue;
          const o = orcamentos[i];
          const rotulo = o.origem === 'INTRANET' ? 'orçamento da intranet' : 'orçamento';
          votar(o.cli, o.cliNome, 'PRODUTO', `${rotulo} ${o.numero} (${fmtDia(o.dia)}): conversa citou ${comuns.slice(0, 3).join(', ')}`);
        }
      }
    }

    // ENTREGA
    for (const e of entregasPorChave.get(conv.chave) ?? []) {
      const hh = e.entregueEm.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Cuiaba' });
      const dd = e.entregueEm.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Cuiaba' });
      votar(e.cli, e.cliNome, 'ENTREGA', `orçamento da intranet ${e.numero} entregue ${dd} ${hh}, mensagem enviada a este número no mesmo minuto`);
    }

    // NOME: melhor cliente por termos raros do nome da agenda, só se destacado do 2º
    const agenda = termos(conv.nomeAgenda);
    if (agenda.size) {
      let melhor = { i: -1, peso: 0, comuns: [] as string[] };
      let segundo = 0;
      termosCli.forEach((tc, i) => {
        const comuns = [...agenda].filter((t) => tc.has(t));
        const peso = comuns.reduce((s, t) => s + (idfNome.get(t) ?? 0), 0);
        if (peso > melhor.peso) {
          segundo = melhor.peso;
          melhor = { i, peso, comuns };
        } else if (peso > segundo) segundo = peso;
      });
      if (melhor.i >= 0 && melhor.peso >= LIMIAR_NOME && melhor.peso >= segundo * 1.5) {
        const c = clientes[melhor.i];
        votar(c.cli, c.nome, 'NOME', `salvo na agenda como "${conv.nomeAgenda}" (${melhor.comuns.join(', ')})`);
      }
    }

    const sugestoes = [...votos.values()].sort((a, b) => b.votos - a.votos || a.cli_codigo - b.cli_codigo);
    const total = sugestoes.reduce((s, x) => s + x.votos, 0);
    const top = sugestoes[0];
    const share = top ? top.votos / total : 0;
    const confianca = top && top.votos >= 2 && share >= 0.6 ? 'ALTA' : top && share > 0.5 ? 'MEDIA' : null;
    resultado.set(conv.chave, { confianca, sugestoes: sugestoes.slice(0, 3) });
  }
  return resultado;
}
