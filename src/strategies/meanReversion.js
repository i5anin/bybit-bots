import { closes, sma, stdDev } from './utils.js';

export function createStrategy() {
  return {
    name: 'Mean Reversion (Z-score 20)',
    signal(candles) {
      const c = closes(candles);
      if (c.length < 20) return 'hold';
      const mean = sma(c, 20);
      const dev = stdDev(c, 20);
      if (dev === 0) return 'hold';
      const z = (c[c.length - 1] - mean) / dev;
      if (z < -1.5) return 'buy';
      if (z > 1.5) return 'sell';
      return 'hold';
    },
  };
}
