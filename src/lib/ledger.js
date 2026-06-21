// Виртуальный леджер одного бота: бумажная торговля без реальных ордеров.
export class Ledger {
  constructor(startBalance) {
    this.cash = startBalance;
    this.position = 0; // количество базового актива в позиции
    this.entryPrice = 0;
    this.trades = [];
  }

  get equity() {
    return this.cash + this.position * this.lastPrice;
  }

  mark(price) {
    this.lastPrice = price;
  }

  buy(price) {
    if (this.position > 0) return; // уже в позиции
    this.position = this.cash / price;
    this.entryPrice = price;
    this.cash = 0;
    this.trades.push({ side: 'buy', price, time: Date.now() });
  }

  sell(price) {
    if (this.position === 0) return; // нет позиции
    this.cash = this.position * price;
    this.trades.push({ side: 'sell', price, time: Date.now(), pnlPct: (price / this.entryPrice - 1) * 100 });
    this.position = 0;
    this.entryPrice = 0;
  }
}
