import type { VolatilityRow } from '../market/volatility.js';
import type { BotStats, GroupStats, PairDetail, PairStats, Stats, TradeRow } from '../stats/stats.types.js';
import type { TradeEvent } from '../trading/engine.service.js';
import { priceLabel, type ChartBar } from './chart.js';
import { PHOTO_ID } from './telegram-api.js';

// Тексты сообщений. Основной вид — rich-сообщение Bot API 10.3 (заголовки,
// таблицы, спойлер, сворачиваемые блоки, кнопки), запасной — классический HTML
// для sendPhoto/sendMessage, если rich-сообщение не прошло.
// Ботов может быть 1200 (100 пар × 12 стратегий), поэтому отчёт — сводки:
// по стратегиям (сумма по всем парам) и по парам (сумма по всем стратегиям).

export type ReportKind = 'hour' | 'day' | 'now';

export interface ReportInput {
  kind: ReportKind;
  stats: Stats;
  prevRub: Record<string, number> | null; // счета ботов (по ключу) на момент прошлого отчёта
  prevPrice: number | null;
  price24hAgo: number | null;
  trades: readonly TradeRow[]; // сделки за период отчёта
  now: Date;
  webUrl: string;
  hasPhoto: boolean;
  refreshButton: boolean;
  schedule: string; // «каждый час 9–22, итог дня в 21:00»
  volatility?: readonly VolatilityRow[]; // рейтинг пар по размаху за сутки
}

const NBSP = ' ';
const MAX_TRADE_ROWS = { hour: 20, now: 20, day: 40 } as const;
const TOP_PAIRS = 10;

export function esc(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// «1 234 ₽» с неразрывными пробелами; со знаком — для прибыли и убытка.
// Меньше 10 ₽ — с копейками: при ставке 1 % изменения за час — копейки.
export function rub(v: number, sign = false): string {
  const small = Math.abs(v) < 10 && Math.abs(v) >= 0.005;
  const r = small ? Math.round(v * 100) / 100 : Math.round(v);
  const abs = small
    ? Math.abs(r).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : Math.abs(r).toLocaleString('ru-RU');
  const text = `${abs.replace(/\s/g, NBSP)}${NBSP}₽`;
  if (!sign) return r < 0 ? `−${text}` : text;
  return r > 0 ? `+${text}` : r < 0 ? `−${text}` : `±${text}`;
}

export function pct(v: number, digits = 2): string {
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}${NBSP}%`;
}

// Годовые и сравнение с вкладом: торговать имеет смысл, только если они выше.
export function apr(v: number | null, bank: number): string {
  if (v === null) return '—';
  return `${pct(v, 1)}${v > bank ? ' ✅' : ''}`;
}

// «Stochastic Oscillator (14, 20/80)» → «Stochastic Oscillator».
export function shortName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, '') || name;
}

export function base(symbol: string): string {
  return symbol.replace(/USDT$/, '');
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function periodLabel(kind: ReportKind): string {
  return kind === 'hour' ? 'за час' : kind === 'day' ? 'за сутки' : 'с прошлого отчёта';
}

function periodHead(kind: ReportKind): string {
  return kind === 'day' ? 'За сутки' : kind === 'hour' ? 'За час' : 'С отчёта';
}

function title(input: ReportInput): string {
  const { kind, now } = input;
  if (kind === 'day') return `📊 Итог дня · ${now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}`;
  if (kind === 'hour') return `🕐 Итоги часа · ${String(now.getHours()).padStart(2, '0')}:00`;
  return `⚡ Сейчас · ${hhmm(now)}`;
}

function rank(i: number): string {
  return ['🥇', '🥈', '🥉'][i] ?? String(i + 1);
}

function changeCell(v: number | null): string {
  if (v === null) return '—';
  const r = Math.round(v * 100);
  return `${r > 0 ? '🟢 ' : r < 0 ? '🔴 ' : ''}${rub(v, true)}`;
}

export interface Changes {
  bot: (b: BotStats) => number | null;
  group: (g: GroupStats, by: 'name' | 'symbol') => number | null;
  total: number | null;
}

// Изменение счёта за период: по ботам — от снимка прошлого отчёта, по группам — сумма.
export function changes(stats: Stats, prevRub: Record<string, number> | null): Changes {
  const bot = (b: BotStats) => {
    const prev = prevRub?.[b.key];
    return prev === undefined ? null : b.equityRub - prev;
  };
  const sum = (list: BotStats[]) => {
    const xs = list.map(bot).filter((x): x is number => x !== null);
    return xs.length ? xs.reduce((s, x) => s + x, 0) : null;
  };
  return {
    bot,
    group: (g, by) => sum(stats.bots.filter(b => (by === 'name' ? b.name : b.symbol) === g.name)),
    total: sum(stats.bots),
  };
}

function strategyTable(input: ReportInput, ch: Changes): string {
  const { stats, kind } = input;
  const multi = stats.symbols.length > 1;
  const head = `<tr><th>#</th><th>Стратегия</th><th>Счёт</th><th>С начала</th><th>${periodHead(kind)}</th><th>Годовых</th>`
    + `${multi ? '<th>В плюсе</th>' : ''}</tr>`;
  const rows = stats.strategies.map((g, i) => {
    const name = g.isMeta ? `<b>${esc(shortName(g.name))}</b>` : esc(shortName(g.name));
    const inMarket = !multi && g.inMarket ? ' 📈' : '';
    return `<tr><td>${rank(i)}</td><td>${name}${inMarket}</td><td align="right"><b>${rub(g.equityRub)}</b></td>`
      + `<td align="right">${rub(g.pnlRub, true)}</td><td align="right">${changeCell(ch.group(g, 'name'))}</td>`
      + `<td align="right">${apr(g.aprPct, stats.bankRatePct)}</td>`
      + (multi ? `<td align="right">${g.inPlus}/${g.bots}</td>` : '') + '</tr>';
  });
  const caption = multi
    ? `Сумма по ${stats.symbols.length} парам, у каждого бота старт ${rub(stats.startRub)} · ✅ — годовые выше вклада ${stats.bankRatePct} %`
    : `Старт у каждого ${rub(stats.startRub)} · 📈 — в рынке · ✅ — годовые выше вклада ${stats.bankRatePct} %`;
  return `<table bordered striped compact><caption>${esc(caption)}</caption>${head}${rows.join('')}</table>`;
}

