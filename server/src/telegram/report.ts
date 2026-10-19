import type { VolatilityRow } from '../market/volatility.js';
import type { BotStats, Stats, TradeRow } from '../stats/stats.types.js';
import type { TradeEvent } from '../trading/engine.service.js';
import { priceLabel } from './chart.js';
import { PHOTO_ID } from './telegram-api.js';

// Тексты сообщений. Основной вид — rich-сообщение Bot API 10.3 (заголовки,
// таблица, спойлер, сворачиваемый блок, кнопки), запасной — классический HTML
// для sendPhoto/sendMessage, если rich-сообщение не прошло.

export type ReportKind = 'hour' | 'day' | 'now';

export interface ReportInput {
  kind: ReportKind;
  stats: Stats;
  prevRub: Record<string, number> | null; // счета на момент прошлого отчёта
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
export function rub(v: number, sign = false): string {
  const r = Math.round(v);
  const text = `${Math.abs(r).toLocaleString('ru-RU').replace(/\s/g, NBSP)}${NBSP}₽`;
  if (!sign) return r < 0 ? `−${text}` : text;
  return r > 0 ? `+${text}` : r < 0 ? `−${text}` : `±${text}`;
}

export function pct(v: number): string {
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}${NBSP}%`;
}

// «Stochastic Oscillator (14, 20/80)» → «Stochastic Oscillator»: в таблице на
// телефоне параметры стратегии не помещаются, а в панели они есть.
export function shortName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, '') || name;
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function periodLabel(kind: ReportKind): string {
  return kind === 'hour' ? 'за час' : kind === 'day' ? 'за сутки' : 'с прошлого отчёта';
}

function title(input: ReportInput): string {
  const { kind, now } = input;
  if (kind === 'day') return `📊 Итог дня · ${now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}`;
  if (kind === 'hour') return `🕐 Итоги часа · ${String(now.getHours()).padStart(2, '0')}:00`;
  return `⚡ Сейчас · ${hhmm(now)}`;
}

interface Summary {
  total: number;
  invested: number;
  periodTotal: number | null;
  change: (b: BotStats) => number | null;
  best: BotStats | null;
  worst: BotStats | null;
  meta: BotStats | undefined;
  closed: TradeRow[];
  wins: number;
  hourPct: number | null;
  dayPct: number | null;
}

function summarize(input: ReportInput): Summary {
  const { stats, prevRub } = input;
  const change = (b: BotStats) => {
    const prev = prevRub?.[b.name];
    return prev === undefined ? null : b.equityRub - prev;
  };
  const total = stats.bots.reduce((s, b) => s + b.equityRub, 0);
  const withChange = stats.bots.filter(b => change(b) !== null);
  const periodTotal = withChange.length ? withChange.reduce((s, b) => s + change(b)!, 0) : null;
  const sorted = [...withChange].sort((a, b) => change(b)! - change(a)!);
  const closed = input.trades.filter(t => t.pnlPct !== '');
  const price = stats.price;
  return {
    total,
    invested: stats.startRub * stats.bots.length,
    periodTotal,
    change,
    best: sorted[0] ?? null,
    worst: sorted.length > 1 ? sorted[sorted.length - 1]! : null,
    meta: stats.bots.find(b => b.isMeta),
    closed,
    wins: closed.filter(t => Number(t.pnlPct) > 0).length,
    hourPct: price && input.prevPrice ? (price / input.prevPrice - 1) * 100 : null,
    dayPct: price && input.price24hAgo ? (price / input.price24hAgo - 1) * 100 : null,
  };
}

function rank(i: number): string {
  return ['🥇', '🥈', '🥉'][i] ?? String(i + 1);
}

function changeCell(v: number | null): string {
  if (v === null) return '—';
  const r = Math.round(v);
  return `${r > 0 ? '🟢 ' : r < 0 ? '🔴 ' : ''}${rub(v, true)}`;
}

function tradeRowsHtml(trades: readonly TradeRow[], limit: number): string {
  const rows = trades.slice(-limit).reverse().map(t => {
    const pnl = t.pnlPct === '' ? '<i>вход</i>' : pct(Number(t.pnlPct));
    const when = new Date(t.time);
    return `<tr><td>${hhmm(when)}</td><td>${esc(shortName(t.bot))}</td><td>${t.side === 'buy' ? '▲ покупка' : '▼ продажа'}</td>`
      + `<td align="right"><code>${esc(t.price)}</code></td><td align="right">${pnl}</td></tr>`;
  });
  const more = trades.length > limit ? `<p><i>и ещё ${trades.length - limit} — в панели</i></p>` : '';
  return `<table striped compact><tr><th>Время</th><th>Бот</th><th>Сделка</th><th>Цена</th><th>Итог</th></tr>${rows.join('')}</table>${more}`;
}

export function reportRichHtml(input: ReportInput): string {
  const { stats, kind } = input;
  const s = summarize(input);
  const label = periodLabel(kind);
  const heading = kind === 'day' ? 'h1' : 'h2';
  const parts: string[] = [`<${heading}>${esc(title(input))}</${heading}>`];

  const market = [`${esc(stats.baseAsset || stats.symbol)} <b>${stats.price ? priceLabel(stats.price) : '—'}${NBSP}$</b>`];
  if (s.hourPct !== null && kind !== 'day') market.push(`${label} <b>${pct(s.hourPct)}</b>`);
  if (s.dayPct !== null) market.push(`за сутки ${pct(s.dayPct)}`);
  parts.push(`<p>${market.join(' · ')}</p>`);

  parts.push(`<p>Все ${stats.bots.length} ботов: <b>${rub(s.total)}</b> из ${rub(s.invested)} (${rub(s.total - s.invested, true)})`
    + (s.periodTotal === null ? '' : ` · ${label} <b>${rub(s.periodTotal, true)}</b>`) + '</p>');

  if (input.hasPhoto) {
    parts.push(`<figure><img src="tg://photo?id=${PHOTO_ID}"/><figcaption>Цена ${esc(stats.baseAsset)} за сутки: ▲ покупки, ▼ продажи ботов. Ниже — заработок каждого бота</figcaption></figure>`);
  }

  parts.push(kind === 'day' ? '<h2>Рейтинг</h2>' : '<h3>Рейтинг</h3>');
  const periodHead = kind === 'day' ? 'За сутки' : kind === 'hour' ? 'За час' : 'С отчёта';
  const rows = stats.bots.map((b, i) => {
    const name = b.isMeta ? `<b>${esc(shortName(b.name))}</b>` : esc(shortName(b.name));
    return `<tr><td>${rank(i)}</td><td>${name}${b.position ? ' 📈' : ''}</td><td align="right"><b>${rub(b.equityRub)}</b></td>`
      + `<td align="right">${rub(b.equityRub - stats.startRub, true)}</td><td align="right">${changeCell(s.change(b))}</td>`
      + (kind === 'day' ? `<td align="right">${b.trades}</td>` : '') + '</tr>';
  });
  parts.push(`<table bordered striped compact><caption>Старт у каждого ${rub(stats.startRub)} · 📈 — в рынке</caption>`
    + `<tr><th>#</th><th>Бот</th><th>Счёт</th><th>С начала</th><th>${periodHead}</th>${kind === 'day' ? '<th>Сделок</th>' : ''}</tr>`
    + rows.join('') + '</table>');

  if (s.meta) {
    parts.push(`<blockquote>🤖 <b>Авто-выбор</b> ${s.meta.leader
      ? `повторяет <b>${esc(shortName(s.meta.leader))}</b> — лучшую стратегию за последние сутки`
      : 'стоит вне рынка: за сутки в плюсе нет ни одной стратегии'}</blockquote>`);
  }

  const facts: string[] = [];
  if (kind === 'day') {
    facts.push(`В плюсе с начала: <b>${stats.bots.filter(b => b.equityRub > stats.startRub).length} из ${stats.bots.length}</b>`);
  }
  if (s.best && s.periodTotal !== null) {
    facts.push(`Лучший ${label}: <b>${esc(shortName(s.best.name))}</b> ${rub(s.change(s.best)!, true)}`);
  }
  if (s.worst) {
    facts.push(`Худший ${label}: <tg-spoiler>${esc(shortName(s.worst.name))} ${rub(s.change(s.worst)!, true)}</tg-spoiler>`);
  }
  facts.push(`Сделок ${label}: <b>${input.trades.length}</b>, закрыто ${s.closed.length}`
    + (s.closed.length ? `, в плюс ${s.wins}` : ''));
  if (kind === 'day' && s.closed.length) {
    const byPnl = [...s.closed].sort((a, b) => Number(b.pnlPct) - Number(a.pnlPct));
    const top = byPnl[0]!;
    const bottom = byPnl[byPnl.length - 1]!;
    facts.push(`Лучшая сделка: <b>${esc(shortName(top.bot))}</b> ${pct(Number(top.pnlPct))}`);
    if (byPnl.length > 1) facts.push(`Худшая сделка: <tg-spoiler>${esc(shortName(bottom.bot))} ${pct(Number(bottom.pnlPct))}</tg-spoiler>`);
  }
  parts.push(`<ul>${facts.map(f => `<li>${f}</li>`).join('')}</ul>`);

  const vol = input.volatility ?? [];
  if (vol.length) {
    const row = (v: VolatilityRow, i: number) => {
      const name = v.symbol === stats.symbol ? `<b>${esc(v.symbol.replace(/USDT$/, ''))}</b> ◀ торгуем` : esc(v.symbol.replace(/USDT$/, ''));
      return `<tr><td>${i + 1}</td><td>${name}</td><td align="right"><b>${v.rangePct.toFixed(1)}${NBSP}%</b></td>`
        + `<td align="right">${pct(v.changePct)}</td><td align="right">${turnover(v.turnover)}</td></tr>`;
    };
    const head = '<tr><th>#</th><th>Пара</th><th>Размах</th><th>За сутки</th><th>Оборот</th></tr>';
    parts.push(`<h3>🔥 Топ-${Math.min(TOP_PAIRS, vol.length)} по волатильности</h3>`);
    parts.push(`<table bordered striped compact><caption>Размах цены за 24 ч, пары к USDT с оборотом от 1 млн $</caption>${head}`
      + vol.slice(0, TOP_PAIRS).map(row).join('') + '</table>');
    const own = vol.findIndex(v => v.symbol === stats.symbol);
    if (own >= TOP_PAIRS) parts.push(`<p>${esc(stats.baseAsset)} — на ${own + 1}-м месте из ${vol.length}</p>`);
    if (vol.length > TOP_PAIRS) {
      parts.push(`<details><summary>Остальные пары · ${vol.length - TOP_PAIRS}</summary><table striped compact>${head}`
        + vol.slice(TOP_PAIRS).map((v, i) => row(v, i + TOP_PAIRS)).join('') + '</table></details>');
    }
  }

  if (input.trades.length) {
    parts.push(`<details><summary>Сделки ${label} · ${input.trades.length}</summary>${tradeRowsHtml(input.trades, MAX_TRADE_ROWS[kind])}</details>`);
  }

  const unix = Math.floor(input.now.getTime() / 1000);
  parts.push(`<footer>Бумажная торговля на ${esc(stats.symbol)} Bybit spot`
    + (stats.feePct !== null ? ` · комиссия ${stats.feePct}${NBSP}% + проскальзывание ${stats.slippagePct}${NBSP}%` : '')
    + ` · курс ${stats.rubPerUsd.toFixed(2)}${NBSP}₽ (${esc(stats.rateSource)})`
    + ` · данные на <tg-time unix="${unix}" format="t">${hhmm(input.now)}</tg-time> · ${esc(input.schedule)}</footer>`);

  const buttons: string[] = [];
  if (input.refreshButton) buttons.push('<tg-button type="callback_data" style="primary" data="now">🔄 Обновить</tg-button>');
  if (/^https:\/\//.test(input.webUrl)) buttons.push(`<tg-button type="url" url="${esc(input.webUrl)}">📊 Панель</tg-button>`);
  else if (input.webUrl) parts.push(`<p><a href="${esc(input.webUrl)}">Открыть панель</a></p>`);
  if (buttons.length) parts.push(`<tg-button-row>${buttons.join('')}</tg-button-row>`);

  return parts.join('\n');
}

