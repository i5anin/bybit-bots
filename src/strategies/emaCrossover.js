import { closes, ema } from './utils.js';

export function createStrategy() {
  return {
    name: 'EMA Crossover (9/21)',
    signal(candles) {
      const c = closes(candles);
      const fast = ema(c, 9);
      const slow = ema(c, 21);
      const prevFast = ema(c.slice(0, -1), 9);
      const prevSlow = ema(c.slice(0, -1), 21);
      if (fast == null || slow == null || prevFast == null || prevSlow == null) return 'hold';
      if (prevFast <= prevSlow && fast > slow) return 'buy';
      if (prevFast >= prevSlow && fast < slow) return 'sell';
      return 'hold';
    },
  };
}