function pairRow(p: PairStats, i: number, ch: Changes, bank: number): string {
  return `<tr><td>${rank(i)}</td><td><b>${esc(base(p.name))}</b></td><td align="right">${rub(p.equityRub)}</td>`
    + `<td align="right">${rub(p.pnlRub, true)}</td><td align="right">${changeCell(ch.group(p, 'symbol'))}</td>`
    + `<td align="right">${apr(p.aprPct, bank)}</td><td>${p.best ? esc(shortName(p.best.name)) : '—'}</td>`
    + `<td align="right">${p.minOrderUsdt === null ? '—' : `${p.minOrderUsdt}${NBSP}$`}</td></tr>`;
}

function pairsSection(input: ReportInput, ch: Changes): string[] {
  const { stats, kind } = input;
  const head = `<tr><th>#</th><th>Пара</th><th>Счёт 12 ботов</th><th>С начала</th><th>${periodHead(kind)}</th><th>Годовых</th><th>Лучшая</th><th>Мин. ордер</th></tr>`;
  const pairs = stats.pairs;
  const out = [
    `<h3>Пары: топ-${Math.min(TOP_PAIRS, pairs.length)} из ${pairs.length}</h3>`,
    `<table bordered striped compact>${head}${pairs.slice(0, TOP_PAIRS).map((p, i) => pairRow(p, i, ch, stats.bankRatePct)).join('')}</table>`,
  ];
  if (pairs.length > TOP_PAIRS) {
    out.push(`<details><summary>Остальные пары · ${pairs.length - TOP_PAIRS}</summary><table striped compact>${head}`
      + pairs.slice(TOP_PAIRS).map((p, i) => pairRow(p, i + TOP_PAIRS, ch, stats.bankRatePct)).join('') + '</table></details>');
  }
  return out;
}

