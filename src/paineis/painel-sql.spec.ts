import * as fs from 'node:fs';
import * as path from 'node:path';
import { MARCADOR_CANAL, MARCADOR_VENDEDOR, listaCanais, montarConsulta, sqlsManuais } from './painel-sql';
import { CacheTtl } from './cache-ttl';

const DIR = __dirname;
const catalogos = fs
  .readdirSync(path.join(DIR, 'catalogo'))
  .map((f) => ({ arquivo: f, ...JSON.parse(fs.readFileSync(path.join(DIR, 'catalogo', f), 'utf8')) }));
const sqls = fs.readdirSync(path.join(DIR, 'sql'));
const lerSql = (f: string) => fs.readFileSync(path.join(DIR, 'sql', f), 'utf8');

describe('catálogo dos painéis', () => {
  it('tem os quatro hubs', () => {
    expect(catalogos.map((c) => c.arquivo).sort()).toEqual([
      'atacado.json',
      'gerencia.json',
      'supervisao_atacado.json',
      'varejo.json',
    ]);
  });

  it('todo card aponta para um SQL que existe e todo SQL é usado', () => {
    const usados = new Set<string>();
    for (const cat of catalogos) {
      for (const c of cat.cards) {
        if (!c.sql) {
          expect(c.indisponivel).toBeTruthy();
          continue;
        }
        expect(sqls).toContain(c.sql);
        usados.add(c.sql);
      }
    }
    expect([...usados].sort()).toEqual([...sqls].sort());
  });

  it('cards em ordem de layout e sem dashcard repetido', () => {
    for (const cat of catalogos) {
      const ordem = cat.cards.map((c: any) => c.row * 1000 + c.col);
      expect(ordem).toEqual([...ordem].sort((a, b) => a - b));
      expect(new Set(cat.cards.map((c: any) => c.dashcard)).size).toBe(cat.cards.length);
    }
  });

  it('SQL sem sobra de parâmetro do Metabase', () => {
    for (const f of sqls) {
      const sobra = lerSql(f).replace(MARCADOR_VENDEDOR, '').replace(MARCADOR_CANAL, '');
      expect({ f, tag: /\{\{|\[\[/.test(sobra) }).toEqual({ f, tag: false });
    }
  });

  it('SQL reescrito à mão fica protegido do extrator em todo dashcard que o usa', () => {
    const manuais = sqlsManuais(catalogos);
    const protegidos = new Set(manuais.values());
    for (const f of sqls.filter((x) => lerSql(x).startsWith('-- MANUAL:'))) {
      expect(protegidos).toContain(f);
      // Um dashcard sem a marca faria o extrator voltar a gravar o SQL do Metabase.
      for (const cat of catalogos) {
        for (const c of cat.cards.filter((x: any) => x.sql === f)) expect(manuais.get(`${cat.hub}:${c.dashcard}`)).toBe(f);
      }
    }
    for (const f of protegidos) expect(lerSql(f).startsWith('-- MANUAL:')).toBe(true);
    expect([...manuais.keys()].sort()).toEqual([
      'ATACADO:295', 'ATACADO:303', 'ATACADO:304', 'ATACADO:306', 'ATACADO:313', 'ATACADO:455',
      'GERENCIA:101', 'GERENCIA:109', 'GERENCIA:79', 'GERENCIA:87', 'GERENCIA:98',
      'SUPERVISAO_ATACADO:376', 'SUPERVISAO_ATACADO:384', 'SUPERVISAO_ATACADO:385',
      'SUPERVISAO_ATACADO:387', 'SUPERVISAO_ATACADO:394', 'SUPERVISAO_ATACADO:453',
      'VAREJO:145', 'VAREJO:153', 'VAREJO:154', 'VAREJO:156', 'VAREJO:163',
    ]);
  });
});

describe('montarConsulta', () => {
  const sql = 'SELECT 1 FROM dbo.t WHERE {{vendedor:dbo.t.nome}} AND x = 1';
  const periodo = { de: '2026-09-01', ate: '2026-09-30' };

  it('expande a lista de vendedores em parâmetros @v0..@vN', () => {
    const r = montarConsulta(sql, { ...periodo, vendedores: ['ANA', 'BIA', 'CAU'] });
    expect(r.texto).toBe('SELECT 1 FROM dbo.t WHERE (dbo.t.nome IN (@v0, @v1, @v2)) AND x = 1');
    expect(r.params).toEqual({ ...periodo, v0: 'ANA', v1: 'BIA', v2: 'CAU' });
  });

  it('normaliza a lista no Node: sem espaço nas pontas, sem repetido, sem vazio', () => {
    const r = montarConsulta(sql, { ...periodo, vendedores: [' ANA ', 'ANA', '', 'BIA'] });
    expect(r.texto).toBe('SELECT 1 FROM dbo.t WHERE (dbo.t.nome IN (@v0, @v1)) AND x = 1');
    expect(r.params).toEqual({ ...periodo, v0: 'ANA', v1: 'BIA' });
  });

  it('lista vazia = sem filtro de vendedor', () => {
    const r = montarConsulta(sql, { ...periodo, vendedores: [] });
    expect(r.texto).toBe('SELECT 1 FROM dbo.t WHERE (1 = 1) AND x = 1');
    expect(r.params).toEqual(periodo);
  });

  const sqlCanal = 'SELECT 1 FROM dbo.v v WHERE {{canal:v.local_venda_1}} AND {{vendedor:v.nome}}';

  it('canais viram @c0..@cN; sem canais = 1 = 1', () => {
    const r = montarConsulta(sqlCanal, { ...periodo, vendedores: ['ANA'], canais: ['ATACADO', 'BALCÃO'] });
    expect(r.texto).toBe('SELECT 1 FROM dbo.v v WHERE (v.local_venda_1 IN (@c0, @c1)) AND (v.nome IN (@v0))');
    expect(r.params).toEqual({ ...periodo, v0: 'ANA', c0: 'ATACADO', c1: 'BALCÃO' });
    expect(montarConsulta(sqlCanal, { ...periodo, vendedores: [] }).texto).toBe(
      'SELECT 1 FROM dbo.v v WHERE (1 = 1) AND (1 = 1)',
    );
  });

  it('listaCanais traduz a chave da tela para o valor do BI e ignora desconhecidos', () => {
    expect(listaCanais('varejo-servico,atacado,xpto,atacado')).toEqual(['ATACADO', 'VAREJO-SERVIÇO']);
    expect(listaCanais(['Varejo', 'atacado'])).toEqual(['ATACADO', 'BALCÃO']);
    expect(listaCanais(undefined)).toEqual([]);
  });

  it('todo SQL que lê vendas (f_analise_vendas / vw_analise_vendas) tem o marcador de canal', () => {
    // Guarda contra reextração do Metabase, que não conhece o marcador.
    const leVendas = /^\s*FROM\s+dbo\.(f_analise_vendas|vw_analise_vendas)\b/im;
    const semMarcador = sqls.filter((f) => leVendas.test(lerSql(f)) && !new RegExp(MARCADOR_CANAL.source).test(lerSql(f)));
    expect(semMarcador).toEqual([]);
  });
});

describe('CacheTtl', () => {
  afterEach(() => jest.useRealTimers());

  it('serve até o TTL e expira depois', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-07T12:00:00Z'));
    const cache = new CacheTtl<string>(60_000);
    cache.set('a', 'painel');
    jest.setSystemTime(new Date('2026-10-07T12:00:59Z'));
    expect(cache.get('a')).toBe('painel');
    jest.setSystemTime(new Date('2026-10-07T12:01:00Z'));
    expect(cache.get('a')).toBeUndefined();
  });
});
