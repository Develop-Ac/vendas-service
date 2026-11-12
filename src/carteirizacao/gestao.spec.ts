import {
  PESOS,
  contarDias,
  disciplina,
  margemMes,
  nivel,
  notasDoOrcamento,
  pisoVenda,
  pontosIndicador,
  premio,
  ritmoNecessario,
  ritmoPrevisao,
  serieAcumulada,
  veredito,
  resumirAuxiliares,
  resumirMotivosPerda,
} from './gestao';
import { diaDaSemana, somarDias } from './supervisao.indicadores';

/** Seg–sex de um intervalo (o BI manda a lista real; aqui basta o desenho). */
const uteisEntre = (ini: string, fim: string): string[] => {
  const r: string[] = [];
  for (let d = ini; d <= fim; d = somarDias(d, 1)) if (![0, 6].includes(diaDaSemana(d))) r.push(d);
  return r;
};

// Caso do aceite: 25 dias úteis no período (datas contínuas só para o teste).
const DIAS25 = Array.from({ length: 25 }, (_, i) => somarDias('2026-10-26', i));

describe('contarDias', () => {
  it('dia corrente útil não conta como fechado nem como restante', () => {
    const d = contarDias(DIAS25, '2026-10-26', '2026-11-25', DIAS25[11]);
    expect(d).toEqual({ total: 25, fechados: 11, restantes: 13, dia_util_corrente: 12, corrente: true });
  });

  it('hoje não útil: restantes = total − fechados', () => {
    const uteis = uteisEntre('2026-10-26', '2026-11-25');
    const d = contarDias(uteis, '2026-10-26', '2026-11-25', '2026-10-31'); // sábado
    expect(d.fechados).toBe(5);
    expect(d.restantes).toBe(uteis.length - 5);
  });

  it('mês encerrado: tudo fechado', () => {
    expect(contarDias(DIAS25, '2026-10-26', '2026-11-25', '2026-12-01')).toEqual({
      total: 25,
      fechados: 25,
      restantes: 0,
      dia_util_corrente: null,
      corrente: false,
    });
  });
});

describe('ritmo e previsão', () => {
  it('caso do aceite: 25 dias, 11 fechados, 225,5 com 8,4 hoje, meta 570', () => {
    const dias = contarDias(DIAS25, '2026-10-26', '2026-11-25', DIAS25[11]);
    const { ritmo, previsao } = ritmoPrevisao({ faturado: 225.5, faturado_hoje: 8.4, dias, encerrado: false });
    expect(ritmo).toBeCloseTo(19.74, 2);
    expect(previsao).toBeCloseTo(493.4, 1);
    expect(ritmoNecessario(570, 225.5, dias.restantes)).toBeCloseTo(26.5, 1);
    expect(veredito(previsao, 570)).toBe('NAO_BATE');
  });

  it('ritmo ignora a venda de hoje', () => {
    const dias = contarDias(DIAS25, '2026-10-26', '2026-11-25', DIAS25[2]);
    expect(ritmoPrevisao({ faturado: 30, faturado_hoje: 10, dias, encerrado: false }).ritmo).toBe(10);
  });

  it('primeiro dia útil: sem base', () => {
    const dias = contarDias(DIAS25, '2026-10-26', '2026-11-25', DIAS25[0]);
    expect(ritmoPrevisao({ faturado: 8, faturado_hoje: 8, dias, encerrado: false })).toEqual({ ritmo: null, previsao: null });
  });

  it('mês encerrado: previsão = faturado', () => {
    const dias = contarDias(DIAS25, '2026-10-26', '2026-11-25', '2026-12-01');
    expect(ritmoPrevisao({ faturado: 600, faturado_hoje: 0, dias, encerrado: true }).previsao).toBe(600);
  });

  it('sem dia restante, ritmo necessário nulo; meta já batida, zero', () => {
    expect(ritmoNecessario(570, 100, 0)).toBeNull();
    expect(ritmoNecessario(570, 600, 3)).toBe(0);
  });
});

describe('veredito', () => {
  it('três cortes', () => {
    expect(veredito(570, 570)).toBe('VAI_BATER');
    expect(veredito(513, 570)).toBe('EM_RISCO'); // 90%
    expect(veredito(512, 570)).toBe('NAO_BATE'); // 89,8%
    expect(veredito(null, 570)).toBeNull();
  });

  it('abaixo do piso manda, mesmo batendo a meta', () => {
    expect(veredito(600, 570, 650)).toBe('ABAIXO_DO_PISO');
    expect(veredito(600, 570, 500)).toBe('VAI_BATER');
  });
});

