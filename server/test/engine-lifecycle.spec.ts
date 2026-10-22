import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/app-config.js';
import type { SocketLike } from '../src/market/bybit-stream.js';
import { StateStore } from '../src/storage/state-store.js';
import { TradeLog } from '../src/storage/trade-log.js';
import { EngineService } from '../src/trading/engine.service.js';
import type { Candle, StrategyFactory } from '../src/trading/types.js';

// Повторы запросов к бирже без пауз: иначе тест ждал бы секунды.
vi.mock('../src/market/bybit.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/market/bybit.js')>();
  return {
    ...real,
    withRetry: (fn: () => Promise<unknown>, o: Parameters<typeof real.withRetry>[1] = {}) =>
      real.withRetry(fn, { ...o, sleep: async () => {} }),
  };
});

const STEP = 300_000;
const LOT = { minOrderAmt: 5, minOrderQty: 0, qtyStep: 0 };
let dir = '';
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function candles(price: (i: number) => number): Candle[] {
  const lastOpen = Math.floor(Date.now() / STEP) * STEP - STEP;
  return Array.from({ length: 101 }, (_, i) => {
    const close = price(i);
    return { time: lastOpen - (100 - i) * STEP, open: close, high: close, low: close, close, volume: 1 };
  });
}

function fakeBybit() {
  return {
    tickers: vi.fn(async () => [
      { symbol: 'AUSDT', lastPrice: 1, highPrice24h: 2, lowPrice24h: 1, price24hPcnt: 0, turnover24h: 1e9 },
      { symbol: 'BUSDT', lastPrice: 1, highPrice24h: 1.5, lowPrice24h: 1, price24hPcnt: 0, turnover24h: 1e9 },
      { symbol: 'CUSDT', lastPrice: 1, highPrice24h: 1.1, lowPrice24h: 1, price24hPcnt: 0, turnover24h: 1e9 },
    ]),
    lotRules: vi.fn(async (symbol: string) => {
      if (symbol === 'BADUSDT') throw new Error('нет пары');
      return LOT;
    }),
    klines: vi.fn(async (symbol: string) => candles(i => (symbol === 'AUSDT' ? 1 : 2) * (1 + Math.sin(i / 3) * 0.03))),
  };
}

// Поддельный сокет: запоминает отправленное, события вызывает тест.
function fakeSocket() {
  const sockets: (SocketLike & { sent: string[] })[] = [];
  const factory = () => {
    const ws = {
      onopen: null, onmessage: null, onclose: null, onerror: null, sent: [] as string[],
      send(data: string) { this.sent.push(data); },
      close() { this.onclose?.(); },
    } as SocketLike & { sent: string[] };
    sockets.push(ws);
    return ws;
  };
  return { sockets, factory };
}

async function setup(env: Record<string, string>, bybit = fakeBybit(), socket?: ReturnType<typeof fakeSocket>) {
  dir = await mkdtemp(join(tmpdir(), 'bybit-life-'));
  const config = loadConfig({ DATA_DIR: join(dir, 'data'), LOG_DIR: join(dir, 'logs'), START_BALANCE: '11.98', BYBIT_STREAM: '0', ...env });
  const store = new StateStore(config.dataDir);
  const log = new TradeLog(config.logDir);
  const e = new EngineService(config, bybit as never, store, log, socket?.factory);
  return { e, store, log, config, bybit };
}

// Стратегия, которая покупает на первой свече и продаёт на второй.
const flip: StrategyFactory = () => {
  let n = 0;
  return { name: 'Флип', signal: () => (n++ % 2 === 0 ? 'buy' : 'sell') };
};

