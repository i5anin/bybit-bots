// Рейтинг пар спота по волатильности: размах цены за 24 часа, (max − min) / min.
// Только пары к USDT с оборотом от minTurnover: на неликвидных минимальный
// ордер исполнялся бы заметно хуже цены из тикера.

export interface Ticker {
  symbol: string;
  lastPrice: number;
  highPrice24h: number;
  lowPrice24h: number;
  price24hPcnt: number; // доля, 0.05 = +5 %
  turnover24h: number; // USDT
}

export interface VolatilityRow {
  symbol: string;
  rangePct: number;
  changePct: number;
  price: number;
  turnover: number;
}

// Стейблкоины, золото и обёртки над BTC/ETH/SOL: их «волатильность» —
// шум, торговать на ней нечего.
const EXCLUDED = new Set([
  'USDC', 'USDE', 'DAI', 'FDUSD', 'TUSD', 'PYUSD', 'USDD', 'USD1', 'USDT0', 'EURC', 'RLUSD', 'USDQ', 'BUSD',
  'USDR', 'XUSD', 'USDG', 'FRAX', 'AUSD', 'EURI', 'PAXG', 'XAUT', 'WBTC', 'STETH', 'WSTETH', 'CMETH', 'METH',
  'BBSOL', 'BNSOL', 'JITOSOL', 'MSOL', 'SSOL', 'EETH', 'WETH', 'CBBTC', 'LBTC',
]);
const LEVERAGED = /\d[LS]$/; // BTC3L, ETH2S — токены с плечом

export function rankVolatility(tickers: readonly Ticker[], { minTurnover = 1e6, limit = 100 } = {}): VolatilityRow[] {
  return tickers
    .filter(t => {
      if (!t.symbol.endsWith('USDT')) return false;
      const base = t.symbol.slice(0, -4);
      return !EXCLUDED.has(base) && !LEVERAGED.test(base) && t.lowPrice24h > 0 && t.turnover24h >= minTurnover;
    })
    .map(t => ({
      symbol: t.symbol,
      rangePct: ((t.highPrice24h - t.lowPrice24h) / t.lowPrice24h) * 100,
      changePct: t.price24hPcnt * 100,
      price: t.lastPrice,
      turnover: t.turnover24h,
    }))
    .sort((a, b) => b.rangePct - a.rangePct)
    .slice(0, limit);
}
