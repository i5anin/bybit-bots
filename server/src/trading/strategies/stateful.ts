import type { Strategy, StrategyContext } from '../types.js';

// Упрощённый Мартингейл: покупка на падении, продажа на возврате к точке входа + профит.
const DROP_PCT = 1; // % падения для входа
const TAKE_PROFIT_PCT = 1;
const STALE_SEC = 30 * 60; // после такого простоя опорная цена считается устаревшей

interface MartingaleState {
  referencePrice: number | null;
  inPosition: boolean;
}

export function martingaleLite(): Strategy {
  let referencePrice: number | null = null;
  let inPosition = false;

  return {
    name: 'Martingale-lite (1% шаг)',
    signal(candles) {
      const price = candles[candles.length - 1]!.close;
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
    toJSON(): MartingaleState {
      return { referencePrice, inPosition };
    },

    // Позиция берётся из леджера, а опорная цена после долгого простоя — текущая
    // рыночная, иначе сигнал считался бы от устаревшего уровня.
    restore(snapshot: unknown, ctx: StrategyContext) {
      const saved = snapshot as Partial<MartingaleState> | null;
      inPosition = Boolean(ctx.inPosition);

      if (inPosition && Number.isFinite(ctx.entryPrice) && ctx.entryPrice > 0) {
        referencePrice = ctx.entryPrice;
        return;
      }
      const stale = (ctx.downtimeSec ?? 0) > STALE_SEC;
      referencePrice = !stale && typeof saved?.referencePrice === 'number' && Number.isFinite(saved.referencePrice)
        ? saved.referencePrice
        : ctx.price ?? null;
    },

    // Сделка не исполнилась (не хватило на минимальный ордер): позицию берём
    // из леджера, иначе стратегия ждала бы продажи того, чего не покупала.
    sync(ctx: StrategyContext) {
      inPosition = Boolean(ctx.inPosition);
    },
  };
}

// Сеточная стратегия: покупка/продажа при пересечении соседних уровней сетки.
// В движок не включена: рядом с Martingale-lite ничего не добавляет.
const GRID_STEP_PCT = 0.5;

export function grid(): Strategy {
  let basePrice: number | null = null;
  let lastLevel = 0;

  return {
    name: 'Grid (0.5% шаг)',
    signal(candles) {
      const price = candles[candles.length - 1]!.close;
      if (basePrice == null) {
        basePrice = price;
        return 'hold';
      }
      const level = Math.round((price / basePrice - 1) * 100 / GRID_STEP_PCT);
      if (level === lastLevel) return 'hold';
      const action = level < lastLevel ? 'buy' : 'sell';
      lastLevel = level;
      return action;
    },
  };
}
