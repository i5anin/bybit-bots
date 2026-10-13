import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRetry } from '../src/lib/bybit.js';
import { createStrategy as emaRibbon } from '../src/strategies/emaRibbon.js';
import { botStatus, buildStats } from '../web/stats.mjs';

describe('logger', () => {
  let dir;
  let logger;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bybit-logs-'));
    process.env.LOG_DIR = dir;
    logger = await import('../src/lib/logger.js');
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  const row = bot => ({ symbol: 'DOGEUSDT', bot, price: 0.1, equity: 12, position: 0, trades: 0, runId: 'r' });

  test('writes all bots of a tick in one block under a single header', async () => {
    await logger.logEquity([row('A'), row('RSI (14, 30/70)')]);
    await logger.logEquity([row('A')]);
    const lines = (await readFile(join(dir, 'equity.csv'), 'utf8')).trim().split('\n');
    assert.equal(lines[0], 'time,symbol,bot,price,equity,position,trades,runId');
    assert.equal(lines.length, 4);
    assert.match(lines[2], /"RSI \(14, 30\/70\)",0\.1,12\.0000,0,0,r$/);
    assert.equal(lines[1].split(',')[0], lines[2].split(',')[0], 'one timestamp per tick');
  });

  test('writes the header again when the log was moved away while running', async () => {
    await logger.logTrade({ symbol: 'DOGEUSDT', bot: 'A', side: 'buy', price: 0.1, runId: 'r' });
    await rm(join(dir, 'trades.csv'));
    await logger.logTrade({ symbol: 'DOGEUSDT', bot: 'A', side: 'sell', price: 0.11, pnlPct: 9.5, runId: 'r' });
    const lines = (await readFile(join(dir, 'trades.csv'), 'utf8')).trim().split('\n');
    assert.equal(lines[0], 'time,symbol,bot,side,price,pnlPct,runId');
    assert.equal(lines.length, 2);
    assert.match(lines[1], /,A,sell,0\.11,9\.5,r$/);
  });
});

describe('withRetry', () => {
  test('retries with growing pauses and returns the first success', async () => {
    const delays = [];
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 4) throw new Error('down');
      return 'ok';
    }, { attempts: 5, baseMs: 5000, maxMs: 15000, sleep: async ms => { delays.push(ms); } });
    assert.equal(result, 'ok');
    assert.deepEqual(delays, [5000, 10000, 15000]);
  });

  test('gives up after the last attempt with the original error', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls += 1; throw new Error('still down'); }, { attempts: 3, sleep: async () => {} }),
      /still down/,
    );
    assert.equal(calls, 3);
  });
});

describe('EMA Ribbon', () => {
  const series = closes => closes.map((close, i) => ({ time: i, open: close, high: close, low: close, close, volume: 1 }));

  test('holds on a perfectly flat market instead of buying', () => {
    assert.equal(emaRibbon().signal(series(Array(60).fill(0.1))), 'hold');
  });

  test('buys on a steady rise and sells on a steady fall', () => {
    const up = Array.from({ length: 60 }, (_, i) => 1 + i * 0.01);
    assert.equal(emaRibbon().signal(series(up)), 'buy');
    assert.equal(emaRibbon().signal(series([...up].reverse())), 'sell');
  });
});

describe('botStatus', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const at = sec => new Date(now - sec * 1000).toISOString();

  test('is running while the state is fresh', () => {
    assert.deepEqual(botStatus({ currentRun: {}, updatedAt: at(70) }, now), { status: 'running', ageSec: 70 });
  });

  test('is stale when an unfinished run stopped writing', () => {
    assert.deepEqual(botStatus({ currentRun: {}, updatedAt: at(301) }, now), { status: 'stale', ageSec: 301 });
    assert.equal(botStatus({ currentRun: {} }, now).status, 'stale');
  });

  test('is stopped after a clean shutdown or before the first start', () => {
    assert.equal(botStatus({ currentRun: null, updatedAt: at(10) }, now).status, 'stopped');
    assert.equal(botStatus(null, now).status, 'stopped');
  });

  test('the panel stops showing a hung bot as running', () => {
    const s = buildStats({ state: { currentRun: {}, updatedAt: at(900), bots: {} }, now, startRub: 1000 });
    assert.equal(s.running, false);
    assert.equal(s.status, 'stale');
    assert.equal(s.ageSec, 900);
  });
});
