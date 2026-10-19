import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inDayHours, loadConfig } from '../src/config/app-config.js';
import type { BotStats, Stats, TradeRow } from '../src/stats/stats.types.js';
import { renderChartPng, renderChartSvg, type ChartInput } from '../src/telegram/chart.js';
import { reportClassic, reportRichHtml, shortName, tradeRichHtml, type ReportInput } from '../src/telegram/report.js';
import { TelegramService } from '../src/telegram/telegram.service.js';
import type { TradeEvent, TradeListener } from '../src/trading/engine.service.js';
import type { Candle } from '../src/trading/types.js';

const plain = (s: string) => s.replace(/ /g, ' ');

function bot(name: string, equityRub: number, extra: Partial<BotStats> = {}): BotStats {
  return {
    name, isMeta: false, equity: equityRub / 85, pnlPct: 0, equityRub, pnlRubPct: equityRub / 10 - 100,
    cash: 0, position: 0, entryPrice: null, trades: 7, fees: 0, leader: null, spark: [], ...extra,
  };
}

const BOTS = [
  bot('Martingale-lite (1% шаг)', 1012.4, { position: 53 }),
  bot('Авто-выбор лучшей (11)', 990, { isMeta: true, leader: 'Martingale-lite (1% шаг)' }),
  bot('MACD (12/26/9)', 931.6),
];

function stats(bots: BotStats[] = BOTS): Stats {
  return {
    updatedAt: null, status: 'running', ageSec: 1, running: true, symbol: 'DOGEUSDT', baseAsset: 'DOGE',
    interval: '5', price: 0.08, rubPerUsd: 85, rateSource: 'ЦБ РФ', startBalance: 11.98, startRub: 1000,
    feePct: 0.1, slippagePct: 0.02, runs: 1, uptimeSecTotal: 0, ticks: 1, bots,
    totals: { equity: 0, equityRub: 0, invested: 0, investedRub: 0, position: 0, inProfit: 0, tradesTotal: 0, tradesClosed: 0, winRatePct: null },
    lastTrades: [],
    lastRuns: [],
  };
}

const TRADES = [
  { time: '2026-10-19T10:10:00.000Z', bot: 'MACD (12/26/9)', side: 'buy', price: '0.0801', pnlPct: '' },
  { time: '2026-10-19T10:20:00.000Z', bot: 'MACD (12/26/9)', side: 'sell', price: '0.0799', pnlPct: '-0.48' },
  { time: '2026-10-19T10:30:00.000Z', bot: 'Martingale-lite (1% шаг)', side: 'sell', price: '0.0812', pnlPct: '1.3' },
] as TradeRow[];

function input(extra: Partial<ReportInput> = {}): ReportInput {
  return {
    kind: 'hour', stats: stats(), prevRub: { 'Martingale-lite (1% шаг)': 1000, 'Авто-выбор лучшей (11)': 991, 'MACD (12/26/9)': 940 },
    prevPrice: 0.0796, price24hAgo: 0.081, trades: TRADES, now: new Date(2026, 9, 19, 14, 0),
    webUrl: 'http://192.168.3.5:3004/', hasPhoto: true, refreshButton: true, schedule: 'каждый час', ...extra,
  };
}

describe('day hours', () => {
  it('include both ends and may wrap past midnight', () => {
    expect([8, 9, 22, 23].map(h => inDayHours(h, 9, 22))).toEqual([false, true, true, false]);
    expect([21, 23, 1, 2, 3].map(h => inDayHours(h, 22, 2))).toEqual([false, true, true, true, false]);
  });
});

