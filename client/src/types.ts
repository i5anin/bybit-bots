// Ответ GET /api/stats — зеркало server/src/stats/stats.types.ts.
// При изменении правьте обе копии.

export type BotRunStatus = 'running' | 'stale' | 'stopped';

export interface BotStats {
  name: string;
  isMeta: boolean;
  equity: number;
  pnlPct: number;
  equityRub: number;
  pnlRubPct: number;
  cash: number;
  position: number;
  entryPrice: number | null;
  trades: number;
  fees: number;
  leader: string | null;
  spark: number[];
}

export interface TradeRow {
  time: string;
  symbol: string;
  bot: string;
  side: string;
  price: string;
  pnlPct: string;
  runId: string;
}

export interface Stats {
  updatedAt: string | null;
  status: BotRunStatus;
  ageSec: number | null;
  running: boolean;
  symbol: string;
  baseAsset: string;
  interval: string;
  price: number | null;
  rubPerUsd: number;
  rateSource: string;
  startBalance: number;
  startRub: number;
  feePct: number | null;
  slippagePct: number | null;
  runs: number;
  uptimeSecTotal: number;
  ticks: number;
  bots: BotStats[];
  totals: {
    equity: number;
    equityRub: number;
    invested: number;
    investedRub: number;
    position: number;
    inProfit: number;
    tradesTotal: number;
    tradesClosed: number;
    winRatePct: number | null;
  };
  lastTrades: TradeRow[];
}
