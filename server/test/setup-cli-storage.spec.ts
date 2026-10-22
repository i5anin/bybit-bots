import 'reflect-metadata';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupApp } from '../src/app.setup.js';
import { passes, runBacktest } from '../src/backtest/backtest.js';
import { arg, runCli } from '../src/backtest/cli.js';
import { APP_CONFIG, inDayHours, loadConfig, marketId } from '../src/config/app-config.js';
import { BybitClient } from '../src/market/bybit.js';
import { createCsvTail } from '../src/storage/csv-tail.js';
import { parseCsv } from '../src/storage/csv.js';
import { StateStore } from '../src/storage/state-store.js';
import { TradeLog } from '../src/storage/trade-log.js';
import { adaptiveRegime, efficiencyRatio } from '../src/trading/strategies/adaptive-regime.js';
import { macd, meanReversion } from '../src/trading/strategies/oscillators.js';
import { martingaleLite } from '../src/trading/strategies/stateful.js';
import { EngineService } from '../src/trading/engine.service.js';
import { TradingModule } from '../src/trading/trading.module.js';
import type { Candle, Costs, Strategy } from '../src/trading/types.js';

let dir = '';
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ''; });
const tmp = async () => (dir = await mkdtemp(join(tmpdir(), 'bybit-extra-')));

const candle = (time: number, close: number): Candle => ({ time, open: close, high: close, low: close, close, volume: 1 });
const COSTS: Costs = { feePct: 0.1, slippagePct: 0, lot: { minOrderAmt: 1, minOrderQty: 0, qtyStep: 0 }, orderUsdt: 0, orderPct: 0, enforceMinOrder: false };

function fakeApp() {
  return { useStaticAssets: vi.fn(), enableShutdownHooks: vi.fn() };
}

describe('настройка приложения', () => {
  it('раздаёт собранную панель и не кеширует index.html', async () => {
    const clientDir = await tmp();
    const app = fakeApp();
    setupApp(app as never, { clientDir } as never);
    const [path, opts] = app.useStaticAssets.mock.calls[0]!;
    expect(path).toBe(clientDir);
    const res = { setHeader: vi.fn() };
    opts.setHeaders(res, 'index.html');
    opts.setHeaders(res, 'app.123.js');
    expect(res.setHeader).toHaveBeenCalledOnce();
    expect(res.setHeader).toHaveBeenCalledWith('cache-control', 'no-cache');
    expect(app.enableShutdownHooks).toHaveBeenCalledWith(['SIGTERM', 'SIGINT']);
  });

  it('предупреждает, если панель не собрана', () => {
    const app = fakeApp();
    const logger = { warn: vi.fn() };
    setupApp(app as never, { clientDir: join(tmpdir(), 'нет-такой-папки') } as never, logger as never);
    expect(app.useStaticAssets).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Панель не собрана'));
  });

  it('модуль торговли собирает клиента биржи, хранилище и логи из настроек', async () => {
    const d = await tmp();
    const moduleRef = await Test.createTestingModule({ imports: [TradingModule] })
      .overrideProvider(APP_CONFIG).useValue(loadConfig({ DATA_DIR: join(d, 'data'), LOG_DIR: join(d, 'logs') }))
      .compile();
    expect(moduleRef.get(BybitClient)).toBeInstanceOf(BybitClient);
    expect(moduleRef.get(StateStore).file).toBe(join(d, 'data', 'state.json'));
    expect(moduleRef.get(TradeLog).dir).toBe(join(d, 'logs'));
    expect(moduleRef.get(EngineService)).toBeInstanceOf(EngineService);
    const plain = await Test.createTestingModule({ imports: [TradingModule] }).compile();
    expect(plain.get(APP_CONFIG).symbol).toBeTruthy();
  });
});

describe('бэктест из командной строки', () => {
  // Синусоида: стратегии успевают и купить, и продать.
  const history = Array.from({ length: 300 }, (_, i) => candle(i * 900_000, 1 + Math.sin(i / 5) * 0.1 + i / 1000));

  function client() {
    return {
      tickers: vi.fn(async () => [
        { symbol: 'ZKUSDT', lastPrice: 1, highPrice24h: 2, lowPrice24h: 1, price24hPcnt: 0, turnover24h: 1e9 },
      ]),
      lotRules: vi.fn(async (s: string) => {
        if (s === 'NOLOTUSDT') throw new Error('нет');
        return COSTS.lot!;
      }),
      history: vi.fn(async (s: string) => {
        if (s === 'BADUSDT') throw new Error('биржа молчит');
        return history;
      }),
    };
  }

  it('читает аргументы', () => {
    expect(arg(['--days', '5'], 'days')).toBe('5');
    expect(arg([], 'days')).toBeUndefined();
  });

  it('гоняет заданные пары, пишет сводку и JSON, пропускает пару с ошибкой', async () => {
    const d = await tmp();
    const lines: string[] = [];
    const c = client();
    const { file, runs } = await runCli(
      ['--symbols', 'NOLOTUSDT,BADUSDT', '--intervals', '15', '--days', '3', '--variants', 'base,both'],
      { client: c, config: loadConfig({}), log: l => lines.push(l), outDir: `${d}/`, now: Date.UTC(2026, 0, 2, 3, 4) },
    );
    expect(file).toBe(`${d}/backtest-202601020304.json`);
    expect(runs.map(r => r.variant)).toEqual(['как сейчас', 'тренд + стоп 3 %']);
    expect(c.tickers).not.toHaveBeenCalled();
    expect(lines.some(l => l.includes('пропуск: биржа молчит'))).toBe(true);
    expect(lines.some(l => l.startsWith('# По вариантам') || l.includes('# По вариантам'))).toBe(true);
    const json = JSON.parse(await readFile(file, 'utf8'));
    expect(json.symbols).toEqual(['NOLOTUSDT', 'BADUSDT']);
    expect(json.days).toBe(3);
  });

  it('без списка пар берёт текущую пару и топ по волатильности', async () => {
    const d = await tmp();
    const { runs } = await runCli(['--intervals', '60', '--variants', 'stop', '--top', '1'], {
      client: client(), config: loadConfig({ SYMBOL: 'DOGEUSDT' }), log: () => {}, outDir: `${d}/`,
    });
    expect(runs.map(r => r.symbol)).toEqual(['DOGEUSDT', 'ZKUSDT']);
  });
});

