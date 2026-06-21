import { closes, sma, stdDev } from './utils.js';

export function createStrategy() {
  return {
    name: 'Bollinger Bands (20, 2σ)',
    signal(candles) {
      const c = closes(candles);
      if (c.length < 20) return 'hold';
      const mean = sma(c, 20);
      const dev = stdDev(c, 20);
      const price = c[c.length - 1];
      const lower = mean - 2 * dev;
      const upper = mean + 2 * dev;
      if (price < lower) return 'buy';
      if (price > upper) return 'sell';
      return 'hold';
    },
  };
}
