import { closes, rsi } from './utils.js';

export function createStrategy() {
  return {
    name: 'RSI (14, 30/70)',
    signal(candles) {
      const c = closes(candles);
      const value = rsi(c, 14);
      if (value == null) return 'hold';
      if (value < 30) return 'buy';
      if (value > 70) return 'sell';
      return 'hold';
    },
  };
}
