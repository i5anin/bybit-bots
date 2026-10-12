import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseKlines, parseLotRules, splitClosed } from '../src/lib/bybit.js';
import { csvRow, parseCsvLine } from '../src/lib/csv.js';
import { formatDuration } from '../src/lib/time.js';

describe('Bybit responses', () => {
  test('parses klines into chronological order with numbers', () => {
    const json = { result: { list: [
      ['300000', '1', '2', '0.5', '1.5', '10'],
      ['0', '0.9', '1.1', '0.8', '1', '5'],
    ] } };
    assert.deepEqual(parseKlines(json), [
      { time: 0, open: 0.9, high: 1.1, low: 0.8, close: 1, volume: 5 },
      { time: 300000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    ]);
  });

  test('parses lot rules and rejects an unknown symbol', () => {
    const json = { result: { list: [{ lotSizeFilter: { minOrderAmt: '5', minOrderQty: '0.1', basePrecision: '0.1' } }] } };
    assert.deepEqual(parseLotRules(json, 'DOGEUSDT'), { minOrderAmt: 5, minOrderQty: 0.1, qtyStep: 0.1 });
    assert.throws(() => parseLotRules({ result: { list: [] } }, 'NOPE'), /NOPE/);
  });
});

describe('splitClosed', () => {
  const five = 5 * 60_000;
  const candles = [0, 1, 2].map(i => ({ time: i * five, close: i + 1 }));

  test('drops the candle that is still open and prices at its close', () => {
    const { closed, price } = splitClosed(candles, '5', 2 * five + 1000);
    assert.deepEqual(closed.map(c => c.time), [0, five]);
    assert.equal(price, 3);
  });

  test('keeps every candle when the exchange returned only closed ones', () => {
    const { closed } = splitClosed(candles, 5, 3 * five);
    assert.equal(closed.length, 3);
  });

  test('handles an empty response', () => {
    assert.deepEqual(splitClosed([], 5, 0), { closed: [], price: null });
  });
});

describe('CSV', () => {
  test('quotes strategy names with commas and round-trips them', () => {
    const row = csvRow(['t', 'RSI (14, 30/70)', 'say "hi"', 1.5, null]);
    assert.equal(row, 't,"RSI (14, 30/70)","say ""hi""",1.5,\n');
    assert.deepEqual(parseCsvLine(row.trimEnd()), ['t', 'RSI (14, 30/70)', 'say "hi"', '1.5', '']);
  });
});

describe('formatDuration', () => {
  test('formats seconds, minutes, hours and days', () => {
    assert.equal(formatDuration(5), '5с');
    assert.equal(formatDuration(65), '1м 05с');
    assert.equal(formatDuration(3 * 3600 + 120), '3ч 02м');
    assert.equal(formatDuration(2 * 86400 + 3600 + 60), '2д 1ч 01м');
    assert.equal(formatDuration(-3), '0с');
  });
});
