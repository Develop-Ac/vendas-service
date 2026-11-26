import { canalDoPapel, montarEmpresa } from './gestao-empresa';
import type { Dias } from './gestao';

const MIL = 1000;
const HOJE = '2026-11-12';
const DIAS: Dias = { total: 22, fechados: 13, restantes: 9, dia_util_corrente: 14, corrente: true };
const FECHADO: Dias = { total: 22, fechados: 22, restantes: 0, dia_util_corrente: null, corrente: false };

// Massa do critério 2: [rep, nome, papel, vendido (mil), meta (mil)].
// Parte com ordem de serviço: metade da venda do vendedor do varejo, tudo do técnico e 10% do
// atacado (que não separa serviço: fica inteira no atacado).
const PARTE_SERVICO: Record<string, number> = { VENDEDOR: 0.5, TECNICO: 1, VENDEDOR_ATACADO: 0.1 };
const MASSA: Array<[number, string, string, number, number]> = [
  [1, 'Alisson', 'VENDEDOR_ATACADO', 141, 220],
  [2, 'Fernando', 'VENDEDOR_ATACADO', 86, 180],
  [3, 'Gabriel', 'VENDEDOR_ATACADO', 78, 140],
  [4, 'Atacado 4', 'VENDEDOR_ATACADO', 49, 80],
  [5, 'Atacado 5', 'VENDEDOR_ATACADO', 26, 60],
  [6, 'Varejo 6', 'VENDEDOR', 88, 150],
  [7, 'Varejo 7', 'VENDEDOR', 80, 140],
  [8, 'Varejo 8', 'VENDEDOR', 70, 120],
  [9, 'Varejo 9', 'VENDEDOR', 62, 130],
  [10, 'Varejo 10', 'VENDEDOR', 54, 100],
  [11, 'Varejo 11', 'VENDEDOR', 46, 110],
  [12, 'Tecnico 12', 'TECNICO', 24, 0],
  [13, 'Tecnico 13', 'TECNICO', 18, 0],
];

function entrada(encerrado = false) {
  return {
    // Venda partida em dois dias anteriores a hoje (nada vendido hoje).
    linhas: MASSA.flatMap(([rep, nome, papel, v]) =>
      ['2026-11-03', '2026-10-28'].map((dia) => ({
        rep,
        dia,
        nome: ` ${nome.toLowerCase()} `,
        venda: (v * MIL) / 2,
        servico: ((v * MIL) / 2) * PARTE_SERVICO[papel],
        custo: (v * MIL * 0.69) / 2,
        lucro: (v * MIL * 0.31) / 2,
        notas: 5,
      })),
    ),
    metasManuais: MASSA.filter(([rep, , , , m]) => m > 0 && rep === 1).map(([rep, , , , m]) => ({ rep_codigo: rep, valor_meta: m * MIL })),
    metasDw: MASSA.filter(([, , , , m]) => m > 0).map(([rep, nome, , , m]) => ({
      cod_vendedor: rep,
      vendedor: nome,
      valor_total: rep === 1 ? 1 : m * MIL, // a manual do rep 1 manda sobre o DW
    })),
    papeis: MASSA.map(([rep, , papel]) => ({ rep_codigo: rep, papel, inativo: false })),
    ativos: MASSA.map(([rep, nome]) => ({ rep_codigo: rep, nome })),
    dias: encerrado ? FECHADO : DIAS,
    encerrado,
    hoje: HOJE,
  };
}

const canal = (r: ReturnType<typeof montarEmpresa>, c: string) => r.canais.find((x) => x.canal === c)!;
const vend = (r: ReturnType<typeof montarEmpresa>, nome: string) => r.vendedores.find((v) => v.rep_nome === nome)!;

