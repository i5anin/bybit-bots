// Упрощённый Мартингейл: покупка на падении, продажа на возврате к точке входа + профит.
const DROP_PCT = 1; // % падения для усреднения/входа
const TAKE_PROFIT_PCT = 1;

export function createStrategy() {
  let referencePrice = null;
  let inPosition = false;

  return {
    name: 'Martingale-lite (1% шаг)',
    signal(candles) {
      const price = candles[candles.length - 1].close;
      if (referencePrice == null) {
        referencePrice = price;
        return 'hold';
      }

      if (!inPosition) {
        const drop = (referencePrice - price) / referencePrice * 100;
        if (drop >= DROP_PCT) {
          inPosition = true;
          referencePrice = price;
          return 'buy';
        }
        return 'hold';
      }

      const gain = (price - referencePrice) / referencePrice * 100;
      if (gain >= TAKE_PROFIT_PCT) {
        inPosition = false;
        referencePrice = price;
        return 'sell';
      }
      return 'hold';
    },
  };
}
