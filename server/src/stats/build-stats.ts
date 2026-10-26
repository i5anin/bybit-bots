import type { DecimatedSeries } from '../storage/csv-tail.js';
import { minOrderUsdt } from '../trading/ledger.js';
import { parseBotKey } from '../trading/engine.service.js';
import type { EngineState } from '../trading/types.js';
import type { BotRunStatus, BotStats, GroupStats, PairStats, RunRow, Stats, TradeRow } from './stats.types.js';

const SPARK_POINTS = 60;
const DAY_MS = 86_400_000;
// Годовые за первые часы — шум вида «+3000 %»: считаем не раньше чем через 6 часов.
const MIN_DAYS_FOR_APR = 0.25;

export interface Rate {
  value: number;
  source: string;
}

export interface EquityHistory {
  series: Map<string, DecimatedSeries>;
  lastPrice: number | null;
}

// running — бот жив и пишет; stale — запуск не завершён штатно, но обновлений
// нет (завис, убит); stopped — остановлен штатно или ещё не запускался.
export function botStatus(
  state: Pick<EngineState, 'updatedAt' | 'currentRun'> | null,
  now: number,
  staleSec: number,
): { status: BotRunStatus; ageSec: number | null } {
  const updated = Date.parse(state?.updatedAt ?? '');
  const ageSec = Number.isFinite(updated) ? Math.max(0, Math.round((now - updated) / 1000)) : null;
  if (!state?.currentRun) return { status: 'stopped', ageSec };
  if (ageSec === null || ageSec > staleSec) return { status: 'stale', ageSec };
  return { status: 'running', ageSec };
}

// Простые годовые: доходность за срок, растянутая на год. Так считают вклады,
// поэтому с вкладом и сравниваем.
export function annualPct(pnlPct: number, days: number | null): number | null {
  if (days === null || days < MIN_DAYS_FOR_APR) return null;
  return (pnlPct * 365) / days;
}

// Мета-бот помечен в состоянии флагом meta; у старых снимков флага нет,
// но есть поле leader, которое бывает только у него.
function isMeta(snapshot: object | undefined): boolean {
  if (!snapshot) return false;
  return (snapshot as { meta?: unknown }).meta === true || Object.hasOwn(snapshot, 'leader');
}

// Сводка по группе ботов: сумма счетов, годовые, лучший и худший.
export function group(name: string, bots: readonly BotStats[], startRub: number, days: number | null, bankRatePct: number, label: (b: BotStats) => string): GroupStats {
  const equityRub = bots.reduce((s, b) => s + b.equityRub, 0);
  const investedRub = startRub * bots.length;
  const pnlRub = equityRub - investedRub;
  const pnlPct = investedRub ? (pnlRub / investedRub) * 100 : 0;
  const sorted = [...bots].sort((a, b) => b.pnlRub - a.pnlRub);
  const top = sorted[0];
  const bottom = sorted[sorted.length - 1];
  // Доход до комиссий = итог + комиссии (в рублях по курсу каждого бота).
  const feesUsd = bots.reduce((s, b) => s + b.fees, 0);
  const feesRub = bots.reduce((s, b) => s + (b.equity > 0 ? b.fees * b.equityRub / b.equity : 0), 0);
  const incomeBeforeFeesRub = pnlRub + feesRub;
  return {
    name,
    isMeta: bots.length > 0 && bots.every(b => b.isMeta),
    bots: bots.length,
    equityRub: round(equityRub, 2),
    investedRub: round(investedRub, 2),
    pnlRub: round(pnlRub, 2),
    pnlPct: round(pnlPct, 3),
    aprPct: nullableRound(annualPct(pnlPct, days), 1),
    inPlus: bots.filter(b => b.pnlRub > 0).length,
    beatsBank: bots.filter(b => b.aprPct !== null && b.aprPct > bankRatePct).length,
    inMarket: bots.filter(b => b.position > 0).length,
    trades: bots.reduce((s, b) => s + b.trades, 0),
    feesUsd: round(feesUsd, 4),
    feesShareOfIncomePct: incomeBeforeFeesRub > 0 ? round(feesRub / incomeBeforeFeesRub * 100, 1) : null,
    best: top ? { name: label(top), pnlRub: top.pnlRub } : null,
    worst: bottom && bots.length > 1 ? { name: label(bottom), pnlRub: bottom.pnlRub } : null,
  };
}

export interface BuildStatsInput {
  state: EngineState | null;
  equity: EquityHistory;
  trades: readonly TradeRow[];
  runs: readonly RunRow[];
  rate: Rate;
  startRub: number;
  staleSec: number;
  bankRatePct: number;
  now?: number;
}

