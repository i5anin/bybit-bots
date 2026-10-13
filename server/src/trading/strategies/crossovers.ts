import { closes, ema, sma } from '../indicators.js';
import type { Action, Strategy } from '../types.js';

type Average = (values: readonly number[], period: number) => number | null;

// Пересечение быстрой и медленной средней на последней закрытой свече.
function crossover(values: number[], average: Average, fastPeriod: number, slowPeriod: number): Action {
  const fast = average(values, fastPeriod);
  const slow = average(values, slowPeriod);
  const prevFast = average(values.slice(0, -1), fastPeriod);
  const prevSlow = average(values.slice(0, -1), slowPeriod);
  if (fast == null || slow == null || prevFast == null || prevSlow == null) return 'hold';
  if (prevFast <= prevSlow && fast > slow) return 'buy';
  if (prevFast >= prevSlow && fast < slow) return 'sell';
  return 'hold';
}

export function smaCrossover(): Strategy {
  return {
    name: 'SMA Crossover (10/30)',
    signal: candles => crossover(closes(candles), sma, 10, 30),
  };
}

export function emaCrossover(): Strategy {
  return {
    name: 'EMA Crossover (9/21)',
    signal: candles => crossover(closes(candles), ema, 9, 21),
  };
}