describe('gestão empresa — critério 2 (empresa e canais)', () => {
  const r = montarEmpresa(entrada());

  it('empresa: meta 1.430.000, vendido 822.000, previsão 1.391.077 (97,3%, em risco)', () => {
    expect(r.empresa.meta).toBe(1_430_000);
    expect(r.empresa.faturado).toBe(822_000);
    expect(r.empresa.faturado_hoje).toBe(0);
    expect(Math.round(r.empresa.previsao!)).toBe(1_391_077);
    expect(Math.round((r.empresa.previsao! / r.empresa.meta) * 1000) / 10).toBe(97.3);
    expect(r.empresa.veredito).toBe('EM_RISCO');
    expect(r.empresa.ritmo_para_meta).toBeCloseTo((1_430_000 - 822_000) / 9);
  });

  it('atacado e varejo; o serviço é parte do varejo e conta na mesma meta; outros fora sem venda nem meta', () => {
    expect(r.canais.map((c) => c.canal)).toEqual(['atacado', 'varejo']);
    expect(canal(r, 'atacado')).toMatchObject({ meta: 680_000, faturado: 380_000, servico: 0 });
    expect(Math.round(canal(r, 'atacado').previsao!)).toBe(643_077);
    // varejo = vendedores (400 mil) + técnicos (42 mil); serviço = metade dos vendedores + tudo dos técnicos
    expect(canal(r, 'varejo')).toMatchObject({ meta: 750_000, faturado: 442_000, servico: 242_000 });
    expect(Math.round(canal(r, 'varejo').previsao!)).toBe(748_000);
    expect(canal(r, 'varejo').veredito).toBe('EM_RISCO');
  });

  it('kpis e série', () => {
    expect(r.kpis.lucro_bruto).toBeCloseTo(822_000 * 0.31);
    expect(r.kpis.margem).toBe(31);
    expect(r.kpis.markup).toBe(44.9);
    expect(r.kpis.vendas).toBe(130);
    expect(r.kpis.ticket_medio).toBeCloseTo(822_000 / 130);
    expect(r.serie.meta_diaria).toBeCloseTo(1_430_000 / 22);
    expect(r.serie.dias.map((d) => d.dia)).toEqual(['2026-10-28', '2026-11-03']);
    expect(r.serie.dias[0]).toMatchObject({ atacado: 190_000, varejo: 100_000, servico: 121_000, outros: 0 });
  });
});

