import { Ledger } from './lib/ledger.js';

// Один бот = одна стратегия + свой счёт.
//   startBalance — стартовый счёт; snapshot — сохранённое состояние после рестарта;
//   downtimeSec — сколько бот простоял; costs — издержки и лот (см. Ledger).
export class Bot {
  constructor(strategy, { startBalance, snapshot = null, downtimeSec = 0, costs } = {}) {
    this.strategy = strategy;
    this.ledger = Ledger.from(snapshot?.ledger, startBalance, costs);
    this.restored = Boolean(snapshot);
    this.pendingStrategyState = snapshot?.strategy ?? null;
    this.downtimeSec = downtimeSec;
    this.strategyReady = !this.restored;
    this.lastSignalCandle = snapshot?.lastSignalCandle ?? null;
  }

  // candles — закрытые свечи (по ним сигнал), price — текущая цена (по ней исполнение).
  step(candles, price) {
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
    const candleTime = candles[candles.length - 1].time;
    if (candleTime === this.lastSignalCandle) return this.result('hold', null, price);
    this.lastSignalCandle = candleTime;

    const action = this.strategy.signal(candles);
    let trade = null;
    if (action === 'buy') trade = this.ledger.buy(price);
    if (action === 'sell') trade = this.ledger.sell(price);

    // Сделка не прошла (на минимальный ордер не хватило денег) — стратегия
    // с собственным учётом позиции должна узнать, что в рынок она не вошла.
    if (!trade && (action === 'buy' || action === 'sell')) {
      this.strategy.sync?.(this.context(price));
    }

    return this.result(action, trade, price);
  }

  context(price) {
    return {
      price,
      downtimeSec: this.downtimeSec,
      inPosition: this.ledger.position > 0,
      entryPrice: this.ledger.entryPrice,
    };
  }

  result(action, trade, price) {
    return { action, trade, price, equity: this.ledger.equity, position: this.ledger.position };
  }

  snapshot() {
    return {
      ledger: this.ledger.toJSON(),
      lastSignalCandle: this.lastSignalCandle,
      strategy: typeof this.strategy.toJSON === 'function' ? this.strategy.toJSON() : null,
    };
  }

  status() {
    return {
      name: this.strategy.name,
      equity: round2(this.ledger.equity),
      position: this.ledger.position > 0 ? 'в позиции' : '—',
      trades: this.ledger.tradeCount,
      'pnl %': round2(this.ledger.realizedPnlPct),
      fees: round2(this.ledger.feesPaid),
    };
  }
}

export function round2(value) {
  return Math.round(value * 100) / 100;
}
