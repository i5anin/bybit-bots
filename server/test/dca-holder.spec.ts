import { describe, expect, it } from 'vitest';
import { Bot } from '../src/trading/bot.js';
import { Ledger } from '../src/trading/ledger.js';
import { dcaHolder, HOLDER_PROFILES, patientHolder, profitTargetPct, quickHolder } from '../src/trading/strategies/dca-holder.js';
import type { Candle } from '../src/trading/types.js';

const HOUR = 3_600_000;
const series = (closes: number[], step = HOUR): Candle[] => closes.map((close, i) => ({
  time: i * step, open: close, high: close, low: close, close, volume: 1,
}));

describe('profitTargetPct', () => {
  it('medium starts at 3 % and shrinks by half a percent a day down to the floor', () => {
    const m = HOLDER_PROFILES.medium;
    expect(profitTargetPct(m, 0)).toBe(3);
    expect(profitTargetPct(m, 2 * 24 * HOUR)).toBe(2);
    expect(profitTargetPct(m, 30 * 24 * HOUR)).toBe(0.6);
  });

  it('quick always wants the minimum and patient never goes below 1.5 %', () => {
    expect(profitTargetPct(HOLDER_PROFILES.quick, 0)).toBe(0.6);
    expect(profitTargetPct(HOLDER_PROFILES.patient, 0)).toBe(8);
    expect(profitTargetPct(HOLDER_PROFILES.patient, 100 * 24 * HOUR)).toBe(1.5);
    expect(profitTargetPct(HOLDER_PROFILES.longTerm, 0)).toBe(20);
    expect(profitTargetPct(HOLDER_PROFILES.longTerm, 365 * 24 * HOUR)).toBe(5);
  });

  it('quick sells on a small rebound that patient keeps holding', () => {
    const prices = [100, 98, 98.7];
    const quick = quickHolder();
    const patient = patientHolder();
    quick.signal(series(prices.slice(0, 2)));
    patient.signal(series(prices.slice(0, 2)));
    expect(quick.signal(series(prices))).toBe('sell');
    expect(patient.signal(series(prices))).toBe('hold');
  });
});

describe('DCA-холдер', () => {
  it('buys only after a 2 % drop from the recent high', () => {
    const s = dcaHolder();
    expect(s.signal(series([100, 99]))).toBe('hold');
    expect(s.signal(series([100, 99, 98]))).toBe('buy');
  });

  it('adds on each further 2 % drop and never more than five times', () => {
    const s = dcaHolder();
    const prices = [100, 98];
    expect(s.signal(series(prices))).toBe('buy');
    let buys = 1;
    for (let p = 96; p > 70; p -= 2) {
      prices.push(p);
      if (s.signal(series(prices)) === 'buy') buys += 1;
    }
    expect(buys).toBe(5);
  });

  it('never sells at a loss and sells when the average is in profit', () => {
    const s = dcaHolder();
    const prices = [100, 98, 96, 94];
    s.signal(series(prices.slice(0, 2)));
    s.signal(series(prices.slice(0, 3)));
    expect(s.signal(series(prices))).toBe('buy'); // три покупки, средняя ≈ 95.97
    expect(s.signal(series([...prices, 95]))).toBe('hold');
    expect(s.signal(series([...prices, 95, 99]))).toBe('sell');
  });

  it('accepts a smaller profit after holding for days', () => {
    const s = dcaHolder();
    const day = 24 * HOUR;
    s.signal(series([100, 98], day));
    expect(s.signal(series([100, 98, 99.5], day))).toBe('hold'); // +1.5 % в первые сутки мало
    expect(s.signal(series([100, 98, 99, 99, 99, 99.5], day))).toBe('sell'); // спустя 4 дня цель 1 %
  });

  it('forgets a buy the ledger could not fill', () => {
    const s = dcaHolder();
    s.signal(series([100, 98]));
    s.sync!({ inPosition: false, price: 98, downtimeSec: 0, entryPrice: 0 });
    expect(s.toJSON!()).toEqual({ buyPrices: [], firstBuyTime: null, pendingBuy: false });
  });

  it('restores from the ledger entry price when its own state is lost', () => {
    const s = dcaHolder();
    s.restore!(null, { inPosition: true, entryPrice: 50, price: 49, downtimeSec: 0 });
    expect((s.toJSON!() as { buyPrices: number[] }).buyPrices).toEqual([50]);
    s.restore!({ buyPrices: [10] }, { inPosition: false, entryPrice: 0, price: 9, downtimeSec: 0 });
    expect((s.toJSON!() as { buyPrices: number[] }).buyPrices).toEqual([]);
  });
});

describe('averaging in the ledger', () => {
  it('adds to an open position and keeps a weighted entry price', () => {
    const ledger = new Ledger(100, { orderPct: 10 });
    ledger.buy(10);
    expect(ledger.buy(10)).toBeNull();
    ledger.buy(5, true);
    expect(ledger.position).toBeCloseTo(1 + 1.8);
    expect(ledger.entryPrice).toBeCloseTo((10 + 9) / 2.8);
    expect(ledger.entryCost).toBeCloseTo(19);
  });

  it('lets an averaging bot buy again while holding', () => {
    const bot = new Bot(dcaHolder(), { startBalance: 100, costs: { orderPct: 10 } });
    bot.step(series([100, 98]), 98);
    bot.step(series([100, 98, 96]), 96);
    expect(bot.ledger.tradeCount).toBe(2);
  });
});
