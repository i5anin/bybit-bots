// Чтение результатов ботов из файлов, которые пишет основной процесс.
// Своего состояния не держит: источник истины — data/state.json и logs/*.csv.
import { readFile } from 'node:fs/promises';

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const LOGS_DIR = process.env.LOGS_DIR || '/app/logs';

async function readTextOrNull(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null; // файла ещё нет — бот не отработал ни одного тика
  }
}

// Парсер под наш формат: запятая, без экранирования кроме кавычек в note.
function parseCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const head = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cells = splitRow(line);
    return Object.fromEntries(head.map((k, i) => [k, cells[i] ?? '']));
  });
}

function splitRow(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export async function readState() {
  const raw = await readTextOrNull(`${DATA_DIR}/state.json`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null; // состояние пишется атомарно, но подстраховка дешевле сбоя
  }
}

export async function readTrades() {
  const raw = await readTextOrNull(`${LOGS_DIR}/trades.csv`);
  return raw ? parseCsv(raw) : [];
}

export async function readEquity() {
  const raw = await readTextOrNull(`${LOGS_DIR}/equity.csv`);
  return raw ? parseCsv(raw) : [];
}

export async function readRuns() {
  const raw = await readTextOrNull(`${LOGS_DIR}/runs.csv`);
  return raw ? parseCsv(raw) : [];
}

// История доходности по каждому боту, прорежённая до points значений:
// на графике-искре больше не видно, а объём ответа падает в десятки раз.
function sparkByBot(equity, points = 60) {
  const byBot = new Map();
  for (const row of equity) {
    const v = Number(row.equity);
    if (!row.bot || !Number.isFinite(v)) continue;
    if (!byBot.has(row.bot)) byBot.set(row.bot, []);
    byBot.get(row.bot).push(v);
  }
  const out = {};
  for (const [bot, series] of byBot) {
    const step = Math.max(1, Math.ceil(series.length / points));
    out[bot] = series.filter((_, i) => i % step === 0).slice(-points);
  }
  return out;
}

export function buildStats(state, equity, trades, runs) {
  const startBalance = state?.startBalance ?? 100;
  const spark = sparkByBot(equity);
  const lastPrice = lastFinite(equity.map(r => Number(r.price)));

  const bots = Object.entries(state?.bots ?? {}).map(([name, b]) => {
    const led = b?.ledger ?? {};
    const price = Number(led.lastPrice) || lastPrice || 0;
    const value = (Number(led.cash) || 0) + (Number(led.position) || 0) * price;
    return {
      name,
      equity: round(value, 4),
      pnlPct: round(((value - startBalance) / startBalance) * 100, 2),
      position: Number(led.position) || 0,
      entryPrice: Number(led.entryPrice) || null,
      trades: Number(led.tradeCount) || 0,
      spark: spark[name] ?? [],
    };
  });

  bots.sort((a, b) => b.equity - a.equity);

  const closed = trades.filter(t => t.pnlPct !== '' && t.pnlPct != null);
  const wins = closed.filter(t => Number(t.pnlPct) > 0);

  return {
    updatedAt: state?.updatedAt ?? null,
    symbol: state?.symbol ?? process.env.SYMBOL ?? 'BTCUSDT',
    interval: state?.interval ?? process.env.INTERVAL ?? '5',
    startBalance,
    price: lastPrice,
    runs: state?.runs ?? 0,
    uptimeSecTotal: state?.uptimeSecTotal ?? 0,
    ticks: state?.currentRun?.ticks ?? state?.lastRun?.ticks ?? 0,
    running: Boolean(state?.currentRun),
    bots,
    totals: {
      equity: round(bots.reduce((s, b) => s + b.equity, 0), 2),
      invested: round(startBalance * bots.length, 2),
      inProfit: bots.filter(b => b.pnlPct > 0).length,
      tradesTotal: trades.length,
      tradesClosed: closed.length,
      winRatePct: closed.length ? round((wins.length / closed.length) * 100, 1) : null,
    },
    lastTrades: trades.slice(-25).reverse(),
    lastRuns: runs.slice(-10).reverse(),
  };
}

function lastFinite(values) {
  for (let i = values.length - 1; i >= 0; i--) {
    if (Number.isFinite(values[i])) return values[i];
  }
  return null;
}

function round(v, digits) {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

export async function collect() {
  const [state, equity, trades, runs] = await Promise.all([
    readState(), readEquity(), readTrades(), readRuns(),
  ]);
  return buildStats(state, equity, trades, runs);
}
