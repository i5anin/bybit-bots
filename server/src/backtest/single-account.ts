import { Bot } from '../trading/bot.js';
import { ACTIVE_STRATEGIES } from '../trading/strategies/index.js';
import type { Candle, Costs, LotRules, StrategyFactory } from '../trading/types.js';
import { runBacktest } from './backtest.js';

export interface MarketHistory {
  symbol: string;
  lot: LotRules;
  candles: Candle[];
}

export interface SingleAccountOptions {
  startRub: number;
  rubPerUsdt: number;
  feePct: number;
  slippagePct: number;
  trainDays: number;
  tradeDays: number;
  stopLossPct: number;
  maxTrainingDrawdownPct: number;
  minClosedTrades: number;
  accountLossLimitPct: number;
}

export const SINGLE_ACCOUNT_DEFAULTS: SingleAccountOptions = {
  startRub: 1000, rubPerUsdt: 80.5573,
  feePct: 0.1, slippagePct: 0.02,
  trainDays: 60, tradeDays: 30, stopLossPct: 3,
  maxTrainingDrawdownPct: 8, minClosedTrades: 3, accountLossLimitPct: 5,
};

export interface SingleAccountPeriod {
  from: number;
  to: number;
  symbol: string | null;
  strategy: string | null;
  trainingPnlPct: number | null;
  startRub: number;
  endRub: number;
  feesRub: number;
  trades: number;
}

export interface SingleAccountResult {
  startRub: number;
  endRub: number;
  pnlRub: number;
  feesRub: number;
  maxDrawdownPct: number;
  periods: SingleAccountPeriod[];
}

const DAY = 86_400_000;
const WINDOW = 100;

/** Ограничивает каждую из 15 исходных стратегий одним лотом без усреднения.
 * Обучение и последующая торговля используют одну и ту же фабрику;
 * Bot.sync сохраняет согласованность стратегии при отклонённой докупке.
 */
function singleLot(factory: StrategyFactory): StrategyFactory {
  return () => ({ ...factory(), averaging: false });
}

/** Задаёт фактический минимальный лот; при 1000 ₽ ставка 1% не проходит биржу.
 * Ledger проверяет баланс и шаг количества. Пара без достоверных правил исключается.
 */
function costsFor(market: MarketHistory, options: SingleAccountOptions): Costs {
  return {
    feePct: options.feePct, slippagePct: options.slippagePct,
    lot: market.lot, orderUsdt: 0, orderPct: 0, enforceMinOrder: true,
  };
}

/** Выбирает пару и стратегию исключительно по свечам, закрытым до границы.
 * runSingleAccount вызывает её перед каждым торговым периодом. Требуются
 * плюс на обеих частях обучения, превосходство удержания лота, закрытые сделки
 * и ограниченная просадка. Рейтинг учитывает просадку; будущий результат не участвует.
 */
function selectCandidate(markets: readonly MarketHistory[], at: number, balance: number,
  options: SingleAccountOptions, factories: readonly StrategyFactory[]) {
  const candidates: { market: MarketHistory; name: string; score: number; pnl: number }[] = [];
  for (const market of markets) {
    const candles = market.candles.filter(c => c.time >= at - options.trainDays * DAY - WINDOW * 3_600_000
      && c.time + 3_600_000 <= at);
    if (candles.length < options.trainDays * 24 + WINDOW) continue;
    const result = runBacktest(candles, factories, {
      startBalance: balance, costs: costsFor(market, options),
      stopLossPct: options.stopLossPct, metaWindow: 24,
    });
    for (const strategy of result.strategies) {
      if (!factories.some(f => f().name === strategy.name)) continue;
      if (strategy.firstPct <= 0 || strategy.lastPct <= 0
        || strategy.pnlPct <= Math.max(0, result.lotHoldPct)
        || strategy.closed < options.minClosedTrades
        || strategy.maxDrawdownPct > options.maxTrainingDrawdownPct) continue;
      candidates.push({ market, name: strategy.name, pnl: strategy.pnlPct,
        score: strategy.pnlPct - strategy.maxDrawdownPct });
    }
  }
  return candidates.sort((a, b) => b.score - a.score || a.market.symbol.localeCompare(b.market.symbol)
    || a.name.localeCompare(b.name))[0] ?? null;
}

/** Испытывает один общий счёт: 60 дней прошлого → выбор → 30 дней торговли.
 * Использует Bot/Ledger и все ACTIVE_STRATEGIES; отдельные виртуальные счета
 * существуют только внутри обучения, прибыль между ними не суммируется.
 * Исполнение на открытии следующей часовой свечи, ликвидация позиции в конце
 * периода с издержками; при отсутствии кандидата деньги сохраняются.
 * Общая защита останавливает счёт при потере accountLossLimitPct от максимума;
 * она проверяется на открытиях свечей, поэтому разрывы цены могут превысить предел.
 * Курс RUB/USDT фиксирован для сопоставимости: валютная переоценка не моделируется.
 * Данные должны быть непрерывными часовыми свечами; ошибка качества останавливает прогон.
 */
