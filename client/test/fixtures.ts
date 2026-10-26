import type { BotStats, GroupStats, PairStats, Stats } from '../src/types';

export function bot(overrides: Partial<BotStats> = {}): BotStats {
  const symbol = overrides.symbol ?? 'ZKUSDT';
  const name = overrides.name ?? 'Stochastic Oscillator (14, 20/80)';
  return {
    key: `${symbol}:${name}`,
    symbol,
    name,
    isMeta: false,
    equity: 12.05,
    pnlPct: 0.6,
    equityRub: 1006.25,
    pnlRub: 6.25,
    pnlRubPct: 0.63,
    aprPct: 22.8,
    cash: 11.9,
    position: 1.2,
    entryPrice: 0.12,
    trades: 14,
    fees: 0.01,
    leader: null,
    spark: [12, 12.02, 12.05],
    ...overrides,
  };
}

export function group(overrides: Partial<GroupStats> = {}): GroupStats {
  return {
    name: 'Stochastic Oscillator (14, 20/80)',
    isMeta: false,
    bots: 2,
    equityRub: 2004.5,
    investedRub: 2000,
    pnlRub: 4.5,
    pnlPct: 0.23,
    aprPct: 18.4,
    inPlus: 1,
    beatsBank: 1,
    inMarket: 1,
    trades: 30,
    feesUsd: 0.02,
    feesShareOfIncomePct: 25,
    best: { name: 'ZKUSDT', pnlRub: 6.25 },
    worst: { name: 'TIAUSDT', pnlRub: -1.75 },
    ...overrides,
  };
}

export function pair(overrides: Partial<PairStats> = {}): PairStats {
  return {
    ...group({ name: 'ZKUSDT', best: { name: 'Stochastic Oscillator (14, 20/80)', pnlRub: 6.25 } }),
    price: 0.1234,
    minOrderUsdt: 5,
    ...overrides,
  };
}

export function stats(overrides: Partial<Stats> = {}): Stats {
  const bots = [
    bot(),
    bot({ symbol: 'TIAUSDT', name: 'MACD (12/26/9)', equityRub: 998.25, pnlRub: -1.75, aprPct: -6.4, position: 0 }),
    bot({ name: 'Авто-выбор лучшей (11)', isMeta: true, leader: 'Stochastic Oscillator (14, 20/80)', pnlRub: 0.4, aprPct: 1.5 }),
  ];
  return {
    updatedAt: '2026-10-19T09:00:00.000Z',
    status: 'running',
    ageSec: 20,
    running: true,
    symbol: 'ZKUSDT',
    symbols: ['ZKUSDT', 'TIAUSDT'],
    baseAsset: '',
    interval: '5',
    price: null,
    rubPerUsd: 83.6,
    rateSource: 'ЦБ РФ',
    startBalance: 11.98,
    startRub: 1000,
    orderPct: 1,
    orderRub: 10,
    enforceMinOrder: false,
    bankRatePct: 16,
    sessionStartedAt: '2026-10-17T09:00:00.000Z',
    sessionDays: 2,
    feePct: 0.1,
    slippagePct: 0.02,
    feed: { source: 'поток', streamConnected: true, lagSec: 0.4, fetchMs: 180, staleSkips: 0 },
    runs: 1,
    uptimeSecTotal: 172_800,
    ticks: 2880,
    bots,
    strategies: [group(), group({ name: 'Авто-выбор лучшей (11)', isMeta: true, pnlRub: 0.4, aprPct: 1.5 })],
    pairs: [pair(), pair({ name: 'TIAUSDT', pnlRub: -1.75, aprPct: -6.4, price: 0.98 })],
    totals: {
      ...group({ name: 'Все боты', bots: 3, equityRub: 3010.75, investedRub: 3000, pnlRub: 10.75, aprPct: 13.1, beatsBank: 1, inPlus: 2 }),
      tradesTotal: 44,
      tradesClosed: 20,
      winRatePct: 55,
    },
    lastTrades: [
      { time: '2026-10-19T08:55:00.000Z', symbol: 'TIAUSDT', bot: 'MACD (12/26/9)', side: 'sell', price: '0.98', pnlPct: '-0.31', runId: 'r' },
      { time: '2026-10-19T08:50:00.000Z', symbol: 'ZKUSDT', bot: 'MACD (12/26/9)', side: 'buy', price: '0.1234', pnlPct: '', runId: 'r' },
    ],
    ...overrides,
  };
}
