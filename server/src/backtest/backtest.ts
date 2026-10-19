import { Bot } from '../trading/bot.js';
import { lotQty } from '../trading/ledger.js';
import { MetaBot } from '../trading/meta-bot.js';
import type { Candle, Costs, StrategyFactory } from '../trading/types.js';

// Прогон стратегий по истории теми же Bot, MetaBot и Ledger, что и вживую:
// одно решение на закрытую свечу, исполнение по открытию следующей, те же
// комиссия, проскальзывание и минимальный лот.

export interface BacktestOptions {
  startBalance: number;
  costs: Costs;
  window?: number; // сколько закрытых свечей видит стратегия, как в движке
  metaWindow: number; // окно «Авто-выбора» в свечах этого таймфрейма
  stopLossPct?: number;
}

export interface StrategyResult {
  name: string;
  pnlPct: number; // от стартового счёта
  firstPct: number; // первые 2/3 истории
  lastPct: number; // последняя треть — проверка, что плюс не случайность начала
  trades: number;
  closed: number;
  winRatePct: number | null;
  feesPct: number; // сколько счёта ушло на комиссии
  maxDrawdownPct: number;
}

export interface BacktestResult {
  candles: number;
  from: number;
  to: number;
  marketPct: number; // цена за весь период
  lotHoldPct: number; // «купил один лот и держал» в % от счёта — с чем сравнивать
  strategies: StrategyResult[];
}

export function runBacktest(candles: readonly Candle[], factories: readonly StrategyFactory[], opts: BacktestOptions): BacktestResult {
  const window = opts.window ?? 100;
  if (candles.length <= window + 10) throw new Error(`мало истории: ${candles.length} свечей`);
  const { startBalance, costs } = opts;

  const bots = factories.map(f => new Bot(f(), { startBalance, costs, stopLossPct: opts.stopLossPct }));
  const meta = new MetaBot([...bots], { startBalance, costs, windowCandles: opts.metaWindow });
  const all = [...bots, meta];
  const split = window + Math.floor((candles.length - window) * 2 / 3);
  const atSplit = new Map<string, number>();
  const peak = new Map<string, number>();
  const drawdown = new Map<string, number>();
  const closed = new Map<string, number>();
  const wins = new Map<string, number>();

  for (let i = window; i < candles.length; i += 1) {
    const view = candles.slice(i - window, i);
    const price = candles[i]!.open;
    for (const bot of all) {
      const name = bot.strategy.name;
      const r = bot.step(view, price);
      if (r.trade?.side === 'sell') {
        closed.set(name, (closed.get(name) ?? 0) + 1);
        if ((r.trade.pnlPct ?? 0) > 0) wins.set(name, (wins.get(name) ?? 0) + 1);
      }
      const top = Math.max(peak.get(name) ?? startBalance, r.equity);
      peak.set(name, top);
      drawdown.set(name, Math.max(drawdown.get(name) ?? 0, (1 - r.equity / top) * 100));
      if (i === split) atSplit.set(name, r.equity);
    }
  }

  const last = candles[candles.length - 1]!;
  const first = candles[window]!;
  for (const bot of all) bot.ledger.mark(last.close);

  const lot = costs.lot;
  const qty = lot ? lotQty(first.open * (1 + costs.slippagePct / 100), lot, costs.orderUsdt) : startBalance / first.open;
  const fee = costs.feePct / 100;
  const slip = costs.slippagePct / 100;
  const spent = qty * first.open * (1 + slip) * (1 + fee);
  const got = qty * last.close * (1 - slip) * (1 - fee);

  return {
    candles: candles.length,
    from: first.time,
    to: last.time,
    marketPct: (last.close / first.open - 1) * 100,
    lotHoldPct: ((got - spent) / startBalance) * 100,
    strategies: all.map(bot => {
      const name = bot.strategy.name;
      const mid = atSplit.get(name) ?? startBalance;
      const end = bot.ledger.equity;
      const c = closed.get(name) ?? 0;
      return {
        name,
        pnlPct: (end / startBalance - 1) * 100,
        firstPct: (mid / startBalance - 1) * 100,
        lastPct: (end / mid - 1) * 100,
        trades: bot.ledger.tradeCount,
        closed: c,
        winRatePct: c ? ((wins.get(name) ?? 0) / c) * 100 : null,
        feesPct: (bot.ledger.feesPaid / startBalance) * 100,
        maxDrawdownPct: drawdown.get(name) ?? 0,
      };
    }).sort((a, b) => b.pnlPct - a.pnlPct),
  };
}

// Прошла проверку: плюс после всех издержек на обоих отрезках истории и
// лучше, чем просто держать лот. Только такие имеет смысл пускать вживую.
export function passes(s: StrategyResult, r: BacktestResult): boolean {
  return s.firstPct > 0 && s.lastPct > 0 && s.pnlPct > Math.max(0, r.lotHoldPct);
}
