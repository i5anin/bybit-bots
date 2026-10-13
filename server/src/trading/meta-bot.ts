import { Ledger } from './ledger.js';
import type { Action, Candle, Costs, MetaSnapshot, StepResult, Trade, Trader } from './types.js';

// Авто-выбор: свой счёт, а решения копирует у той стратегии, что лучше всех
// заработала за последнее окно. Лидер меняется, только если новый обгоняет
// текущего с запасом, — иначе бот метался бы между равными и платил комиссии.
// Если за окно в плюсе нет никого, бот стоит вне рынка: копировать
// «наименее убыточную» — значит гарантированно терять вместе с ней.
export const META_DEFAULTS = Object.freeze({
  windowCandles: 288, // 288 × 5м = сутки
  switchMarginPct: 0.5,
});

export function metaName(count: number): string {
  return `Авто-выбор лучшей (${count})`;
}

export interface MetaOptions {
  startBalance: number;
  snapshot?: Partial<MetaSnapshot> | null;
  costs?: Partial<Costs>;
  windowCandles?: number;
  switchMarginPct?: number;
}

export class MetaBot implements Trader {
  readonly strategy: { readonly name: string };
  readonly ledger: Ledger;
  readonly options: { windowCandles: number; switchMarginPct: number };
  lastSignalCandle: number | null;
  leader: string | null;
  history: Record<string, number[]>; // имя бота → equity на закрытых свечах

  constructor(private readonly bots: readonly Trader[], { startBalance, snapshot = null, costs, ...options }: MetaOptions) {
    this.options = {
      windowCandles: options.windowCandles ?? META_DEFAULTS.windowCandles,
      switchMarginPct: options.switchMarginPct ?? META_DEFAULTS.switchMarginPct,
    };
    this.strategy = { name: metaName(bots.length) };
    this.ledger = Ledger.from(snapshot?.ledger, startBalance, costs);
    this.lastSignalCandle = snapshot?.lastSignalCandle ?? null;
    this.leader = snapshot?.leader ?? null;
    this.history = snapshot?.history ?? {};
  }

  // Вызывается после шагов остальных ботов: их позиции уже обновлены.
  step(candles: readonly Candle[], price: number): StepResult {
    this.ledger.mark(price);
    const candleTime = candles[candles.length - 1]?.time ?? null;
    if (candleTime === this.lastSignalCandle) return this.result('hold', null, price);
    this.lastSignalCandle = candleTime;

    this.record();
    this.leader = this.pickLeader();

    const leaderBot = this.bots.find(b => b.strategy.name === this.leader);
    const wantIn = Boolean(leaderBot && leaderBot.ledger.position > 0);
    if (wantIn && this.ledger.position === 0) {
      return this.result('buy', this.ledger.buy(price), price);
    }
    if (!wantIn && this.ledger.position > 0) {
      return this.result('sell', this.ledger.sell(price), price);
    }
    return this.result('hold', null, price);
  }

  private record(): void {
    const keep = this.options.windowCandles + 1;
    for (const bot of this.bots) {
      const series = (this.history[bot.strategy.name] ??= []);
      // 8 знаков хватает для доходности за окно, а state.json, который пишется
      // каждую минуту, становится вдвое меньше.
      series.push(Number(bot.ledger.equity.toFixed(8)));
      if (series.length > keep) series.splice(0, series.length - keep);
    }
  }

  windowReturn(name: string): number {
    const s = this.history[name];
    const first = s?.[0];
    const last = s?.[s.length - 1];
    if (!s || s.length < 2 || first === undefined || last === undefined || !(first > 0)) return 0;
    return (last / first - 1) * 100;
  }

  private pickLeader(): string | null {
    let best: string | null = null;
    let bestRet = 0; // ноль — порог: лидером может стать только стратегия в плюсе
    for (const bot of this.bots) {
      const r = this.windowReturn(bot.strategy.name);
      if (r > bestRet) { best = bot.strategy.name; bestRet = r; }
    }
    if (!best) return null;

    const current = this.bots.some(b => b.strategy.name === this.leader) ? this.leader : null;
    const currentRet = current ? this.windowReturn(current) : 0;
    if (current && currentRet > 0 && bestRet <= currentRet + this.options.switchMarginPct) {
      return current;
    }
    return best;
  }

  private result(action: Action, trade: Trade | null, price: number): StepResult {
    return { action, trade, price, equity: this.ledger.equity, position: this.ledger.position };
  }

  snapshot(): MetaSnapshot {
    return {
      meta: true,
      ledger: this.ledger.toJSON(),
      lastSignalCandle: this.lastSignalCandle,
      leader: this.leader,
      history: this.history,
    };
  }
}