describe('hourly report', () => {
  const html = plain(reportRichHtml(input()));

  it('has a heading, the chart, a ranked table and the change for the hour', () => {
    expect(html).toContain('<h2>🕐 Итоги часа · 14:00</h2>');
    expect(html).toContain('<img src="tg://photo?id=report"/>');
    expect(html).toContain('<table bordered striped compact>');
    expect(html).toContain('<td>🥇</td><td>Martingale-lite 📈</td><td align="right"><b>1 012 ₽</b></td><td align="right">+12 ₽</td><td align="right">🟢 +12 ₽</td>');
    expect(html).toContain('<b>Авто-выбор лучшей</b>');
    expect(html).toContain('за час <b>+0.50 %</b>');
    expect(html).toContain('за час <b>+3 ₽</b>');
  });

  it('hides the worst bot under a spoiler and the trades in a collapsible block', () => {
    expect(html).toContain('Худший за час: <tg-spoiler>MACD −8 ₽</tg-spoiler>');
    expect(html).toContain('<details><summary>Сделки за час · 3</summary>');
    expect(html).toContain('<td>▼ продажа</td><td align="right"><code>0.0799</code></td><td align="right">−0.48 %</td>');
  });

  it('says who the meta bot follows', () => {
    expect(html).toContain('🤖 <b>Авто-выбор</b> повторяет <b>Martingale-lite</b>');
  });

  it('adds a refresh button, a time stamp and a panel link', () => {
    expect(html).toContain('<tg-button type="callback_data" style="primary" data="now">🔄 Обновить</tg-button>');
    expect(html).toMatch(/<tg-time unix="\d+" format="t">14:00<\/tg-time>/);
    expect(html).toContain('<a href="http://192.168.3.5:3004/">Открыть панель</a>');
    expect(plain(reportRichHtml(input({ webUrl: 'https://bots.example/' })))).toContain('<tg-button type="url" url="https://bots.example/">📊 Панель</tg-button>');
  });

  it('shows dashes instead of a change before the first report', () => {
    const first = plain(reportRichHtml(input({ prevRub: null, prevPrice: null, hasPhoto: false })));
    expect(first).toContain('<td align="right">—</td>');
    expect(first).not.toContain('tg://photo');
    expect(first).not.toContain('Худший');
  });

  it('never lets a strategy name break the markup', () => {
    const evil = plain(reportRichHtml(input({ stats: stats([bot('<b>x</b> & "y"', 1000)]), prevRub: null })));
    expect(evil).toContain('&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;');
  });
});

describe('daily report', () => {
  const html = plain(reportRichHtml(input({ kind: 'day' })));

  it('is a bigger page with the trade count and the best and worst trades', () => {
    expect(html).toContain('<h1>📊 Итог дня · 19.10</h1>');
    expect(html).toContain('<th>Сделок</th>');
    expect(html).toContain('В плюсе с начала: <b>1 из 3</b>');
    expect(html).toContain('Лучшая сделка: <b>Martingale-lite</b> +1.30 %');
    expect(html).toContain('Худшая сделка: <tg-spoiler>MACD −0.48 %</tg-spoiler>');
    expect(html).toContain('за сутки <b>+3 ₽</b>');
  });
});

describe('classic fallback', () => {
  it('fits the photo caption limit and keeps the table monospaced', () => {
    const { caption, text } = reportClassic(input());
    expect(caption.length).toBeLessThan(1024);
    expect(plain(text)).toContain('<pre> 1 Martingale-lite');
    expect(text).toContain('<blockquote expandable>Сделки за час · 3');
  });
});

describe('trade message', () => {
  it('shows the money made and where the account stands', () => {
    const e: TradeEvent = { bot: 'Stochastic Oscillator (14, 20/80)', side: 'sell', price: 0.08631, pnlPct: 1.42, pnlUsdt: 0.0712, equity: 12.2, time: '' };
    const html = plain(tradeRichHtml(e, { rubPerUsd: 85, startRub: 1000 }));
    expect(html).toContain('<h3>✅ +6 ₽ · Stochastic Oscillator</h3>');
    expect(html).toContain('Счёт бота: <b>1 037 ₽</b>, с начала +37 ₽');
  });

  it('short names drop the parameters', () => {
    expect(shortName('RSI (14, 30/70)')).toBe('RSI');
    expect(shortName('Martingale-lite (1% шаг)')).toBe('Martingale-lite');
  });
});

