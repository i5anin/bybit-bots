import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/app-config.js';
import type { BotStats, Stats, TradeRow } from '../src/stats/stats.types.js';
import { digestMessage, TelegramService, tradeMessage } from '../src/telegram/telegram.service.js';
import type { TradeEvent, TradeListener } from '../src/trading/engine.service.js';

const plain = (s: string) => s.replace(/ /g, ' ');

function bot(name: string, equityRub: number, extra: Partial<BotStats> = {}): BotStats {
  return {
    name, isMeta: false, equity: equityRub / 85, pnlPct: 0, equityRub, pnlRubPct: equityRub / 10 - 100,
    cash: 0, position: 0, entryPrice: null, trades: 0, fees: 0, leader: null, spark: [], ...extra,
  };
}

function stats(bots: BotStats[]): Stats {
  return {
    updatedAt: null, status: 'running', ageSec: 1, running: true, symbol: 'DOGEUSDT', baseAsset: 'DOGE',
    interval: '5', price: 0.085, rubPerUsd: 85, rateSource: 'ЦБ РФ', startBalance: 11.98, startRub: 1000,
    feePct: 0.1, slippagePct: 0.02, runs: 1, uptimeSecTotal: 0, ticks: 1, bots,
    totals: { equity: 0, equityRub: 0, invested: 0, investedRub: 0, position: 0, inProfit: 0, tradesTotal: 0, tradesClosed: 0, winRatePct: null },
    lastTrades: [],
    lastRuns: [],
  };
}

const sale: TradeEvent = {
  bot: 'Stochastic Oscillator (14, 20/80)', side: 'sell', price: 0.08631,
  pnlPct: 1.42, pnlUsdt: 0.0712, equity: 12.2, time: '2026-10-14T10:00:00.000Z',
};

describe('tradeMessage', () => {
  it('says how much the trade earned in rubles and dollars and where the account stands', () => {
    const text = plain(tradeMessage(sale, { rubPerUsd: 85, startRub: 1000 }));
    expect(text).toContain('+6 ₽');
    expect(text).toContain('+1.42 %');
    expect(text).toContain('$0.0712');
    expect(text).toContain('Счёт бота: <b>1 037 ₽</b>, с начала +37 ₽');
  });
});

describe('digestMessage', () => {
  const bots = [
    bot('Donchian Breakout (20)', 1012.4),
    bot('Авто-выбор лучшей (11)', 990, { isMeta: true, leader: 'Donchian Breakout (20)' }),
    bot('MACD (12/26/9)', 931.6),
  ];
  const trades = [
    { time: '2026-10-13T10:00:00.000Z', pnlPct: '' },
    { time: '2026-10-14T09:00:00.000Z', pnlPct: '' },
    { time: '2026-10-14T10:00:00.000Z', pnlPct: '0.8' },
    { time: '2026-10-14T11:00:00.000Z', pnlPct: '-0.3' },
  ] as TradeRow[];
  const now = new Date('2026-10-14T18:00:00.000Z');

  it('lists every bot with its account and how much it earned since the start', () => {
    const text = plain(digestMessage(stats(bots), { lastDigestDay: null, lastDigestAt: null, digestRub: {} }, trades, '', now));
    expect(text).toContain('1. Donchian Breakout (20) — <b>1 012 ₽</b> (+12 ₽)');
    expect(text).toContain('3. MACD (12/26/9) — <b>932 ₽</b> (−68 ₽)');
    expect(text).toContain('повторяет Donchian Breakout (20)');
    expect(text).toContain('Все 3 вместе: 2 934 ₽ из 3 000 ₽ (−66 ₽)');
    expect(text).toContain('В плюсе с начала: 1 из 3');
    expect(text).toContain('Сделок всего: 4, закрыто 2, в плюс 1');
    expect(text).not.toContain('за сутки');
  });

  it('adds the change since the previous digest', () => {
    const seen = {
      lastDigestDay: '2026-10-13',
      lastDigestAt: '2026-10-13T18:00:00.000Z',
      digestRub: { 'Donchian Breakout (20)': 1000, 'Авто-выбор лучшей (11)': 995, 'MACD (12/26/9)': 940 },
    };
    const text = plain(digestMessage(stats(bots), seen, trades, 'http://bots.home/', now));
    expect(text).toContain('(+12 ₽) · за сутки +12 ₽');
    expect(text).toContain('(−68 ₽) · за сутки −8 ₽');
    expect(text).toContain(', за сутки −1 ₽');
    expect(text).toContain('Сделок за сутки: 3, закрыто 2, в плюс 1');
    expect(text).toContain('href="http://bots.home/"');
  });
});

