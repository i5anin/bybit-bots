import { describe, expect, it } from 'vitest';
import { botStatus, buildStats, type EquityHistory } from '../src/stats/build-stats.js';
import { RatesService } from '../src/stats/rates.service.js';
import { addEquity } from '../src/stats/stats.service.js';
import type { TradeRow } from '../src/stats/stats.types.js';
import { loadConfig } from '../src/config/app-config.js';
import type { EngineState } from '../src/trading/types.js';

const state = {
  startBalance: 12,
  symbol: 'DOGEUSDT',
  bots: {
    'Stochastic Oscillator (14, 20/80)': { ledger: { cash: 13.2, position: 0, lastPrice: 0.1 } },
    'Авто-выбор лучшей (11)': { meta: true, leader: null, ledger: { cash: 6, position: 50, lastPrice: 0.1 } },
    'Old meta': { leader: 'x', ledger: { cash: 12, position: 0 } },
  },
} as unknown as EngineState;
const rate = { value: 80, source: 'test' };
const equity = (): EquityHistory => addEquity({ series: new Map(), lastPrice: null }, [
  { symbol: 'DOGEUSDT', bot: 'Stochastic Oscillator (14, 20/80)', equity: '12', price: '0.1' },
  { symbol: 'DOGEUSDT', bot: 'Stochastic Oscillator (14, 20/80)', equity: '13.2', price: '0.11' },
]);
const build = (extra: Partial<Parameters<typeof buildStats>[0]> = {}) => buildStats({
  state, equity: equity(), trades: [], runs: [], rate, startRub: 1000, staleSec: 300, bankRatePct: 16, ...extra,
});

describe('buildStats', () => {
  it('counts ruble profit as dollar profit at the current rate, from a fixed 1000 ₽ start', () => {
    const s = build();
    // +1.2 $ × 80 ₽ = +96 ₽; курс сам по себе прибылью не считается.
    expect(s.bots[0]).toMatchObject({ equityRub: 1096, pnlRub: 96, pnlRubPct: 9.6, pnlPct: 10 });
    expect(s.startRub).toBe(1000);
  });

  it('a bot that has not traded shows exactly the start, whatever the rate', () => {
    const flat = { ...state, bots: { A: { ledger: { cash: 12, position: 0, lastPrice: 0.1 } } } } as unknown as EngineState;
    expect(build({ state: flat, rate: { value: 83.62, source: 'ЦБ' } }).bots[0]).toMatchObject({ equityRub: 1000, pnlRub: 0 });
  });

  it('falls back to start balance times the rate without START_RUB', () => {
    expect(build({ startRub: 0 }).startRub).toBe(960);
  });

  it('marks the meta bot even in snapshots from before the flag', () => {
    const meta = build().bots.filter(b => b.isMeta).map(b => b.name).sort();
    expect(meta).toEqual(['Old meta', 'Авто-выбор лучшей (11)']);
  });

  it('takes the price from the bots and the sparkline from the equity log', () => {
    const s = build();
    expect(s.price).toBe(0.1);
    expect(s.bots[0]!.spark).toEqual([12, 13.2, 13.2]);
    expect(s.baseAsset).toBe('DOGE');
  });

  describe('many pairs', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    const multi = {
      startBalance: 12,
      symbol: 'ZKUSDT',
      symbols: ['ZKUSDT', 'TIAUSDT'],
      sessionStartedAt: '2026-10-19T12:00:00Z', // 10 дней назад
      orderPct: 1,
      enforceMinOrder: false,
      lots: { ZKUSDT: { minOrderAmt: 5, minOrderQty: 0, qtyStep: 0.1 }, TIAUSDT: { minOrderAmt: 1, minOrderQty: 10, qtyStep: 0.01 } },
      bots: {
        'ZKUSDT:RSI (14, 30/70)': { ledger: { cash: 12.06, position: 0, lastPrice: 0.12 } },
        'ZKUSDT:MACD (12/26/9)': { ledger: { cash: 11.94, position: 0, lastPrice: 0.12 } },
        'TIAUSDT:RSI (14, 30/70)': { ledger: { cash: 12, position: 0, lastPrice: 0.9 } },
        'TIAUSDT:MACD (12/26/9)': { ledger: { cash: 12.03, position: 0, lastPrice: 0.9 } },
      },
    } as unknown as EngineState;
    const s = buildStats({
      state: multi, equity: { series: new Map(), lastPrice: null }, trades: [], runs: [],
      rate: { value: 100, source: 't' }, startRub: 1000, staleSec: 300, bankRatePct: 16, now,
    });

    it('parses pair and strategy from the bot key', () => {
      expect(s.bots.map(b => `${b.symbol}|${b.name}`)).toContain('TIAUSDT|MACD (12/26/9)');
      expect(s.baseAsset).toBe('');
      expect(s.price).toBeNull();
    });

    it('sums each strategy over pairs and each pair over strategies', () => {
      const rsi = s.strategies.find(g => g.name === 'RSI (14, 30/70)')!;
      expect(rsi).toMatchObject({ bots: 2, equityRub: 2006, investedRub: 2000, pnlRub: 6, inPlus: 1 });
      expect(rsi.best).toEqual({ name: 'ZK', pnlRub: 6 });
      const tia = s.pairs.find(p => p.name === 'TIAUSDT')!;
      expect(tia).toMatchObject({ bots: 2, pnlRub: 3, price: 0.9, minOrderUsdt: 9 });
      expect(s.pairs[0]!.name).toBe('TIAUSDT');
    });

    it('annualizes the return over the session and compares it with the deposit', () => {
      const zkRsi = s.bots.find(b => b.key === 'ZKUSDT:RSI (14, 30/70)')!;
      // +0.6 % за 10 дней → 0.6 × 365 / 10 = 21.9 % годовых, вклад 16 % — обогнал.
      expect(zkRsi.aprPct).toBeCloseTo(21.9, 1);
      expect(s.totals.beatsBank).toBe(1);
      expect(s.sessionDays).toBe(10);
      expect(s.orderRub).toBe(10);
    });

    it('gives no annual return in the first hours', () => {
      const early = buildStats({
        state: multi, equity: { series: new Map(), lastPrice: null }, trades: [], runs: [],
        rate: { value: 100, source: 't' }, startRub: 1000, staleSec: 300, bankRatePct: 16,
        now: Date.parse('2026-10-19T14:00:00Z'),
      });
      expect(early.totals.aprPct).toBeNull();
    });
  });

  it('counts win rate over closed trades only', () => {
    const trades = ['', '1.2', '-0.3', '0.5'].map(pnlPct => ({ pnlPct }) as TradeRow);
    const s = build({ trades });
    expect(s.totals.tradesClosed).toBe(3);
    expect(s.totals.winRatePct).toBe(66.7);
  });
});

