import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/app-config.js';
import { buildStats } from '../src/stats/build-stats.js';
import type { PairDetail, Stats, TradeRow } from '../src/stats/stats.types.js';
import { priceLabel, renderChartSvg, type ChartInput } from '../src/telegram/chart.js';
import {
  apr, chartSections, pairClassic, pairRichHtml, reportClassic, reportRichHtml, shortName, tradeClassic, type ReportInput,
} from '../src/telegram/report.js';
import { TelegramApi } from '../src/telegram/telegram-api.js';
import { TelegramService, type Seen } from '../src/telegram/telegram.service.js';
import type { TradeEvent, TradeListener } from '../src/trading/engine.service.js';
import type { EngineState } from '../src/trading/types.js';

// Крайние случаи оповещений: отказы Telegram и биржи, пустые данные, команды.
const plain = (s: string) => s.replace(/[  ]/g, ' ');
const RATE = 85;
const NOW = new Date(2026, 9, 19, 14, 0);

function stateOf(symbols: string[], bots: Record<string, { pnl: number; meta?: boolean; leader?: string | null; position?: number }>, extra: Partial<EngineState> = {}): EngineState {
  return {
    version: 1, symbol: symbols[0]!, symbols, interval: '5', startBalance: 11.98, market: 'mainnet:spot',
    feePct: 0.1, slippagePct: 0.02, orderUsdt: 0, updatedAt: NOW.toISOString(), runs: 1, uptimeSecTotal: 0,
    lastRun: null, currentRun: { runId: 'r', startedAt: '', runUptimeSec: 0, ticks: 1 },
    sessionStartedAt: new Date(NOW.getTime() - 10 * 86_400_000).toISOString(),
    lots: Object.fromEntries(symbols.map(s => [s, { minOrderAmt: 5, minOrderQty: 0, qtyStep: 0.1 }])),
    bots: Object.fromEntries(Object.entries(bots).map(([key, b]) => [key, {
      ledger: { cash: 11.98 + b.pnl / RATE - (b.position ?? 0) * 0.08, position: b.position ?? 0, entryPrice: b.position ? 0.08 : 0, lastPrice: 0.08, tradeCount: 7, realizedPnlPct: 0, entryCost: 0, feesPaid: 0 },
      lastSignalCandle: null,
      ...(b.meta ? { meta: true, leader: b.leader ?? null, history: {} } : {}),
    }])) as EngineState['bots'],
    ...extra,
  };
}

function statsOf(state: EngineState, sessionDays = 10): Stats {
  return buildStats({
    state: { ...state, sessionStartedAt: new Date(NOW.getTime() - sessionDays * 86_400_000).toISOString() },
    equity: { series: new Map(), lastPrice: null }, trades: [], runs: [], rate: { value: RATE, source: 'ЦБ РФ' },
    startRub: 1000, staleSec: 300, bankRatePct: 16, now: NOW.getTime(),
  });
}

const SINGLE = statsOf(stateOf(['DOGEUSDT'], {
  'RSI (14, 30/70)': { pnl: 5 },
  'Авто-выбор лучшей (11)': { pnl: -1, meta: true, leader: null },
}));

// 14 пар: в отчёте топ-10 и свёрнутые остальные, на графике 8 лучших и 4 худших.
const MANY_SYMBOLS = Array.from({ length: 14 }, (_, i) => `P${i}USDT`);
const MANY = statsOf(stateOf(MANY_SYMBOLS, Object.fromEntries(MANY_SYMBOLS.map((s, i) => [`${s}:RSI (14, 30/70)`, { pnl: i - 5 }]))));

function input(extra: Partial<ReportInput> = {}): ReportInput {
  return {
    kind: 'now', stats: SINGLE, prevRub: null, prevPrice: null, price24hAgo: null, trades: [], now: NOW,
    webUrl: '', hasPhoto: false, refreshButton: false, schedule: 'каждый час', ...extra,
  };
}

