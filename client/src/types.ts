// Ответы API — зеркало server/src/stats/stats.types.ts.
// При изменении правьте обе копии.

export type BotRunStatus = 'running' | 'stale' | 'stopped';

export interface FeedStatus {
  source: 'поток' | 'опрос';
  streamConnected: boolean;
  lagSec: number | null;
  fetchMs: number | null;
  staleSkips: number;
}

export interface BotStats {
  key: string;
  symbol: string;
  name: string;
  isMeta: boolean;
  equity: number;
  pnlPct: number;
  equityRub: number;
  pnlRub: number;
  pnlRubPct: number;
  aprPct: number | null;
  cash: number;
  position: number;
  entryPrice: number | null;
  trades: number;
  fees: number;
  leader: string | null;
  spark: number[];
}

export interface GroupStats {
  name: string;
  isMeta: boolean;
  bots: number;
  equityRub: number;
  investedRub: number;
  pnlRub: number;
  pnlPct: number;
  aprPct: number | null;
  inPlus: number;
  beatsBank: number;
  inMarket: number;
  trades: number;
  best: { name: string; pnlRub: number } | null;
  worst: { name: string; pnlRub: number } | null;
}

export interface PairStats extends GroupStats {
  price: number | null;
  minOrderUsdt: number | null;
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
  symbols: string[];
  baseAsset: string;
  interval: string;
  price: number | null;
  rubPerUsd: number;
  rateSource: string;
  startBalance: number;
  startRub: number;
  orderPct: number;
  orderRub: number;
  enforceMinOrder: boolean;
  bankRatePct: number;
  sessionStartedAt: string | null;
  sessionDays: number | null;
  feePct: number | null;
  slippagePct: number | null;
  feed: FeedStatus | null;
  runs: number;
  uptimeSecTotal: number;
  ticks: number;
  bots: BotStats[];
  strategies: GroupStats[];
  pairs: PairStats[];
  totals: GroupStats & { tradesTotal: number; tradesClosed: number; winRatePct: number | null };
  lastTrades: TradeRow[];
}

export interface PairDetail {
  symbol: string;
  pair: PairStats | null;
  bots: BotStats[];
  trades: TradeRow[];
}