describe('запуск движка', () => {
  it('берёт топ пар по волатильности и пропускает пару без правил лота', async () => {
    const { e, bybit } = await setup({ SYMBOLS: 'top:2', SYMBOLS_MIN_TURNOVER: '1' });
    expect(await e.resolveSymbols(null)).toEqual(['AUSDT', 'BUSDT']);
    expect(bybit.tickers).toHaveBeenCalledOnce();

    const one = await setup({ SYMBOL: 'AUSDT' });
    expect(await one.e.resolveSymbols(null)).toEqual(['AUSDT']);

    const bad = await setup({ SYMBOLS: 'AUSDT,BADUSDT' });
    await bad.e.start();
    expect(bad.e.marketSymbols()).toEqual(['AUSDT']);
    await bad.e.beforeApplicationShutdown('test');
  });

  it('слушает поток свечей через поданный сокет и торгует по закрытию свечи', async () => {
    const socket = fakeSocket();
    const { e } = await setup({ SYMBOLS: 'AUSDT,BUSDT', BYBIT_STREAM: '1', POLL_MS: '3600000' }, fakeBybit(), socket);
    await e.start([flip]);
    const ws = socket.sockets[0]!;
    ws.onopen!();
    expect(JSON.parse(ws.sent[0]!).args).toEqual(['kline.5.AUSDT', 'kline.5.BUSDT']);

    const tick = vi.spyOn(e, 'tick');
    ws.onmessage!({ data: JSON.stringify({ topic: 'kline.5.AUSDT', data: [{ start: 0, confirm: true }] }) });
    expect(tick).toHaveBeenCalledWith('поток', STEP);
    await tick.mock.results[0]!.value;
    expect(e.state()?.feed?.streamConnected).toBe(true);

    await e.beforeApplicationShutdown('SIGTERM');
    expect(e.state()?.currentRun).toBeNull();
    // Повторная остановка ничего не делает.
    await e.beforeApplicationShutdown('SIGTERM');
  });

  it('при сбое старта пишет ошибку и просит процесс завершиться', async () => {
    const bybit = fakeBybit();
    const { e, store } = await setup({ SYMBOL: 'AUSDT' }, bybit);
    vi.spyOn(store, 'load').mockRejectedValue(new Error('диск'));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    e.onApplicationBootstrap();
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM'));
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('не стартует торговлю, если остановка пришла во время ожидания биржи', async () => {
    const { e, store } = await setup({ SYMBOL: 'AUSDT' });
    const load = vi.spyOn(store, 'load');
    const pending = e.start();
    await e.beforeApplicationShutdown('SIGTERM');
    await pending;
    expect(load).toHaveBeenCalledOnce();
    expect(e.marketSymbols()).toEqual([]);
  });
});

describe('тик движка', () => {
  it('сообщает о сделках подписчикам, и упавший подписчик не мешает остальным', async () => {
    const { e, log } = await setup({ SYMBOL: 'AUSDT' });
    await e.init(['AUSDT'], LOT, [flip]);
    const events: string[] = [];
    e.onTrade(() => { throw new Error('сломан'); });
    const off = e.onTrade(ev => events.push(`${ev.bot}:${ev.side}`));
    await e.tick();
    expect(events).toContain('Флип:buy');
    expect((await readFile(log.file('trades'), 'utf8'))).toContain('Флип');
    off();
  });

  it('не запускает второй тик внахлёст и не тикает до init', async () => {
    const { e } = await setup({ SYMBOL: 'AUSDT' });
    await e.tick();
    expect(e.state()).toBeNull();
    await e.init(['AUSDT'], LOT, [flip]);
    const a = e.tick();
    expect(e.tick()).toBe(a);
    await a;
  });

  it('пропускает пару без свечей и с битой ценой и переживает ошибку тика', async () => {
    const bybit = fakeBybit();
    const { e, store } = await setup({ SYMBOLS: 'AUSDT,BUSDT,CUSDT' }, bybit);
    await e.init(['AUSDT', 'BUSDT', 'CUSDT'], LOT, [flip]);
    bybit.klines.mockImplementation(async (s: string) => {
      if (s === 'AUSDT') throw new Error('сеть');
      if (s === 'BUSDT') return [];
      return candles(() => Number.NaN);
    });
    await e.tick();
    expect(e.state()?.feed?.lagSec).toBeNull();

    vi.spyOn(store, 'save').mockRejectedValue(new Error('диск полон'));
    bybit.klines.mockImplementation(async () => candles(() => 1));
    await expect(e.tick()).resolves.toBeUndefined();
  });

  it('записывает сбой прошлого запуска и простой при продолжении', async () => {
    const first = await setup({ SYMBOL: 'AUSDT' });
    await first.e.init(['AUSDT'], LOT, [flip]);
    await first.e.tick();
    // Без штатной остановки в состоянии остаётся currentRun — это сбой.
    const again = new EngineService(first.config, fakeBybit() as never, first.store, first.log);
    await again.init(['AUSDT'], LOT, [flip]);
    await again.tick();
    const runs = (await readFile(first.log.file('runs'), 'utf8')).trim().split('\n').map(l => l.split(',')[1]);
    expect(runs).toEqual(['event', 'start', 'crash', 'start', 'resume']);
  });

  it('сбрасывает счёт, когда параметры запуска изменились', async () => {
    const first = await setup({ SYMBOL: 'AUSDT' });
    await first.e.init(['AUSDT'], LOT, [flip]);
    await first.e.beforeApplicationShutdown();
    const changed = loadConfig({ DATA_DIR: first.config.dataDir, LOG_DIR: first.config.logDir, START_BALANCE: '50', BYBIT_STREAM: '0' });
    const again = new EngineService(changed, fakeBybit() as never, first.store, first.log);
    await again.init(['AUSDT'], LOT, [flip]);
    expect(again.state()).toBeNull();
  });
});

describe('остановка движка', () => {
  it('до старта просто выходит, а ошибку записи состояния пишет в лог', async () => {
    const idle = await setup({ SYMBOL: 'AUSDT' });
    await idle.e.beforeApplicationShutdown();
    expect(idle.e.state()).toBeNull();

    const { e, store } = await setup({ SYMBOL: 'AUSDT' });
    await e.init(['AUSDT'], LOT, [flip]);
    vi.spyOn(store, 'save').mockRejectedValue(new Error('диск полон'));
    await expect(e.beforeApplicationShutdown()).resolves.toBeUndefined();
  });
});
