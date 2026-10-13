import { closes, emaSeries, rsi as rsiValue, sma, stdDev } from '../indicators.js';
import type { Strategy } from '../types.js';

export function rsi(): Strategy {
  return {
    name: 'RSI (14, 30/70)',
    signal(candles) {
      const value = rsiValue(closes(candles), 14);
      if (value == null) return 'hold';
      if (value < 30) return 'buy';
      if (value > 70) return 'sell';
      return 'hold';
    },
  };
}

export function macd(): Strategy {
  return {
    name: 'MACD (12/26/9)',
    signal(candles) {
      const c = closes(candles);
      const fastSeries = emaSeries(c, 12);
      const slowSeries = emaSeries(c, 26);
      if (fastSeries.length < 2 || slowSeries.length < 2) return 'hold';

      const offset = fastSeries.length - slowSeries.length;
      const macdSeries = slowSeries.map((slowVal, i) => fastSeries[i + offset]! - slowVal);
      if (macdSeries.length < 10) return 'hold';

      const signalSeries = emaSeries(macdSeries, 9);
      if (signalSeries.length < 2) return 'hold';

      const histNow = macdSeries[macdSeries.length - 1]! - signalSeries[signalSeries.length - 1]!;
      const histPrev = macdSeries[macdSeries.length - 2]! - signalSeries[signalSeries.length - 2]!;

      if (histPrev <= 0 && histNow > 0) return 'buy';
      if (histPrev >= 0 && histNow < 0) return 'sell';
      return 'hold';
    },
  };
}

export function bollingerBands(): Strategy {
  return {
    name: 'Bollinger Bands (20, 2σ)',
    signal(candles) {
      const c = closes(candles);
      if (c.length < 20) return 'hold';
      const mean = sma(c, 20)!;
      const dev = stdDev(c, 20);
      const price = c[c.length - 1]!;
      if (price < mean - 2 * dev) return 'buy';
      if (price > mean + 2 * dev) return 'sell';
      return 'hold';
    },
  };
}

export function stochastic(): Strategy {
  return {
    name: 'Stochastic Oscillator (14, 20/80)',
    signal(candles) {
      if (candles.length < 14) return 'hold';
      const slice = candles.slice(-14);
      const high = Math.max(...slice.map(c => c.high));
      const low = Math.min(...slice.map(c => c.low));
      const close = slice[slice.length - 1]!.close;
      if (high === low) return 'hold';
      const k = ((close - low) / (high - low)) * 100;
      if (k < 20) return 'buy';
      if (k > 80) return 'sell';
      return 'hold';
    },
  };
}

export function meanReversion(): Strategy {
  return {
    name: 'Mean Reversion (Z-score 20)',
    signal(candles) {
      const c = closes(candles);
      if (c.length < 20) return 'hold';
      const mean = sma(c, 20)!;
      const dev = stdDev(c, 20);
      if (dev === 0) return 'hold';
      const z = (c[c.length - 1]! - mean) / dev;
      if (z < -1.5) return 'buy';
      if (z > 1.5) return 'sell';
      return 'hold';
    },
  };
}
