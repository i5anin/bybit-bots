import { closes, ema } from './utils.js';

const PERIODS = [5, 10, 15, 20, 25];

export function createStrategy() {
  return {
    name: 'EMA Ribbon (5/10/15/20/25)',
    signal(candles) {
      const c = closes(candles);
      const values = PERIODS.map(p => ema(c, p));
      if (values.some(v => v == null)) return 'hold';
      // Бычий веер: быстрая EMA выше медленных (ema5 > ema10 > ... > ema25)
      const bullish = values.every((v, i) => i === 0 || v <= values[i - 1]);
      const bearish = values.every((v, i) => i === 0 || v >= values[i - 1]);
      if (bullish) return 'buy';
      if (bearish) return 'sell';
      return 'hold';
    },
  };
}
