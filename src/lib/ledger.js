// Виртуальный леджер одного бота: бумажная торговля без реальных ордеров.
// Состояние сериализуемо — бот продолжает счёт после рестарта контейнера.
// Издержки исполнения, % за сторону: комиссия тейкера Bybit spot и проскальзывание.
const FEE = Number(process.env.FEE_PCT ?? 0.1) / 100;
const SLIPPAGE = Number(process.env.SLIPPAGE_PCT ?? 0.02) / 100;

// Размер одной сделки: минимальный ордер биржи (ORDER_USDT поверх него, если задан).
let lotRules = { minOrderAmt: 0, minOrderQty: 0, qtyStep: 0 };
const ORDER_USDT = Number(process.env.ORDER_USDT || 0);
export function setLotRules(rules) {
  lotRules = rules;
}

function orderQty(price) {
  const amount = Math.max(ORDER_USDT, lotRules.minOrderAmt);
  let qty = amount / price;
  if (lotRules.qtyStep > 0) qty = Math.ceil(qty / lotRules.qtyStep - 1e-9) * lotRules.qtyStep;
  return Math.max(qty, lotRules.minOrderQty);
}

export class Ledger {
  constructor(startBalance) {
    this.cash = startBalance;
    this.position = 0; // количество базового актива в позиции
    this.entryPrice = 0;
    this.lastPrice = 0;
    this.tradeCount = 0; // за всю историю, а не за текущий запуск
    this.realizedPnlPct = 0; // сумма pnl% по закрытым сделкам
    this.entryCost = 0; // сколько денег ушло на вход, вместе с комиссией
    this.feesPaid = 0;
  }

  get equity() {
    return this.cash + this.position * this.lastPrice;
  }

  mark(price) {
    this.lastPrice = price;
  }

  buy(price) {
    if (this.position > 0) return null; // уже в позиции
    const fill = price * (1 + SLIPPAGE);
    // Берём минимальный лот, а не весь счёт; без правил лота — весь счёт, как раньше.
    const qty = lotRules.minOrderAmt > 0 ? orderQty(fill) : this.cash / fill / (1 + FEE);
    const cost = qty * fill;
    const fee = cost * FEE;
    if (cost + fee > this.cash + 1e-9) return null; // денег на минимальный ордер не хватает
    this.feesPaid += fee;
    this.entryCost = cost + fee;
    this.position = qty;
    this.entryPrice = fill;
    this.cash -= cost + fee;
    this.tradeCount += 1;
    return { side: 'buy', price, time: Date.now() };
  }

  sell(price) {
    if (this.position === 0) return null; // нет позиции
    const gross = this.position * price * (1 - SLIPPAGE);
    const fee = gross * FEE;
    this.feesPaid += fee;
    const proceeds = gross - fee;
    this.cash += proceeds;
    // Доходность чистая: от всех потраченных на вход денег до полученных на выходе.
    const pnlPct = this.entryCost > 0 ? (proceeds / this.entryCost - 1) * 100 : 0;
    this.entryCost = 0;
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
      entryCost: this.entryCost,
      feesPaid: this.feesPaid,
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
    ledger.entryCost = num(snapshot.entryCost, 0);
    ledger.feesPaid = num(snapshot.feesPaid, 0);

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
