import { mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, marketId } from '../src/config/app-config.js';
import { BybitClient, parseKlines, parseLotRules, splitClosed, withRetry } from '../src/market/bybit.js';
import { createCsvTail, DecimatedSeries } from '../src/storage/csv-tail.js';
import { csvRow, parseCsv, parseCsvLine, type CsvRecord } from '../src/storage/csv.js';
import { StateStore } from '../src/storage/state-store.js';
import { formatDuration } from '../src/storage/time.js';
import { TradeLog } from '../src/storage/trade-log.js';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'bybit-bots-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('config', () => {
  it('reads the same variable names as the old bot and panel', () => {
    const c = loadConfig({ SYMBOL: 'DOGEUSDT', START_BALANCE: '11.98', STATE_DIR: 'st', LOGS_DIR: 'lg', FEE_PCT: '0.1' }, '/app');
    expect(c.startBalance).toBe(11.98);
    expect(c.dataDir).toMatch(/st$/);
    expect(c.logDir).toMatch(/lg$/);
    expect(c.feePct).toBe(0.1);
    expect(marketId(c)).toBe('mainnet:spot');
  });

  it('rejects a number that is not a number', () => {
    expect(() => loadConfig({ POLL_MS: 'fast' })).toThrow(/POLL_MS/);
  });
});

describe('Bybit responses', () => {
  it('parses klines into chronological order with numbers', () => {
    const json = { result: { list: [
      ['300000', '1', '2', '0.5', '1.5', '10'],
      ['0', '0.9', '1.1', '0.8', '1', '5'],
    ] as [string, string, string, string, string, string][] } };
    expect(parseKlines(json)).toEqual([
      { time: 0, open: 0.9, high: 1.1, low: 0.8, close: 1, volume: 5 },
      { time: 300000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    ]);
  });

  it('parses lot rules and rejects an unknown symbol', () => {
    const json = { result: { list: [{ lotSizeFilter: { minOrderAmt: '5', minOrderQty: '0.1', basePrecision: '0.1' } }] } };
    expect(parseLotRules(json, 'DOGEUSDT')).toEqual({ minOrderAmt: 5, minOrderQty: 0.1, qtyStep: 0.1 });
    expect(() => parseLotRules({ result: { list: [] } }, 'NOPE')).toThrow(/NOPE/);
  });

  it('turns an API error into an exception', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ retCode: 10001, retMsg: 'bad symbol' }))) as typeof fetch;
    const client = new BybitClient({ baseUrl: 'https://x', category: 'spot', timeoutMs: 1000, fetch: fetchFn });
    await expect(client.klines('NOPE', '5')).rejects.toThrow(/bad symbol/);
  });
});

describe('splitClosed', () => {
  const five = 5 * 60_000;
  const candles = [0, 1, 2].map(i => ({ time: i * five, open: 0, high: 0, low: 0, close: i + 1, volume: 0 }));

  it('drops the candle that is still open and prices at its close', () => {
    const { closed, price } = splitClosed(candles, '5', 2 * five + 1000);
    expect(closed.map(c => c.time)).toEqual([0, five]);
    expect(price).toBe(3);
  });

  it('keeps every candle when the exchange returned only closed ones', () => {
    expect(splitClosed(candles, 5, 3 * five).closed).toHaveLength(3);
  });

  it('handles an empty response', () => {
    expect(splitClosed([], 5, 0)).toEqual({ closed: [], price: null });
  });
});

describe('withRetry', () => {
  it('retries with growing pauses and returns the first success', async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 4) throw new Error('down');
      return 'ok';
    }, { attempts: 5, baseMs: 5000, maxMs: 15000, sleep: async ms => { delays.push(ms); } });
    expect(result).toBe('ok');
    expect(delays).toEqual([5000, 10000, 15000]);
  });

  it('gives up after the last attempt with the original error', async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls += 1; throw new Error('still down'); }, {
      attempts: 3, sleep: async () => {},
    })).rejects.toThrow(/still down/);
    expect(calls).toBe(3);
  });
});

describe('CSV', () => {
  it('quotes strategy names with commas and round-trips them', () => {
    const row = csvRow(['t', 'RSI (14, 30/70)', 'say "hi"', 1.5, null]);
    expect(row).toBe('t,"RSI (14, 30/70)","say ""hi""",1.5,\n');
    expect(parseCsvLine(row.trimEnd())).toEqual(['t', 'RSI (14, 30/70)', 'say "hi"', '1.5', '']);
  });

  it('parseCsv maps rows to the header', () => {
    expect(parseCsv('a,b\r\n1,2\n')).toEqual([{ a: '1', b: '2' }]);
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes, hours and days', () => {
    expect(formatDuration(5)).toBe('5с');
    expect(formatDuration(65)).toBe('1м 05с');
    expect(formatDuration(3 * 3600 + 120)).toBe('3ч 02м');
    expect(formatDuration(2 * 86400 + 3600 + 60)).toBe('2д 1ч 01м');
    expect(formatDuration(-3)).toBe('0с');
  });
});

