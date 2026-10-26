import { Ledger } from './ledger.js';
import type {
  Action, BotSnapshot, Candle, Costs, LedgerSnapshot, StepResult, Strategy, StrategyContext, Trade, Trader,
} from './types.js';

export interface BotOptions {
  startBalance: number;
  snapshot?: Partial<BotSnapshot> | null;
  downtimeSec?: number;
  costs?: Partial<Costs>;
  // Принудительная продажа, если цена ушла ниже входа на столько процентов.
  stopLossPct?: number;
}

// Один бот = одна стратегия + свой счёт.
export class Bot implements Trader {
  readonly ledger: Ledger;
  lastSignalCandle: number | null;
  private readonly restored: boolean;
  private readonly pendingStrategyState: unknown;
  private readonly downtimeSec: number;
  private strategyReady: boolean;
  private readonly stopLossPct: number;

  constructor(readonly strategy: Strategy, { startBalance, snapshot = null, downtimeSec = 0, costs, stopLossPct = 0 }: BotOptions) {
    this.stopLossPct = stopLossPct;
    this.ledger = Ledger.from(snapshot?.ledger as Partial<LedgerSnapshot> | undefined, startBalance, costs);
    this.restored = Boolean(snapshot);
    this.pendingStrategyState = snapshot?.strategy ?? null;
    this.downtimeSec = downtimeSec;
    this.strategyReady = !this.restored;
    this.lastSignalCandle = snapshot?.lastSignalCandle ?? null;
  }

  // candles — закрытые свечи (по ним сигнал), price — текущая цена (по ней исполнение).
  step(candles: readonly Candle[], price: number): StepResult {
    this.ledger.mark(price); // переоценка позиции по текущей цене до сигнала

    // Стратегию восстанавливаем на первом тике: только здесь известна
    // актуальная цена и длительность простоя, а опорные точки за время
    // остановки могли устареть.
    if (!this.strategyReady) {
      this.strategyReady = true;
      this.strategy.restore?.(this.pendingStrategyState, this.context(price));
    }

    // Одно решение на закрытую свечу: внутри незакрытой свечи сигнал мигает
    // от минуты к минуте и даёт лишние сделки, каждая из которых платит комиссию.
    const candleTime = candles[candles.length - 1]?.time ?? null;
    if (candleTime === this.lastSignalCandle) return this.result('hold', null, price);
    this.lastSignalCandle = candleTime;

    // Стоп-лосс срабатывает раньше сигнала: позиция закрывается, стратегия
    // узнаёт, что она больше не в рынке.
    if (this.stopLossPct > 0 && this.ledger.position > 0
      && price <= this.ledger.entryPrice * (1 - this.stopLossPct / 100)) {
      const stop = this.ledger.sell(price);
      this.strategy.sync?.(this.context(price));
      return this.result('sell', stop, price);
    }

    const action = this.strategy.signal(candles);
    let trade: Trade | null = null;
    if (action === 'buy') trade = this.ledger.buy(price, Boolean(this.strategy.averaging));
    if (action === 'sell') trade = this.ledger.sell(price);

    // Сделка не прошла (на минимальный ордер не хватило денег) — стратегия
    // с собственным учётом позиции должна узнать, что в рынок она не вошла.
    if (!trade && (action === 'buy' || action === 'sell')) {
      this.strategy.sync?.(this.context(price));
    }

    return this.result(action, trade, price);
  }

  private context(price: number): StrategyContext {
    return {
      price,
      downtimeSec: this.downtimeSec,
      inPosition: this.ledger.position > 0,
      entryPrice: this.ledger.entryPrice,
    };
  }

  private result(action: Action, trade: Trade | null, price: number): StepResult {
    return { action, trade, price, equity: this.ledger.equity, position: this.ledger.position };
  }

  snapshot(): BotSnapshot {
    return {
      ledger: this.ledger.toJSON(),
      lastSignalCandle: this.lastSignalCandle,
      strategy: typeof this.strategy.toJSON === 'function' ? this.strategy.toJSON() : null,
    };
  }
}