describe('gestão empresa — critério 3 (vendedores)', () => {
  const r = montarEmpresa(entrada());

  it('veredito por vendedor', () => {
    expect(vend(r, 'Alisson')).toMatchObject({ meta: 220_000, faturado: 141_000, veredito: 'VAI_BATER', canal: 'atacado' });
    expect(vend(r, 'Fernando').veredito).toBe('NAO_BATE');
    expect(vend(r, 'Gabriel').veredito).toBe('EM_RISCO');
    expect(vend(r, 'Tecnico 12')).toMatchObject({ veredito: null, canal: 'varejo', servico: 24_000 });
    expect(vend(r, 'Varejo 6')).toMatchObject({ faturado: 88_000, servico: 44_000 });
    expect(vend(r, 'Alisson').servico).toBe(0);
  });

  it('ranking 1 a 13 pelo vendido, nome da venda e margem/markup', () => {
    expect(r.vendedores.map((v) => v.posicao)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect(r.vendedores.map((v) => v.faturado)).toEqual([...r.vendedores.map((v) => v.faturado)].sort((a, b) => b - a));
    expect(r.vendedores[0].rep_nome).toBe('Alisson');
    expect(vend(r, 'Alisson')).toMatchObject({ nome_venda: 'ALISSON', margem: 31, markup: 44.9, atingimento: 64.1 });
  });
});

describe('gestão empresa — critério 4 (papel e inativo)', () => {
  it('canalDoPapel', () => {
    expect(canalDoPapel('VENDEDOR_ATACADO')).toBe('atacado');
    expect(canalDoPapel('VENDEDOR')).toBe('varejo');
    expect(canalDoPapel('TECNICO')).toBe('varejo');
    expect(canalDoPapel('GERENTE')).toBe('outros');
    expect(canalDoPapel('')).toBe('outros');
    expect(canalDoPapel(null)).toBe('outros');
  });

  it('desconhecido, vazio, sem cadastro e sem vendedor vão para outros; inativo some da lista e fica no total', () => {
    const linha = (rep: number | null, venda: number, nome: string | null = null, servico = 0) => ({ rep, dia: '2026-11-03', nome, venda, servico, custo: 0, lucro: 0, notas: 1 });
    const r = montarEmpresa({
      // serviço do técnico (rep 1) aparece no varejo; o do gerente (rep 2, outros) não é separado
      linhas: [linha(1, 100, null, 100), linha(2, 200, null, 50), linha(3, 300), linha(4, 400, 'Sem cadastro'), linha(5, 500), linha(null, 600)],
      metasManuais: [],
      metasDw: [{ cod_vendedor: 5, vendedor: 'Saiu', valor_total: 1000 }],
      papeis: [
        { rep_codigo: 1, papel: 'TECNICO', inativo: false },
        { rep_codigo: 2, papel: 'GERENTE', inativo: false },
        { rep_codigo: 3, papel: '', inativo: false },
        { rep_codigo: 5, papel: 'VENDEDOR', inativo: true },
      ],
      ativos: [],
      dias: DIAS,
      encerrado: false,
      hoje: HOJE,
    });
    expect(r.vendedores.map((v) => [v.rep_codigo, v.canal])).toEqual([
      [4, 'outros'],
      [3, 'outros'],
      [2, 'outros'],
      [1, 'varejo'],
    ]);
    expect(r.vendedores.find((v) => v.rep_codigo === 4)).toMatchObject({ rep_nome: 'SEM CADASTRO', papel: null });
    expect(r.empresa).toMatchObject({ faturado: 2100, meta: 1000 });
    expect(r.canais.map((c) => [c.canal, c.faturado, c.meta, c.servico])).toEqual([
      ['atacado', 0, 0, 0],
      ['varejo', 600, 1000, 100],
      ['outros', 1500, 0, 0],
    ]);
    expect(r.serie.dias[0]).toMatchObject({ atacado: 0, varejo: 500, servico: 100, outros: 1500 });
  });

  it('venda líquida negativa sem meta nem cadastro ativo desconta da empresa e do canal', () => {
    const r = montarEmpresa({
      linhas: [
        { rep: 1, dia: '2026-11-03', nome: 'A', venda: 5000, servico: 0, custo: 0, lucro: 0, notas: 1 },
        { rep: 2, dia: '2026-11-03', nome: 'T', venda: -2000, servico: -2000, custo: 0, lucro: 0, notas: 1 },
      ],
      metasManuais: [],
      metasDw: [],
      papeis: [{ rep_codigo: 2, papel: 'TECNICO', inativo: false }],
      ativos: [],
      dias: DIAS,
      encerrado: false,
      hoje: HOJE,
    });
    expect(r.empresa.faturado).toBe(3000);
    expect(r.canais.find((c) => c.canal === 'varejo')).toMatchObject({ faturado: -2000, servico: -2000 });
    const dia = r.serie.dias[0];
    expect(dia.atacado + dia.varejo + dia.servico + dia.outros).toBe(r.empresa.faturado);
  });

  it('venda de hoje entra em faturado_hoje', () => {
    const r = montarEmpresa({
      linhas: [{ rep: 1, dia: HOJE, nome: 'A', venda: 50, servico: 0, custo: 0, lucro: 0, notas: 1 }],
      metasManuais: [],
      metasDw: [],
      papeis: [],
      ativos: [],
      dias: DIAS,
      encerrado: false,
      hoje: HOJE,
    });
    expect(r.empresa.faturado_hoje).toBe(50);
    expect(r.vendedores[0].faturado_hoje).toBe(50);
  });
});

describe('gestão empresa — mês encerrado', () => {
  const r = montarEmpresa({ ...entrada(true), hoje: '2026-11-03' });

  it('previsão = vendido e nada conta como hoje', () => {
    expect(r.empresa.previsao).toBe(822_000);
    expect(r.empresa.faturado_hoje).toBe(0);
    expect(canal(r, 'atacado').previsao).toBe(380_000);
    expect(vend(r, 'Alisson')).toMatchObject({ previsao: 141_000, faturado_hoje: 0 });
    expect(r.serie.meta_diaria).toBeCloseTo(1_430_000 / 22);
  });
});