describe('отчёт: редкие ветки', () => {
  it('без цены, без прошлого отчёта и с https-панелью — кнопка вместо ссылки', () => {
    const html = plain(reportRichHtml(input({ stats: { ...SINGLE, price: null, feePct: null }, webUrl: 'https://bots.example/' })));
    expect(html).toContain('<h2>⚡ Сейчас · 14:00</h2>');
    expect(html).toContain('<b>— $</b>'.replace(/ /g, ' '));
    expect(html).toContain('<tg-button type="url" url="https://bots.example/">📊 Панель</tg-button>');
    expect(html).toContain('стоит вне рынка');
    expect(html).not.toContain('комиссия');
  });

  it('молодой счёт: годовые появятся после 6 часов', () => {
    const young = statsOf(stateOf(['DOGEUSDT'], { 'RSI (14, 30/70)': { pnl: 0 } }), 0.01);
    expect(plain(reportRichHtml(input({ stats: young })))).toContain('(годовые — после 6 часов работы)');
    expect(apr(null, 16)).toBe('—');
    expect(shortName('(x)')).toBe('(x)');
  });

  it('много пар: остальные свёрнуты, сделок больше лимита, ставка минимальным ордером', () => {
    const trades = Array.from({ length: 30 }, (_, i) => ({
      time: new Date(NOW.getTime() - i * 60_000).toISOString(), symbol: 'P1USDT', bot: 'RSI (14, 30/70)', side: 'buy', price: '1', pnlPct: '',
    })) as TradeRow[];
    const html = plain(reportRichHtml(input({ stats: { ...MANY, orderPct: 0 }, trades, hasPhoto: true })));
    expect(html).toContain('<details><summary>Остальные пары · 4</summary>');
    expect(html).toContain('— в панели');
    expect(html).toContain('<i>вход</i>');
    expect(html).toContain('сделка минимальным ордером биржи');
    expect(html).toContain('по стратегиям (сумма по всем парам)');
    expect(chartSections(MANY, null)[1]!.title).toBe('Пары: 8 лучших и 4 худших');
    expect(reportClassic(input({ stats: MANY })).text).toContain('<pre>');
  });

  it('отчёт по паре без данных о паре, со сделками и позицией', () => {
    const bots = SINGLE.bots.map((b, i) => ({ ...b, position: i === 0 ? 1 : 0 }));
    const trade = { time: NOW.toISOString(), symbol: 'DOGEUSDT', bot: 'RSI (14, 30/70)', side: 'sell', price: '0.08', pnlPct: '1' } as TradeRow;
    const detail: PairDetail = { symbol: 'DOGEUSDT', pair: null, bots, trades: [trade] };
    const html = plain(pairRichHtml(detail, SINGLE, false));
    expect(html).toContain('📈 в рынке');
    expect(html).toContain('<details><summary>Сделки · 1</summary>');
    expect(html).not.toContain('<figure>');
    const priced = plain(pairRichHtml({ ...detail, pair: { ...SINGLE.pairs[0]!, price: null, minOrderUsdt: null } }, SINGLE, false));
    expect(priced).toContain('Цена <b>— $</b>');
    expect(priced).toContain('минимальный ордер биржи — $');
    expect(pairClassic(detail)).toContain('<pre>');
  });

  it('сделка без суммы прибыли — нули в обычном сообщении', () => {
    const e: TradeEvent = { symbol: 'ZKUSDT', bot: 'MACD', side: 'sell', price: 0.1, equity: 12, time: '' };
    const text = plain(tradeClassic(e, { rubPerUsd: 85, startRub: 1000 }));
    expect(text).toContain('прибыль $0.0000');
    expect(text).toContain('(0.00 %)');
  });
});