export function buildStats(input: BuildStatsInput): Stats {
  const { state, equity, trades, runs, rate, startRub, staleSec, bankRatePct, now = Date.now() } = input;
  const startBalance = state?.startBalance ?? 100;
  const lastPrice = equity.lastPrice;
  // Рублёвая доходность — от фиксированного старта: пересчёт по сегодняшнему
  // курсу показывал бы «из 1017 ₽» при вложенных 1000.
  const startRubValue = startRub > 0 ? startRub : startBalance * rate.value;
  const run = botStatus(state, now, staleSec);
  const symbol = state?.symbol ?? 'DOGEUSDT';
  const symbols = state?.symbols ?? [symbol];
  const multi = symbols.length > 1;
  const sessionStart = Date.parse(state?.sessionStartedAt ?? '');
  const days = Number.isFinite(sessionStart) ? Math.max(0, (now - sessionStart) / DAY_MS) : null;
  const prices = new Map<string, number>();

  const bots: BotStats[] = Object.entries(state?.bots ?? {}).map(([key, b]) => {
    const { symbol: pair, name } = parseBotKey(key, symbol);
    const led = b?.ledger;
    const cash = num(led?.cash);
    const position = num(led?.position);
    const price = num(led?.lastPrice) || (pair === symbol ? lastPrice : null) || 0;
    if (num(led?.lastPrice)) prices.set(pair, num(led?.lastPrice));
    const value = cash + position * price;
    // Рубли — старт плюс заработок в долларах по курсу: иначе колебание курса
    // ЦБ выглядело бы прибылью (11.98 $ сегодня — не ровно 1000 ₽).
    const valueRub = startRubValue + (value - startBalance) * rate.value;
    const pnlRubPct = (valueRub / startRubValue - 1) * 100;
    return {
      key,
      symbol: pair,
      name,
      isMeta: isMeta(b),
      equity: round(value, 4),
      pnlPct: round(((value - startBalance) / startBalance) * 100, 3),
      equityRub: round(valueRub, 2),
      pnlRub: round(valueRub - startRubValue, 2),
      pnlRubPct: round(pnlRubPct, 3),
      aprPct: nullableRound(annualPct(pnlRubPct, days), 1),
      cash: round(cash, 4),
      position,
      entryPrice: num(led?.entryPrice) || null,
      trades: num(led?.tradeCount),
      fees: round(num(led?.feesPaid), 4),
      leader: b?.leader ?? null,
      // Ряды счёта по всем 1200 ботам раздули бы ответ — только для одной пары.
      spark: multi ? [] : sparkOf(equity, pair, name),
    };
  });
  bots.sort((a, b) => b.pnlRub - a.pnlRub);

  const byName = new Map<string, BotStats[]>();
  const byPair = new Map<string, BotStats[]>();
  for (const b of bots) {
    if (!byName.has(b.name)) byName.set(b.name, []);
    if (!byPair.has(b.symbol)) byPair.set(b.symbol, []);
    byName.get(b.name)!.push(b);
    byPair.get(b.symbol)!.push(b);
  }
  const base = (s: string) => s.replace(/USDT$/, '');
  const short = (s: string) => s.replace(/\s*\(.*\)\s*$/, '') || s;
  const strategies = [...byName].map(([name, list]) => group(name, list, startRubValue, days, bankRatePct, b => base(b.symbol)))
    .sort((a, b) => b.pnlRub - a.pnlRub);
  const pairs: PairStats[] = [...byPair].map(([pair, list]) => {
    const lot = state?.lots?.[pair];
    const price = prices.get(pair) ?? null;
    return {
      ...group(pair, list, startRubValue, days, bankRatePct, b => b.name),
      price,
      minOrderUsdt: lot && price ? round(minOrderUsdt(lot, price), 2) : null,
    };
  }).sort((a, b) => b.pnlRub - a.pnlRub);

  const closed = trades.filter(t => t.pnlPct !== '' && t.pnlPct != null);
  const wins = closed.filter(t => Number(t.pnlPct) > 0);
  const orderPct = state?.orderPct ?? 0;

  return {
    updatedAt: state?.updatedAt ?? null,
    ...run,
    running: run.status === 'running',
    symbol,
    symbols,
    baseAsset: multi ? '' : symbol.replace(/USDT$/, ''),
    interval: state?.interval ?? '5',
    price: multi ? null : prices.get(symbol) ?? lastPrice,
    rubPerUsd: round(rate.value, 4),
    rateSource: rate.source,
    startBalance,
    startRub: round(startRubValue, 2),
    orderPct,
    orderRub: round((startRubValue * orderPct) / 100, 2),
    enforceMinOrder: state?.enforceMinOrder ?? true,
    bankRatePct,
    sessionStartedAt: state?.sessionStartedAt ?? null,
    sessionDays: days === null ? null : round(days, 3),
    feePct: state?.feePct ?? null,
    slippagePct: state?.slippagePct ?? null,
    feed: state?.feed ?? null,
    runs: state?.runs ?? 0,
    uptimeSecTotal: state?.uptimeSecTotal ?? 0,
    ticks: state?.currentRun?.ticks ?? state?.lastRun?.ticks ?? 0,
    bots,
    strategies,
    pairs,
    totals: {
      ...group('Все боты', bots, startRubValue, days, bankRatePct,
        b => (multi ? `${base(b.symbol)} · ${short(b.name)}` : short(b.name))),
      tradesTotal: trades.length,
      tradesClosed: closed.length,
      winRatePct: closed.length ? round((wins.length / closed.length) * 100, 1) : null,
    },
    lastTrades: trades.slice(-25).reverse(),
    lastRuns: runs.slice(-10).reverse(),
  };
}

// Ряд счёта бота из equity.csv; ключ — «ПАРА:стратегия».
export function sparkOf(equity: EquityHistory, symbol: string, name: string): number[] {
  return equity.series.get(`${symbol}:${name}`)?.sample(SPARK_POINTS) ?? [];
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(v: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

function nullableRound(v: number | null, digits: number): number | null {
  return v === null ? null : round(v, digits);
}