// Запасной вид: подпись к фото (до 1024 символов) и текст с моноширинной таблицей.
export function reportClassic(input: ReportInput): { caption: string; text: string } {
  const { stats, kind } = input;
  const s = summarize(input);
  const label = periodLabel(kind);
  const head = `<b>${esc(title(input))}</b>`;
  const totals = `Все ${stats.bots.length}: <b>${rub(s.total)}</b> из ${rub(s.invested)} (${rub(s.total - s.invested, true)})`
    + (s.periodTotal === null ? '' : `, ${label} ${rub(s.periodTotal, true)}`);
  const market = `${esc(stats.baseAsset)} ${stats.price ? priceLabel(stats.price) : '—'} $`
    + (s.dayPct === null ? '' : ` · за сутки ${pct(s.dayPct)}`);

  const nameW = 18;
  const table = stats.bots.map((b, i) => {
    const name = shortName(b.name).slice(0, nameW).padEnd(nameW);
    const ch = s.change(b);
    return `${String(i + 1).padStart(2)} ${name} ${rub(b.equityRub).padStart(7)} ${rub(b.equityRub - stats.startRub, true).padStart(7)}`
      + (ch === null ? '' : ` ${rub(ch, true).padStart(6)}`);
  }).join('\n');

  const trades = input.trades.slice(-15).reverse().map(t =>
    `${hhmm(new Date(t.time))} ${esc(shortName(t.bot))} ${t.side === 'buy' ? '▲' : '▼'} ${esc(t.price)}`
    + (t.pnlPct === '' ? '' : ` ${pct(Number(t.pnlPct))}`)).join('\n');

  const vol = (input.volatility ?? []).slice(0, TOP_PAIRS)
    .map((v, i) => `${String(i + 1).padStart(2)} ${v.symbol.replace(/USDT$/, '').padEnd(9)} ${v.rangePct.toFixed(1).padStart(5)}% ${pct(v.changePct).padStart(8)}`)
    .join('\n');

  const text = [
    head,
    market,
    totals,
    `<pre>${esc(table)}</pre>`,
    vol ? `🔥 Топ-${TOP_PAIRS} по волатильности (размах за сутки):\n<pre>${esc(vol)}</pre>` : '',
    s.worst ? `Худший ${label}: <tg-spoiler>${esc(shortName(s.worst.name))} ${rub(s.change(s.worst)!, true)}</tg-spoiler>` : '',
    trades ? `<blockquote expandable>Сделки ${label} · ${input.trades.length}\n${trades}</blockquote>` : `Сделок ${label} не было`,
    input.webUrl ? `<a href="${esc(input.webUrl)}">Панель</a>` : '',
  ].filter(Boolean).join('\n');

  return { caption: [head, market, totals].join('\n'), text };
}

