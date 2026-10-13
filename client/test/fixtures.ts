import type { BotStats, Stats } from '../src/types';

export function bot(overrides: Partial<BotStats> = {}): BotStats {
  return {
    name: 'Stochastic Oscillator (14, 20/80)',
    isMeta: false,
    equity: 12.5,
    pnlPct: 4.35,
    equityRub: 1062.5,
    pnlRubPct: 6.25,
    cash: 7.5,
    position: 53.5,
    entryPrice: 0.0935,
    trades: 104,
    fees: 0.21,
    leader: null,
    spark: [12, 12.2, 12.5],
    ...overrides,
  };
}

export function stats(overrides: Partial<Stats> = {}): Stats {
  return {
    updatedAt: '2026-10-13T09:00:00.000Z',
    status: 'running',
    ageSec: 20,
    running: true,
    symbol: 'DOGEUSDT',
    baseAsset: 'DOGE',
    interval: '5',
    price: 0.08454,
    rubPerUsd: 85,
    rateSource: 'ЦБ РФ',
    startBalance: 11.98,
    startRub: 1000,
    feePct: 0.1,
    slippagePct: 0.02,
    runs: 3,
    uptimeSecTotal: 748_018,
    ticks: 819,
    bots: [
      bot(),
      bot({ name: 'Авто-выбор лучшей (11)', isMeta: true, leader: 'Donchian Breakout (20)', equityRub: 981.7, pnlPct: -3.49, pnlRubPct: -1.83, position: 0 }),
    ],
    totals: {
      equity: 24.1,
      equityRub: 2044.2,
      invested: 23.96,
      investedRub: 2000,
      position: 53.5,
      inProfit: 1,
      tradesTotal: 790,
      tradesClosed: 390,
      winRatePct: 28.5,
    },
    lastTrades: [
      { time: '2026-10-13T08:55:00.000Z', symbol: 'DOGEUSDT', bot: 'MACD (12/26/9)', side: 'sell', price: '0.08461', pnlPct: '-0.31', runId: 'r' },
      { time: '2026-10-13T08:50:00.000Z', symbol: 'DOGEUSDT', bot: 'MACD (12/26/9)', side: 'buy', price: '0.0845', pnlPct: '', runId: 'r' },
    ],
    ...overrides,
  };
}
