import { sugerirVinculos, termos, OrcamentoJanela, ClienteCadastro } from './sugestao-vinculo';

/**
 * Motor da sugestão de vínculo: entra conversa + orçamentos + cadastro, sai o
 * cliente provável com a evidência. Função pura, sem banco nem ERP.
 */
describe('sugerirVinculos', () => {
  const orc = (numero: string, cli: number, dia: string, itens: string[], rep = 163): OrcamentoJanela => ({
    origem: 'CELTA',
    numero,
    rep,
    cli,
    cliNome: `CLIENTE ${cli}`,
    dia,
    itens,
  });
  // coleção com termos comuns para o idf separar o raro do genérico; tamanho da
  // ordem do mês real (o limiar do produto foi medido sobre milhares de orçamentos)
  const fundo: OrcamentoJanela[] = Array.from({ length: 300 }, (_, i) =>
    orc(`F${i}`, 900 + i, '2026-09-01', ['PARA BRISA GOL G5 VERDE', 'PALHETA UNIVERSAL']),
  );
  const conv = (textos: Record<string, string>, nomeAgenda: string | null = null) => ({
    chave: '6599990000',
    rep: 163,
    textoPorDia: new Map(Object.entries(textos)),
    nomeAgenda,
  });

  it('termos ignora genéricos e acentos', () => {
    expect([...termos('Para-brisa dianteiro HB20 Vidraçaria São José')].sort()).toEqual(['HB20', 'JOSE', 'SAO']);
  });

  it('produto raro citado no mesmo dia do orçamento vota no cliente, com a evidência', () => {
    const r = sugerirVinculos(
      [conv({ '2026-09-16': 'tem o protetor do hb20 2016?' })],
      [...fundo, orc('405549', 23867, '2026-09-16', ['PROTETOR P/LAMA HB20 12/ DIANT. LE'])],
      [],
      [],
    ).get('6599990000')!;
    expect(r.sugestoes[0]).toMatchObject({ cli_codigo: 23867, votos: 1 });
    expect(r.sugestoes[0].evidencias[0].texto).toContain('405549');
    expect(r.sugestoes[0].evidencias[0].texto).toContain('HB20');
    expect(r.confianca).toBe('MEDIA');
  });

  it('mesmo produto em outro dia NÃO vota; termo comum da coleção também não', () => {
    const r = sugerirVinculos(
      [conv({ '2026-09-17': 'hb20', '2026-09-01': 'gol g5 palheta' })],
      [...fundo, orc('405549', 23867, '2026-09-16', ['PROTETOR HB20'])],
      [],
      [],
    ).get('6599990000')!;
    expect(r.sugestoes).toEqual([]);
    expect(r.confianca).toBeNull();
  });

  it('dois sinais no mesmo cliente dão confiança ALTA; entrega e agenda também votam', () => {
    // cadastro do tamanho do atacado real (~1,2 mil) para o idf do nome valer
    const clientes: ClienteCadastro[] = [
      ...Array.from({ length: 1000 }, (_, i) => ({ cli: 10_000 + i, nome: `CLIENTE ${i} VIDROS`, contato: null })),
      { cli: 23867, nome: 'VIDRACARIA TURINI LTDA', contato: 'MARCOS' },
      { cli: 5, nome: 'AUTO VIDROS SILVA', contato: null },
      { cli: 6, nome: 'SILVA E FILHOS', contato: null },
    ];
    const r = sugerirVinculos(
      [conv({ '2026-09-16': 'protetor hb20' }, 'Marcos Turini')],
      [...fundo, orc('405549', 23867, '2026-09-16', ['PROTETOR HB20'])],
      [{ chave: '6599990000', rep: 163, cli: 23867, cliNome: 'VIDRACARIA TURINI', numero: '77', entregueEm: new Date('2026-09-16T14:32:00-04:00') }],
      clientes,
    ).get('6599990000')!;
    expect(r.confianca).toBe('ALTA');
    expect(r.sugestoes[0]).toMatchObject({ cli_codigo: 23867, votos: 3 });
    expect(r.sugestoes[0].evidencias.map((e) => e.tipo).sort()).toEqual(['ENTREGA', 'NOME', 'PRODUTO']);
  });

  it('votos divididos entre clientes não dão confiança', () => {
    const r = sugerirVinculos(
      [conv({ '2026-09-16': 'protetor hb20 e capa onix' })],
      [...fundo, orc('1', 10, '2026-09-16', ['PROTETOR HB20']), orc('2', 11, '2026-09-16', ['CAPA ONIX'])],
      [],
      [],
    ).get('6599990000')!;
    expect(r.sugestoes).toHaveLength(2);
    expect(r.confianca).toBeNull();
  });

  it('nome da agenda ambíguo (dois clientes com o mesmo termo) não vota', () => {
    const r = sugerirVinculos(
      [conv({}, 'Silva')],
      [],
      [],
      [
        { cli: 5, nome: 'AUTO VIDROS SILVA', contato: null },
        { cli: 6, nome: 'SILVA E FILHOS', contato: null },
        { cli: 7, nome: 'OUTRO QUALQUER', contato: null },
      ],
    ).get('6599990000')!;
    expect(r.sugestoes).toEqual([]);
  });
});
