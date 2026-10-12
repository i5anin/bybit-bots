import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { MetaBot, metaName } from '../src/metaBot.js';
import { createStrategy as martingale } from '../src/strategies/martingaleLite.js';

const candle = (time, close = 1) => ({ time, open: close, high: close, low: close, close, volume: 1 });

function scripted(actions, extra = {}) {
  const calls = [];
  return {
    name: 'scripted',
    calls,
    signal() {
      calls.push('signal');
      return actions.shift() ?? 'hold';
    },
    ...extra,
  };
}

describe('Bot', () => {
  test('makes one decision per closed candle', () => {
    const strategy = scripted(['buy', 'sell']);
    const bot = new Bot(strategy, { startBalance: 100 });
    bot.step([candle(1)], 10);
    bot.step([candle(1)], 11);
    bot.step([candle(1)], 12);
    assert.equal(strategy.calls.length, 1);
    assert.equal(bot.ledger.position, 10);

    const r = bot.step([candle(1), candle(2)], 12);
    assert.equal(r.action, 'sell');
    assert.equal(bot.ledger.position, 0);
    assert.equal(bot.ledger.cash, 120);
  });

  test('marks equity to the current price even between decisions', () => {
    const bot = new Bot(scripted(['buy']), { startBalance: 100 });
    bot.step([candle(1)], 10);
    const r = bot.step([candle(1)], 15);
    assert.equal(r.action, 'hold');
    assert.equal(r.equity, 150);
  });

  test('restores the strategy once with the current market context', () => {
    let ctx = null;
    let restores = 0;
    const strategy = scripted([], {
      restore(snapshot, c) { restores += 1; ctx = { snapshot, ...c }; },
    });
    const snapshot = { ledger: { cash: 0, position: 2, entryPrice: 5, lastPrice: 5 }, strategy: { x: 1 } };
    const bot = new Bot(strategy, { startBalance: 10, snapshot, downtimeSec: 120 });
    bot.step([candle(1)], 6);
    bot.step([candle(2)], 6);
    assert.equal(restores, 1);
    assert.deepEqual(ctx, { snapshot: { x: 1 }, price: 6, downtimeSec: 120, inPosition: true, entryPrice: 5 });
  });

  test('tells the strategy when its buy could not be filled', () => {
    const costs = { feePct: 0.1, slippagePct: 0, lot: { minOrderAmt: 5, minOrderQty: 0, qtyStep: 0.1 } };
    const strategy = martingale();
    const bot = new Bot(strategy, { startBalance: 1, costs });
    bot.step([candle(1, 1)], 1);
    const r = bot.step([candle(1, 1), candle(2, 0.98)], 0.98);
    assert.equal(r.action, 'buy');
    assert.equal(r.trade, null);
    assert.equal(strategy.toJSON().inPosition, false, 'strategy must not wait to sell what it never bought');
  });

  test('keeps the last decided candle across a restart', () => {
    const bot = new Bot(scripted(['buy']), { startBalance: 100 });
    bot.step([candle(1)], 10);
    const strategy = scripted(['sell']);
    const again = new Bot(strategy, { startBalance: 100, snapshot: bot.snapshot() });
    again.step([candle(1)], 10);
    assert.equal(strategy.calls.length, 0);
  });
});

function fakeBot(name) {
  return { strategy: { name }, ledger: { equity: 100, position: 0 } };
}

function metaFor(bots, options = {}) {
  return new MetaBot(bots, { startBalance: 100, windowCandles: 10, switchMarginPct: 0.5, ...options });
}

describe('MetaBot', () => {
  test('is named after the number of bots it watches', () => {
    assert.equal(metaFor([fakeBot('a'), fakeBot('b')]).strategy.name, metaName(2));
  });

  test('stays out of the market while nobody is in profit', () => {
    const a = fakeBot('a');
    const b = fakeBot('b');
    const meta = metaFor([a, b]);
    meta.step([candle(1)], 1);
    a.ledger.equity = 99; a.ledger.position = 1;
    b.ledger.equity = 98; b.ledger.position = 1;
    const r = meta.step([candle(2)], 1);
    assert.equal(meta.leader, null);
    assert.equal(r.action, 'hold');
    assert.equal(meta.ledger.position, 0);
  });

  test('follows the best positive strategy in and out of the market', () => {
    const a = fakeBot('a');
    const b = fakeBot('b');
    const meta = metaFor([a, b]);
    meta.step([candle(1)], 1);

    a.ledger.equity = 101;
    b.ledger.equity = 103; b.ledger.position = 1;
    assert.equal(meta.step([candle(2)], 1).action, 'buy');
    assert.equal(meta.leader, 'b');

    b.ledger.position = 0;
    assert.equal(meta.step([candle(3)], 1.1).action, 'sell');
  });

  test('switches leader only when the new one is ahead by the margin', () => {
    const a = fakeBot('a');
    const b = fakeBot('b');
    const meta = metaFor([a, b]);
    meta.step([candle(1)], 1);
    a.ledger.equity = 102;
    meta.step([candle(2)], 1);
    assert.equal(meta.leader, 'a');

    b.ledger.equity = 102.4;
    meta.step([candle(3)], 1);
    assert.equal(meta.leader, 'a', '0.4 % ahead is within the margin');

    b.ledger.equity = 103;
    meta.step([candle(4)], 1);
    assert.equal(meta.leader, 'b');
  });

  test('drops a leader whose window return is no longer positive', () => {
    const a = fakeBot('a');
    const meta = metaFor([a]);
    meta.step([candle(1)], 1);
    a.ledger.equity = 101; a.ledger.position = 1;
    meta.step([candle(2)], 1);
    assert.equal(meta.ledger.position > 0, true);

    a.ledger.equity = 99.5;
    const r = meta.step([candle(3)], 1);
    assert.equal(meta.leader, null);
    assert.equal(r.action, 'sell');
  });

  test('keeps only the configured window of history', () => {
    const a = fakeBot('a');
    const meta = metaFor([a], { windowCandles: 3 });
    for (let t = 1; t <= 10; t += 1) {
      a.ledger.equity = 100 + t;
      meta.step([candle(t)], 1);
    }
    assert.deepEqual(meta.history.a, [107, 108, 109, 110]);
  });

  test('marks its snapshot as meta and restores leader and history', () => {
    const a = fakeBot('a');
    const meta = metaFor([a]);
    meta.step([candle(1)], 1);
    a.ledger.equity = 101;
    meta.step([candle(2)], 1);
    const snap = JSON.parse(JSON.stringify(meta.snapshot()));
    assert.equal(snap.meta, true);
    const again = metaFor([a], { snapshot: snap });
    assert.equal(again.leader, 'a');
    assert.deepEqual(again.history, meta.history);
  });
});