describe('margem e piso', () => {
  const FATOR = 0.9955;
  const DESP = 0.0467;

  it('piso é a venda em que a margem cobre o custo do departamento', () => {
    const piso = pisoVenda(157_000, 1.6, FATOR, DESP)!;
    expect(margemMes(piso, 1.6, FATOR, DESP)).toBeCloseTo(157_000, 2);
  });

  it('sem markup (ou margem não positiva): sem base', () => {
    expect(pisoVenda(157_000, null, FATOR, DESP)).toBeNull();
    expect(pisoVenda(157_000, 0, FATOR, DESP)).toBeNull();
    expect(pisoVenda(157_000, 1.02, FATOR, DESP)).toBeNull();
    expect(margemMes(500_000, null, FATOR, DESP)).toBeNull();
  });
});

describe('nível', () => {
  it('sem o nível 1 não há 2 nem 3', () => {
    expect(nivel({ venda: 700_000, margem: 100_000, custoDepto: 157_000, meta: 570_000 })).toBe(0);
    expect(nivel({ venda: 700_000, margem: null, custoDepto: 157_000, meta: 570_000 })).toBe(0);
    // sem meta cadastrada não há base, mesmo com a margem cobrindo o custo
    expect(nivel({ venda: 700_000, margem: 200_000, custoDepto: 157_000, meta: 0 })).toBe(0);
  });

  it('com o nível 1: 1, 2 e 3 pela meta', () => {
    const base = { margem: 160_000, custoDepto: 157_000, meta: 570_000 };
    expect(nivel({ ...base, venda: 500_000 })).toBe(1);
    expect(nivel({ ...base, venda: 570_000 })).toBe(2);
    // nível 3 = 110% da meta, exato na divisa
    expect(nivel({ ...base, venda: 626_999.99 })).toBe(2);
    expect(nivel({ ...base, venda: 627_000 })).toBe(3);
  });
});

describe('pontos e disciplina', () => {
  it('pontos por semáforo', () => {
    expect(PESOS.CLIENTES_ATIVOS_MES + PESOS.RECUPERACAO_AB_PCT + PESOS.CURVA_A_COMPRANDO_PCT + PESOS.DISCIPLINA).toBe(100);
    expect(pontosIndicador('verde', 30)).toBe(30);
    expect(pontosIndicador('amarelo', 15)).toBe(7.5);
    expect(pontosIndicador('vermelho', 25)).toBe(0);
    expect(pontosIndicador(null, 25)).toBe(0);
  });

  it('disciplina composta', () => {
    const metas = { metaSla: 90, metaMotivos: 80 };
    expect(disciplina({ sla: 95, motivos: 80, ...metas }).cor).toBe('verde');
    expect(disciplina({ sla: 85, motivos: 72, ...metas }).cor).toBe('amarelo');
    expect(disciplina({ sla: 95, motivos: 69, ...metas }).cor).toBe('vermelho');
    expect(disciplina({ sla: 90, motivos: 72, ...metas }).valor).toBe(95);
    expect(disciplina({ sla: null, motivos: 80, ...metas })).toEqual({ valor: null, cor: null, bonus: 0 });
  });

  it('disciplina: fila de contatos na meta soma 10 p.p. ao resgate (só na disciplina, teto 100)', () => {
    const metas = { metaSla: 90, metaMotivos: 80, metaFila: 80 };
    // 72,7% de resgate é vermelho (< 80); com o bônus vira 82,7% = amarelo
    expect(disciplina({ sla: 72.7, motivos: 86, fila: 91.9, ...metas })).toMatchObject({ cor: 'amarelo', bonus: 10 });
    expect(disciplina({ sla: 72.7, motivos: 86, fila: 79.9, ...metas })).toMatchObject({ cor: 'vermelho', bonus: 0 });
    expect(disciplina({ sla: 72.7, motivos: 86, fila: null, ...metas })).toMatchObject({ cor: 'vermelho', bonus: 0 });
    // longe da faixa o bônus não muda a cor: 36,4 + 10 continua vermelho
    expect(disciplina({ sla: 36.4, motivos: 86, fila: 91.9, ...metas })).toMatchObject({ cor: 'vermelho', bonus: 10 });
    // teto: 95 + 10 conta como 100 → (111,1 + 100) / 2
    expect(disciplina({ sla: 95, motivos: 80, fila: 80, ...metas }).valor).toBe(105.6);
  });
});

describe('prêmio', () => {
  const valores = { n1: 800, n2: 1500, n3: 2000 };

  it('valor do nível × pontos ÷ 100', () => {
    expect(premio({ nivel: 2, pontos: 85, valores, travaBolsa: false })).toBe(1275);
    expect(premio({ nivel: 0, pontos: 100, valores, travaBolsa: false })).toBe(0);
  });

  it('trava da bolsa zera', () => {
    expect(premio({ nivel: 3, pontos: 100, valores, travaBolsa: true })).toBe(0);
  });
});

