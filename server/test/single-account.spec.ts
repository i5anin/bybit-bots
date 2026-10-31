import { describe, expect, it } from 'vitest';
import { runSingleAccount, SINGLE_ACCOUNT_DEFAULTS, type MarketHistory } from '../src/backtest/single-account.js';
import type { StrategyFactory } from '../src/trading/types.js';

const HOUR = 3_600_000;
const FROM = 144 * HOUR;
const TO = 192 * HOUR;
const options = { ...SINGLE_ACCOUNT_DEFAULTS, startRub: 1000, rubPerUsdt: 1,
  trainDays: 1, tradeDays: 1, stopLossPct: 50, maxTrainingDrawdownPct: 50,
  minClosedTrades: 1, accountLossLimitPct: 50 };

/** Создаёт повторяющийся рынок для проверки причинности, издержек и отказов ордеров. */
function history(): MarketHistory {
  return { symbol: 'TESTUSDT', lot: { minOrderAmt: 5, minOrderQty: 0.01, qtyStep: 0.01 },
    candles: Array.from({ length: 240 }, (_, i) => {
      const price = i % 4 < 2 ? 100 : 110;
      return { time: i * HOUR, open: price, high: price, low: price, close: price, volume: 1 };
    }) };
}

/** Тестовая стратегия использует только последнюю закрытую свечу. */
const cycle: StrategyFactory = () => ({ name: 'cycle', signal(candles) {
  return candles.at(-1)!.close === 100 ? 'buy' : 'sell';
} });

describe('single account walk-forward', () => {
  it('trades one account and includes liquidation fees', () => {
    const result = runSingleAccount([history()], FROM, TO, options, [cycle]);
    expect(result.endRub).toBeGreaterThan(1000);
    expect(result.feesRub).toBeGreaterThan(0);
    expect(result.periods.every(p => p.strategy === 'cycle' && p.trades > 0 && p.trades % 2 === 0)).toBe(true);
    expect(result.periods[1]!.startRub).toBe(result.periods[0]!.endRub);
    expect(result.pnlRub).toBeCloseTo(result.endRub - 1000);
  });

  it('does not change earlier choices when later prices change', () => {
    const market = history();
    const first = runSingleAccount([market], FROM, TO, options, [cycle]);
    const changed = history();
    for (const c of changed.candles) {
      if (c.time >= FROM + 24 * HOUR) { c.open *= 2; c.high *= 2; c.low *= 2; c.close *= 2; }
    }
    const second = runSingleAccount([changed], FROM, TO, options, [cycle]);
    expect(second.periods[0]).toEqual(first.periods[0]);
  });

  it('keeps cash when no strategy closes profitable trades', () => {
    const result = runSingleAccount([history()], FROM, TO, options,
      [() => ({ name: 'idle', signal: () => 'hold' })]);
    expect(result.endRub).toBe(1000);
    expect(result.feesRub).toBe(0);
    expect(result.periods.every(p => p.symbol === null)).toBe(true);
  });

  it('cannot create trades when minimum lot is unaffordable', () => {
    const market = history();
    market.lot.minOrderAmt = 2000;
    const result = runSingleAccount([market], FROM, TO, options, [cycle]);
    expect(result.endRub).toBe(1000);
    expect(result.periods.every(p => p.trades === 0)).toBe(true);
  });

  it('halts for all subsequent periods after the account loss limit', () => {
    const market = history();
    for (const c of market.candles) {
      if (c.time >= FROM + HOUR) c.open = c.high = c.low = c.close = 20;
    }
    const result = runSingleAccount([market], FROM, TO,
      { ...options, accountLossLimitPct: 0.1 }, [cycle]);
    expect(result.endRub).toBeLessThan(1000);
    expect(result.periods[1]!.strategy).toBeNull();
    expect(result.periods[1]!.trades).toBe(0);
  });

  it('rejects missing candles and unknown lot rules', () => {
    const market = history();
    market.candles.splice(20, 1);
    expect(() => runSingleAccount([market], FROM, TO, options, [cycle])).toThrow('история');
    const noLot = history();
    noLot.lot.qtyStep = 0;
    expect(() => runSingleAccount([noLot], FROM, TO, options, [cycle])).toThrow('лота');
  });
});
