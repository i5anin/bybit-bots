import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG, loadConfig } from '../src/config/app-config.js';
import { BybitClient } from '../src/market/bybit.js';
import { EngineService } from '../src/trading/engine.service.js';
import type { Candle } from '../src/trading/types.js';

// Биржа-заглушка: 101 свеча по 5 минут, последняя ещё открыта.
class FakeBybit {
  price = 0.1;
  async lotRules() {
    return { minOrderAmt: 5, minOrderQty: 0.1, qtyStep: 0.1 };
  }
  async klines(): Promise<Candle[]> {
    const step = 300_000;
    const open = Math.floor(Date.now() / step) * step;
    return Array.from({ length: 101 }, (_, i) => {
      const close = this.price * (1 + Math.sin(i / 3) * 0.02);
      return { time: open - (100 - i) * step, open: close, high: close * 1.001, low: close * 0.999, close, volume: 1 };
    });
  }
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bybit-app-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function boot(): Promise<{ app: INestApplication; engine: EngineService }> {
  const config = loadConfig({
    DATA_DIR: join(dir, 'data'),
    LOG_DIR: join(dir, 'logs'),
    CLIENT_DIR: join(dir, 'no-client'),
    START_BALANCE: '11.98',
    START_RUB: '1000',
    POLL_MS: '3600000',
    RUB_PER_USDT: '80',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG).useValue(config)
    .overrideProvider(BybitClient).useValue(new FakeBybit())
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  const engine = app.get(EngineService);
  for (let i = 0; i < 100 && !engine.state(); i += 1) await new Promise(r => setTimeout(r, 20));
  return { app, engine };
}

describe('application', () => {
  it('ticks, serves stats and health, and continues after a clean restart', async () => {
    const first = await boot();
    expect(first.engine.state()?.currentRun).not.toBeNull();

    const health = await request(first.app.getHttpServer()).get('/api/health').expect(200);
    expect(health.body).toMatchObject({ ok: true, bot: 'running', telegram: false });

    const stats = await request(first.app.getHttpServer()).get('/api/stats').expect(200);
    expect(stats.headers['cache-control']).toBe('no-store');
    expect(stats.body.bots).toHaveLength(12);
    expect(stats.body.bots.filter((b: { isMeta: boolean }) => b.isMeta)).toHaveLength(1);
    expect(stats.body.startRub).toBe(1000);
    expect(stats.body.ticks).toBe(1);

    await first.app.close();
    const saved = JSON.parse(await readFile(join(dir, 'data', 'state.json'), 'utf8'));
    expect(saved.currentRun).toBeNull();
    expect(saved.runs).toBe(1);

    const second = await boot();
    expect(second.engine.state()?.runs).toBe(2);
    const runs = (await readFile(join(dir, 'logs', 'runs.csv'), 'utf8')).trim().split('\n').map(l => l.split(',')[1]);
    expect(runs).toEqual(['event', 'start', 'stop', 'start', 'resume']);
    await second.app.close();
  });

  it('reports a bot that stopped writing as unhealthy', async () => {
    const { app, engine } = await boot();
    const state = engine.state()!;
    state.updatedAt = new Date(Date.now() - 3600_000).toISOString();
    const res = await request(app.getHttpServer()).get('/api/health').expect(503);
    expect(res.body).toMatchObject({ ok: false, bot: 'stale' });
    await app.close();
  });
});