describe('график: редкие ветки', () => {
  const base: ChartInput = { title: 'T', subtitle: 's', sections: [], periodLabel: 'за час' };

  it('ровная цена, сделки вне шкалы, длинные имена и нулевые полоски', () => {
    const svg = renderChartSvg({
      ...base,
      prices: [{ time: 0, price: 5 }, { time: 0, price: 5 }],
      trades: [{ time: 10, price: 5, side: 'buy' }, { time: 0, price: 500, side: 'sell' }],
      sections: [{ title: 'Боты', bars: [{ name: 'x'.repeat(40), total: 0, period: null }, { name: 'y', total: -0.001, period: null }] }],
    });
    expect(svg).toContain('x'.repeat(25) + '…');
    expect(svg).not.toContain('<polygon');
    expect(svg).not.toContain('ниже —');
  });

  it('цена в долларах и сотнях долларов подписывается разной точностью', () => {
    expect(priceLabel(12.3456)).toBe('12.346');
    expect(priceLabel(1234.56)).toBe('1234.6');
    expect(renderChartSvg({ ...base, prices: [{ time: 0, price: 0 }, { time: 1, price: 0 }] })).toContain('<path');
  });
});

describe('клиент Bot API', () => {
  it('сетевая ошибка и ответ без JSON не бросаются, а возвращаются как отказ', async () => {
    const broken = new TelegramApi('t', '1', (async () => { throw new Error('сеть упала'); }) as unknown as typeof fetch);
    expect(await broken.sendMessage('x')).toEqual({ ok: false, description: 'сеть упала' });
    const html = new TelegramApi('t', '1', (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch);
    expect(await html.chatAction('typing')).toEqual({ ok: false, description: 'HTTP 502' });
  });

  it('фото, команды, опрос с отменой и ответ на кнопку', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const api = new TelegramApi('t', '1', (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ ok: true, result: [] }));
    }) as unknown as typeof fetch);
    expect((await api.sendPhoto(Buffer.from('png'), 'cap')).ok).toBe(true);
    expect((await api.setCommands([{ command: 'now', description: 'x' }])).ok).toBe(true);
    expect((await api.getUpdates(5, 1, new AbortController().signal)).result).toEqual([]);
    expect((await api.answerCallback('q', 'ok')).ok).toBe(true);
    expect(seen.map(s => s.url.split('/').pop())).toEqual(['sendPhoto', 'setMyCommands', 'getUpdates', 'answerCallbackQuery']);
    expect(seen[0]!.init.body).toBeInstanceOf(FormData);
  });
});

interface Call {
  method: string;
  fields: Record<string, unknown>;
}

