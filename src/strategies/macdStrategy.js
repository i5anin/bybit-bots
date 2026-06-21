import { closes, emaSeries } from './utils.js';

export function createStrategy() {
  return {
    name: 'MACD (12/26/9)',
    signal(candles) {
      const c = closes(candles);
      const fastSeries = emaSeries(c, 12);
      const slowSeries = emaSeries(c, 26);
      if (fastSeries.length < 2 || slowSeries.length < 2) return 'hold';

      const offset = fastSeries.length - slowSeries.length;
      const macdSeries = slowSeries.map((slowVal, i) => fastSeries[i + offset] - slowVal);
      if (macdSeries.length < 10) return 'hold';

      const signalSeries = emaSeries(macdSeries, 9);
      if (signalSeries.length < 2) return 'hold';

      const histNow = macdSeries[macdSeries.length - 1] - signalSeries[signalSeries.length - 1];
      const histPrev = macdSeries[macdSeries.length - 2] - signalSeries[signalSeries.length - 2];

      if (histPrev <= 0 && histNow > 0) return 'buy';
      if (histPrev >= 0 && histNow < 0) return 'sell';
      return 'hold';
    },
  };
}
