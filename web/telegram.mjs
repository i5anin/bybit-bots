// Оповещения в Telegram: удачные сделки сразу, сводка — раз в сутки.
// Без токена в окружении молча не работает: панель и бот от этого не страдают.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT = process.env.TELEGRAM_CHAT_ID || '';
const MIN_PNL = Number(process.env.TELEGRAM_MIN_PNL_PCT ?? 0.5);
const DIGEST_HOUR = Number(process.env.TELEGRAM_DIGEST_HOUR ?? 21);
const STATE_PATH = `${process.env.DATA_DIR || '/app/data'}/notify-state.json`;

export const enabled = Boolean(TOKEN && CHAT);

async function loadSeen() {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8'));
  } catch {
    return { lastTradeTime: null, lastDigestDay: null };
  }
}

async function saveSeen(seen) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(seen, null, 2));
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function send(html) {
  if (!enabled) return false;
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const body = {
    chat_id: CHAT,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.warn('[telegram] отказ', res.status, (await res.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[telegram] не отправлено:', err.message);
    return false;
  }
}

// Отбираем только закрытые сделки в плюс: пустой pnlPct означает вход в позицию.
function profitableSince(trades, sinceIso) {
  return trades.filter(t => {
    const pnl = Number(t.pnlPct);
    if (!Number.isFinite(pnl) || pnl < MIN_PNL) return false;
    return !sinceIso || t.time > sinceIso;
  });
}

function tradeMessage(t, symbol) {
  const pnl = Number(t.pnlPct).toFixed(2);
  const time = new Date(t.time).toLocaleTimeString('ru-RU', { hour12: false });
  return [
    `✅ <b>Прибыльная сделка</b>`,
    ``,
    `Стратегия: <b>${escapeHtml(t.bot)}</b>`,
    `Инструмент: ${escapeHtml(t.symbol || symbol)}`,
    `Направление: ${escapeHtml(t.side)}`,
    `Цена: ${escapeHtml(t.price)}`,
    `Результат: <b>+${pnl} %</b>`,
    `Время: ${time}`,
  ].join('\n');
}

function digestMessage(stats, webUrl) {
  const top = stats.bots.slice(0, 5);
  const lines = top.map((b, i) => {
    const sign = b.pnlPct >= 0 ? '+' : '';
    return `${i + 1}. ${escapeHtml(b.name)} — <b>${sign}${b.pnlPct} %</b>` +
           ` (${b.equity.toFixed(2)})`;
  });
  const hours = Math.floor(stats.uptimeSecTotal / 3600);
  const win = stats.totals.winRatePct;
  return [
    `📊 <b>Сводка за сутки</b> — ${escapeHtml(stats.symbol)}`,
    ``,
    ...lines,
    ``,
    `В плюсе: <b>${stats.totals.inProfit}</b> из ${stats.bots.length}`,
    `Сделок всего: ${stats.totals.tradesTotal}` +
      (win === null ? '' : `, доля удачных: <b>${win} %</b>`),
    `Общий счёт: <b>${stats.totals.equity}</b> из ${stats.totals.invested}`,
    `Наработка: ${hours} ч, запусков: ${stats.runs}`,
    webUrl ? `\n<a href="${escapeHtml(webUrl)}">Подробности</a>` : '',
  ].join('\n');
}

// Один проход: свежие удачные сделки плюс сводка, если её сегодня не слали.
export async function tick(stats, trades, webUrl) {
  if (!enabled) return;
  const seen = await loadSeen();
  let changed = false;

  const fresh = profitableSince(trades, seen.lastTradeTime);
  for (const t of fresh.slice(-10)) {
    if (await send(tradeMessage(t, stats.symbol))) {
      seen.lastTradeTime = t.time;
      changed = true;
    }
  }
  // Сдвигаем метку даже без отправок, иначе старые сделки будут проверяться вечно.
  const lastAny = trades.at(-1)?.time;
  if (lastAny && (!seen.lastTradeTime || lastAny > seen.lastTradeTime)) {
    seen.lastTradeTime = lastAny;
    changed = true;
  }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getHours() >= DIGEST_HOUR && seen.lastDigestDay !== today) {
    if (await send(digestMessage(stats, webUrl))) {
      seen.lastDigestDay = today;
      changed = true;
    }
  }

  if (changed) await saveSeen(seen);
}

export async function sendStartupNotice(stats, webUrl) {
  if (!enabled) return;
  await send([
    `🤖 <b>Наблюдение запущено</b>`,
    ``,
    `Инструмент: ${escapeHtml(stats.symbol)}, таймфрейм ${escapeHtml(stats.interval)}м`,
    `Стратегий: ${stats.bots.length}`,
    `Порог оповещения: от +${MIN_PNL} %`,
    `Сводка: ежедневно после ${DIGEST_HOUR}:00`,
    webUrl ? `\n<a href="${escapeHtml(webUrl)}">Панель</a>` : '',
  ].join('\n'));
}
