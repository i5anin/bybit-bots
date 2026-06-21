export function createStrategy() {
  return {
    name: 'Stochastic Oscillator (14, 20/80)',
    signal(candles) {
      if (candles.length < 14) return 'hold';
      const slice = candles.slice(-14);
      const high = Math.max(...slice.map(c => c.high));
      const low = Math.min(...slice.map(c => c.low));
      const close = slice[slice.length - 1].close;
      if (high === low) return 'hold';
      const k = ((close - low) / (high - low)) * 100;
      if (k < 20) return 'buy';
      if (k > 80) return 'sell';
      return 'hold';
    },
  };
}
