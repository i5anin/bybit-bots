import { Ledger } from './lib/ledger.js';

export class Bot {
  constructor(strategy, startBalance) {
    this.strategy = strategy;
    this.ledger = new Ledger(startBalance);
  }

  step(candles) {
    const price = candles[candles.length - 1].close;
    this.ledger.mark(price);

    const action = this.strategy.signal(candles);
    if (action === 'buy') this.ledger.buy(price);
    if (action === 'sell') this.ledger.sell(price);

    return action;
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
