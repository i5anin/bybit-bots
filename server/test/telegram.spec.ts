import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inDayHours, loadConfig } from '../src/config/app-config.js';
import { rankVolatility, type Ticker } from '../src/market/volatility.js';
import { buildStats } from '../src/stats/build-stats.js';
import type { PairDetail, Stats, TradeRow } from '../src/stats/stats.types.js';
import { renderChartPng, renderChartSvg, type ChartInput } from '../src/telegram/chart.js';
import {
  chartSections, pairRichHtml, reportClassic, reportRichHtml, rub, shortName, tradeRichHtml, type ReportInput,
} from '../src/telegram/report.js';
import { TelegramService } from '../src/telegram/telegram.service.js';
import type { TradeEvent, TradeListener } from '../src/trading/engine.service.js';
import type { Candle, EngineState } from '../src/trading/types.js';

const plain = (s: string) => s.replace(/ /g, ' ');
const RATE = 85;
const NOW = new Date(2026, 9, 19, 14, 0);

// Состояние движка → Stats настоящим buildStats: фикстуры не расходятся с API.
// pnl — заработок бота в рублях: в долларах это pnl / курс.
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

function statsOf(state: EngineState): Stats {
  return buildStats({
    state, equity: { series: new Map(), lastPrice: null }, trades: [], runs: [], rate: { value: RATE, source: 'ЦБ РФ' },
    startRub: 1000, staleSec: 300, bankRatePct: 16, now: NOW.getTime(),
  });
}

const SINGLE = statsOf(stateOf(['DOGEUSDT'], {
  'Martingale-lite (1% шаг)': { pnl: 12.4, position: 53 },
  'Авто-выбор лучшей (11)': { pnl: -10, meta: true, leader: 'Martingale-lite (1% шаг)' },
  'MACD (12/26/9)': { pnl: -68.4 },
}));

const MULTI = statsOf(stateOf(['ZKUSDT', 'TIAUSDT'], {
  'ZKUSDT:RSI (14, 30/70)': { pnl: 6 },
  'ZKUSDT:MACD (12/26/9)': { pnl: -2 },
  'TIAUSDT:RSI (14, 30/70)': { pnl: 1 },
  'TIAUSDT:MACD (12/26/9)': { pnl: -0.5 },
}, { orderPct: 1, enforceMinOrder: false }));

const TRADES = [
  { time: '2026-10-19T10:10:00.000Z', symbol: 'DOGEUSDT', bot: 'MACD (12/26/9)', side: 'buy', price: '0.0801', pnlPct: '' },
  { time: '2026-10-19T10:20:00.000Z', symbol: 'DOGEUSDT', bot: 'MACD (12/26/9)', side: 'sell', price: '0.0799', pnlPct: '-0.48' },
  { time: '2026-10-19T10:30:00.000Z', symbol: 'DOGEUSDT', bot: 'Martingale-lite (1% шаг)', side: 'sell', price: '0.0812', pnlPct: '1.3' },
] as TradeRow[];

function input(extra: Partial<ReportInput> = {}): ReportInput {
  return {
    kind: 'hour', stats: SINGLE,
    prevRub: { 'Martingale-lite (1% шаг)': 1000, 'Авто-выбор лучшей (11)': 991, 'MACD (12/26/9)': 940 },
    prevPrice: 0.0796, price24hAgo: 0.081, trades: TRADES, now: NOW,
    webUrl: 'http://192.168.3.5:3004/', hasPhoto: true, refreshButton: true, schedule: 'каждый час', ...extra,
  };
}

describe('day hours', () => {
  it('include both ends and may wrap past midnight', () => {
    expect([8, 9, 22, 23].map(h => inDayHours(h, 9, 22))).toEqual([false, true, true, false]);
    expect([21, 23, 1, 2, 3].map(h => inDayHours(h, 22, 2))).toEqual([false, true, true, true, false]);
  });
});

describe('money format', () => {
  it('shows kopecks below 10 ₽ — stakes of 1 % move by kopecks', () => {
    expect(plain(rub(0.37, true))).toBe('+0,37 ₽');
    expect(plain(rub(-12.4, true))).toBe('−12 ₽');
    expect(plain(rub(1234))).toBe('1 234 ₽');
    expect(plain(rub(0, true))).toBe('±0 ₽');
  });
});

