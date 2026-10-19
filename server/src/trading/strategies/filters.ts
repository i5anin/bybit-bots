import { closes, sma } from '../indicators.js';
import type { StrategyFactory } from '../types.js';

// Фильтр тренда: покупка запрещена, пока цена ниже средней за period свечей,
// — бот не входит в сделку на падающем рынке. Продажи не трогает.
export function withTrendFilter(factory: StrategyFactory, period = 100): StrategyFactory {
  return () => {
    const inner = factory();
    return {
      name: `${inner.name} + тренд`,
      signal(candles) {
        const action = inner.signal(candles);
        if (action !== 'buy') return action;
        const avg = sma(closes(candles), Math.min(period, candles.length));
        const price = candles[candles.length - 1]!.close;
        if (avg === null || price >= avg) return action;
        // Стратегия с собственным учётом позиции считает, что купила, — поправляем.
        inner.sync?.({ price, downtimeSec: 0, inPosition: false, entryPrice: 0 });
        return 'hold';
      },
      toJSON: inner.toJSON?.bind(inner),
      restore: inner.restore?.bind(inner),
      sync: inner.sync?.bind(inner),
    };
  };
}
