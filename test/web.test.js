import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCsvTail, DecimatedSeries, parseCsv, splitRow } from '../web/csvTail.mjs';
import { addEquity, buildStats } from '../web/stats.mjs';
import { digestMessage } from '../web/telegram.mjs';

let dir;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'bybit-bots-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

describe('splitRow', () => {
  test('handles quoted commas and escaped quotes', () => {
    assert.deepEqual(splitRow('a,"RSI (14, 30/70)","x ""y""",'), ['a', 'RSI (14, 30/70)', 'x "y"', '']);
  });

  test('parseCsv maps rows to the header', () => {
    assert.deepEqual(parseCsv('a,b\r\n1,2\n'), [{ a: '1', b: '2' }]);
  });
});

describe('createCsvTail', () => {
  test('reads only new complete lines and keeps a partial one for later', async () => {
    const file = join(dir, 'tail.csv');
    await writeFile(file, 'bot,equity\nA,1\nB,');
    const rows = [];
    const read = createCsvTail(file, { onRows: r => rows.push(...r) });

    await read();
    assert.deepEqual(rows, [{ bot: 'A', equity: '1' }]);

    await appendFile(file, '2\nA,3\n');
    await read();
    assert.deepEqual(rows.map(r => r.equity), ['1', '2', '3']);

    await read();
    assert.equal(rows.length, 3, 'nothing new — nothing added');
  });

  test('does not break a multibyte name split across two reads', async () => {
    const file = join(dir, 'utf8.csv');
    const name = 'Авто-выбор лучшей (11)';
    const line = Buffer.from(`${name},5\n`);
    await writeFile(file, Buffer.concat([Buffer.from('bot,equity\n'), line.subarray(0, 3)]));
    const rows = [];
    const read = createCsvTail(file, { onRows: r => rows.push(...r) });
    await read();
    await appendFile(file, line.subarray(3));
    await read();
    assert.deepEqual(rows, [{ bot: name, equity: '5' }]);
  });

  test('starts over when the file is replaced by a shorter one', async () => {
    const file = join(dir, 'reset.csv');
    await writeFile(file, 'bot,equity\nA,1\nA,2\nA,3\n');
    let rows = [];
    let resets = 0;
    const read = createCsvTail(file, { onRows: r => rows.push(...r), onReset: () => { resets += 1; rows = []; } });
    await read();
    await writeFile(file, 'bot,equity\nB,9\n');
    await read();
    assert.equal(resets, 1);
    assert.deepEqual(rows, [{ bot: 'B', equity: '9' }]);
  });

  test('parallel reads do not duplicate rows', async () => {
    const file = join(dir, 'race.csv');
    await writeFile(file, 'bot,equity\n' + 'A,1\n'.repeat(500));
    const rows = [];
    const read = createCsvTail(file, { onRows: r => rows.push(...r) });
    await Promise.all([read(), read(), read()]);
    assert.equal(rows.length, 500);
  });

  test('a missing file is just empty', async () => {
    const rows = [];
    await createCsvTail(join(dir, 'none.csv'), { onRows: r => rows.push(...r) })();
    assert.equal(rows.length, 0);
  });
});

describe('DecimatedSeries', () => {
  test('keeps memory bounded and still ends at the latest value', () => {
    const s = new DecimatedSeries(100);
    for (let i = 0; i < 10_000; i += 1) s.push(i);
    assert.ok(s.values.length <= 200);
    assert.equal(s.values[0], 0);
    const spark = s.sample(60);
    assert.ok(spark.length <= 60);
    assert.equal(spark.at(-1), 9999);
    assert.ok(spark.every((v, i) => i === 0 || v > spark[i - 1]), 'order is preserved');
  });

  test('a single point gives a flat two-point line', () => {
    const s = new DecimatedSeries();
    s.push(5);
    assert.deepEqual(s.sample(60), [5, 5]);
  });
});

describe('buildStats', () => {
  const state = {
    startBalance: 12,
    symbol: 'DOGEUSDT',
    bots: {
      'Stochastic Oscillator (14, 20/80)': { ledger: { cash: 13.2, position: 0, lastPrice: 0.1 } },
      'Авто-выбор лучшей (11)': { meta: true, leader: null, ledger: { cash: 6, position: 50, lastPrice: 0.1 } },
      'Old meta': { leader: 'x', ledger: { cash: 12, position: 0 } },
    },
  };
  const rate = { value: 80, source: 'test' };
  const equity = addEquity({ series: new Map(), lastPrice: null }, [
    { bot: 'Stochastic Oscillator (14, 20/80)', equity: '12', price: '0.1' },
    { bot: 'Stochastic Oscillator (14, 20/80)', equity: '13.2', price: '0.11' },
  ]);

  test('counts rubles from the fixed start, not from today\'s rate', () => {
    const s = buildStats({ state, equity, rate, startRub: 1000 });
    const best = s.bots[0];
    assert.equal(best.equityRub, 1056);
    assert.equal(best.pnlRubPct, 5.6);
    assert.equal(best.pnlPct, 10);
    assert.equal(s.startRub, 1000);
  });

  test('falls back to start balance times the rate without START_RUB', () => {
    assert.equal(buildStats({ state, equity, rate, startRub: 0 }).startRub, 960);
  });

  test('marks the meta bot even in snapshots from before the flag', () => {
    const s = buildStats({ state, equity, rate, startRub: 1000 });
    const meta = s.bots.filter(b => b.isMeta).map(b => b.name).sort();
    assert.deepEqual(meta, ['Old meta', 'Авто-выбор лучшей (11)']);
  });

  test('takes the price and sparkline from the equity log', () => {
    const s = buildStats({ state, equity, rate, startRub: 1000 });
    assert.equal(s.price, 0.11);
    assert.deepEqual(s.bots[0].spark, [12, 13.2, 13.2]);
    assert.equal(s.baseAsset, 'DOGE');
  });

  test('counts win rate over closed trades only', () => {
    const trades = [{ pnlPct: '' }, { pnlPct: '1.2' }, { pnlPct: '-0.3' }, { pnlPct: '0.5' }];
    const s = buildStats({ state, equity, trades, rate, startRub: 1000 });
    assert.equal(s.totals.tradesClosed, 3);
    assert.equal(s.totals.winRatePct, 66.7);
  });

  test('the daily digest shows rubles and the per-bot start', () => {
    const text = digestMessage(buildStats({ state, equity, rate, startRub: 1000 }), '');
    assert.match(text, /1056 ₽/);
    assert.match(text, /Старт у каждого бота: 1000 ₽ \(12 USDT\)/);
  });
});