function tradeRowsHtml(trades: readonly TradeRow[], limit: number, multi: boolean): string {
  const rows = trades.slice(-limit).reverse().map(t => {
    const pnl = t.pnlPct === '' ? '<i>вход</i>' : pct(Number(t.pnlPct));
    return `<tr><td>${hhmm(new Date(t.time))}</td>${multi ? `<td>${esc(base(t.symbol))}</td>` : ''}<td>${esc(shortName(t.bot))}</td>`
      + `<td>${t.side === 'buy' ? '▲ покупка' : '▼ продажа'}</td>`
      + `<td align="right"><code>${esc(t.price)}</code></td><td align="right">${pnl}</td></tr>`;
  });
  const more = trades.length > limit ? `<p><i>и ещё ${trades.length - limit} — в панели</i></p>` : '';
  return `<table striped compact><tr><th>Время</th>${multi ? '<th>Пара</th>' : ''}<th>Бот</th><th>Сделка</th><th>Цена</th><th>Итог</th></tr>`
    + `${rows.join('')}</table>${more}`;
}

function volatilitySection(input: ReportInput): string[] {
  const vol = input.volatility ?? [];
  if (!vol.length) return [];
  const { stats } = input;
  const row = (v: VolatilityRow, i: number) => {
    const name = v.symbol === stats.symbol ? `<b>${esc(base(v.symbol))}</b> ◀ торгуем` : esc(base(v.symbol));
    return `<tr><td>${i + 1}</td><td>${name}</td><td align="right"><b>${v.rangePct.toFixed(1)}${NBSP}%</b></td>`
      + `<td align="right">${pct(v.changePct)}</td><td align="right">${(v.turnover / 1e6).toFixed(1)}${NBSP}млн $</td></tr>`;
  };
  const head = '<tr><th>#</th><th>Пара</th><th>Размах</th><th>За сутки</th><th>Оборот</th></tr>';
  const out = [
    `<h3>🔥 Топ-${Math.min(TOP_PAIRS, vol.length)} по волатильности</h3>`,
    `<table bordered striped compact><caption>Размах цены за 24 ч</caption>${head}${vol.slice(0, TOP_PAIRS).map(row).join('')}</table>`,
  ];
  if (vol.length > TOP_PAIRS) {
    out.push(`<details><summary>Остальные пары · ${vol.length - TOP_PAIRS}</summary><table striped compact>${head}`
      + vol.slice(TOP_PAIRS).map((v, i) => row(v, i + TOP_PAIRS)).join('') + '</table></details>');
  }
  return out;
}

