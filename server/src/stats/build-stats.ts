import type { DecimatedSeries } from '../storage/csv-tail.js';
import type { EngineState } from '../trading/types.js';
import type { BotRunStatus, BotStats, RunRow, Stats, TradeRow } from './stats.types.js';

const SPARK_POINTS = 60;

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

// Мета-бот помечен в состоянии флагом meta; у старых снимков флага нет,
// но есть поле leader, которое бывает только у него.
function isMeta(snapshot: object | undefined): boolean {
  if (!snapshot) return false;
  return (snapshot as { meta?: unknown }).meta === true || Object.hasOwn(snapshot, 'leader');
}

export interface BuildStatsInput {
  state: EngineState | null;
  equity: EquityHistory;
  trades: readonly TradeRow[];
  runs: readonly RunRow[];
  rate: Rate;
  startRub: number;
  staleSec: number;
  now?: number;
}

export function buildStats(input: BuildStatsInput): Stats {
  const { state, equity, trades, runs, rate, startRub, staleSec, now = Date.now() } = input;
  const startBalance = state?.startBalance ?? 100;
  const lastPrice = equity.lastPrice;
  // Рублёвая доходность — от фиксированного старта: пересчёт по сегодняшнему
  // курсу показывал бы «из 1017 ₽» при вложенных 1000.
  const startRubValue = startRub > 0 ? startRub : startBalance * rate.value;
  const run = botStatus(state, now, staleSec);

  const bots: BotStats[] = Object.entries(state?.bots ?? {}).map(([name, b]) => {
    const led = b?.ledger;
    const cash = num(led?.cash);
    const position = num(led?.position);
    const price = num(led?.lastPrice) || lastPrice || 0;
    const value = cash + position * price;
    const valueRub = value * rate.value;
    return {
      name,
      isMeta: isMeta(b),
      equity: round(value, 4),
      pnlPct: round(((value - startBalance) / startBalance) * 100, 2),
      equityRub: round(valueRub, 2),
      pnlRubPct: round((valueRub / startRubValue - 1) * 100, 2),
      cash: round(cash, 4),
      position,
      entryPrice: num(led?.entryPrice) || null,
      trades: num(led?.tradeCount),
      fees: round(num(led?.feesPaid), 4),
      leader: b?.leader ?? null,
      spark: equity.series.get(name)?.sample(SPARK_POINTS) ?? [],
    };
  });

  bots.sort((a, b) => b.equity - a.equity);

  const closed = trades.filter(t => t.pnlPct !== '' && t.pnlPct != null);
  const wins = closed.filter(t => Number(t.pnlPct) > 0);
  const symbol = state?.symbol ?? 'DOGEUSDT';
  const totalEquity = bots.reduce((s, b) => s + b.equity, 0);

  return {
    updatedAt: state?.updatedAt ?? null,
    ...run,
    running: run.status === 'running',
    symbol,
    baseAsset: symbol.replace(/USDT$/, ''),
    interval: state?.interval ?? '5',
    price: lastPrice,
    rubPerUsd: round(rate.value, 4),
    rateSource: rate.source,
    startBalance,
    startRub: round(startRubValue, 2),
    feePct: state?.feePct ?? null,
    feed: state?.feed ?? null,
    slippagePct: state?.slippagePct ?? null,
    runs: state?.runs ?? 0,
    uptimeSecTotal: state?.uptimeSecTotal ?? 0,
    ticks: state?.currentRun?.ticks ?? state?.lastRun?.ticks ?? 0,
    bots,
    totals: {
      equity: round(totalEquity, 2),
      equityRub: round(totalEquity * rate.value, 2),
      invested: round(startBalance * bots.length, 2),
      investedRub: round(startRubValue * bots.length, 2),
      position: bots.reduce((s, b) => s + b.position, 0),
      inProfit: bots.filter(b => b.pnlPct > 0).length,
      tradesTotal: trades.length,
      tradesClosed: closed.length,
      winRatePct: closed.length ? round((wins.length / closed.length) * 100, 1) : null,
    },
    lastTrades: trades.slice(-25).reverse(),
    lastRuns: runs.slice(-10).reverse(),
  };
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(v: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}
