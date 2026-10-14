// Виртуальный леджер одного бота: бумажная торговля без реальных ордеров.
// Состояние сериализуемо — бот продолжает счёт после рестарта контейнера.
import type { Costs, LedgerSnapshot, LotRules, Trade } from './types.js';

export const NO_COSTS: Readonly<Costs> = Object.freeze({ feePct: 0, slippagePct: 0, lot: null, orderUsdt: 0 });

// Количество для ордера: сумма не меньше минимальной, шаг количества — биржевой,
// округление вверх, чтобы ордер не оказался чуть меньше минимума.
export function lotQty(price: number, lot: LotRules, orderUsdt = 0): number {
  const amount = Math.max(orderUsdt, lot.minOrderAmt || 0);
  let qty = amount / price;
  if (lot.qtyStep > 0) {
    const steps = Math.ceil(qty / lot.qtyStep - 1e-9);
    qty = Number((steps * lot.qtyStep).toFixed(decimals(lot.qtyStep)));
  }
  return Math.max(qty, lot.minOrderQty || 0);
}

function decimals(step: number): number {
  const text = String(step);
  return text.includes('.') ? (text.split('.')[1]?.length ?? 0) : 0;
}

export class Ledger {
  readonly costs: Costs;
  cash: number;
  position = 0; // количество базового актива в позиции
  entryPrice = 0;
  lastPrice = 0;
  tradeCount = 0; // за всю историю, а не за текущий запуск
  realizedPnlPct = 0; // сумма pnl% по закрытым сделкам
  entryCost = 0; // сколько денег ушло на вход, вместе с комиссией
  feesPaid = 0;

  constructor(startBalance: number, costs: Partial<Costs> = NO_COSTS) {
    this.costs = { ...NO_COSTS, ...costs };
    this.cash = startBalance;
  }

  get equity(): number {
    return this.cash + this.position * this.lastPrice;
  }

  mark(price: number): void {
    this.lastPrice = price;
  }

  buy(price: number): Trade | null {
    if (this.position > 0) return null; // уже в позиции
    const fee = this.costs.feePct / 100;
    const fill = price * (1 + this.costs.slippagePct / 100);
    // С правилами лота берём минимальный ордер, без них — весь счёт.
    const lot = this.costs.lot;
    const qty = lot && lot.minOrderAmt > 0
      ? lotQty(fill, lot, this.costs.orderUsdt)
      : this.cash / fill / (1 + fee);
    const cost = qty * fill;
    const feePaid = cost * fee;
    if (!(qty > 0) || cost + feePaid > this.cash + 1e-9) return null; // на ордер не хватает
    this.feesPaid += feePaid;
    this.entryCost = cost + feePaid;
    this.position = qty;
    this.entryPrice = fill;
    this.cash = Math.max(0, this.cash - cost - feePaid);
    this.tradeCount += 1;
    return { side: 'buy', price, time: Date.now() };
  }

  sell(price: number): Trade | null {
    if (this.position === 0) return null; // нет позиции
    const gross = this.position * price * (1 - this.costs.slippagePct / 100);
    const feePaid = gross * (this.costs.feePct / 100);
    const proceeds = gross - feePaid;
    // Доходность чистая: от всех потраченных на вход денег до полученных на выходе.
    const pnlPct = this.entryCost > 0 ? (proceeds / this.entryCost - 1) * 100 : 0;
    const pnlUsdt = this.entryCost > 0 ? proceeds - this.entryCost : 0;
    this.feesPaid += feePaid;
    this.cash += proceeds;
    this.entryCost = 0;
    this.position = 0;
    this.entryPrice = 0;
    this.tradeCount += 1;
    this.realizedPnlPct += pnlPct;
    return { side: 'sell', price, time: Date.now(), pnlPct, pnlUsdt };
  }

  toJSON(): LedgerSnapshot {
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
  static from(snapshot: Partial<LedgerSnapshot> | null | undefined, startBalance: number, costs?: Partial<Costs>): Ledger {
    const ledger = new Ledger(startBalance, costs);
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

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