describe('TelegramService: отказы и команды', () => {
  let dir: string;
  let calls: Call[];
  let fail: Set<string>;
  let listener: TradeListener | null;
  let onUpdates: (() => Response) | null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bybit-tg-edge-'));
    calls = [];
    fail = new Set();
    listener = null;
    onUpdates = null;
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  interface Opts {
    stats?: Stats | (() => Promise<Stats>);
    klinesFail?: boolean;
    chartFail?: boolean;
  }

  function service(env: Record<string, string> = {}, opts: Opts = {}) {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '42', TELEGRAM_MIN_PNL_PCT: '1', TELEGRAM_TRADE_ALERTS: '1',
      START_RUB: '1000', DATA_DIR: dir, NOTIFY_INTERVAL_MS: '3600000', TELEGRAM_COMMANDS: '0', ...env,
    });
    const s = opts.stats ?? SINGLE;
    const getStats = typeof s === 'function' ? s : async () => s;
    const statsService = {
      stats: getStats,
      allTrades: async () => [],
      pairDetail: async (symbol: string): Promise<PairDetail> => {
        const st = await getStats();
        return { symbol, pair: st.pairs.find(p => p.name === symbol) ?? null, bots: st.bots.filter(b => b.symbol === symbol), trades: [] };
      },
    };
    const rates = { rubPerUsd: async () => ({ value: 85, source: 'test' }) };
    const engine = { onTrade: (l: TradeListener) => { listener = l; return () => { listener = null; }; } };
    const reject = async () => { throw new Error('биржа недоступна'); };
    const bybit = opts.klinesFail ? { klines: reject, tickers: reject } : { klines: async () => [], tickers: async () => [] };
    const charts = { render: opts.chartFail ? reject : async () => Buffer.from('png') };
    const fetchFn = (async (url: string, init: RequestInit) => {
      const method = url.split('/').pop()!;
      const fields = init.body instanceof FormData
        ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '<file>']))
        : JSON.parse(String(init.body));
      calls.push({ method, fields });
      if (method === 'getUpdates' && onUpdates) return onUpdates();
      if (fail.has(method)) return new Response(JSON.stringify({ ok: false, description: 'нет' }), { status: 400 });
      return new Response(JSON.stringify({ ok: true, result: true }));
    }) as unknown as typeof fetch;
    return new TelegramService(config, statsService as never, rates as never, engine as never, bybit as never, charts as never, fetchFn);
  }

  const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
  const methods = () => calls.map(c => c.method);
  const emptySeen = (): Seen => ({ lastDigestDay: null, lastDigestAt: null, digestRub: {}, digestPrice: null, lastReportKey: null, lastReportAt: null, reportRub: {}, reportPrice: null });

  it('сделка: покупка не пишется, отказ rich — обычное сообщение, без START_RUB — от баланса', async () => {
    const tg = service({ START_RUB: '0' });
    const sale: TradeEvent = { symbol: 'ZKUSDT', bot: 'MACD', side: 'sell', price: 0.08, pnlPct: 2, pnlUsdt: 0.1, equity: 12, time: '' };
    expect(await tg.notifyTrade({ ...sale, side: 'buy' }, at(19, 14))).toBe(false);
    fail.add('sendRichMessage');
    expect(await tg.notifyTrade(sale, at(19, 14))).toBe(true);
    expect(methods()).toEqual(['sendRichMessage', 'sendMessage']);
  });

  it('если отказали все способы, отчёт не считается отправленным', async () => {
    fail = new Set(['sendRichMessage', 'sendPhoto', 'sendMessage']);
    const tg = service();
    expect(await tg.tick(at(19, 14))).toBeNull();
    expect(await tg.tick(at(19, 15))).toBeNull();
    expect(methods()).toEqual(['sendRichMessage', 'sendPhoto', 'sendMessage', 'sendRichMessage', 'sendPhoto', 'sendMessage']);
  });

  it('биржа недоступна — отчёт всё равно уходит; без ботов — не уходит; ошибка статистики — тихо null', async () => {
    expect(await service({}, { klinesFail: true }).tick(at(19, 14))).toBe('hour');
    calls = [];
    const empty = { ...SINGLE, bots: [] };
    expect(await service({}, { stats: empty }).tick(at(19, 15))).toBeNull();
    expect(calls).toHaveLength(0);
    const broken = service({}, { stats: async () => { throw new Error('нет файла'); } });
    expect(await broken.tick(at(19, 16))).toBeNull();
  });

  it('итог дня читает прошлое состояние из файла и сохраняет снимок дня', async () => {
    await writeFile(join(dir, 'notify-state.json'), JSON.stringify({ lastDigestDay: '2026-10-18', digestRub: { 'RSI (14, 30/70)': 1000 }, digestPrice: 0.07 }));
    expect(await service().tick(at(19, 21, 5))).toBe('day');
  });

  it('/now без данных отвечает текстом, /pair без пары — подсказкой, график пары не нарисован — без фото', async () => {
    const empty = service({}, { stats: { ...SINGLE, bots: [] } });
    expect(await empty.sendNow(at(19, 14))).toBe(true);
    expect(String(calls.at(-1)!.fields.text)).toContain('Данных пока нет');
    calls = [];
    const tg = service({}, { chartFail: true });
    expect(await tg.sendPair('')).toBe(true);
    expect(String(calls[0]!.fields.text)).toContain('Лучшие сейчас: DOGE');
    calls = [];
    expect(await tg.sendPair('dogeusdt')).toBe(true);
    const report = calls.find(c => c.method === 'sendRichMessage')!;
    expect(report.fields.rich_message).toBeDefined();
    expect(report.fields.report).toBeUndefined();
  });

  it('цель: без токена сообщение не уходит и ступень не засчитывается', async () => {
    const rich = statsOf(stateOf(['DOGEUSDT'], { 'RSI (14, 30/70)': { pnl: 300 } }));
    const off = service({ TELEGRAM_BOT_TOKEN: '' }, { stats: rich });
    const seen = emptySeen();
    expect(await off.checkGoal(seen, at(19, 14))).toBe(false);
    expect(seen.goalLevels).toBeUndefined();
    const none = service({}, { stats: { ...SINGLE, bots: [], strategies: [], totals: { ...SINGLE.totals, investedRub: 0 } } });
    expect(await none.checkGoal(seen, at(19, 14))).toBe(false);
  });

  it('команды: чужие кнопки, /start, /help, неизвестная команда и пустое сообщение', async () => {
    const tg = service();
    const now = Math.floor(Date.now() / 1000);
    await tg.handleUpdate({ update_id: 1, callback_query: { id: 'q', data: 'now', message: { chat: { id: 7 } } } });
    await tg.handleUpdate({ update_id: 2, callback_query: { id: 'q', data: 'other' } });
    await tg.handleUpdate({ update_id: 3 });
    await tg.handleUpdate({ update_id: 4, message: { chat: { id: 42 } } });
    await tg.handleUpdate({ update_id: 5, message: { chat: { id: 42 }, text: '/what' } });
    expect(calls).toHaveLength(0);
    await tg.handleUpdate({ update_id: 6, message: { chat: { id: 42 }, text: '/start', date: now } });
    await tg.handleUpdate({ update_id: 7, message: { chat: { id: 42 }, text: '/help' } });
    expect(methods()).toEqual(['sendRichMessage', 'sendRichMessage']);
  });

  it('при запуске с командами ставит меню, опрашивает обновления и переживает отказы', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const tg = service({ TELEGRAM_COMMANDS: '1', TELEGRAM_TRADE_ALERTS: '0' });
    let round = 0;
    onUpdates = () => {
      round += 1;
      if (round <= 2) return new Response(JSON.stringify({ ok: false, description: 'Conflict' }), { status: 409 });
      if (round === 3) {
        return new Response(JSON.stringify({ ok: true, result: [
          { update_id: 10, message: { chat: { id: 42 }, text: '/help' } },
          { update_id: 11, message: { chat: { id: 42 }, text: '/pair' } },
        ] }));
      }
      if (round === 4) return new Response(JSON.stringify({ ok: true }));
      tg.onApplicationShutdown();
      return new Response(JSON.stringify({ ok: true, result: [] }));
    };
    tg.onApplicationBootstrap();
    expect(listener).not.toBeNull();
    for (let i = 0; i < 5 && round < 5; i += 1) await vi.advanceTimersByTimeAsync(10_000);
    expect(round).toBe(5);
    expect(methods()).toContain('setMyCommands');
    const offsets = calls.filter(c => c.method === 'getUpdates').map(c => c.fields.offset);
    expect(offsets.at(-1)).toBe(12);
    expect(listener).toBeNull();
  });

  it('сделка от движка приходит в оповещения через подписку', async () => {
    const tg = service({ TELEGRAM_COMMANDS: '0' });
    tg.onApplicationBootstrap();
    listener!({ symbol: 'ZKUSDT', bot: 'MACD', side: 'sell', price: 0.08, pnlPct: 5, pnlUsdt: 0.1, equity: 12, time: '' });
    await vi.waitFor(() => expect(calls.filter(c => c.method === 'sendRichMessage').length).toBeGreaterThanOrEqual(2));
    tg.onApplicationShutdown();
  });
});
