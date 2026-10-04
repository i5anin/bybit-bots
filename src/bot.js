import { Ledger } from './lib/ledger.js';

export class Bot {
  constructor(strategy, startBalance, snapshot, resume) {
    this.strategy = strategy;
    this.ledger = Ledger.from(snapshot?.ledger, startBalance);
    this.restored = Boolean(snapshot);
    this.pendingStrategyState = snapshot?.strategy ?? null;
    this.resume = resume ?? { downtimeSec: 0 };
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
      if (typeof this.strategy.restore === 'function') {
        this.strategy.restore(this.pendingStrategyState, {
          price,
          downtimeSec: this.resume.downtimeSec,
          inPosition: this.ledger.position > 0,
          entryPrice: this.ledger.entryPrice,
        });
      }
    }

    // Одно решение на закрытую свечу: внутри незакрытой свечи сигнал мигает
    // от минуты к минуте и даёт лишние сделки, каждая из которых платит комиссию.
    const candleTime = candles[candles.length - 1].time;
    if (candleTime === this.lastSignalCandle) {
      return { action: 'hold', trade: null, price, equity: this.ledger.equity, position: this.ledger.position };
    }
    this.lastSignalCandle = candleTime;

    const action = this.strategy.signal(candles);
    let trade = null;
    if (action === 'buy') trade = this.ledger.buy(price);
    if (action === 'sell') trade = this.ledger.sell(price);

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

function round2(value) {
  return Math.round(value * 100) / 100;
}