export function runSingleAccount(markets: readonly MarketHistory[], from: number, to: number,
  options: SingleAccountOptions = SINGLE_ACCOUNT_DEFAULTS,
  strategyFactories: readonly StrategyFactory[] = ACTIVE_STRATEGIES): SingleAccountResult {
  if (!(options.startRub > 0 && options.rubPerUsdt > 0 && options.trainDays >= 1
    && options.tradeDays >= 1 && options.stopLossPct > 0 && options.maxTrainingDrawdownPct > 0
    && options.minClosedTrades >= 1 && options.feePct >= 0 && options.slippagePct >= 0
    && options.accountLossLimitPct > 0 && options.accountLossLimitPct <= 100)
    || !Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('Неверные параметры счёта или периода');
  if (!markets.length || !strategyFactories.length) throw new Error('Нет рынков или стратегий');
  for (const market of markets) {
    if (!(market.lot.minOrderAmt > 0 && market.lot.qtyStep > 0 && market.lot.minOrderQty >= 0)) {
      throw new Error(`Нет достоверного минимального лота: ${market.symbol}`);
    }
    for (let i = 0; i < market.candles.length; i++) {
      const c = market.candles[i]!;
      if (![c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)
        || Math.min(c.open, c.low, c.close) <= 0 || c.high < Math.max(c.open, c.close)
        || c.low > Math.min(c.open, c.close) || c.volume < 0
        || (i > 0 && c.time - market.candles[i - 1]!.time !== 3_600_000)) {
        throw new Error(`Некорректная или неполная история: ${market.symbol}`);
      }
    }
    if (!market.candles.length || market.candles[0]!.time > from - options.trainDays * DAY - WINDOW * 3_600_000
      || market.candles.at(-1)!.time + 3_600_000 < to) throw new Error(`Недостаточно истории: ${market.symbol}`);
  }
  const factories = strategyFactories.map(singleLot);
  let balance = options.startRub / options.rubPerUsdt;
  let peak = balance;
  let maxDrawdownPct = 0;
  let feesRub = 0;
  let halted = false;
  const lossFloor = balance * (1 - options.accountLossLimitPct / 100);
  const periods: SingleAccountPeriod[] = [];
  for (let at = from; at < to; at += options.tradeDays * DAY) {
    const end = Math.min(to, at + options.tradeDays * DAY);
    const selected = halted ? null : selectCandidate(markets, at, balance, options, factories);
    const startRub = balance * options.rubPerUsdt;
    let fees = 0;
    let trades = 0;
    if (selected) {
      const factory = factories.find(f => f().name === selected.name)!;
      const bot = new Bot(factory(), { startBalance: balance,
        costs: costsFor(selected.market, options), stopLossPct: options.stopLossPct });
      const history = selected.market.candles;
      for (let i = WINDOW; i < history.length; i++) {
        const candle = history[i]!;
        if (candle.time < at || candle.time >= end) continue;
        // Проверяем общий предел на доступной цене открытия. После остановки
        // счёт не возобновляет торговлю автоматически; разрыв цены может превысить предел.
        bot.ledger.mark(candle.open);
        if (bot.ledger.equity <= Math.max(lossFloor, peak * (1 - options.accountLossLimitPct / 100))) {
          bot.ledger.sell(candle.open);
          halted = true;
          break;
        }
        bot.step(history.slice(i - WINDOW, i), candle.open);
        // Закрытия учитываются при измерении просадки, включая последний бар.
        bot.ledger.mark(candle.close);
        peak = Math.max(peak, bot.ledger.equity);
        maxDrawdownPct = Math.max(maxDrawdownPct, (1 - bot.ledger.equity / peak) * 100);
      }
      if (!halted) bot.ledger.sell(history.findLast(c => c.time >= at && c.time < end)!.close);
      balance = bot.ledger.equity;
      fees = bot.ledger.feesPaid * options.rubPerUsdt;
      trades = bot.ledger.tradeCount;
      maxDrawdownPct = Math.max(maxDrawdownPct, (1 - balance / peak) * 100);
    }
    feesRub += fees;
    periods.push({ from: at, to: end, symbol: selected?.market.symbol ?? null,
      strategy: selected?.name ?? null, trainingPnlPct: selected?.pnl ?? null,
      startRub, endRub: balance * options.rubPerUsdt, feesRub: fees, trades });
  }
  const endRub = balance * options.rubPerUsdt;
  return { startRub: options.startRub, endRub, pnlRub: endRub - options.startRub,
    feesRub, maxDrawdownPct, periods };
}