describe('TelegramService', () => {
  let dir: string;
  let sent: string[];
  let listener: TradeListener | null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bybit-tg-'));
    sent = [];
    listener = null;
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function service(env: Record<string, string> = {}) {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '42', TELEGRAM_MIN_PNL_PCT: '1',
      TELEGRAM_DIGEST_HOUR: '21', START_RUB: '1000', DATA_DIR: dir, ...env,
    });
    const statsService = { stats: async () => stats([bot('A', 1010), bot('B', 990)]), allTrades: async () => [] };
    const rates = { rubPerUsd: async () => ({ value: 85, source: 'test' }) };
    const engine = { onTrade: (l: TradeListener) => { listener = l; return () => { listener = null; }; } };
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).text);
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch;
    return new TelegramService(config, statsService as never, rates as never, engine as never, fetchFn);
  }

  it('sends a profitable sale above the threshold with the amount earned', async () => {
    const tg = service();
    expect(await tg.notifyTrade(sale)).toBe(true);
    expect(plain(sent[0]!)).toContain('+6 ₽');
  });

  it('stays quiet about small profits, losses and purchases', async () => {
    const tg = service();
    expect(await tg.notifyTrade({ ...sale, pnlPct: 0.4 })).toBe(false);
    expect(await tg.notifyTrade({ ...sale, pnlPct: -2 })).toBe(false);
    expect(await tg.notifyTrade({ ...sale, side: 'buy', pnlPct: undefined })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('listens to the engine once started and stops on shutdown', async () => {
    const tg = service({ NOTIFY_INTERVAL_MS: '3600000' });
    tg.onApplicationBootstrap();
    expect(listener).not.toBeNull();
    listener!(sale);
    await new Promise(r => setTimeout(r, 10));
    expect(sent.some(t => t.includes('Stochastic'))).toBe(true);
    tg.onApplicationShutdown();
    expect(listener).toBeNull();
  });

  it('sends the daily digest once a day, after the digest hour', async () => {
    const tg = service();
    expect(await tg.digestIfDue(new Date(2026, 9, 14, 20, 59))).toBe(false);
    expect(await tg.digestIfDue(new Date(2026, 9, 14, 21, 0))).toBe(true);
    expect(await tg.digestIfDue(new Date(2026, 9, 14, 23, 0))).toBe(false);
    expect(sent).toHaveLength(1);
    expect(plain(sent[0]!)).toContain('1. A — <b>1 010 ₽</b> (+10 ₽)');

    const saved = JSON.parse(await readFile(join(dir, 'notify-state.json'), 'utf8'));
    expect(saved).toMatchObject({ lastDigestDay: '2026-10-14', digestRub: { A: 1010, B: 990 } });

    expect(await tg.digestIfDue(new Date(2026, 9, 15, 21, 5))).toBe(true);
    expect(plain(sent[1]!)).toContain('за сутки ±0 ₽');
  });

  it('does nothing without a token', async () => {
    const tg = service({ TELEGRAM_BOT_TOKEN: '' });
    tg.onApplicationBootstrap();
    expect(tg.enabled).toBe(false);
    expect(listener).toBeNull();
    expect(await tg.digestIfDue(new Date(2026, 9, 14, 22, 0))).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