describe('createCsvTail', () => {
  it('reads only new complete lines and keeps a partial one for later', async () => {
    const file = join(dir, 'tail.csv');
    await writeFile(file, 'bot,equity\nA,1\nB,');
    const rows: CsvRecord[] = [];
    const read = createCsvTail(file, { onRows: r => rows.push(...r) });
    await read();
    expect(rows).toEqual([{ bot: 'A', equity: '1' }]);
    await appendFile(file, '2\nA,3\n');
    await read();
    expect(rows.map(r => r.equity)).toEqual(['1', '2', '3']);
    await read();
    expect(rows).toHaveLength(3);
  });

  it('does not break a multibyte name split across two reads', async () => {
    const file = join(dir, 'utf8.csv');
    const name = 'Авто-выбор лучшей (11)';
    const line = Buffer.from(`${name},5\n`);
    await writeFile(file, Buffer.concat([Buffer.from('bot,equity\n'), line.subarray(0, 3)]));
    const rows: CsvRecord[] = [];
    const read = createCsvTail(file, { onRows: r => rows.push(...r) });
    await read();
    await appendFile(file, line.subarray(3));
    await read();
    expect(rows).toEqual([{ bot: name, equity: '5' }]);
  });

  it('starts over when the file is replaced by a shorter one', async () => {
    const file = join(dir, 'reset.csv');
    await writeFile(file, 'bot,equity\nA,1\nA,2\nA,3\n');
    let rows: CsvRecord[] = [];
    let resets = 0;
    const read = createCsvTail(file, { onRows: r => rows.push(...r), onReset: () => { resets += 1; rows = []; } });
    await read();
    await writeFile(file, 'bot,equity\nB,9\n');
    await read();
    expect(resets).toBe(1);
    expect(rows).toEqual([{ bot: 'B', equity: '9' }]);
  });

  it('parallel reads do not duplicate rows', async () => {
    const file = join(dir, 'race.csv');
    await writeFile(file, 'bot,equity\n' + 'A,1\n'.repeat(500));
    const rows: CsvRecord[] = [];
    const read = createCsvTail(file, { onRows: r => rows.push(...r) });
    await Promise.all([read(), read(), read()]);
    expect(rows).toHaveLength(500);
  });

  it('a missing file is just empty', async () => {
    const rows: CsvRecord[] = [];
    await createCsvTail(join(dir, 'none.csv'), { onRows: r => rows.push(...r) })();
    expect(rows).toHaveLength(0);
  });
});

describe('DecimatedSeries', () => {
  it('keeps memory bounded and still ends at the latest value', () => {
    const s = new DecimatedSeries(100);
    for (let i = 0; i < 10_000; i += 1) s.push(i);
    expect(s.values.length).toBeLessThanOrEqual(200);
    expect(s.values[0]).toBe(0);
    const spark = s.sample(60);
    expect(spark.length).toBeLessThanOrEqual(60);
    expect(spark.at(-1)).toBe(9999);
    expect(spark.every((v, i) => i === 0 || v > spark[i - 1]!)).toBe(true);
  });

  it('a single point gives a flat two-point line', () => {
    const s = new DecimatedSeries();
    s.push(5);
    expect(s.sample(60)).toEqual([5, 5]);
  });
});

describe('TradeLog', () => {
  const row = (bot: string) => ({ symbol: 'DOGEUSDT', bot, price: 0.1, equity: 12, position: 0 as const, trades: 0, runId: 'r' });

  it('writes all bots of a tick in one block under a single header', async () => {
    const log = new TradeLog(join(dir, 'logs1'));
    await log.equity([row('A'), row('RSI (14, 30/70)')]);
    await log.equity([row('A')]);
    const lines = (await readFile(log.file('equity'), 'utf8')).trim().split('\n');
    expect(lines[0]).toBe('time,symbol,bot,price,equity,position,trades,runId');
    expect(lines).toHaveLength(4);
    expect(lines[2]).toMatch(/"RSI \(14, 30\/70\)",0\.1,12\.0000,0,0,r$/);
    expect(lines[1]!.split(',')[0]).toBe(lines[2]!.split(',')[0]);
  });

  it('writes the header again when the log was moved away while running', async () => {
    const log = new TradeLog(join(dir, 'logs2'));
    await log.trade({ symbol: 'DOGEUSDT', bot: 'A', side: 'buy', price: 0.1, runId: 'r' });
    await rm(log.file('trades'));
    await log.trade({ symbol: 'DOGEUSDT', bot: 'A', side: 'sell', price: 0.11, pnlPct: 9.5, runId: 'r' });
    const lines = (await readFile(log.file('trades'), 'utf8')).trim().split('\n');
    expect(lines[0]).toBe('time,symbol,bot,side,price,pnlPct,runId');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/,A,sell,0\.11,9\.5,r$/);
  });
});

describe('StateStore', () => {
  it('returns null for a missing, broken or foreign-version file', async () => {
    const store = new StateStore(join(dir, 'state1'));
    expect(await store.load()).toBeNull();
    await writeFile(join(dir, 'broken.json'), '{');
    await store.save({ version: 99 } as never);
    expect(await store.load()).toBeNull();
  });

  it('saves atomically and loads back', async () => {
    const store = new StateStore(join(dir, 'state2'));
    const state = { version: 1, symbol: 'DOGEUSDT', bots: {} } as never;
    await store.save(state);
    expect(await store.load()).toEqual(state);
  });
});
