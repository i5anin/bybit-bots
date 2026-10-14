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
  { bot: 'Stochastic Oscillator (14, 20/80)', equity: '12', price: '0.1' },
  { bot: 'Stochastic Oscillator (14, 20/80)', equity: '13.2', price: '0.11' },
]);
const build = (extra: Partial<Parameters<typeof buildStats>[0]> = {}) => buildStats({
  state, equity: equity(), trades: [], runs: [], rate, startRub: 1000, staleSec: 300, ...extra,
});

describe('buildStats', () => {
  it("counts rubles from the fixed start, not from today's rate", () => {
    const s = build();
    expect(s.bots[0]).toMatchObject({ equityRub: 1056, pnlRubPct: 5.6, pnlPct: 10 });
    expect(s.startRub).toBe(1000);
  });

  it('falls back to start balance times the rate without START_RUB', () => {
    expect(build({ startRub: 0 }).startRub).toBe(960);
  });

  it('marks the meta bot even in snapshots from before the flag', () => {
    const meta = build().bots.filter(b => b.isMeta).map(b => b.name).sort();
    expect(meta).toEqual(['Old meta', 'Авто-выбор лучшей (11)']);
  });

  it('takes the price and sparkline from the equity log', () => {
    const s = build();
    expect(s.price).toBe(0.11);
    expect(s.bots[0]!.spark).toEqual([12, 13.2, 13.2]);
    expect(s.baseAsset).toBe('DOGE');
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
