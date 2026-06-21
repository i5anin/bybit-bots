import { Ledger } from './lib/ledger.js';

export class Bot {
  constructor(strategy, startBalance) {
    this.strategy = strategy;
    this.ledger = new Ledger(startBalance);
  }

  step(candles) {
    const price = candles[candles.length - 1].close;
    this.ledger.mark(price);

    const tradesBefore = this.ledger.trades.length;
    const action = this.strategy.signal(candles);
    if (action === 'buy') this.ledger.buy(price);
    if (action === 'sell') this.ledger.sell(price);

    const trade = this.ledger.trades.length > tradesBefore
      ? this.ledger.trades[this.ledger.trades.length - 1]
      : null;

    return { action, trade, price, equity: this.ledger.equity, position: this.ledger.position };
  }

  status() {
    return {
      name: this.strategy.name,
      equity: this.ledger.equity,
      position: this.ledger.position > 0 ? 'в позиции' : '—',
      trades: this.ledger.trades.length,
    };
  }
}
