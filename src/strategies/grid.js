// Сеточная стратегия: покупка/продажа при пересечении соседних уровней сетки.
const STEP_PCT = 0.5; // шаг сетки, %

export function createStrategy() {
  let basePrice = null;
  let lastLevel = 0;

  return {
    name: 'Grid (0.5% шаг)',
    signal(candles) {
      const price = candles[candles.length - 1].close;
      if (basePrice == null) {
        basePrice = price;
        return 'hold';
      }
      const level = Math.round((price / basePrice - 1) * 100 / STEP_PCT);
      if (level === lastLevel) return 'hold';
      const action = level < lastLevel ? 'buy' : 'sell';
      lastLevel = level;
      return action;
    },
  };
}
