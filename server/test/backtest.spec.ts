import { describe, expect, it } from 'vitest';
import { passes, runBacktest } from '../src/backtest/backtest.js';
import { Bot } from '../src/trading/bot.js';
import { withTrendFilter } from '../src/trading/strategies/filters.js';
import { ACTIVE_STRATEGIES } from '../src/trading/strategies/index.js';
import { martingaleLite } from '../src/trading/strategies/stateful.js';
import type { Action, Candle, Costs, Strategy } from '../src/trading/types.js';

const candle = (time: number, close: number): Candle => ({ time, open: close, high: close, low: close, close, volume: 1 });
const always = (action: Action): Strategy => ({ name: action, signal: () => action });
const COSTS: Costs = { feePct: 0.1, slippagePct: 0.02, lot: { minOrderAmt: 5, minOrderQty: 0.1, qtyStep: 0.1 }, orderUsdt: 0, orderPct: 0, enforceMinOrder: true };

describe('stop-loss', () => {
  it('sells once the price falls below entry by the stop', () => {
    const bot = new Bot(always('buy'), { startBalance: 100, stopLossPct: 3 });
    bot.step([candle(1, 10)], 10);
    expect(bot.step([candle(2, 9.8)], 9.8).action).toBe('buy');
    const r = bot.step([candle(3, 9.69)], 9.69);
    expect(r.action).toBe('sell');
    expect(r.trade?.pnlPct).toBeCloseTo(-3.1, 6);
    expect(bot.ledger.position).toBe(0);
  });

  it('tells a stateful strategy it is out of the market', () => {
    const strategy = martingaleLite();
    const bot = new Bot(strategy, { startBalance: 100, stopLossPct: 3 });
    bot.step([candle(1, 100)], 100);
    bot.step([candle(2, 99)], 99);
    bot.step([candle(3, 95)], 95);
    expect((strategy.toJSON!() as { inPosition: boolean }).inPosition).toBe(false);
  });
});

describe('trend filter', () => {
  const falling = Array.from({ length: 100 }, (_, i) => candle(i, 100 - i * 0.1));
  const rising = Array.from({ length: 100 }, (_, i) => candle(i, 100 + i * 0.1));

  it('blocks buys below the average and passes sells', () => {
    expect(withTrendFilter(() => always('buy'))().signal(falling)).toBe('hold');
    expect(withTrendFilter(() => always('buy'))().signal(rising)).toBe('buy');
    expect(withTrendFilter(() => always('sell'))().signal(falling)).toBe('sell');
  });

  it('keeps a stateful strategy from thinking it bought', () => {
    const filtered = withTrendFilter(martingaleLite)();
    filtered.signal([candle(0, 100)]);
    expect(filtered.signal([candle(0, 100), candle(1, 98.9)])).toBe('hold');
    expect((filtered.toJSON!() as { inPosition: boolean }).inPosition).toBe(false);
  });
});

describe('runBacktest', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let p = 0.1;
  const candles = Array.from({ length: 600 }, (_, i) => {
    p *= 1 + (rand() - 0.5) * 0.02;
    return { time: i * 3_600_000, open: p, high: p * 1.003, low: p * 0.997, close: p, volume: 1 };
  });

  it('runs every strategy plus the meta bot with real costs', () => {
    const r = runBacktest(candles, ACTIVE_STRATEGIES, { startBalance: 11.98, costs: COSTS, metaWindow: 24 });
    expect(r.strategies).toHaveLength(12);
    expect(r.strategies.some(s => s.name.startsWith('Авто-выбор'))).toBe(true);
    expect(r.strategies.every(s => s.feesPct >= 0 && s.maxDrawdownPct >= 0)).toBe(true);
    expect(r.strategies.find(s => s.trades > 0)!.feesPct).toBeGreaterThan(0);
    const sorted = [...r.strategies].sort((a, b) => b.pnlPct - a.pnlPct);
    expect(r.strategies).toEqual(sorted);
  });

  it('compares with holding one lot from the first decision to the end', () => {
    const up = Array.from({ length: 200 }, (_, i) => candle(i, 1 + i / 100));
    const r = runBacktest(up, [() => always('hold')], { startBalance: 11.98, costs: COSTS, metaWindow: 24 });
    expect(r.marketPct).toBeCloseTo((2.99 / 2 - 1) * 100, 6);
    expect(r.lotHoldPct).toBeGreaterThan(0);
    expect(r.strategies[0]!.pnlPct).toBe(0);
    expect(passes(r.strategies[0]!, r)).toBe(false);
  });

  it('refuses a history shorter than the strategy window', () => {
    expect(() => runBacktest(candles.slice(0, 50), ACTIVE_STRATEGIES, { startBalance: 11.98, costs: COSTS, metaWindow: 24 }))
      .toThrow(/мало истории/);
  });
});