describe('ветки бэктеста', () => {
  it('без правил лота держит на весь счёт и считает долю прибыльных сделок', () => {
    const wave = Array.from({ length: 200 }, (_, i) => candle(i, 1 + (i % 2) * 0.5));
    let n = 0;
    const flip = (): Strategy => ({ name: 'флип', signal: () => (n++ % 2 === 0 ? 'buy' : 'sell') });
    const hold = (): Strategy => ({ name: 'держу', signal: () => 'hold' });
    const r = runBacktest(wave, [flip, hold], { startBalance: 100, costs: { ...COSTS, lot: undefined } as never, metaWindow: 10, window: 20 });
    const s = r.strategies.find(x => x.name === 'флип')!;
    expect(s.closed).toBeGreaterThan(0);
    expect(s.winRatePct).not.toBeNull();
    expect(r.strategies.find(x => x.name === 'держу')!.winRatePct).toBeNull();
    expect(typeof passes(s, r)).toBe('boolean');
  });
});

describe('ветки стратегий', () => {
  const flat = Array.from({ length: 120 }, (_, i) => candle(i, 1));

  it('на ровной цене ничего не делают', () => {
    expect(adaptiveRegime().signal(flat)).toBe('hold');
    expect(meanReversion().signal(flat)).toBe('hold');
    expect(macd().signal(flat.slice(0, 40))).toBe('hold');
    expect(adaptiveRegime().signal(flat.slice(0, 10))).toBe('hold');
    expect(efficiencyRatio([1, 2], 5)).toBeNull();
    expect(efficiencyRatio([1, 1, 1], 2)).toBeNull();
  });

  it('мартингейл после простоя берёт опорную цену с рынка', () => {
    const m = martingaleLite();
    m.restore!({ referencePrice: 5 }, { price: 2, downtimeSec: 10 ** 9, inPosition: false, entryPrice: 0 });
    expect((m.toJSON!() as { referencePrice: number }).referencePrice).toBe(2);
    m.restore!(null, { price: undefined, inPosition: false } as never);
    expect((m.toJSON!() as { referencePrice: number | null }).referencePrice).toBeNull();
    m.restore!({ referencePrice: 3 }, { price: 2, inPosition: false } as never);
    expect((m.toJSON!() as { referencePrice: number }).referencePrice).toBe(3);
  });
});

describe('хранилище и настройки', () => {
  it('битый state.json и файл другой версии — чистый лист', async () => {
    const d = await tmp();
    const store = new StateStore(d);
    await writeFile(store.file, '{битый');
    expect(await store.load()).toBeNull();
    await writeFile(store.file, JSON.stringify({ version: 999 }));
    expect(await store.load()).toBeNull();
    await writeFile(store.file, 'null');
    expect(await store.load()).toBeNull();
  });

  it('пустое поле сделки пишется пустым и CSV без строк данных пуст', async () => {
    const d = await tmp();
    const log = new TradeLog(join(d, 'logs'), () => new Date(0));
    await log.trade({ symbol: 'A', bot: 'b', side: 'buy', price: 1, runId: 'r' });
    await log.run({ event: 'start', runId: 'r', runUptimeSec: 0, totalUptimeSec: 0, ticks: 0 });
    const rows = parseCsv(await readFile(log.file('trades'), 'utf8'));
    expect(rows[0]!.pnlPct ?? '').toBe('');
    expect(parseCsv('a,b\n')).toEqual([]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('a,b\n1\n')).toEqual([{ a: '1', b: '' }]);
  });

  it('хвост CSV ждёт конца строки, если в файле пока нет перевода строки', async () => {
    const d = await tmp();
    await mkdir(d, { recursive: true });
    const file = join(d, 'x.csv');
    await writeFile(file, 'a,');
    const rows: unknown[] = [];
    const read = createCsvTail(file, { onRows: r => rows.push(...r) });
    await read();
    await writeFile(file, 'a,b\n1,2\n');
    await read();
    expect(rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('неверный флаг в настройках — ошибка, часы и рынок считаются', () => {
    expect(() => loadConfig({ BYBIT_STREAM: 'может' })).toThrow(/ожидалось 1 или 0/);
    expect(loadConfig({ BYBIT_STREAM: 'да' }).bybitStream).toBe(true);
    expect(loadConfig({ BYBIT_STREAM: 'нет' }).bybitStream).toBe(false);
    expect(inDayHours(23, 22, 2)).toBe(true);
    expect(inDayHours(12, 22, 2)).toBe(false);
    expect(marketId({ bybitBaseUrl: 'https://api.bybit.com', bybitCategory: 'spot' })).toContain('spot');
  });
});