describe('chart', () => {
  const t0 = Date.UTC(2026, 9, 19, 0, 0);
  const chart: ChartInput = {
    title: 'DOGEUSDT · итоги часа', subtitle: 'цена 0.08 $',
    prices: Array.from({ length: 96 }, (_, i) => ({ time: t0 + i * 900_000, price: 0.08 + Math.sin(i / 8) * 0.001 })),
    trades: [{ time: t0 + 3_600_000, price: 0.0805, side: 'buy' }, { time: t0 + 7_200_000, price: 0.0808, side: 'sell' }],
    bars: [{ name: 'A & <B>', total: 12, period: 1, highlight: true }, { name: 'MACD', total: -68, period: -2 }],
    periodLabel: 'за час',
  };

  it('draws the price, the trades and a bar per bot', () => {
    const svg = renderChartSvg(chart);
    expect(svg).toContain('A &amp; &lt;B&gt;');
    expect(svg.match(/<polygon/g)).toHaveLength(2);
    expect(svg).toContain('за час −2 ₽');
  });

  it('copes with no price data', () => {
    expect(renderChartSvg({ ...chart, prices: [] })).toContain('нет данных о цене');
  });

  it('renders a PNG', () => {
    const png = renderChartPng(chart);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.length).toBeGreaterThan(10_000);
  });
});

interface Call {
  method: string;
  fields: Record<string, unknown>;
}

