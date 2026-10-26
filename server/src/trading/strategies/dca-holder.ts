import type { Candle, Strategy, StrategyContext } from '../types.js';

// «Терпеливый холдер» (усреднение, DCA): минимальная покупка на падении,
// докупка тем же минимумом на каждом следующем падении и продажа всей
// позиции, когда она в плюсе. Стоп-лосса нет: убыточная позиция не
// продаётся, а ждёт возврата цены.
//
// Цель прибыли уменьшается со временем: чем дольше держим, тем на меньший
// плюс соглашаемся, но не ниже пола, который покрывает комиссии круга
// (около 0.24 %) и оставляет чистый плюс. Три характера холдера отличаются
// только целью прибыли (HOLDER_PROFILES).

const LOOKBACK_CANDLES = 24; // от какого максимума считаем падение для первой покупки
const ENTRY_DROP_PCT = 2; // на сколько цена должна упасть от максимума для входа
const ADD_DROP_PCT = 2; // докупка — ещё на столько ниже последней покупки
const MAX_BUYS = 5; // всего покупок в одной позиции; дальше только ждём
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Цель прибыли: startPct сразу после первой покупки, снижается на
// decayPctPerDay за сутки, но не ниже floorPct.
export interface ProfitTarget {
  label: string;
  startPct: number;
  decayPctPerDay: number;
  floorPct: number;
}

export const HOLDER_PROFILES = {
  // Продаёт при минимальном плюсе, который остаётся после комиссий.
  quick: { label: 'быстрый', startPct: 0.6, decayPctPerDay: 0, floorPct: 0.6 },
  // Сначала ждёт 3 %, за 5 дней соглашается на 0.6 %.
  medium: { label: 'средний', startPct: 3, decayPctPerDay: 0.5, floorPct: 0.6 },
  // Долго ждёт существенный плюс: 8 %, за 26 дней соглашается на 1.5 %.
  patient: { label: 'терпеливый', startPct: 8, decayPctPerDay: 0.25, floorPct: 1.5 },
} as const satisfies Record<string, ProfitTarget>;

interface DcaState {
  buyPrices: number[];
  firstBuyTime: number | null;
  pendingBuy: boolean;
}

/**
 * Цель прибыли в % от средней цены входа для позиции, которую держим heldMs.
 * Используется сигналом стратегии; вынесена отдельно ради тестов.
 */
export function profitTargetPct(target: ProfitTarget, heldMs: number): number {
  const days = Math.max(0, heldMs) / MS_PER_DAY;
  return Math.max(target.floorPct, target.startPct - days * target.decayPctPerDay);
}

/**
 * Средняя цена входа при покупках на равную сумму — среднее гармоническое цен.
 * Ставка в леджере — % от свободных денег, поэтому суммы почти равны.
 */
function averagePrice(prices: readonly number[]): number {
  return prices.length / prices.reduce((sum, p) => sum + 1 / p, 0);
}

/**
 * Фабрика стратегии с заданной целью прибыли (один из HOLDER_PROFILES). Подключается в ACTIVE_STRATEGIES; `averaging: true`
 * разрешает боту (Bot.step → Ledger.buy) докупать при открытой позиции.
 * Состояние (цены покупок, время первой) переживает перезапуск через
 * toJSON/restore; sync откатывает покупку, которую леджер не исполнил.
 */
export function dcaHolder(target: ProfitTarget = HOLDER_PROFILES.medium): Strategy {
  let buyPrices: number[] = [];
  let firstBuyTime: number | null = null;
  let pendingBuy = false; // покупка отдана боту; если не прошла — sync её откатит

  function buy(candle: Candle): 'buy' {
    buyPrices.push(candle.close);
    firstBuyTime ??= candle.time;
    pendingBuy = true;
    return 'buy';
  }

  return {
    name: `DCA-холдер ${target.label} (+${target.startPct}%→${target.floorPct}%)`,
    averaging: true,

    signal(candles) {
      pendingBuy = false;
      const last = candles[candles.length - 1]!;
      const price = last.close;

      if (buyPrices.length === 0) {
        const recent = candles.slice(-LOOKBACK_CANDLES);
        const high = Math.max(...recent.map(c => c.high));
        const drop = (high - price) / high * 100;
        return drop >= ENTRY_DROP_PCT ? buy(last) : 'hold';
      }

      const gain = (price / averagePrice(buyPrices) - 1) * 100;
      if (gain >= profitTargetPct(target, last.time - (firstBuyTime ?? last.time))) {
        buyPrices = [];
        firstBuyTime = null;
        return 'sell';
      }

      const lastBuy = buyPrices[buyPrices.length - 1]!;
      const dropFromLastBuy = (lastBuy - price) / lastBuy * 100;
      if (buyPrices.length < MAX_BUYS && dropFromLastBuy >= ADD_DROP_PCT) return buy(last);
      return 'hold';
    },

    toJSON(): DcaState {
      return { buyPrices, firstBuyTime, pendingBuy: false };
    },

    // Позиция — по леджеру: нет позиции — забываем покупки; есть, а своих
    // записей нет — считаем одну покупку по цене входа леджера.
    restore(snapshot: unknown, ctx: StrategyContext) {
      const saved = snapshot as Partial<DcaState> | null;
      const savedPrices = Array.isArray(saved?.buyPrices)
        ? saved.buyPrices.filter(p => typeof p === 'number' && p > 0)
        : [];
      if (!ctx.inPosition) {
        buyPrices = [];
        firstBuyTime = null;
        return;
      }
      buyPrices = savedPrices.length > 0 ? savedPrices : [ctx.entryPrice];
      firstBuyTime = typeof saved?.firstBuyTime === 'number' ? saved.firstBuyTime : null;
    },

    // Покупка не исполнилась (не хватило денег на минимальный ордер) —
    // убираем её из своего учёта.
    sync(ctx: StrategyContext) {
      if (pendingBuy) {
        buyPrices.pop();
        pendingBuy = false;
      }
      if (!ctx.inPosition) {
        buyPrices = [];
        firstBuyTime = null;
      }
    },
  };
}

export const quickHolder = (): Strategy => dcaHolder(HOLDER_PROFILES.quick);
export const mediumHolder = (): Strategy => dcaHolder(HOLDER_PROFILES.medium);
export const patientHolder = (): Strategy => dcaHolder(HOLDER_PROFILES.patient);
