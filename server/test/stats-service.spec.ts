import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/app-config.js';
import type { BybitClient } from '../src/market/bybit.js';
import type { StateStore } from '../src/storage/state-store.js';
import { TradeLog } from '../src/storage/trade-log.js';
import { PairChartService } from '../src/stats/pair-chart.service.js';
import type { RatesService } from '../src/stats/rates.service.js';
import { StatsController } from '../src/stats/stats.controller.js';
import { StatsService } from '../src/stats/stats.service.js';
import type { PairDetail } from '../src/stats/stats.types.js';
import type { TelegramService } from '../src/telegram/telegram.service.js';
import type { EngineService } from '../src/trading/engine.service.js';
import type { EngineState } from '../src/trading/types.js';

const now = Date.parse('2026-10-22T12:00:00Z');
const state = {
  startBalance: 12,
  symbol: 'DOGEUSDT',
  symbols: ['DOGEUSDT', 'ZKUSDT'],
  updatedAt: new Date(now).toISOString(),
  currentRun: { id: 'r1' },
  bots: {
    'DOGEUSDT:A': { ledger: { cash: 12, position: 0, lastPrice: 0.1 } },
    'DOGEUSDT:Meta': { meta: true, ledger: { cash: 13, position: 0, lastPrice: 0.1 } },
    'ZKUSDT:A': { ledger: { cash: 12, position: 0, lastPrice: 0.05 } },
  },
} as unknown as EngineState;
const config = { startRub: 1000, staleSec: 300, bankRatePct: 16, symbols: ['DOGEUSDT', 'ZKUSDT'] } as unknown as AppConfig;
const rates = { rubPerUsd: vi.fn(async () => ({ value: 80, source: 'test' })) } as unknown as RatesService;

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'stats-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function service(engineState: EngineState | null, stored: EngineState | null = null) {
  const engine = { state: () => engineState } as unknown as EngineService;
  const load = vi.fn(async () => stored);
  const store = { load } as unknown as StateStore;
  return { svc: new StatsService(config, engine, store, new TradeLog(dir), rates), load };
}

async function writeLogs() {
  await writeFile(path.join(dir, 'equity.csv'), 'time,symbol,bot,equity,price\n'
    + 't,DOGEUSDT,A,12,0.1\nt,DOGEUSDT,A,12.5,0.11\nt,DOGEUSDT,,1,1\nt,DOGEUSDT,A,x,1\nt,ZKUSDT,A,12,y\n');
  await writeFile(path.join(dir, 'trades.csv'), 'time,symbol,bot,side,price,pnlPct,runId\n'
    + '2026-10-20T11:00:00.000Z,DOGEUSDT,A,buy,0.1,0,r1\n'
    + '2026-10-22T11:00:00.000Z,DOGEUSDT,A,sell,0.11,1,r1\n'
    + '2026-10-22T11:30:00.000Z,ZKUSDT,A,buy,0.05,0,r1\n');
  await writeFile(path.join(dir, 'runs.csv'), 'runId,startedAt\nr1,2026-10-22T00:00:00.000Z\n');
}

describe('StatsService', () => {
  it('собирает статистику из движка и CSV-логов', async () => {
    await writeLogs();
    const { svc } = service(state);
    const s = await svc.stats(now);
    expect(s.bots).toHaveLength(3);
    expect(s.pairs.map(p => p.name).sort()).toEqual(['DOGEUSDT', 'ZKUSDT']);
    expect(await svc.allTrades()).toHaveLength(3);
  });

  it('отчёт пары: только её боты с рядом счёта и её сделки, новые сверху', async () => {
    await writeLogs();
    const d = await service(state).svc.pairDetail('DOGEUSDT', now);
    expect(d.pair?.name).toBe('DOGEUSDT');
    expect(d.bots.map(b => b.name).sort()).toEqual(['A', 'Meta']);
    expect(d.bots.find(b => b.name === 'A')!.spark.length).toBeGreaterThan(0);
    expect(d.trades.map(t => t.side)).toEqual(['sell', 'buy']);
    const none = await service(state).svc.pairDetail('NOPEUSDT');
    expect(none).toMatchObject({ pair: null, bots: [], trades: [] });
  });

  it('до первого тика берёт состояние с диска; без него бот не «работает»', async () => {
    const { svc, load } = service(null, state);
    expect((await svc.health(now)).status).toBe('running');
    expect(load).toHaveBeenCalled();
    expect((await service(null, null).svc.health()).status).not.toBe('running');
  });

  it('урезанный лог сбрасывает накопленное', async () => {
    await writeLogs();
    const { svc } = service(state);
    await svc.stats(now);
    await writeFile(path.join(dir, 'equity.csv'), 'a\n');
    await writeFile(path.join(dir, 'trades.csv'), 'a\n');
    await writeFile(path.join(dir, 'runs.csv'), 'a\n');
    await svc.stats(now);
    expect(await svc.allTrades()).toHaveLength(0);
    const d = await svc.pairDetail('DOGEUSDT', now);
    expect(d.trades).toEqual([]);
  });
});

