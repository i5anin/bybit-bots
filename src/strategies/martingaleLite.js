// Упрощённый Мартингейл: покупка на падении, продажа на возврате к точке входа + профит.
const DROP_PCT = 1; // % падения для усреднения/входа
const TAKE_PROFIT_PCT = 1;
const STALE_SEC = 30 * 60; // после такого простоя опорная цена считается устаревшей

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

    // Опорная цена переживает рестарт — иначе шаг мартингейла считался бы заново.
    toJSON() {
      return { referencePrice, inPosition };
    },

    // ctx описывает реальное состояние на момент возобновления: позиция берётся
    // из леджера, а опорная цена после долгого простоя — текущая рыночная,
    // иначе сигнал считался бы от устаревшего уровня.
    restore(snapshot, ctx) {
      inPosition = Boolean(ctx?.inPosition);

      if (inPosition && Number.isFinite(ctx?.entryPrice) && ctx.entryPrice > 0) {
        referencePrice = ctx.entryPrice;
        return;
      }
      const stale = (ctx?.downtimeSec ?? 0) > STALE_SEC;
      referencePrice = !stale && Number.isFinite(snapshot?.referencePrice)
        ? snapshot.referencePrice
        : ctx?.price ?? null;
    },
  };
}
