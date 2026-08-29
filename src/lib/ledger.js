// Виртуальный леджер одного бота: бумажная торговля без реальных ордеров.
// Состояние сериализуемо — бот продолжает счёт после рестарта контейнера.
export class Ledger {
  constructor(startBalance) {
    this.cash = startBalance;
    this.position = 0; // количество базового актива в позиции
    this.entryPrice = 0;
    this.lastPrice = 0;
    this.tradeCount = 0; // за всю историю, а не за текущий запуск
    this.realizedPnlPct = 0; // сумма pnl% по закрытым сделкам
  }

  get equity() {
    return this.cash + this.position * this.lastPrice;
  }

  mark(price) {
    this.lastPrice = price;
  }

  buy(price) {
    if (this.position > 0) return null; // уже в позиции
    this.position = this.cash / price;
    this.entryPrice = price;
    this.cash = 0;
    this.tradeCount += 1;
    return { side: 'buy', price, time: Date.now() };
  }

  sell(price) {
    if (this.position === 0) return null; // нет позиции
    const pnlPct = (price / this.entryPrice - 1) * 100;
    this.cash = this.position * price;
    this.position = 0;
    this.entryPrice = 0;
    this.tradeCount += 1;
    this.realizedPnlPct += pnlPct;
    return { side: 'sell', price, time: Date.now(), pnlPct };
  }

  toJSON() {
    return {
      cash: this.cash,
      position: this.position,
      entryPrice: this.entryPrice,
      lastPrice: this.lastPrice,
      tradeCount: this.tradeCount,
      realizedPnlPct: this.realizedPnlPct,
    };
  }

  // Битое поле откатывается к значению по умолчанию, а не роняет запуск.
  static from(snapshot, startBalance) {
    const ledger = new Ledger(startBalance);
    if (!snapshot) return ledger;

    ledger.cash = num(snapshot.cash, startBalance);
    ledger.position = num(snapshot.position, 0);
    ledger.entryPrice = num(snapshot.entryPrice, 0);
    ledger.lastPrice = num(snapshot.lastPrice, 0);
    ledger.tradeCount = num(snapshot.tradeCount, 0);
    ledger.realizedPnlPct = num(snapshot.realizedPnlPct, 0);

    // Позиция без цены входа неучитываема — считаем её закрытой.
    if (ledger.position > 0 && ledger.entryPrice <= 0) {
      ledger.cash += ledger.position * ledger.lastPrice;
      ledger.position = 0;
    }
    return ledger;
  }
}

function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}
