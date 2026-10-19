import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/app-config.js';
import { KlineStream, type SocketLike } from '../src/market/bybit-stream.js';
import { StateStore } from '../src/storage/state-store.js';
import { TradeLog } from '../src/storage/trade-log.js';
import { EngineService } from '../src/trading/engine.service.js';
import type { Candle } from '../src/trading/types.js';

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.onclose?.(); }
  emit(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

afterEach(() => { vi.useRealTimers(); });

describe('KlineStream', () => {
  function stream() {
    const sockets: FakeSocket[] = [];
    const closedAt: number[] = [];
    const s = new KlineStream({
      url: 'wss://x', symbols: ['DOGEUSDT'], interval: '5',
      onCandleClosed: (_, start) => closedAt.push(start),
      socket: () => { const ws = new FakeSocket(); sockets.push(ws); return ws; },
      pingMs: 1000,
    });
    return { s, sockets, closedAt };
  }

  it('subscribes to the candle topic and keeps the connection alive', () => {
    vi.useFakeTimers();
    const { s, sockets } = stream();
    s.start();
    sockets[0]!.onopen?.();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ op: 'subscribe', args: ['kline.5.DOGEUSDT'] });
    vi.advanceTimersByTime(2500);
    expect(sockets[0]!.sent.filter(m => m.includes('ping'))).toHaveLength(2);
    expect(s.connected).toBe(true);
    s.stop();
  });

  it('subscribes to many pairs in batches of ten and names the pair on close', () => {
    const sockets: FakeSocket[] = [];
    const closed: string[] = [];
    const symbols = Array.from({ length: 25 }, (_, i) => `P${i}USDT`);
    const s = new KlineStream({
      url: 'wss://x', symbols, interval: '5',
      onCandleClosed: symbol => closed.push(symbol),
      socket: () => { const ws = new FakeSocket(); sockets.push(ws); return ws; },
    });
    s.start();
    sockets[0]!.onopen?.();
    const subs = sockets[0]!.sent.map(m => JSON.parse(m) as { op: string; args: string[] }).filter(m => m.op === 'subscribe');
    expect(subs.map(m => m.args.length)).toEqual([10, 10, 5]);
    sockets[0]!.emit({ topic: 'kline.5.P17USDT', data: [{ start: 1, confirm: true }] });
    expect(closed).toEqual(['P17USDT']);
    s.stop();
  });

  it('reports only closed candles of its own topic', () => {
    const { s, sockets, closedAt } = stream();
    s.start();
    sockets[0]!.onopen?.();
    sockets[0]!.emit({ topic: 'kline.5.DOGEUSDT', data: [{ start: 1, confirm: false }] });
    sockets[0]!.emit({ topic: 'kline.5.BTCUSDT', data: [{ start: 2, confirm: true }] });
    sockets[0]!.emit({ topic: 'kline.5.DOGEUSDT', data: [{ start: 3, confirm: true }] });
    sockets[0]!.onmessage?.({ data: 'not json' });
    expect(closedAt).toEqual([3]);
    s.stop();
  });

  it('reconnects after a drop with a growing pause and stops for good', () => {
    vi.useFakeTimers();
    const { s, sockets } = stream();
    s.start();
    sockets[0]!.onopen?.();
    sockets[0]!.close();
    expect(s.connected).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.close();
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    s.stop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(3);
  });
});

describe('data freshness', () => {
  let dir: string;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  async function engine(lagMs: number) {
    dir = await mkdtemp(join(tmpdir(), 'bybit-fresh-'));
    const config = loadConfig({ DATA_DIR: join(dir, 'data'), LOG_DIR: join(dir, 'logs'), START_BALANCE: '11.98', BYBIT_STREAM: '0' });
    const step = 300_000;
    const bybit = {
      async klines(): Promise<Candle[]> {
        // Последняя свеча закрылась lagMs назад; открытой новой в ответе нет.
        const lastOpen = Date.now() - lagMs - step;
        return Array.from({ length: 101 }, (_, i) => {
          const close = 0.1 * (1 + Math.sin(i / 4) * 0.01);
          return { time: lastOpen - (100 - i) * step, open: close, high: close, low: close, close, volume: 1 };
        });
      },
    };
    const store = new StateStore(config.dataDir);
    const e = new EngineService(config, bybit as never, store, new TradeLog(config.logDir));
    await e.init(['DOGEUSDT'], { minOrderAmt: 5, minOrderQty: 0.1, qtyStep: 0.1 });
    await e.tick('поток');
    return { e, store };
  }

  it('trades on a candle that has just closed and records the delay', async () => {
    const { e } = await engine(400);
    const feed = e.state()!.feed!;
    expect(feed.source).toBe('поток');
    expect(feed.lagSec).toBeGreaterThanOrEqual(0.4);
    expect(feed.lagSec).toBeLessThan(5);
    expect(feed.staleSkips).toBe(0);
  });

  it('treats the candle as closed when the stream says so a moment before its end', async () => {
    const { e } = await engine(0);
    const before = e.state()!.bots['SMA Crossover (10/30)']!.lastSignalCandle!;
    // Свеча, которая формально закончится через 30 мс: без подсказки потока она открыта.
    const end = before + 2 * 300_000;
    const bybit = (e as unknown as { bybit: { klines: () => Promise<Candle[]> } }).bybit;
    const original = bybit.klines.bind(bybit);
    bybit.klines = async () => {
      const candles = await original();
      const last = candles[candles.length - 1]!;
      return [...candles, { ...last, time: end - 300_000 }];
    };
    vi.spyOn(Date, 'now').mockReturnValue(end - 30);
    await e.tick('поток', end);
    vi.restoreAllMocks();
    expect(e.state()!.bots['SMA Crossover (10/30)']!.lastSignalCandle).toBe(end - 300_000);
  });

  it('skips the tick when the exchange returns data older than one candle', async () => {
    const { e, store } = await engine(6 * 60_000);
    await e.tick('опрос');
    const state = (await store.load())!;
    // Состояние сохранено, но ни один бот по устаревшим свечам не решал.
    expect(Object.values(state.bots).every(b => b.lastSignalCandle === null)).toBe(true);
    expect(state.feed!.staleSkips).toBe(2);
  });
});