function detail(extra: Partial<PairDetail> = {}): PairDetail {
  return {
    symbol: 'DOGEUSDT',
    pair: { name: 'DOGEUSDT', price: 0.1, minOrderUsdt: 5, equityRub: 2000.4, investedRub: 2000 } as PairDetail['pair'],
    bots: [{ name: 'A', pnlRub: 10, isMeta: false }, { name: 'Meta', pnlRub: -5, isMeta: true }] as PairDetail['bots'],
    trades: [
      { time: '2026-10-22T11:00:00.000Z', side: 'buy', price: '0.1' },
      { time: '2026-10-22T11:30:00.000Z', side: 'sell', price: '0.11' },
      { time: '2026-10-20T11:00:00.000Z', side: 'sell', price: '0.11' },
    ] as PairDetail['trades'],
    ...extra,
  };
}

function charts(d: PairDetail, klines: unknown) {
  const stats = { pairDetail: vi.fn(async () => d) } as unknown as StatsService;
  return new PairChartService(config, { klines } as unknown as BybitClient, stats);
}

describe('PairChartService', () => {
  it('рисует PNG пары с ценой, сделками и барами ботов', async () => {
    const klines = vi.fn(async () => [
      { time: now - 120_000, open: 1, high: 1, low: 1, close: 0.1, volume: 1 },
      { time: now - 60_000, open: 1, high: 1, low: 1, close: 0.11, volume: 1 },
    ]);
    const png = await charts(detail(), klines).render('DOGEUSDT', now);
    expect(png!.subarray(1, 4).toString()).toBe('PNG');
    expect(klines).toHaveBeenCalledWith('DOGEUSDT', '15', 96);
  });

  it('без ботов — null; ошибка биржи и пустая пара не мешают', async () => {
    expect(await charts(detail({ bots: [] }), vi.fn()).render('DOGEUSDT', now)).toBeNull();
    const failing = vi.fn(async () => { throw new Error('сеть'); });
    expect(await charts(detail({ pair: null }), failing).render('DOGEUSDT')).toBeInstanceOf(Buffer);
    const bare = detail({ pair: { ...detail().pair!, price: null, minOrderUsdt: null } });
    expect(await charts(bare, failing).render('DOGEUSDT', now)).toBeInstanceOf(Buffer);
  });

  it('список пар — из конфига', () => {
    expect(charts(detail(), vi.fn()).symbols()).toEqual(['DOGEUSDT', 'ZKUSDT']);
  });
});

describe('StatsController', () => {
  function res() {
    const r = { setHeader: vi.fn(), status: vi.fn(), end: vi.fn() };
    r.setHeader.mockReturnValue(r);
    r.status.mockReturnValue(r);
    return r;
  }
  function controller(d: PairDetail, png: Buffer | null, status = 'running') {
    const pairDetail = vi.fn(async () => d);
    const stats = {
      pairDetail,
      stats: vi.fn(async () => ({ bots: [] })),
      health: vi.fn(async () => ({ status, ageSec: 3 })),
    } as unknown as StatsService;
    const telegram = { enabled: true } as unknown as TelegramService;
    const chartSvc = { render: vi.fn(async () => png) } as unknown as PairChartService;
    return { ctl: new StatsController(stats, telegram, chartSvc), pairDetail };
  }

  it('отдаёт пару по символу в любом регистре, неизвестная — 404', async () => {
    const r = res();
    const { ctl, pairDetail } = controller(detail(), null);
    expect((await ctl.getPair('dogeusdt', r as never)).symbol).toBe('DOGEUSDT');
    expect(pairDetail).toHaveBeenCalledWith('DOGEUSDT');
    expect(r.setHeader).toHaveBeenCalledWith('cache-control', 'no-store');
    await expect(controller(detail({ bots: [] }), null).ctl.getPair('x', res() as never)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('график пары — PNG с кэшем на минуту, без пары — 404', async () => {
    const r = res();
    const png = Buffer.from('png');
    await controller(detail(), png).ctl.getPairChart('doge', r as never);
    expect(r.setHeader).toHaveBeenCalledWith('content-type', 'image/png');
    expect(r.setHeader).toHaveBeenCalledWith('cache-control', 'max-age=60');
    expect(r.end).toHaveBeenCalledWith(png);
    await expect(controller(detail(), null).ctl.getPairChart('x', res() as never)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('статистика без кэша', async () => {
    const r = res();
    expect(await controller(detail(), null).ctl.getStats(r as never)).toEqual({ bots: [] });
    expect(r.setHeader).toHaveBeenCalledWith('cache-control', 'no-store');
  });

  it('health: 200 когда бот работает, иначе 503', async () => {
    const r = res();
    expect(await controller(detail(), null).ctl.getHealth(r as never)).toEqual({ ok: true, bot: 'running', ageSec: 3, telegram: true });
    expect(r.status).toHaveBeenCalledWith(200);
    const r2 = res();
    expect((await controller(detail(), null, 'stale').ctl.getHealth(r2 as never)).ok).toBe(false);
    expect(r2.status).toHaveBeenCalledWith(503);
  });
});
