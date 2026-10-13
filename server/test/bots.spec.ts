import { describe, expect, it } from 'vitest';
import { Bot } from '../src/trading/bot.js';
import { MetaBot, metaName, type MetaOptions } from '../src/trading/meta-bot.js';
import { martingaleLite } from '../src/trading/strategies/stateful.js';
import type { Action, Candle, Strategy, StrategyContext, Trader } from '../src/trading/types.js';

const candle = (time: number, close = 1): Candle => ({ time, open: close, high: close, low: close, close, volume: 1 });

function scripted(actions: Action[], extra: Partial<Strategy> = {}): Strategy & { calls: number } {
  const s = {
    name: 'scripted',
    calls: 0,
    signal(): Action {
      s.calls += 1;
      return actions.shift() ?? 'hold';
    },
    ...extra,
  };
  return s;
}

describe('Bot', () => {
  it('makes one decision per closed candle', () => {
    const strategy = scripted(['buy', 'sell']);
    const bot = new Bot(strategy, { startBalance: 100 });
    bot.step([candle(1)], 10);
    bot.step([candle(1)], 11);
    bot.step([candle(1)], 12);
    expect(strategy.calls).toBe(1);
    expect(bot.ledger.position).toBe(10);

    expect(bot.step([candle(1), candle(2)], 12).action).toBe('sell');
    expect(bot.ledger.position).toBe(0);
    expect(bot.ledger.cash).toBe(120);
  });

  it('marks equity to the current price even between decisions', () => {
    const bot = new Bot(scripted(['buy']), { startBalance: 100 });
    bot.step([candle(1)], 10);
    const r = bot.step([candle(1)], 15);
    expect(r.action).toBe('hold');
    expect(r.equity).toBe(150);
  });

  it('restores the strategy once with the current market context', () => {
    let seen: unknown = null;
    let restores = 0;
    const strategy = scripted([], {
      restore(snapshot: unknown, ctx: StrategyContext) { restores += 1; seen = { snapshot, ...ctx }; },
    });
    const snapshot = { ledger: { cash: 0, position: 2, entryPrice: 5, lastPrice: 5 }, strategy: { x: 1 } };
    const bot = new Bot(strategy, { startBalance: 10, snapshot: snapshot as never, downtimeSec: 120 });
    bot.step([candle(1)], 6);
    bot.step([candle(2)], 6);
    expect(restores).toBe(1);
    expect(seen).toEqual({ snapshot: { x: 1 }, price: 6, downtimeSec: 120, inPosition: true, entryPrice: 5 });
  });

  it('tells the strategy when its buy could not be filled', () => {
    const costs = { feePct: 0.1, slippagePct: 0, lot: { minOrderAmt: 5, minOrderQty: 0, qtyStep: 0.1 } };
    const strategy = martingaleLite();
    const bot = new Bot(strategy, { startBalance: 1, costs });
    bot.step([candle(1, 1)], 1);
    const r = bot.step([candle(1, 1), candle(2, 0.98)], 0.98);
    expect(r.action).toBe('buy');
    expect(r.trade).toBeNull();
    expect((strategy.toJSON!() as { inPosition: boolean }).inPosition).toBe(false);
  });

  it('keeps the last decided candle across a restart', () => {
    const bot = new Bot(scripted(['buy']), { startBalance: 100 });
    bot.step([candle(1)], 10);
    const strategy = scripted(['sell']);
    new Bot(strategy, { startBalance: 100, snapshot: bot.snapshot() }).step([candle(1)], 10);
    expect(strategy.calls).toBe(0);
  });
});

function fakeBot(name: string) {
  return { strategy: { name }, ledger: { equity: 100, position: 0, tradeCount: 0 } } as Trader & {
    ledger: { equity: number; position: number };
  };
}

function metaFor(bots: Trader[], options: Partial<MetaOptions> = {}) {
  return new MetaBot(bots, { startBalance: 100, windowCandles: 10, switchMarginPct: 0.5, ...options });
}

describe('MetaBot', () => {
  it('is named after the number of bots it watches', () => {
    expect(metaFor([fakeBot('a'), fakeBot('b')]).strategy.name).toBe(metaName(2));
  });

  it('stays out of the market while nobody is in profit', () => {
    const a = fakeBot('a');
    const b = fakeBot('b');
    const meta = metaFor([a, b]);
    meta.step([candle(1)], 1);
    a.ledger.equity = 99; a.ledger.position = 1;
    b.ledger.equity = 98; b.ledger.position = 1;
    const r = meta.step([candle(2)], 1);
    expect(meta.leader).toBeNull();
    expect(r.action).toBe('hold');
    expect(meta.ledger.position).toBe(0);
  });

  it('follows the best positive strategy in and out of the market', () => {
    const a = fakeBot('a');
    const b = fakeBot('b');
    const meta = metaFor([a, b]);
    meta.step([candle(1)], 1);
    a.ledger.equity = 101;
    b.ledger.equity = 103; b.ledger.position = 1;
    expect(meta.step([candle(2)], 1).action).toBe('buy');
    expect(meta.leader).toBe('b');
    b.ledger.position = 0;
    expect(meta.step([candle(3)], 1.1).action).toBe('sell');
  });

  it('switches leader only when the new one is ahead by the margin', () => {
    const a = fakeBot('a');
    const b = fakeBot('b');
    const meta = metaFor([a, b]);
    meta.step([candle(1)], 1);
    a.ledger.equity = 102;
    meta.step([candle(2)], 1);
    expect(meta.leader).toBe('a');
    b.ledger.equity = 102.4;
    meta.step([candle(3)], 1);
    expect(meta.leader).toBe('a');
    b.ledger.equity = 103;
    meta.step([candle(4)], 1);
    expect(meta.leader).toBe('b');
  });

  it('drops a leader whose window return is no longer positive', () => {
    const a = fakeBot('a');
    const meta = metaFor([a]);
    meta.step([candle(1)], 1);
    a.ledger.equity = 101; a.ledger.position = 1;
    meta.step([candle(2)], 1);
    expect(meta.ledger.position).toBeGreaterThan(0);
    a.ledger.equity = 99.5;
    expect(meta.step([candle(3)], 1).action).toBe('sell');
    expect(meta.leader).toBeNull();
  });

  it('keeps only the configured window of history', () => {
    const a = fakeBot('a');
    const meta = metaFor([a], { windowCandles: 3 });
    for (let t = 1; t <= 10; t += 1) {
      a.ledger.equity = 100 + t;
      meta.step([candle(t)], 1);
    }
    expect(meta.history.a).toEqual([107, 108, 109, 110]);
  });

  it('marks its snapshot as meta and restores leader and history', () => {
    const a = fakeBot('a');
    const meta = metaFor([a]);
    meta.step([candle(1)], 1);
    a.ledger.equity = 101;
    meta.step([candle(2)], 1);
    const snap = JSON.parse(JSON.stringify(meta.snapshot()));
    expect(snap.meta).toBe(true);
    const again = metaFor([a], { snapshot: snap });
    expect(again.leader).toBe('a');
    expect(again.history).toEqual(meta.history);
  });
});
