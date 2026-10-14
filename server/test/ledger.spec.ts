import { describe, expect, it } from 'vitest';
import { Ledger, lotQty, NO_COSTS } from '../src/trading/ledger.js';
import type { Costs } from '../src/trading/types.js';

const DOGE_LOT = { minOrderAmt: 5, minOrderQty: 0.1, qtyStep: 0.1 };
const REAL: Costs = { feePct: 0.1, slippagePct: 0.02, lot: DOGE_LOT, orderUsdt: 0 };

describe('lotQty', () => {
  it('rounds up to the exchange step so the order is never below the minimum', () => {
    const qty = lotQty(0.0936, DOGE_LOT);
    expect(qty).toBe(53.5);
    expect(qty * 0.0936).toBeGreaterThanOrEqual(5);
  });

  it('keeps the step precision without float noise', () => {
    expect(lotQty(0.07, DOGE_LOT)).toBe(71.5);
    expect(String(lotQty(0.0937, DOGE_LOT))).toBe('53.4');
  });

  it('uses the larger of the desired amount and the exchange minimum', () => {
    expect(lotQty(0.1, DOGE_LOT, 8)).toBe(80);
    expect(lotQty(0.1, DOGE_LOT, 1)).toBe(50);
  });

  it('respects the minimum quantity', () => {
    expect(lotQty(1000, { minOrderAmt: 1, minOrderQty: 0.5, qtyStep: 0.1 })).toBe(0.5);
  });
});

describe('Ledger without costs', () => {
  it('goes all-in and back out at the same price with no loss', () => {
    const l = new Ledger(100, NO_COSTS);
    l.mark(10);
    expect(l.buy(10)).not.toBeNull();
    expect(l.position).toBe(10);
    expect(l.cash).toBe(0);
    expect(l.sell(10)?.pnlPct).toBe(0);
    expect(l.cash).toBe(100);
    expect(l.tradeCount).toBe(2);
  });

  it('ignores a second buy and a sell without position', () => {
    const l = new Ledger(100);
    expect(l.sell(10)).toBeNull();
    l.buy(10);
    expect(l.buy(9)).toBeNull();
    expect(l.tradeCount).toBe(1);
  });
});

describe('Ledger with real costs', () => {
  it('buys only the minimum lot and keeps the rest in cash', () => {
    const l = new Ledger(11.98, REAL);
    l.mark(0.1);
    l.buy(0.1);
    const fill = 0.1 * 1.0002;
    const cost = 50 * fill;
    expect(l.position).toBe(50);
    expect(l.entryPrice).toBeCloseTo(fill, 12);
    expect(l.cash).toBeCloseTo(11.98 - cost * 1.001, 9);
    expect(l.feesPaid).toBeCloseTo(cost * 0.001, 12);
  });

  it('a round trip at an unchanged price loses exactly fees and slippage', () => {
    const l = new Ledger(11.98, REAL);
    l.buy(0.1);
    const pnlPct = l.sell(0.1)!.pnlPct!;
    const expected = ((0.9998 * 0.999) / (1.0002 * 1.001) - 1) * 100;
    expect(pnlPct).toBeCloseTo(expected, 9);
    expect(pnlPct).toBeLessThan(-0.235);
    expect(pnlPct).toBeGreaterThan(-0.245);
    expect(l.cash).toBeLessThan(11.98);
  });

  it('reports the closed trade profit in money after all costs', () => {
    const l = new Ledger(11.98, REAL);
    l.buy(0.1);
    const spent = l.entryCost;
    const cashBefore = l.cash;
    const trade = l.sell(0.101)!;
    expect(trade.pnlUsdt).toBeCloseTo(l.cash - cashBefore - spent, 12);
    expect(trade.pnlUsdt! / spent * 100).toBeCloseTo(trade.pnlPct!, 9);
  });

  it('reports a net profit only when the move beats the costs', () => {
    const small = new Ledger(11.98, REAL);
    small.buy(0.1);
    expect(small.sell(0.1002)!.pnlPct).toBeLessThan(0);

    const big = new Ledger(11.98, REAL);
    big.buy(0.1);
    expect(big.sell(0.101)!.pnlPct).toBeGreaterThan(0.7);
  });

  it('refuses to buy when cash does not cover the minimum order', () => {
    const l = new Ledger(4.99, REAL);
    expect(l.buy(0.1)).toBeNull();
    expect(l.position).toBe(0);
    expect(l.cash).toBe(4.99);
    expect(l.tradeCount).toBe(0);
  });

  it('equity marks the open position to the current price', () => {
    const l = new Ledger(11.98, REAL);
    l.buy(0.1);
    l.mark(0.2);
    expect(l.equity).toBeCloseTo(l.cash + 50 * 0.2, 12);
  });
});

describe('Ledger snapshot', () => {
  it('survives a JSON round trip', () => {
    const l = new Ledger(11.98, REAL);
    l.mark(0.1);
    l.buy(0.1);
    const restored = Ledger.from(JSON.parse(JSON.stringify(l.toJSON())), 11.98, REAL);
    expect(restored.toJSON()).toEqual(l.toJSON());
    expect(restored.sell(0.1)!.pnlPct).toBeLessThan(0);
  });

  it('replaces broken fields with defaults instead of crashing', () => {
    const l = Ledger.from({ cash: 'oops', position: null, tradeCount: 7 } as never, 10);
    expect(l.cash).toBe(10);
    expect(l.position).toBe(0);
    expect(l.tradeCount).toBe(7);
  });

  it('closes a position that has no entry price', () => {
    const l = Ledger.from({ cash: 1, position: 2, entryPrice: 0, lastPrice: 3 }, 10);
    expect(l.position).toBe(0);
    expect(l.cash).toBe(7);
  });

  it('does not store costs in the snapshot', () => {
    expect('costs' in new Ledger(1, REAL).toJSON()).toBe(false);
  });
});
