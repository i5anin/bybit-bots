import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { sma, ema, rsi, stdDev } from '../src/strategies/utils.js';
import { createStrategy as stochastic } from '../src/strategies/stochastic.js';
import { createStrategy as martingale } from '../src/strategies/martingaleLite.js';

const series = closes => closes.map((close, i) => ({
  time: i * 300_000, open: close, high: close, low: close, close, volume: 1,
}));

describe('indicators', () => {
  test('sma and ema need enough values', () => {
    assert.equal(sma([1, 2], 3), null);
    assert.equal(ema([1, 2], 3), null);
    assert.equal(sma([1, 2, 3, 4], 2), 3.5);
  });

  test('ema of a constant series is that constant', () => {
    assert.ok(Math.abs(ema(Array(30).fill(7), 9) - 7) < 1e-12);
  });

  test('rsi is 100 on a straight rise and 0 on a straight fall', () => {
    const up = Array.from({ length: 15 }, (_, i) => i);
    assert.equal(rsi(up, 14), 100);
    assert.equal(rsi([...up].reverse(), 14), 0);
  });

  test('stdDev of a constant series is zero', () => {
    assert.equal(stdDev(Array(20).fill(3), 20), 0);
  });
});

describe('Stochastic', () => {
  test('buys near the bottom of the range and sells near the top', () => {
    const s = stochastic();
    const range = [10, 20, 15, 12, 18, 11, 19, 14, 16, 13, 17, 15, 14];
    assert.equal(s.signal(series([...range, 11])), 'buy');
    assert.equal(s.signal(series([...range, 19.5])), 'sell');
    assert.equal(s.signal(series([...range, 15])), 'hold');
  });

  test('holds on a flat market and on too little history', () => {
    const s = stochastic();
    assert.equal(s.signal(series(Array(14).fill(5))), 'hold');
    assert.equal(s.signal(series([1, 2, 3])), 'hold');
  });
});

describe('Martingale-lite', () => {
  test('buys after a 1 % drop and sells after a 1 % rebound', () => {
    const s = martingale();
    assert.equal(s.signal(series([100])), 'hold');
    assert.equal(s.signal(series([100, 99])), 'buy');
    assert.equal(s.signal(series([100, 99, 99.5])), 'hold');
    assert.equal(s.signal(series([100, 99, 100])), 'sell');
  });

  test('sync drops the imagined position', () => {
    const s = martingale();
    s.signal(series([100]));
    s.signal(series([100, 99]));
    s.sync({ inPosition: false });
    assert.equal(s.toJSON().inPosition, false);
  });
});

// Каждая стратегия на любом рынке отвечает одним из трёх решений и не падает.
describe('every strategy', async () => {
  const dir = new URL('../src/strategies/', import.meta.url);
  const files = (await readdir(dir)).filter(f => f.endsWith('.js') && f !== 'utils.js');
  let seed = 42;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const closes = [100];
  for (let i = 1; i < 300; i += 1) closes.push(closes[i - 1] * (1 + (rand() - 0.5) * 0.02));
  const candles = closes.map((c, i) => ({
    time: i * 300_000, open: c, high: c * 1.002, low: c * 0.998, close: c, volume: 1,
  }));

  for (const file of files) {
    test(`${file} returns buy, sell or hold on every candle`, async () => {
      const { createStrategy } = await import(new URL(file, dir));
      const s = createStrategy();
      assert.equal(typeof s.name, 'string');
      const seen = new Set();
      for (let i = 1; i <= candles.length; i += 1) {
        const action = s.signal(candles.slice(Math.max(0, i - 100), i));
        assert.ok(['buy', 'sell', 'hold'].includes(action), `${file}: ${action}`);
        seen.add(action);
      }
      assert.ok(seen.size > 1, `${file} never changes its mind on a random walk`);
    });
  }
});