describe('série acumulada', () => {
  it('venda de dia não útil soma no próximo dia útil', () => {
    const uteis = ['2026-10-30', '2026-11-02', '2026-11-03'];
    const porDia = [
      { dia: '2026-10-30', valor: 10 },
      { dia: '2026-10-31', valor: 5 }, // sábado
      { dia: '2026-11-02', valor: 20 },
      { dia: '2026-11-03', valor: 7 },
    ];
    expect(serieAcumulada(porDia, uteis, '2026-11-02')).toEqual([
      { dia: '2026-10-30', acumulado: 10 },
      { dia: '2026-11-02', acumulado: 35 },
    ]);
  });
});

describe('notasDoOrcamento + resumirAuxiliares', () => {
  const linha = (nfs: number, rep: number, quantidade: number, liquido: number, devolucao = false) => ({
    empresa: 3, serie: '1', nfs, emissao: new Date('2026-11-05T00:00:00'), rep_codigo: rep, quantidade, liquido, devolucao,
  });

  it('valor = parte casada do líquido de cada linha, somada por nota; devolução abate', () => {
    const linhas = [linha(1, 5, 10, 1_000), linha(1, 5, 2, 300), linha(2, 6, 4, 400), linha(3, 5, 1, 100, true)];
    const r = notasDoOrcamento([{ linha: 0, quantidade: 5 }, { linha: 1, quantidade: 2 }, { linha: 2, quantidade: 1 }, { linha: 3, quantidade: 1 }], linhas);
    expect(r).toEqual([
      { chave: '3-1-1', empresa: 3, serie: '1', nfs: 1, emissao_ymd: '2026-11-05', valor: 800, rep_codigo: 5 },
      { chave: '3-1-2', empresa: 3, serie: '1', nfs: 2, emissao_ymd: '2026-11-05', valor: 100, rep_codigo: 6 },
      { chave: '3-1-3', empresa: 3, serie: '1', nfs: 3, emissao_ymd: '2026-11-05', valor: -100, rep_codigo: 5 },
    ]);
    expect(notasDoOrcamento([], linhas)).toEqual([]);
  });

  it('vendeu do auxiliar soma no vendedor em que a nota saiu', () => {
    const nota = (chave: string, rep: number, valor: number) => ({ chave, empresa: 3, serie: '1', nfs: 1, emissao_ymd: '2026-11-05', valor, rep_codigo: rep });
    const orc = (id: string, rep: number, total: number) => ({ id, rep_codigo: rep, total });
    const { auxiliares, veio_dos_auxiliares } = resumirAuxiliares([
      { orcamento: orc('a', 9, 100), notas: [nota('n1', 5, 100)] },
      { orcamento: orc('b', 9, 50), notas: [nota('n2', 6, 50)] },
      { orcamento: orc('c', 9, 70), notas: [] },
      { orcamento: orc('d', 8, 30), notas: [nota('n4', 5, 30)] },
    ]);
    expect(auxiliares.find((a) => a.rep_codigo === 9)).toEqual({
      rep_codigo: 9,
      orcamentos_fechados: 3,
      vendeu: 150,
      por_vendedor: [
        { rep_codigo: 5, valor: 100 },
        { rep_codigo: 6, valor: 50 },
      ],
      sem_nota: { valor: 70, quantidade: 1 },
    });
    expect(veio_dos_auxiliares).toEqual([
      { rep_codigo: 5, valor: 130 },
      { rep_codigo: 6, valor: 50 },
    ]);
  });
});

describe('resumirMotivosPerda', () => {
  it('soma por motivo, ordena pelo valor e dá a parte de cada um no valor perdido', () => {
    const r = resumirMotivosPerda([
      { motivo: 'PRECO', total: 600 },
      { motivo: 'CLIENTE_ADIOU', total: 100 },
      { motivo: 'PRECO', total: 300 },
    ]);
    expect(r).toEqual({
      quantidade: 3,
      valor: 1000,
      motivos: [
        { motivo: 'PRECO', quantidade: 2, valor: 900, pct: 90 },
        { motivo: 'CLIENTE_ADIOU', quantidade: 1, valor: 100, pct: 10 },
      ],
    });
  });

  it('mês sem motivo apontado devolve placar vazio', () => {
    expect(resumirMotivosPerda([])).toEqual({ quantidade: 0, valor: 0, motivos: [] });
  });
});
