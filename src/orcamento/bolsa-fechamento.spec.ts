import { BadRequestException } from '@nestjs/common';
import { OrcamentoService } from './orcamento.service';
import type { BolsaEntrada } from './regua';

/**
 * fecharMes com o repositório e as leituras do mês mockados: a conta do fechamento
 * (saldo inicial + gerado, reserva, base, prêmio), o que é gravado e as recusas.
 */
describe('fechamento mensal da bolsa', () => {
  const entradas: Record<number, BolsaEntrada> = {
    // inicial 2.400 + gerado 12.000 = 14.400 → reserva para no teto (3.000), base 9.000, 25% = 2.250
    1: { receita_mtd: 12_000, custo_mtd: 0, desconto_mtd: 0, piso: 1.5, linha: 1.5, premio_pct: 0.25, premio_degraus: null, saldo_inicial: 2_400 },
    // gerado 1.000 − 1.000 × 1,5 = −500 → reserva −150 (30% do negativo, sem teto), base 0
    2: { receita_mtd: 1_000, custo_mtd: 1_000, desconto_mtd: 0, piso: 1.5, linha: 1.5, premio_pct: 0.25, premio_degraus: null, saldo_inicial: 0 },
  };

  const montar = (proximo: Array<{ rep_codigo: number; fechado_em: Date | null }> = []) => {
    const db = {
      bolsaMesDoPeriodo: jest.fn(async () => proximo),
      gravarFechamentoBolsa: jest.fn(async () => []),
    };
    const bi = { vendedoresAtacado: jest.fn(async () => [{ rep_codigo: 1, rep_nome: 'A', papel: null }, { rep_codigo: 2, rep_nome: 'B', papel: null }]) };
    const service = new OrcamentoService({} as never, bi as never, db as never, {} as never, {} as never);
    // leituras do BI/ERP fora do teste: só a entrada do mês de cada vendedor importa
    Object.assign(service as unknown as Record<string, unknown>, {
      pisoVigente: async () => ({ piso: 1.5, linha: 1.5 }),
      servicosDoErp: async () => [],
      oportunidadesParaBolsa: async () => [],
      entradaDoMes: async (rep: number) => ({ entrada: entradas[rep] }),
    });
    return { service, db };
  };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-12-27T12:00:00'));
    delete process.env.ORCAMENTO_BOLSA_FECHAMENTO_DESDE;
    delete process.env.ORCAMENTO_RESERVA_PCT;
    delete process.env.ORCAMENTO_RESERVA_TETO;
  });
  afterEach(() => jest.useRealTimers());

  it('reserva positiva para no teto; negativa passa 30% sem teto; a reserva vai ao mês seguinte', async () => {
    const { service, db } = montar();
    const r = await service.fecharMes(2026, 11, 'Gestor');
    expect(r.falhas).toEqual([]);
    expect(db.gravarFechamentoBolsa).toHaveBeenCalledTimes(2);
    expect(db.gravarFechamentoBolsa).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ rep_codigo: 1, ano: 2026, mes: 11, saldo_inicial: 2_400, gerado: 12_000, saldo_final: 14_400, reserva: 3_000, premio_base: 9_000, premio_pct: 0.25, premio: 2_250, piso: 1.5, fechado_por: 'Gestor' }),
      { ano: 2026, mes: 12 },
    );
    expect(db.gravarFechamentoBolsa).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ rep_codigo: 2, gerado: -500, saldo_final: -500, reserva: -150, premio_base: 0, premio: 0 }),
      { ano: 2026, mes: 12 },
    );
  });

  it('recusa quando o mês seguinte já foi fechado, sem gravar nada', async () => {
    const { service, db } = montar([{ rep_codigo: 1, fechado_em: new Date() }]);
    await expect(service.fecharMes(2026, 11, 'Gestor')).rejects.toBeInstanceOf(BadRequestException);
    expect(db.gravarFechamentoBolsa).not.toHaveBeenCalled();
  });

  it('linha do mês seguinte só com saldo inicial (não fechada) não impede refazer', async () => {
    const { service, db } = montar([{ rep_codigo: 1, fechado_em: null }]);
    await service.fecharMes(2026, 11, 'Gestor', 1);
    expect(db.gravarFechamentoBolsa).toHaveBeenCalledTimes(1);
  });

  it('recusa mês anterior ao início e mês ainda aberto', async () => {
    const { service } = montar();
    await expect(service.fecharMes(2026, 10, 'Gestor')).rejects.toThrow('começa em 11/2026');
    await expect(service.fecharMes(2027, 1, 'Gestor')).rejects.toThrow('ainda não terminou');
  });
});