describe('hourly report for one pair', () => {
  const html = plain(reportRichHtml(input()));

  it('has a heading, the chart, the strategy table and the hour change', () => {
    expect(html).toContain('<h2>🕐 Итоги часа · 14:00</h2>');
    expect(html).toContain('<img src="tg://photo?id=report"/>');
    expect(html).toContain('<td>🥇</td><td>Martingale-lite 📈</td><td align="right"><b>1 012 ₽</b></td><td align="right">+12 ₽</td><td align="right">🟢 +12 ₽</td>');
    expect(html).toContain('<b>Авто-выбор лучшей</b>');
    expect(html).toContain('за час <b>+0.50 %</b>');
  });

  it('shows the annual return next to the deposit rate', () => {
    // +12.4 ₽ за 10 дней = 1.24 % → 45.3 % годовых, выше вклада 16 % — галочка.
    expect(html).toContain('+45.3 % ✅');
    expect(html).toContain('при вкладе 16 %');
    expect(html).toContain('Обгоняют вклад 16 %: <b>1 из 3</b>');
  });

  it('hides the worst under a spoiler and the trades in a collapsible block', () => {
    expect(html).toContain('Худший за час: <tg-spoiler>MACD −8,40 ₽</tg-spoiler>');
    expect(html).toContain('<details><summary>Сделки за час · 3</summary>');
    expect(html).toContain('<td>▼ продажа</td><td align="right"><code>0.0799</code></td><td align="right">−0.48 %</td>');
  });

  it('says who the meta bot follows and adds the buttons', () => {
    expect(html).toContain('🤖 <b>Авто-выбор</b> повторяет <b>Martingale-lite</b>');
    expect(html).toContain('<tg-button type="callback_data" style="primary" data="now">🔄 Обновить</tg-button>');
    expect(html).toContain('<a href="http://192.168.3.5:3004/">Открыть панель</a>');
    expect(html).toMatch(/<tg-time unix="\d+" format="t">14:00<\/tg-time>/);
  });

  it('shows dashes before the first report and never lets a name break the markup', () => {
    const first = plain(reportRichHtml(input({ prevRub: null, hasPhoto: false })));
    expect(first).toContain('<td align="right">—</td>');
    expect(first).not.toContain('Худший');
    const evil = statsOf(stateOf(['DOGEUSDT'], { '<b>x</b> & "y"': { pnl: 0 } }));
    expect(reportRichHtml(input({ stats: evil, prevRub: null }))).toContain('&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;');
  });
});

describe('report for many pairs', () => {
  const trades = [{ time: '2026-10-19T10:10:00.000Z', symbol: 'ZKUSDT', bot: 'RSI (14, 30/70)', side: 'sell', price: '0.12', pnlPct: '2.1' }] as TradeRow[];
  const html = plain(reportRichHtml(input({ stats: MULTI, prevRub: { 'ZKUSDT:RSI (14, 30/70)': 5 + 1000 }, trades })));

  it('describes the grid of pairs × strategies and the 1 % stake', () => {
    expect(html).toContain('2 пар × 2 стратегий = <b>4 ботов</b>, у каждого 1 000 ₽, ставка 1 % счёта (10 ₽) без учёта минимального ордера биржи.');
  });

  it('sums strategies over pairs and lists pairs with the exchange minimum', () => {
    expect(html).toContain('Сумма по 2 парам');
    expect(html).toContain('<td align="right">2/2</td>');
    expect(html).toContain('<td align="right">0/2</td>');
    expect(html).toContain('<h3>Пары: топ-2 из 2</h3>');
    expect(html).toContain('<td><b>ZK</b></td>');
    expect(html).toContain('<td align="right">5 $</td>');
  });

  it('names the pair in trades and in the best and worst of the hour', () => {
    expect(html).toContain('<th>Пара</th>');
    expect(html).toContain('<td>ZK</td><td>RSI</td>');
    expect(html).toContain('Лучший за час: <b>ZK · RSI</b> +1,00 ₽');
    expect(html).not.toContain('по волатильности');
  });

  it('charts strategies and pairs instead of one price', () => {
    const sections = chartSections(MULTI, null);
    expect(sections.map(s => s.title)).toEqual(['Стратегии: сумма по 2 парам', 'Пары']);
    expect(sections[0]!.bars.map(b => b.name)).toEqual(['RSI', 'MACD']);
  });
});