function buttons(input: ReportInput, parts: string[]): void {
  const list: string[] = [];
  if (input.refreshButton) list.push('<tg-button type="callback_data" style="primary" data="now">🔄 Обновить</tg-button>');
  if (/^https:\/\//.test(input.webUrl)) list.push(`<tg-button type="url" url="${esc(input.webUrl)}">📊 Панель</tg-button>`);
  else if (input.webUrl) parts.push(`<p><a href="${esc(input.webUrl)}">Открыть панель</a></p>`);
  if (list.length) parts.push(`<tg-button-row>${list.join('')}</tg-button-row>`);
}

function stakeText(stats: Stats): string {
  if (!stats.orderPct) return 'сделка минимальным ордером биржи';
  return `ставка ${stats.orderPct}${NBSP}% счёта (${rub(stats.orderRub)})`
    + (stats.enforceMinOrder ? '' : ' без учёта минимального ордера биржи');
}

export function reportRichHtml(input: ReportInput): string {
  const { stats, kind } = input;
  const ch = changes(stats, input.prevRub);
  const label = periodLabel(kind);
  const multi = stats.symbols.length > 1;
  const t = stats.totals;
  const heading = kind === 'day' ? 'h1' : 'h2';
  const parts: string[] = [`<${heading}>${esc(title(input))}</${heading}>`];

  if (multi) {
    parts.push(`<p>${stats.symbols.length} пар × ${stats.strategies.length} стратегий = <b>${t.bots} ботов</b>, `
      + `у каждого ${rub(stats.startRub)}, ${esc(stakeText(stats))}.</p>`);
  } else {
    const market = [`${esc(stats.baseAsset || stats.symbol)} <b>${stats.price ? priceLabel(stats.price) : '—'}${NBSP}$</b>`];
    const hourPct = stats.price && input.prevPrice ? (stats.price / input.prevPrice - 1) * 100 : null;
    const dayPct = stats.price && input.price24hAgo ? (stats.price / input.price24hAgo - 1) * 100 : null;
    if (hourPct !== null && kind !== 'day') market.push(`${label} <b>${pct(hourPct)}</b>`);
    if (dayPct !== null) market.push(`за сутки ${pct(dayPct)}`);
    parts.push(`<p>${market.join(' · ')}</p>`);
  }
  parts.push(`<p>Все боты: <b>${rub(t.equityRub)}</b> из ${rub(t.investedRub)} (${rub(t.pnlRub, true)})`
    + (ch.total === null ? '' : ` · ${label} <b>${rub(ch.total, true)}</b>`)
    + ` · <b>${apr(t.aprPct, stats.bankRatePct)}</b> годовых при вкладе ${stats.bankRatePct}${NBSP}%</p>`);

  if (input.hasPhoto) {
    parts.push(`<figure><img src="tg://photo?id=${PHOTO_ID}"/><figcaption>${multi
      ? 'Заработок с начала: по стратегиям (сумма по всем парам) и по лучшим и худшим парам'
      : `Цена ${esc(stats.baseAsset)} за сутки: ▲ покупки, ▼ продажи ботов. Ниже — заработок каждого бота`}</figcaption></figure>`);
  }

  parts.push(kind === 'day' ? '<h2>Стратегии</h2>' : '<h3>Стратегии</h3>');
  parts.push(strategyTable(input, ch));

  const meta = stats.strategies.find(g => g.isMeta);
  if (meta && !multi) {
    const leader = stats.bots.find(b => b.isMeta)?.leader;
    parts.push(`<blockquote>🤖 <b>Авто-выбор</b> ${leader
      ? `повторяет <b>${esc(shortName(leader))}</b> — лучшую стратегию за последние сутки`
      : 'стоит вне рынка: за сутки в плюсе нет ни одной стратегии'}</blockquote>`);
  }
  if (multi) parts.push(...pairsSection(input, ch));

  const ranked = stats.bots.map(b => ({ b, c: ch.bot(b) })).filter((x): x is { b: BotStats; c: number } => x.c !== null)
    .sort((a, b) => b.c - a.c);
  const who = (b: BotStats) => multi ? `${base(b.symbol)} · ${shortName(b.name)}` : shortName(b.name);
  const facts: string[] = [];
  facts.push(`Обгоняют вклад ${stats.bankRatePct}${NBSP}%: <b>${t.beatsBank} из ${t.bots}</b>`
    + (t.aprPct === null ? ' (годовые — после 6 часов работы)' : ''));
  if (multi) facts.push(`В плюсе с начала: <b>${t.inPlus} из ${t.bots}</b>`);
  if (t.best) facts.push(`Лучший с начала: <b>${esc(t.best.name)}</b> ${rub(t.best.pnlRub, true)}`);
  if (ranked.length) facts.push(`Лучший ${label}: <b>${esc(who(ranked[0]!.b))}</b> ${rub(ranked[0]!.c, true)}`);
  if (ranked.length > 1) {
    const worst = ranked[ranked.length - 1]!;
    facts.push(`Худший ${label}: <tg-spoiler>${esc(who(worst.b))} ${rub(worst.c, true)}</tg-spoiler>`);
  }
  const closed = input.trades.filter(x => x.pnlPct !== '');
  facts.push(`Сделок ${label}: <b>${input.trades.length}</b>, закрыто ${closed.length}`
    + (closed.length ? `, в плюс ${closed.filter(x => Number(x.pnlPct) > 0).length}` : ''));
  parts.push(`<ul>${facts.map(f => `<li>${f}</li>`).join('')}</ul>`);

  if (input.trades.length) {
    parts.push(`<details><summary>Сделки ${label} · ${input.trades.length}</summary>${tradeRowsHtml(input.trades, MAX_TRADE_ROWS[kind], multi)}</details>`);
  }
  if (!multi) parts.push(...volatilitySection(input));

  const unix = Math.floor(input.now.getTime() / 1000);
  parts.push(`<footer>Тест на реальных ценах Bybit spot, без реальных ордеров · ${esc(stakeText(stats))}`
    + (stats.feePct !== null ? ` · комиссия ${stats.feePct}${NBSP}% + проскальзывание ${stats.slippagePct}${NBSP}%` : '')
    + ` · курс ${stats.rubPerUsd.toFixed(2)}${NBSP}₽ (${esc(stats.rateSource)})`
    + ` · данные на <tg-time unix="${unix}" format="t">${hhmm(input.now)}</tg-time> · ${esc(input.schedule)}</footer>`);
  buttons(input, parts);
  return parts.join('\n');
}

// Запасной вид: подпись к фото (до 1024 символов) и текст с моноширинными таблицами.
export function reportClassic(input: ReportInput): { caption: string; text: string } {
  const { stats, kind } = input;
  const ch = changes(stats, input.prevRub);
  const label = periodLabel(kind);
  const t = stats.totals;
  const head = `<b>${esc(title(input))}</b>`;
  const totals = `Все ${t.bots} ботов: <b>${rub(t.equityRub)}</b> из ${rub(t.investedRub)} (${rub(t.pnlRub, true)})`
    + (ch.total === null ? '' : `, ${label} ${rub(ch.total, true)}`)
    + ` · годовых ${apr(t.aprPct, stats.bankRatePct)} при вкладе ${stats.bankRatePct} %`;
  const table = stats.strategies.map((g, i) => {
    const c = ch.group(g, 'name');
    return `${String(i + 1).padStart(2)} ${shortName(g.name).slice(0, 18).padEnd(18)} ${rub(g.pnlRub, true).padStart(9)}`
      + (c === null ? '' : ` ${rub(c, true).padStart(8)}`);
  }).join('\n');
  const pairs = stats.symbols.length > 1
    ? stats.pairs.slice(0, TOP_PAIRS).map((p, i) => `${String(i + 1).padStart(2)} ${base(p.name).padEnd(9)} ${rub(p.pnlRub, true).padStart(9)}`).join('\n')
    : '';
  const text = [
    head,
    totals,
    `<pre>${esc(table)}</pre>`,
    pairs ? `Пары, топ-${TOP_PAIRS}:\n<pre>${esc(pairs)}</pre>` : '',
    input.webUrl ? `<a href="${esc(input.webUrl)}">Панель</a>` : '',
  ].filter(Boolean).join('\n');
  return { caption: [head, totals].join('\n'), text };
}

// Столбики для картинки отчёта: стратегии, а при многих парах — ещё лучшие и худшие пары.
export function chartSections(stats: Stats, prevRub: Record<string, number> | null): { title: string; bars: ChartBar[] }[] {
  const ch = changes(stats, prevRub);
  if (stats.symbols.length <= 1) {
    return [{
      title: 'Заработок ботов с начала',
      bars: stats.bots.map(b => ({ name: b.name, total: b.pnlRub, period: ch.bot(b), highlight: b.isMeta })),
    }];
  }
  const pairs = stats.pairs;
  const picked = pairs.length > 12 ? [...pairs.slice(0, 8), ...pairs.slice(-4)] : pairs;
  return [
    {
      title: `Стратегии: сумма по ${stats.symbols.length} парам`,
      bars: stats.strategies.map(g => ({ name: shortName(g.name), total: g.pnlRub, period: ch.group(g, 'name'), highlight: g.isMeta })),
    },
    {
      title: pairs.length > 12 ? 'Пары: 8 лучших и 4 худших' : 'Пары',
      bars: picked.map(p => ({ name: base(p.name), total: p.pnlRub, period: ch.group(p, 'symbol') })),
    },
  ];
}

// Отчёт по одной паре: её 12 ботов и её сделки (команда /pair).
export function pairRichHtml(d: PairDetail, stats: Stats, hasPhoto: boolean): string {
  const p = d.pair;
  const parts = [`<h2>📈 ${esc(base(d.symbol))} · ${d.bots.length} ботов</h2>`];
  if (p) {
    parts.push(`<p>Цена <b>${p.price === null ? '—' : priceLabel(p.price)}${NBSP}$</b> · все боты пары: <b>${rub(p.equityRub)}</b> `
      + `из ${rub(p.investedRub)} (${rub(p.pnlRub, true)}) · ${apr(p.aprPct, stats.bankRatePct)} годовых · `
      + `минимальный ордер биржи ${p.minOrderUsdt ?? '—'}${NBSP}$, ставка ${rub(stats.orderRub)}</p>`);
  }
  if (hasPhoto) parts.push(`<figure><img src="tg://photo?id=${PHOTO_ID}"/><figcaption>Цена за сутки: ▲ входы, ▼ выходы ботов этой пары</figcaption></figure>`);
  parts.push('<table bordered striped compact><tr><th>#</th><th>Стратегия</th><th>Счёт</th><th>С начала</th><th>Годовых</th><th>Сделок</th><th>Позиция</th></tr>'
    + d.bots.map((b, i) => `<tr><td>${rank(i)}</td><td>${b.isMeta ? `<b>${esc(shortName(b.name))}</b>` : esc(shortName(b.name))}</td>`
      + `<td align="right"><b>${rub(b.equityRub)}</b></td><td align="right">${rub(b.pnlRub, true)}</td>`
      + `<td align="right">${apr(b.aprPct, stats.bankRatePct)}</td><td align="right">${b.trades}</td><td>${b.position ? '📈 в рынке' : '—'}</td></tr>`).join('')
    + '</table>');
  if (d.trades.length) parts.push(`<details><summary>Сделки · ${d.trades.length}</summary>${tradeRowsHtml([...d.trades].reverse(), 30, false)}</details>`);
  return parts.join('\n');
}

export function pairClassic(d: PairDetail): string {
  const lines = d.bots.map((b, i) => `${String(i + 1).padStart(2)} ${shortName(b.name).slice(0, 18).padEnd(18)} ${rub(b.pnlRub, true).padStart(9)} сделок ${b.trades}`);
  return `📈 <b>${esc(base(d.symbol))}</b>\n<pre>${esc(lines.join('\n'))}</pre>`;
}

export interface TradeContext {
  rubPerUsd: number;
  startRub: number;
}

export function tradeRichHtml(e: TradeEvent, ctx: TradeContext): string {
  const profitRub = (e.pnlUsdt ?? 0) * ctx.rubPerUsd;
  const equityRub = e.equity * ctx.rubPerUsd;
  return [
    `<h3>✅ ${rub(profitRub, true)} · ${esc(base(e.symbol))} · ${esc(shortName(e.bot))}</h3>`,
    `<p>Продажа по <code>${e.price}</code> · <b>${pct(e.pnlPct ?? 0)}</b> · прибыль $${(e.pnlUsdt ?? 0).toFixed(4)} после комиссий</p>`,
    `<p>Счёт бота: <b>${rub(equityRub)}</b>, с начала ${rub(equityRub - ctx.startRub, true)}</p>`,
  ].join('\n');
}

export function tradeClassic(e: TradeEvent, ctx: TradeContext): string {
  const profitRub = (e.pnlUsdt ?? 0) * ctx.rubPerUsd;
  const equityRub = e.equity * ctx.rubPerUsd;
  return [
    `✅ <b>${rub(profitRub, true)}</b> (${pct(e.pnlPct ?? 0)}) — ${esc(base(e.symbol))} · ${esc(e.bot)}`,
    `Продажа по ${e.price}, прибыль $${(e.pnlUsdt ?? 0).toFixed(4)} после комиссий`,
    `Счёт бота: <b>${rub(equityRub)}</b>, с начала ${rub(equityRub - ctx.startRub, true)}`,
  ].join('\n');
}
