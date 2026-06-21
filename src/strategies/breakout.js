export function createStrategy() {
  return {
    name: 'Donchian Breakout (20)',
    signal(candles) {
      if (candles.length < 21) return 'hold';
      const prev = candles.slice(-21, -1);
      const last = candles[candles.length - 1];
      const high = Math.max(...prev.map(c => c.high));
      const low = Math.min(...prev.map(c => c.low));
      if (last.close > high) return 'buy';
      if (last.close < low) return 'sell';
      return 'hold';
    },
  };
}