describe('botStatus', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const at = (sec: number) => new Date(now - sec * 1000).toISOString();
  const run = { runId: 'r', startedAt: at(1000), runUptimeSec: 0, ticks: 0 };

  it('is running while the state is fresh', () => {
    expect(botStatus({ currentRun: run, updatedAt: at(70) }, now, 300)).toEqual({ status: 'running', ageSec: 70 });
  });

  it('is stale when an unfinished run stopped writing', () => {
    expect(botStatus({ currentRun: run, updatedAt: at(301) }, now, 300)).toEqual({ status: 'stale', ageSec: 301 });
  });

  it('is stopped after a clean shutdown or before the first start', () => {
    expect(botStatus({ currentRun: null, updatedAt: at(10) }, now, 300).status).toBe('stopped');
    expect(botStatus(null, now, 300).status).toBe('stopped');
  });

  it('the panel stops showing a hung bot as running', () => {
    const s = build({ state: { ...state, currentRun: run, updatedAt: at(900) }, now });
    expect(s).toMatchObject({ running: false, status: 'stale', ageSec: 900 });
  });
});

describe('RatesService', () => {
  const config = loadConfig({ RUB_PER_USDT: '83.48' });

  it('takes the dollar rate from the central bank and caches it for an hour', async () => {
    let calls = 0;
    const fetchFn = (async () => { calls += 1; return new Response(JSON.stringify({ Valute: { USD: { Value: 84.9 } } })); }) as typeof fetch;
    const rates = new RatesService(config, fetchFn);
    expect(await rates.rubPerUsd(0)).toEqual({ value: 84.9, source: 'ЦБ РФ' });
    await rates.rubPerUsd(1000);
    expect(calls).toBe(1);
    await rates.rubPerUsd(3_600_001);
    expect(calls).toBe(2);
  });

  it('falls back to the configured rate when the bank is unreachable', async () => {
    const rates = new RatesService(config, (async () => { throw new Error('offline'); }) as typeof fetch);
    expect(await rates.rubPerUsd(0)).toEqual({ value: 83.48, source: 'env' });
  });
});
