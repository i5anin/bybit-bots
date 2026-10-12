import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, lotQty, NO_COSTS } from '../src/lib/ledger.js';

const DOGE_LOT = { minOrderAmt: 5, minOrderQty: 0.1, qtyStep: 0.1 };
const REAL = { feePct: 0.1, slippagePct: 0.02, lot: DOGE_LOT, orderUsdt: 0 };

describe('lotQty', () => {
  test('rounds up to the exchange step so the order is never below the minimum', () => {
    const qty = lotQty(0.0936, DOGE_LOT);
    assert.equal(qty, 53.5);
    assert.ok(qty * 0.0936 >= 5);
  });

  test('keeps the step precision without float noise', () => {
    assert.equal(lotQty(0.07, DOGE_LOT), 71.5);
    assert.equal(String(lotQty(0.0937, DOGE_LOT)), '53.4');
  });

  test('uses the larger of the desired amount and the exchange minimum', () => {
    assert.equal(lotQty(0.1, DOGE_LOT, 8), 80);
    assert.equal(lotQty(0.1, DOGE_LOT, 1), 50);
  });

  test('respects the minimum quantity', () => {
    assert.equal(lotQty(1000, { minOrderAmt: 1, minOrderQty: 0.5, qtyStep: 0.1 }), 0.5);
  });
});

describe('Ledger without costs', () => {
  test('goes all-in and back out at the same price with no loss', () => {
    const l = new Ledger(100, NO_COSTS);
    l.mark(10);
    assert.ok(l.buy(10));
    assert.equal(l.position, 10);
    assert.equal(l.cash, 0);
    const trade = l.sell(10);
    assert.equal(trade.pnlPct, 0);
    assert.equal(l.cash, 100);
    assert.equal(l.tradeCount, 2);
  });

  test('ignores a second buy and a sell without position', () => {
    const l = new Ledger(100);
    assert.equal(l.sell(10), null);
    l.buy(10);
    assert.equal(l.buy(9), null);
    assert.equal(l.tradeCount, 1);
  });
});

describe('Ledger with real costs', () => {
  test('buys only the minimum lot and keeps the rest in cash', () => {
    const l = new Ledger(11.98, REAL);
    l.mark(0.1);
    l.buy(0.1);
    const fill = 0.1 * 1.0002;
    assert.equal(l.position, 50);
    assert.ok(Math.abs(l.entryPrice - fill) < 1e-12);
    const cost = 50 * fill;
    assert.ok(Math.abs(l.cash - (11.98 - cost * 1.001)) < 1e-9);
    assert.ok(Math.abs(l.feesPaid - cost * 0.001) < 1e-12);
  });

  test('a round trip at an unchanged price loses exactly fees and slippage', () => {
    const l = new Ledger(11.98, REAL);
    l.buy(0.1);
    const { pnlPct } = l.sell(0.1);
    const expected = ((0.9998 * 0.999) / (1.0002 * 1.001) - 1) * 100;
    assert.ok(Math.abs(pnlPct - expected) < 1e-9, `${pnlPct} vs ${expected}`);
    assert.ok(pnlPct < -0.235 && pnlPct > -0.245, `~0.24 % per round trip, got ${pnlPct}`);
    assert.ok(l.cash < 11.98);
  });

  test('reports a net profit only when the move beats the costs', () => {
    const small = new Ledger(11.98, REAL);
    small.buy(0.1);
    assert.ok(small.sell(0.1002).pnlPct < 0, '0.2 % move does not cover ~0.24 % costs');

    const big = new Ledger(11.98, REAL);
    big.buy(0.1);
    assert.ok(big.sell(0.101).pnlPct > 0.7);
  });

  test('refuses to buy when cash does not cover the minimum order', () => {
    const l = new Ledger(4.99, REAL);
    assert.equal(l.buy(0.1), null);
    assert.equal(l.position, 0);
    assert.equal(l.cash, 4.99);
    assert.equal(l.tradeCount, 0);
  });

  test('equity marks the open position to the current price', () => {
    const l = new Ledger(11.98, REAL);
    l.buy(0.1);
    l.mark(0.2);
    assert.ok(Math.abs(l.equity - (l.cash + 50 * 0.2)) < 1e-12);
  });
});

describe('Ledger snapshot', () => {
  test('survives a JSON round trip', () => {
    const l = new Ledger(11.98, REAL);
    l.mark(0.1);
    l.buy(0.1);
    const restored = Ledger.from(JSON.parse(JSON.stringify(l.toJSON())), 11.98, REAL);
    assert.deepEqual(restored.toJSON(), l.toJSON());
    assert.ok(restored.sell(0.1).pnlPct < 0);
  });

  test('replaces broken fields with defaults instead of crashing', () => {
    const l = Ledger.from({ cash: 'oops', position: null, tradeCount: 7 }, 10);
    assert.equal(l.cash, 10);
    assert.equal(l.position, 0);
    assert.equal(l.tradeCount, 7);
  });

  test('closes a position that has no entry price', () => {
    const l = Ledger.from({ cash: 1, position: 2, entryPrice: 0, lastPrice: 3 }, 10);
    assert.equal(l.position, 0);
    assert.equal(l.cash, 7);
  });

  test('does not store costs in the snapshot', () => {
    assert.equal('costs' in new Ledger(1, REAL).toJSON(), false);
  });
});