function turnover(usdt: number): string {
  return usdt >= 1e9 ? `${(usdt / 1e9).toFixed(1)}${NBSP}млрд $` : `${(usdt / 1e6).toFixed(1)}${NBSP}млн $`;
}

export interface TradeContext {
  rubPerUsd: number;
  startRub: number;
}

export function tradeRichHtml(e: TradeEvent, ctx: TradeContext): string {
  const profitRub = (e.pnlUsdt ?? 0) * ctx.rubPerUsd;
  const equityRub = e.equity * ctx.rubPerUsd;
  return [
    `<h3>✅ ${rub(profitRub, true)} · ${esc(shortName(e.bot))}</h3>`,
    `<p>Продажа по <code>${e.price}</code> · <b>${pct(e.pnlPct ?? 0)}</b> · прибыль $${(e.pnlUsdt ?? 0).toFixed(4)} после комиссий</p>`,
    `<p>Счёт бота: <b>${rub(equityRub)}</b>, с начала ${rub(equityRub - ctx.startRub, true)}</p>`,
  ].join('\n');
}

export function tradeClassic(e: TradeEvent, ctx: TradeContext): string {
  const profitRub = (e.pnlUsdt ?? 0) * ctx.rubPerUsd;
  const equityRub = e.equity * ctx.rubPerUsd;
  return [
    `✅ <b>${rub(profitRub, true)}</b> (${pct(e.pnlPct ?? 0)}) — ${esc(e.bot)}`,
    `Продажа по ${e.price}, прибыль $${(e.pnlUsdt ?? 0).toFixed(4)} после комиссий`,
    `Счёт бота: <b>${rub(equityRub)}</b>, с начала ${rub(equityRub - ctx.startRub, true)}`,
  ].join('\n');
}
