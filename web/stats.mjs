// Чтение результатов ботов из файлов, которые пишет основной процесс.
// Источник истины — data/state.json и logs/*.csv; в памяти держим только
// уже прочитанную часть логов, чтобы не разбирать их заново на каждый запрос.
import { readFile } from 'node:fs/promises';
import { createCsvTail, DecimatedSeries } from './csvTail.mjs';

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const LOGS_DIR = process.env.LOGS_DIR || '/app/logs';
// Старт счёта в рублях. Пересчёт по сегодняшнему курсу показывал бы «из 1017 ₽»
// при заявленных 1000: курс за неделю сдвинулся, а вложено было ровно 1000.
const START_RUB = Number(process.env.START_RUB || 0);
const SPARK_POINTS = 60;

export async function readState() {
  let raw;
  try {
    raw = await readFile(`${DATA_DIR}/state.json`, 'utf8');
  } catch {
    return null; // файла ещё нет — бот не отработал ни одного тика
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null; // состояние пишется атомарно, но подстраховка дешевле сбоя
  }
}

// Накопители логов: equity — прорежённые ряды по ботам, сделки и запуски — целиком
// (их на порядки меньше).
const equity = { series: new Map(), lastPrice: null };
const trades = [];
const runs = [];

const tails = {
  equity: createCsvTail(`${LOGS_DIR}/equity.csv`, {
    onRows: rows => addEquity(equity, rows),
    onReset: () => { equity.series.clear(); equity.lastPrice = null; },
  }),
  trades: createCsvTail(`${LOGS_DIR}/trades.csv`, {
    onRows: rows => trades.push(...rows),
    onReset: () => { trades.length = 0; },
  }),
  runs: createCsvTail(`${LOGS_DIR}/runs.csv`, {
    onRows: rows => runs.push(...rows),
    onReset: () => { runs.length = 0; },
  }),
};

export function addEquity(acc, rows) {
  for (const row of rows) {
    const v = Number(row.equity);
    if (!row.bot || !Number.isFinite(v)) continue;
    if (!acc.series.has(row.bot)) acc.series.set(row.bot, new DecimatedSeries());
    acc.series.get(row.bot).push(v);
    const price = Number(row.price);
    if (Number.isFinite(price)) acc.lastPrice = price;
  }
  return acc;
}

export async function readTrades() {
  await tails.trades();
  return trades;
}

// Курс рубля к доллару по ЦБ: USDT считаем равным доллару. Обновляется раз в час,
// при недоступности ЦБ остаётся прошлое значение или RUB_PER_USDT из окружения.
const RATE_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';
let rubRate = { value: Number(process.env.RUB_PER_USDT || 85), at: 0, source: 'env' };

async function rubPerUsd() {
  if (Date.now() - rubRate.at < 3600_000) return rubRate;
  try {
    const res = await fetch(RATE_URL, { signal: AbortSignal.timeout(5000) });
    const v = Number((await res.json())?.Valute?.USD?.Value);
    if (Number.isFinite(v) && v > 0) rubRate = { value: v, at: Date.now(), source: 'ЦБ РФ' };
    else rubRate.at = Date.now();
  } catch {
    rubRate.at = Date.now() - 3000_000; // повтор через 10 минут
  }
  return rubRate;
}

// Мета-бот помечен в состоянии флагом meta; у старых снимков флага нет,
// но есть поле leader, которое бывает только у него.
function isMeta(snapshot) {
  return snapshot?.meta === true || Object.hasOwn(snapshot ?? {}, 'leader');
}

export function buildStats({
  state, equity: eq, trades: tradeRows = [], runs: runRows = [], rate = rubRate, startRub = START_RUB,
}) {
  const startBalance = state?.startBalance ?? 100;
  const lastPrice = eq?.lastPrice ?? null;
  // Рублёвая доходность считается от фиксированного старта, долларовая — от startBalance.
  const startRubValue = startRub > 0 ? startRub : startBalance * rate.value;

  const bots = Object.entries(state?.bots ?? {}).map(([name, b]) => {
    const led = b?.ledger ?? {};
    const price = Number(led.lastPrice) || lastPrice || 0;
    const value = (Number(led.cash) || 0) + (Number(led.position) || 0) * price;
    const valueRub = value * rate.value;
    return {
      name,
      isMeta: isMeta(b),
      equity: round(value, 4),
      pnlPct: round(((value - startBalance) / startBalance) * 100, 2),
      equityRub: round(valueRub, 2),
      pnlRubPct: round((valueRub / startRubValue - 1) * 100, 2),
      cash: round(Number(led.cash) || 0, 4),
      position: Number(led.position) || 0,
      entryPrice: Number(led.entryPrice) || null,
      trades: Number(led.tradeCount) || 0,
      fees: round(Number(led.feesPaid) || 0, 4),
      leader: b?.leader ?? null,
      spark: eq?.series?.get(name)?.sample(SPARK_POINTS) ?? [],
    };
  });

  bots.sort((a, b) => b.equity - a.equity);

  const closed = tradeRows.filter(t => t.pnlPct !== '' && t.pnlPct != null);
  const wins = closed.filter(t => Number(t.pnlPct) > 0);

  const symbol = state?.symbol ?? process.env.SYMBOL ?? 'BTCUSDT';
  const totalEquity = bots.reduce((s, b) => s + b.equity, 0);

  return {
    updatedAt: state?.updatedAt ?? null,
    baseAsset: symbol.replace(/USDT$/, ''),
    rubPerUsd: round(rate.value, 4),
    rateSource: rate.source,
    symbol,
    interval: state?.interval ?? process.env.INTERVAL ?? '5',
    startBalance,
    startRub: round(startRubValue, 2),
    price: lastPrice,
    runs: state?.runs ?? 0,
    uptimeSecTotal: state?.uptimeSecTotal ?? 0,
    ticks: state?.currentRun?.ticks ?? state?.lastRun?.ticks ?? 0,
    running: Boolean(state?.currentRun),
    bots,
    totals: {
      equity: round(totalEquity, 2),
      equityRub: round(totalEquity * rate.value, 2),
      invested: round(startBalance * bots.length, 2),
      investedRub: round(startRubValue * bots.length, 2),
      position: bots.reduce((s, b) => s + b.position, 0),
      inProfit: bots.filter(b => b.pnlPct > 0).length,
      tradesTotal: tradeRows.length,
      tradesClosed: closed.length,
      winRatePct: closed.length ? round((wins.length / closed.length) * 100, 1) : null,
    },
    lastTrades: tradeRows.slice(-25).reverse(),
    lastRuns: runRows.slice(-10).reverse(),
  };
}

function round(v, digits) {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

export async function collect() {
  const [state, rate] = await Promise.all([
    readState(), rubPerUsd(), tails.equity(), tails.trades(), tails.runs(),
  ]);
  return buildStats({ state, equity, trades, runs, rate });
}
