import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/app-config.js';
import { StateStore } from '../src/storage/state-store.js';
import { TradeLog } from '../src/storage/trade-log.js';
import { botKey, EngineService, parseBotKey } from '../src/trading/engine.service.js';
import { Ledger } from '../src/trading/ledger.js';
import type { Candle } from '../src/trading/types.js';

const STEP = 300_000;
let dir = '';
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

// Биржа-заглушка: у каждой пары свои свечи; у STALE последняя закрыта 20 минут назад.
function fakeBybit() {
  return {
    async klines(symbol: string): Promise<Candle[]> {
      const lag = symbol === 'STALEUSDT' ? 20 * 60_000 : 0;
      const lastOpen = Math.floor((Date.now() - lag) / STEP) * STEP - STEP;
      const base = symbol === 'AUSDT' ? 1 : 2;
      return Array.from({ length: 101 }, (_, i) => {
        const close = base * (1 + Math.sin(i / 3) * 0.03);
        return { time: lastOpen - (100 - i) * STEP, open: close, high: close, low: close, close, volume: 1 };
      });
    },
  };
}

async function engine(env: Record<string, string>) {
  dir = await mkdtemp(join(tmpdir(), 'bybit-engine-'));
  const config = loadConfig({ DATA_DIR: join(dir, 'data'), LOG_DIR: join(dir, 'logs'), START_BALANCE: '11.98', BYBIT_STREAM: '0', ...env });
  const store = new StateStore(config.dataDir);
  const log = new TradeLog(config.logDir);
  const e = new EngineService(config, fakeBybit() as never, store, log);
  return { e, store, log, config };
}

describe('bot keys', () => {
  it('keep the plain name for one pair and prefix the pair for many', () => {
    expect(botKey('ZKUSDT', 'RSI (14, 30/70)', false)).toBe('RSI (14, 30/70)');
    expect(botKey('ZKUSDT', 'RSI (14, 30/70)', true)).toBe('ZKUSDT:RSI (14, 30/70)');
    expect(parseBotKey('ZKUSDT:RSI (14, 30/70)', 'X')).toEqual({ symbol: 'ZKUSDT', name: 'RSI (14, 30/70)' });
    expect(parseBotKey('RSI (14, 30/70)', 'DOGEUSDT')).toEqual({ symbol: 'DOGEUSDT', name: 'RSI (14, 30/70)' });
  });
});

describe('engine with many pairs', () => {
  it('runs 15 bots on every pair with their own accounts and skips a pair with stale data', async () => {
    const { e, store, log } = await engine({ SYMBOLS: 'AUSDT,BUSDT,STALEUSDT', ORDER_PCT: '1', ENFORCE_MIN_ORDER: '0' });
    await e.init(['AUSDT', 'BUSDT', 'STALEUSDT'], { minOrderAmt: 5, minOrderQty: 0, qtyStep: 0.01 });
    await e.tick('поток');
    const state = (await store.load())!;
    expect(state.symbols).toEqual(['AUSDT', 'BUSDT', 'STALEUSDT']);
    expect(Object.keys(state.bots)).toHaveLength(45);
    expect(state.bots['BUSDT:Авто-выбор лучшей (14)']?.meta).toBe(true);
    expect(state.orderPct).toBe(1);
    expect(state.sessionStartedAt).toBeTruthy();
    expect(state.feed?.staleSkips).toBe(1);

    const equity = (await readFile(log.file('equity'), 'utf8')).trim().split('\n').slice(1);
    expect(new Set(equity.map(l => l.split(',')[1]))).toEqual(new Set(['AUSDT', 'BUSDT']));
    expect(equity).toHaveLength(30);

    // Минутный опрос внутри той же свечи не пишет счёт заново.
    await e.tick('опрос');
    expect((await readFile(log.file('equity'), 'utf8')).trim().split('\n')).toHaveLength(31);
  });

  it('keeps the same pairs and accounts after a restart', async () => {
    const first = await engine({ SYMBOLS: 'AUSDT,BUSDT' });
    await first.e.init(['AUSDT', 'BUSDT'], { minOrderAmt: 5, minOrderQty: 0, qtyStep: 0.01 });
    await first.e.tick('поток');
    await first.e.beforeApplicationShutdown('test');
    const saved = (await first.store.load())!;
    const again = new EngineService(first.config, fakeBybit() as never, first.store, first.log);
    expect(await again.resolveSymbols(saved)).toEqual(['AUSDT', 'BUSDT']);
    await again.init(['AUSDT', 'BUSDT'], { minOrderAmt: 5, minOrderQty: 0, qtyStep: 0.01 });
    expect(again.state()?.runs).toBe(1);
    expect(again.state()?.sessionStartedAt).toBe(saved.sessionStartedAt);
  });
});

describe('stake of 1 % of the account', () => {
  const lot = { minOrderAmt: 5, minOrderQty: 0, qtyStep: 0.1 };

  it('buys for 1 % of cash, ignoring the exchange minimum in the test mode', () => {
    const l = new Ledger(11.98, { feePct: 0.1, slippagePct: 0, lot, orderUsdt: 0, orderPct: 1, enforceMinOrder: false });
    expect(l.buy(0.1)).not.toBeNull();
    expect(l.entryCost).toBeCloseTo(0.1198, 6);
    expect(l.cash).toBeCloseTo(11.98 - 0.1198, 6);
  });

  it('refuses the trade when the stake is below the exchange minimum and the minimum is enforced', () => {
    const l = new Ledger(11.98, { feePct: 0.1, slippagePct: 0, lot, orderUsdt: 0, orderPct: 1, enforceMinOrder: true });
    expect(l.buy(0.1)).toBeNull();
    expect(l.tradeCount).toBe(0);
  });

  it('caps the stake at 2 % whatever the setting says', () => {
    expect(loadConfig({ ORDER_PCT: '5' }).orderPct).toBe(2);
    expect(loadConfig({ ORDER_PCT: '1' }).orderPct).toBe(1);
  });
});
