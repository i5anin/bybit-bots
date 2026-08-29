import { closes, sma, ema, stdDev } from './utils.js';

// Адаптивная стратегия: сначала определяет характер рынка, потом выбирает
// приём под него.
//
// Зачем. Остальные десять привязаны к одному приёму намертво, и таблица это
// показывает: все стратегии возврата к среднему в плюсе, все трендовые в
// минусе. Это оценка не приёмов, а того, что рынок держался в коридоре.
// Смена характера перевернёт таблицу, и сегодняшние лидеры станут худшими.
//
// Характер меряем коэффициентом эффективности Кауфмана:
//     ER = |путь по прямой| / |сумма всех шагов|
// Цена прошла 500 пунктов вверх почти без откатов - ER близко к 1, тренд.
// Проболталась туда-обратно и вернулась - ER близко к 0, коридор.
// Коэффициент безразмерный, поэтому порог не надо подгонять под цену
// инструмента: он одинаково работает и на BTC, и на чём угодно ещё.
//
// Три состояния, и третье - самое важное: когда характер неясен, стратегия
// не входит в рынок совсем. Отказ от сделки - тоже решение, и именно он
// отличает адаптивную логику от переключателя.

const WINDOW = 20;

// Полоса нечувствительности между порогами намеренно широкая: при едином
// пороге стратегия дёргалась бы туда-обратно на каждом шаге около него.
const TREND_ER = 0.35;   // выше - считаем трендом
const RANGE_ER = 0.18;   // ниже - считаем коридором

// У стратегии Mean Reversion порог 1.5. Берём шире, иначе новая стратегия
// повторяла бы её сделки и ничего не добавляла к общей картине.
const Z_ENTRY = 2.0;

function efficiencyRatio(values, period) {
  if (values.length < period + 1) return null;
  const slice = values.slice(-(period + 1));
  const net = Math.abs(slice[slice.length - 1] - slice[0]);
  let path = 0;
  for (let i = 1; i < slice.length; i++) {
    path += Math.abs(slice[i] - slice[i - 1]);
  }
  if (path === 0) return null;        // свеча в свечу, судить не о чем
  return net / path;
}

export function createStrategy() {
  return {
    name: 'Adaptive Regime (ER 20)',
    signal(candles) {
      const c = closes(candles);
      if (c.length < 50) return 'hold';   // нужна медленная EMA(50)

      const er = efficiencyRatio(c, WINDOW);
      if (er === null) return 'hold';

      const price = c[c.length - 1];

      // Тренд: идём по направлению, а не против него.
      if (er >= TREND_ER) {
        const fast = ema(c, 20);
        const slow = ema(c, 50);
        if (fast === null || slow === null) return 'hold';
        if (fast > slow && price > fast) return 'buy';
        if (fast < slow && price < fast) return 'sell';
        return 'hold';
      }

      // Коридор: ставим на возврат к середине.
      if (er <= RANGE_ER) {
        const mean = sma(c, WINDOW);
        const dev = stdDev(c, WINDOW);
        if (mean === null || dev === 0) return 'hold';
        const z = (price - mean) / dev;
        if (z <= -Z_ENTRY) return 'buy';
        if (z >= Z_ENTRY) return 'sell';
        return 'hold';
      }

      // Середина полосы: характер неясен, в рынок не входим.
      return 'hold';
    },
  };
}
