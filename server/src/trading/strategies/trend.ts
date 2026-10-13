import { closes, ema } from '../indicators.js';
import type { Strategy } from '../types.js';

export function donchianBreakout(): Strategy {
  return {
    name: 'Donchian Breakout (20)',
    signal(candles) {
      if (candles.length < 21) return 'hold';
      const prev = candles.slice(-21, -1);
      const last = candles[candles.length - 1]!;
      const high = Math.max(...prev.map(c => c.high));
      const low = Math.min(...prev.map(c => c.low));
      if (last.close > high) return 'buy';
      if (last.close < low) return 'sell';
      return 'hold';
    },
  };
}

const RIBBON = [5, 10, 15, 20, 25];

export function emaRibbon(): Strategy {
  return {
    name: 'EMA Ribbon (5/10/15/20/25)',
    signal(candles) {
      const c = closes(candles);
      const values = RIBBON.map(p => ema(c, p));
      if (values.some(v => v == null)) return 'hold';
      const v = values as number[];
      // Бычий веер: быстрая EMA выше медленных (ema5 > ema10 > ... > ema25).
      // Сравнение строгое: на ровном рынке все EMA равны, и нестрогое условие
      // объявляло веер бычьим и медвежьим сразу — с покупкой.
      const bullish = v.every((x, i) => i === 0 || x < v[i - 1]!);
      const bearish = v.every((x, i) => i === 0 || x > v[i - 1]!);
      if (bullish) return 'buy';
      if (bearish) return 'sell';
      return 'hold';
    },
  };
}