describe('daily report and fallback', () => {
  it('is a bigger page for the day', () => {
    const html = plain(reportRichHtml(input({ kind: 'day' })));
    expect(html).toContain('<h1>📊 Итог дня · 19.10</h1>');
    expect(html).toContain('<th>За сутки</th>');
  });

  it('the classic version fits the caption limit and keeps tables monospaced', () => {
    const { caption, text } = reportClassic(input({ stats: MULTI, prevRub: null }));
    expect(caption.length).toBeLessThan(1024);
    expect(text).toContain('<pre>');
    expect(text).toContain('Пары, топ-10:');
  });
});

describe('pair report and trade message', () => {
  it('lists the 12 bots of one pair with the exchange minimum and stake', () => {
    const detail: PairDetail = { symbol: 'ZKUSDT', pair: MULTI.pairs.find(p => p.name === 'ZKUSDT')!, bots: MULTI.bots.filter(b => b.symbol === 'ZKUSDT'), trades: [] };
    const html = plain(pairRichHtml(detail, MULTI, true));
    expect(html).toContain('<h2>📈 ZK · 2 ботов</h2>');
    expect(html).toContain('минимальный ордер биржи 5 $, ставка 10 ₽');
    expect(html).toContain('Цена за сутки: ▲ входы, ▼ выходы ботов этой пары');
  });

  it('a trade names its pair and the money made', () => {
    const e: TradeEvent = { symbol: 'ZKUSDT', bot: 'Stochastic Oscillator (14, 20/80)', side: 'sell', price: 0.12, pnlPct: 1.42, pnlUsdt: 0.0712, equity: 12.2, time: '' };
    expect(plain(tradeRichHtml(e, { rubPerUsd: 85, startRub: 1000 }))).toContain('<h3>✅ +6,05 ₽ · ZK · Stochastic Oscillator</h3>');
    expect(shortName('RSI (14, 30/70)')).toBe('RSI');
  });
});

const tick = (symbol: string, low: number, high: number, turnover = 5e6): Ticker =>
  ({ symbol, lastPrice: high, highPrice24h: high, lowPrice24h: low, price24hPcnt: 0.05, turnover24h: turnover });

describe('volatility ranking', () => {
  it('ranks liquid USDT pairs by the 24h range and skips stables, leveraged tokens and thin pairs', () => {
    const rows = rankVolatility([
      tick('AUSDT', 1, 1.1), tick('BUSDT', 1, 1.5), tick('USDCUSDT', 0.9, 1.1), tick('BTC3LUSDT', 1, 2),
      tick('THINUSDT', 1, 3, 1e5), tick('CBTC', 1, 2),
    ]);
    expect(rows.map(r => r.symbol)).toEqual(['BUSDT', 'AUSDT']);
  });

  it('a one-pair report shows the top ten and the rest collapsed', () => {
    const vol = rankVolatility(Array.from({ length: 15 }, (_, i) => tick(`P${i}USDT`, 1, 2 - i / 20)).concat(tick('DOGEUSDT', 1, 1.01)));
    const html = plain(reportRichHtml(input({ volatility: vol })));
    expect(html).toContain('<h3>🔥 Топ-10 по волатильности</h3>');
    expect(html).toContain('<details><summary>Остальные пары · 6</summary>');
    expect(html).toContain('<td>16</td><td><b>DOGE</b> ◀ торгуем</td>');
  });
});

