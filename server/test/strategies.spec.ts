import { describe, expect, it } from 'vitest';
import { ema, rsi, sma, stdDev } from '../src/trading/indicators.js';
import { efficiencyRatio } from '../src/trading/strategies/adaptive-regime.js';
import { ACTIVE_STRATEGIES, ALL_STRATEGIES } from '../src/trading/strategies/index.js';
import { stochastic } from '../src/trading/strategies/oscillators.js';
import { martingaleLite } from '../src/trading/strategies/stateful.js';
import { emaRibbon } from '../src/trading/strategies/trend.js';
import type { Candle } from '../src/trading/types.js';

const series = (closes: number[]): Candle[] => closes.map((close, i) => ({
  time: i * 300_000, open: close, high: close, low: close, close, volume: 1,
}));

describe('indicators', () => {
  it('sma and ema need enough values', () => {
    expect(sma([1, 2], 3)).toBeNull();
    expect(ema([1, 2], 3)).toBeNull();
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
  });

  it('ema of a constant series is that constant', () => {
    expect(ema(Array(30).fill(7), 9)).toBeCloseTo(7, 12);
  });

  it('rsi is 100 on a straight rise and 0 on a straight fall', () => {
    const up = Array.from({ length: 15 }, (_, i) => i);
    expect(rsi(up, 14)).toBe(100);
    expect(rsi([...up].reverse(), 14)).toBe(0);
  });

  it('stdDev of a constant series is zero', () => {
    expect(stdDev(Array(20).fill(3), 20)).toBe(0);
  });

  it('efficiency ratio is 1 on a straight line and 0 on a round trip', () => {
    expect(efficiencyRatio([1, 2, 3, 4, 5], 4)).toBe(1);
    expect(efficiencyRatio([1, 2, 1, 2, 1], 4)).toBe(0);
    expect(efficiencyRatio([1, 1, 1], 2)).toBeNull();
  });
});

describe('Stochastic', () => {
  const range = [10, 20, 15, 12, 18, 11, 19, 14, 16, 13, 17, 15, 14];

  it('buys near the bottom of the range and sells near the top', () => {
    const s = stochastic();
    expect(s.signal(series([...range, 11]))).toBe('buy');
    expect(s.signal(series([...range, 19.5]))).toBe('sell');
    expect(s.signal(series([...range, 15]))).toBe('hold');
  });

  it('holds on a flat market and on too little history', () => {
    const s = stochastic();
    expect(s.signal(series(Array(14).fill(5)))).toBe('hold');
    expect(s.signal(series([1, 2, 3]))).toBe('hold');
  });
});

describe('EMA Ribbon', () => {
  it('holds on a perfectly flat market instead of buying', () => {
    expect(emaRibbon().signal(series(Array(60).fill(0.1)))).toBe('hold');
  });

  it('buys on a steady rise and sells on a steady fall', () => {
    const up = Array.from({ length: 60 }, (_, i) => 1 + i * 0.01);
    expect(emaRibbon().signal(series(up))).toBe('buy');
    expect(emaRibbon().signal(series([...up].reverse()))).toBe('sell');
  });
});

describe('Martingale-lite', () => {
  it('buys after a 1 % drop and sells after a 1 % rebound', () => {
    const s = martingaleLite();
    expect(s.signal(series([100]))).toBe('hold');
    expect(s.signal(series([100, 99]))).toBe('buy');
    expect(s.signal(series([100, 99, 99.5]))).toBe('hold');
    expect(s.signal(series([100, 99, 100]))).toBe('sell');
  });

  it('sync drops the imagined position', () => {
    const s = martingaleLite();
    s.signal(series([100]));
    s.signal(series([100, 99]));
    s.sync!({ inPosition: false, price: 99, downtimeSec: 0, entryPrice: 0 });
    expect((s.toJSON!() as { inPosition: boolean }).inPosition).toBe(false);
  });

  it('restores the reference from the entry price when in position', () => {
    const s = martingaleLite();
    s.restore!({ referencePrice: 50, inPosition: false }, { price: 80, downtimeSec: 10, inPosition: true, entryPrice: 70 });
    expect(s.toJSON!()).toEqual({ referencePrice: 70, inPosition: true });
  });

  it('forgets a stale reference after a long downtime', () => {
    const s = martingaleLite();
    s.restore!({ referencePrice: 50, inPosition: false }, { price: 80, downtimeSec: 3600, inPosition: false, entryPrice: 0 });
    expect(s.toJSON!()).toEqual({ referencePrice: 80, inPosition: false });
  });
});

describe('strategy registry', () => {
  it('keeps the eleven active strategies in the order the saved state expects', () => {
    expect(ACTIVE_STRATEGIES.map(f => f().name)).toEqual([
      'SMA Crossover (10/30)',
      'EMA Crossover (9/21)',
      'RSI (14, 30/70)',
      'MACD (12/26/9)',
      'Bollinger Bands (20, 2σ)',
      'Stochastic Oscillator (14, 20/80)',
      'Donchian Breakout (20)',
      'Mean Reversion (Z-score 20)',
      'EMA Ribbon (5/10/15/20/25)',
      'Martingale-lite (1% шаг)',
      'Adaptive Regime (ER 20)',
    ]);
  });

  // Каждая стратегия на любом рынке отвечает одним из трёх решений и не падает.
  let seed = 42;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const closes = [100];
  for (let i = 1; i < 300; i += 1) closes.push(closes[i - 1]! * (1 + (rand() - 0.5) * 0.02));
  const candles = closes.map((c, i) => ({
    time: i * 300_000, open: c, high: c * 1.002, low: c * 0.998, close: c, volume: 1,
  }));

  it.each(ALL_STRATEGIES.map(f => [f().name, f] as const))('%s returns buy, sell or hold on every candle', (_, factory) => {
    const s = factory();
    const seen = new Set<string>();
    for (let i = 1; i <= candles.length; i += 1) {
      const action = s.signal(candles.slice(Math.max(0, i - 100), i));
      expect(['buy', 'sell', 'hold']).toContain(action);
      seen.add(action);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
