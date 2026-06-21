import { closes, sma } from './utils.js';

export function createStrategy() {
  return {
    name: 'SMA Crossover (10/30)',
    signal(candles) {
      const c = closes(candles);
      const fast = sma(c, 10);
      const slow = sma(c, 30);
      const prevFast = sma(c.slice(0, -1), 10);
      const prevSlow = sma(c.slice(0, -1), 30);
      if (fast == null || slow == null || prevFast == null || prevSlow == null) return 'hold';
      if (prevFast <= prevSlow && fast > slow) return 'buy';
      if (prevFast >= prevSlow && fast < slow) return 'sell';
      return 'hold';
    },
  };
}