describe('TelegramService', () => {
  let dir: string;
  let calls: Call[];
  let richFails: boolean;
  let listener: TradeListener | null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bybit-tg-'));
    calls = [];
    richFails = false;
    listener = null;
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function service(env: Record<string, string> = {}, bots = BOTS) {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '42', TELEGRAM_MIN_PNL_PCT: '1',
      TELEGRAM_DIGEST_HOUR: '21', TELEGRAM_DAY_FROM: '9', TELEGRAM_DAY_TO: '22',
      START_RUB: '1000', DATA_DIR: dir, NOTIFY_INTERVAL_MS: '3600000', TELEGRAM_COMMANDS: '0', ...env,
    });
    const statsService = { stats: async () => stats(bots), allTrades: async () => TRADES };
    const rates = { rubPerUsd: async () => ({ value: 85, source: 'test' }) };
    const engine = { onTrade: (l: TradeListener) => { listener = l; return () => { listener = null; }; } };
    const candles: Candle[] = Array.from({ length: 96 }, (_, i) => ({
      time: Date.UTC(2026, 9, 18, 12) + i * 900_000, open: 0.08, high: 0.081, low: 0.079, close: 0.08 + i * 0.00001, volume: 1,
    }));
    const bybit = { klines: async () => candles };
    const fetchFn = (async (url: string, init: RequestInit) => {
      const method = url.split('/').pop()!;
      const fields = init.body instanceof FormData
        ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `<file ${v.size}>`]))
        : JSON.parse(String(init.body));
      calls.push({ method, fields });
      if (method === 'sendRichMessage' && richFails) {
        return new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse rich message" }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true, result: true }));
    }) as unknown as typeof fetch;
    return new TelegramService(config, statsService as never, rates as never, engine as never, bybit as never, fetchFn);
  }

  const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
  const methods = () => calls.map(c => c.method);

  it('reports every hour by day, the digest at 21:00 and nothing at night', async () => {
    const tg = service();
    const kinds = [];
    for (const [day, hour, minute] of [
      [19, 8, 30], [19, 9, 0], [19, 9, 40], [19, 10, 1], [19, 21, 0], [19, 21, 30], [19, 22, 0],
      [19, 23, 0], [20, 3, 0], [20, 8, 59], [20, 9, 0],
    ] as const) {
      kinds.push(await tg.tick(at(day, hour, minute)));
    }
    expect(kinds).toEqual([null, 'hour', null, 'hour', 'day', null, 'hour', null, null, null, 'hour']);
    expect(methods().every(m => m === 'sendRichMessage')).toBe(true);
  });

  it('sends the chart with the rich message in one multipart request', async () => {
    await service().tick(at(19, 14));
    const call = calls[0]!;
    expect(call.fields.report).toMatch(/^<file \d+>$/);
    const rich = JSON.parse(String(call.fields.rich_message));
    expect(rich.media).toEqual([{ id: 'report', media: { type: 'photo', media: 'attach://report' } }]);
    expect(rich.html).toContain('<h2>🕐 Итоги часа · 14:00</h2>');
    expect(call.fields.disable_notification).toBe('false');
  });

  it('compares the next hour with the previous report', async () => {
    const tg = service();
    await tg.tick(at(19, 14));
    const saved = JSON.parse(await readFile(join(dir, 'notify-state.json'), 'utf8'));
    expect(saved).toMatchObject({ lastReportKey: '2026-10-19 14', reportRub: { 'MACD (12/26/9)': 931.6 } });
    await tg.tick(at(19, 15));
    const html = plain(JSON.parse(String(calls[1]!.fields.rich_message)).html);
    expect(html).toContain('за час <b>±0 ₽</b>');
  });

  it('falls back to a photo and plain HTML when the rich message is rejected', async () => {
    richFails = true;
    expect(await service().tick(at(19, 14))).toBe('hour');
    expect(methods()).toEqual(['sendRichMessage', 'sendPhoto', 'sendMessage']);
    expect(String(calls[2]!.fields.text)).toContain('<pre>');
  });

  it('sends profitable trades loudly by day and silently at night', async () => {
    const tg = service();
    const sale: TradeEvent = { bot: 'MACD (12/26/9)', side: 'sell', price: 0.08, pnlPct: 1.5, pnlUsdt: 0.08, equity: 12, time: '' };
    expect(await tg.notifyTrade(sale, at(19, 14))).toBe(true);
    expect(await tg.notifyTrade(sale, at(19, 3))).toBe(true);
    expect(await tg.notifyTrade({ ...sale, pnlPct: 0.4 }, at(19, 14))).toBe(false);
    expect(calls.map(c => c.fields.disable_notification)).toEqual([false, true]);
  });

  it('answers /now and the refresh button only in the configured chat', async () => {
    const tg = service();
    const now = Math.floor(Date.now() / 1000);
    await tg.handleUpdate({ update_id: 1, message: { chat: { id: 7 }, text: '/now', date: now } });
    expect(calls).toHaveLength(0);
    await tg.handleUpdate({ update_id: 2, message: { chat: { id: 42 }, text: '/now', date: now - 3600 } });
    expect(calls).toHaveLength(0);
    await tg.handleUpdate({ update_id: 3, message: { chat: { id: 42 }, text: '/now@bybit_bot', date: now } });
    expect(JSON.parse(String(calls[0]!.fields.rich_message)).html).toContain('⚡ Сейчас');
    await tg.handleUpdate({ update_id: 4, callback_query: { id: 'q', data: 'now', message: { chat: { id: 42 } } } });
    expect(methods().slice(1)).toEqual(['answerCallbackQuery', 'sendRichMessage']);
  });

  it('a report on demand does not move the hourly comparison point', async () => {
    const tg = service();
    await tg.tick(at(19, 14));
    const before = await readFile(join(dir, 'notify-state.json'), 'utf8');
    await tg.sendNow(at(19, 14, 30));
    expect(await readFile(join(dir, 'notify-state.json'), 'utf8')).toBe(before);
  });

  it('subscribes to trades on start and unsubscribes on shutdown', () => {
    const tg = service();
    tg.onApplicationBootstrap();
    expect(listener).not.toBeNull();
    tg.onApplicationShutdown();
    expect(listener).toBeNull();
  });

  it('does nothing without a token', async () => {
    const tg = service({ TELEGRAM_BOT_TOKEN: '' });
    tg.onApplicationBootstrap();
    expect(tg.enabled).toBe(false);
    expect(await tg.tick(at(19, 14))).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
