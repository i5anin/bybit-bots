// Ответ GET /api/stats и /api/pair/:symbol. Клиент держит зеркальную копию
// этих типов в client/src/types.ts — при изменении правьте обе.

import type { FeedStatus } from '../trading/types.js';

export type BotRunStatus = 'running' | 'stale' | 'stopped';

// Один бот = пара × стратегия, свой счёт.
export interface BotStats {
  key: string; // ключ в state.json
  symbol: string;
  name: string;
  isMeta: boolean;
  equity: number;
  pnlPct: number;
  equityRub: number;
  pnlRub: number;
  pnlRubPct: number;
  aprPct: number | null; // % годовых с начала сессии
  cash: number;
  position: number;
  entryPrice: number | null;
  trades: number;
  fees: number;
  leader: string | null;
  spark: number[];
}

// Сводка по одной стратегии на всех парах или по одной паре на всех стратегиях.
export interface GroupStats {
  name: string;
  isMeta: boolean;
  bots: number;
  equityRub: number;
  investedRub: number;
  pnlRub: number;
  pnlPct: number;
  aprPct: number | null;
  inPlus: number; // ботов в плюсе
  beatsBank: number; // ботов, обгоняющих вклад
  inMarket: number;
  trades: number;
  // Комиссии биржи в долларах и их доля от дохода до комиссий, %.
  // null — до комиссий дохода не было: комиссии съели всё (и добавили минус).
  feesUsd: number;
  feesShareOfIncomePct: number | null;
  best: { name: string; pnlRub: number } | null;
  worst: { name: string; pnlRub: number } | null;
}

export interface PairStats extends GroupStats {
  price: number | null;
  minOrderUsdt: number | null; // минимальный ордер биржи по паре
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

export interface RunRow {
  time: string;
  event: string;
  runId: string;
  runUptimeSec: string;
  totalUptimeSec: string;
  ticks: string;
  note: string;
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
  orderRub: number; // ставка на сделку в рублях при стартовом счёте
  enforceMinOrder: boolean;
  bankRatePct: number; // ставка вклада — с ней сравниваются годовые
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
  totals: GroupStats & {
    tradesTotal: number;
    tradesClosed: number;
    winRatePct: number | null;
  };
  lastTrades: TradeRow[];
  lastRuns: RunRow[];
}

export interface PairDetail {
  symbol: string;
  pair: PairStats | null;
  bots: BotStats[];
  trades: TradeRow[];
}

export interface Health {
  ok: boolean;
  bot: BotRunStatus;
  ageSec: number | null;
  telegram: boolean;
}