describe('chart', () => {
  const t0 = Date.UTC(2026, 9, 19, 0, 0);
  const chart: ChartInput = {
    title: 'DOGEUSDT · итоги часа', subtitle: 'цена 0.08 $',
    prices: Array.from({ length: 96 }, (_, i) => ({ time: t0 + i * 900_000, price: 0.08 + Math.sin(i / 8) * 0.001 })),
    trades: [{ time: t0 + 3_600_000, price: 0.0805, side: 'buy' }, { time: t0 + 7_200_000, price: 0.0808, side: 'sell' }],
    sections: [{ title: 'Боты', bars: [{ name: 'A & <B>', total: 12, period: 1, highlight: true }, { name: 'MACD', total: -68, period: -2 }] }],
    periodLabel: 'за час',
  };

  it('draws the price, the trades and a bar per bot', () => {
    const svg = renderChartSvg(chart);
    expect(svg).toContain('A &amp; &lt;B&gt;');
    expect(svg.match(/<polygon/g)).toHaveLength(2);
    expect(svg).toContain('за час −2,00 ₽');
  });

  it('draws several bar sections without a price panel', () => {
    const svg = renderChartSvg({ ...chart, prices: undefined, trades: undefined, sections: [chart.sections[0]!, { title: 'Пары', bars: [{ name: 'ZK', total: 3, period: null }] }] });
    expect(svg).toContain('Пары');
    expect(svg).not.toContain('<path');
  });

  it('copes with no price data and renders a PNG', () => {
    expect(renderChartSvg({ ...chart, prices: [] })).toContain('нет данных о цене');
    const png = renderChartPng(chart);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
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
  let draftFails: boolean;
  let listener: TradeListener | null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bybit-tg-'));
    calls = [];
    richFails = false;
    draftFails = false;
    listener = null;
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function service(env: Record<string, string> = {}, s: Stats = SINGLE) {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '42', TELEGRAM_MIN_PNL_PCT: '1',
      TELEGRAM_DIGEST_HOUR: '21', TELEGRAM_DAY_FROM: '9', TELEGRAM_DAY_TO: '22',
      START_RUB: '1000', DATA_DIR: dir, NOTIFY_INTERVAL_MS: '3600000', TELEGRAM_COMMANDS: '0', ...env,
    });
    const statsService = {
      stats: async () => s,
      allTrades: async () => TRADES,
      pairDetail: async (symbol: string): Promise<PairDetail> => ({
        symbol, pair: s.pairs.find(p => p.name === symbol) ?? null, bots: s.bots.filter(b => b.symbol === symbol), trades: [],
      }),
    };
    const rates = { rubPerUsd: async () => ({ value: 85, source: 'test' }) };
    const engine = { onTrade: (l: TradeListener) => { listener = l; return () => { listener = null; }; } };
    const candles: Candle[] = Array.from({ length: 96 }, (_, i) => ({
      time: Date.UTC(2026, 9, 18, 12) + i * 900_000, open: 0.08, high: 0.081, low: 0.079, close: 0.08 + i * 0.00001, volume: 1,
    }));
    const bybit = { klines: async () => candles, tickers: async () => [tick('ZKUSDT', 1, 1.2), tick('DOGEUSDT', 1, 1.05)] };
    const charts = { render: async () => Buffer.from('png') };
    const fetchFn = (async (url: string, init: RequestInit) => {
      const method = url.split('/').pop()!;
      const fields = init.body instanceof FormData
        ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `<file ${v.size}>`]))
        : JSON.parse(String(init.body));
      calls.push({ method, fields });
      if (method === 'sendRichMessageDraft' && draftFails) {
        return new Response(JSON.stringify({ ok: false, description: 'Bad Request: method not found' }), { status: 404 });
      }
      if (method === 'sendRichMessage' && richFails) {
        return new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse rich message" }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true, result: true }));
    }) as unknown as typeof fetch;
    return new TelegramService(config, statsService as never, rates as never, engine as never, bybit as never, charts as never, fetchFn);
  }

  const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
  const methods = () => calls.map(c => c.method);
  const richHtml = (c: Call) => plain(JSON.parse(String(c.fields.rich_message)).html as string);

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
    expect(richHtml(call)).toContain('<td>1</td><td>ZK</td>');
  });

  it('compares the next hour with the previous report, bot by bot', async () => {
    const tg = service({}, MULTI);
    await tg.tick(at(19, 14));
    const saved = JSON.parse(await readFile(join(dir, 'notify-state.json'), 'utf8'));
    expect(saved).toMatchObject({ lastReportKey: '2026-10-19 14', reportRub: { 'TIAUSDT:MACD (12/26/9)': 999.5 } });
    await tg.tick(at(19, 15));
    expect(richHtml(calls[1]!)).toContain('за час <b>±0 ₽</b>');
  });

  it('falls back to a photo and plain HTML when the rich message is rejected', async () => {
    richFails = true;
    expect(await service().tick(at(19, 14))).toBe('hour');
    expect(methods()).toEqual(['sendRichMessage', 'sendPhoto', 'sendMessage']);
  });

  it('sends at most three trade alerts an hour, loudly by day and silently at night', async () => {
    const tg = service();
    const sale: TradeEvent = { symbol: 'ZKUSDT', bot: 'MACD (12/26/9)', side: 'sell', price: 0.08, pnlPct: 1.5, pnlUsdt: 0.08, equity: 12, time: '' };
    expect(await tg.notifyTrade({ ...sale, pnlPct: 0.4 }, at(19, 14))).toBe(false);
    expect(await tg.notifyTrade(sale, at(19, 14))).toBe(true);
    expect(await tg.notifyTrade(sale, at(19, 14, 1))).toBe(true);
    expect(await tg.notifyTrade(sale, at(19, 14, 2))).toBe(true);
    expect(await tg.notifyTrade(sale, at(19, 14, 3))).toBe(false);
    expect(await tg.notifyTrade(sale, at(20, 3))).toBe(true);
    expect(calls.map(c => c.fields.disable_notification)).toEqual([false, false, false, true]);
  });

  it('answers /now and the refresh button only in the configured chat', async () => {
    const tg = service();
    const now = Math.floor(Date.now() / 1000);
    await tg.handleUpdate({ update_id: 1, message: { chat: { id: 7 }, text: '/now', date: now } });
    await tg.handleUpdate({ update_id: 2, message: { chat: { id: 42 }, text: '/now', date: now - 3600 } });
    expect(calls).toHaveLength(0);
    await tg.handleUpdate({ update_id: 3, message: { chat: { id: 42 }, text: '/now@bybit_bot', date: now } });
    expect(richHtml(calls.find(c => c.method === 'sendRichMessage')!)).toContain('⚡ Сейчас');
    calls = [];
    await tg.handleUpdate({ update_id: 4, callback_query: { id: 'q', data: 'now', message: { chat: { id: 42 } } } });
    expect(methods().filter(m => m !== 'sendRichMessageDraft')).toEqual(['answerCallbackQuery', 'sendRichMessage']);
  });

  it('/pair sends the chart and the bots of that pair', async () => {
    const tg = service({}, MULTI);
    const now = Math.floor(Date.now() / 1000);
    await tg.handleUpdate({ update_id: 1, message: { chat: { id: 42 }, text: '/pair zk', date: now } });
    const report = calls.find(c => c.method === 'sendRichMessage')!;
    expect(report.fields.report).toMatch(/^<file/);
    expect(richHtml(report)).toContain('📈 ZK · 2 ботов');
    calls = [];
    await tg.handleUpdate({ update_id: 2, message: { chat: { id: 42 }, text: '/pair NOPE', date: now } });
    expect(String(calls[0]!.fields.text)).toContain('Пары NOPE нет');
  });

  it('animates a draft while the report on demand is being built', async () => {
    await service().sendNow(at(19, 14, 30));
    expect(methods()).toEqual(['sendRichMessageDraft', 'sendRichMessageDraft', 'sendRichMessageDraft', 'sendRichMessage']);
    expect(new Set(calls.slice(0, 3).map(c => c.fields.draft_id)).size).toBe(1);
  });

  it('falls back to the upload status when drafts are not supported', async () => {
    draftFails = true;
    await service().sendNow(at(19, 14, 30));
    expect(methods()).toEqual(['sendRichMessageDraft', 'sendChatAction', 'sendChatAction', 'sendChatAction', 'sendRichMessage']);
  });

  it('a report on demand does not move the hourly comparison point', async () => {
    const tg = service();
    await tg.tick(at(19, 14));
    const before = await readFile(join(dir, 'notify-state.json'), 'utf8');
    await tg.sendNow(at(19, 14, 30));
    expect(await readFile(join(dir, 'notify-state.json'), 'utf8')).toBe(before);
  });

  it('subscribes to trades on start, unsubscribes on shutdown, and does nothing without a token', async () => {
    const tg = service();
    tg.onApplicationBootstrap();
    expect(listener).not.toBeNull();
    tg.onApplicationShutdown();
    expect(listener).toBeNull();
    calls = [];
    const off = service({ TELEGRAM_BOT_TOKEN: '' });
    off.onApplicationBootstrap();
    expect(await off.tick(at(19, 14))).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
