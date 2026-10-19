// Общие типы торгового движка. Формы снимков совпадают с data/state.json
// прежней JS-версии: накопленная статистика переживает переход без сброса.

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Action = 'buy' | 'sell' | 'hold';

// Реальное состояние на момент восстановления или несостоявшейся сделки.
export interface StrategyContext {
  price: number;
  downtimeSec: number;
  inPosition: boolean;
  entryPrice: number;
}

export interface Strategy {
  readonly name: string;
  signal(candles: readonly Candle[]): Action;
  // Стратегии с собственной памятью сохраняют её между перезапусками.
  toJSON?(): unknown;
  restore?(snapshot: unknown, ctx: StrategyContext): void;
  // Сделка не исполнилась — стратегия сверяет свою позицию с леджером.
  sync?(ctx: StrategyContext): void;
}

export type StrategyFactory = () => Strategy;

// Правила биржи на размер ордера.
export interface LotRules {
  minOrderAmt: number;
  minOrderQty: number;
  qtyStep: number;
}

// Издержки и размер сделки: % за сторону, правила лота, желаемая сумма.
export interface Costs {
  feePct: number;
  slippagePct: number;
  lot: LotRules | null;
  orderUsdt: number;
  // Ставка — доля счёта на одну сделку, %. 0 — минимальный ордер биржи.
  orderPct: number;
  // Соблюдать минимальный ордер биржи. В тесте со ставкой 1 % от 1000 ₽
  // (0.12 $) это невозможно — минимум Bybit около 5 $, — поэтому выключено.
  enforceMinOrder: boolean;
}

export interface LedgerSnapshot {
  cash: number;
  position: number;
  entryPrice: number;
  lastPrice: number;
  tradeCount: number;
  realizedPnlPct: number;
  entryCost: number;
  feesPaid: number;
}

export interface Trade {
  side: 'buy' | 'sell';
  price: number;
  time: number;
  pnlPct?: number;
  pnlUsdt?: number; // чистая прибыль закрытой сделки в деньгах, после всех издержек
}

export interface StepResult {
  action: Action;
  trade: Trade | null;
  price: number;
  equity: number;
  position: number;
}

export interface BotSnapshot {
  ledger: LedgerSnapshot;
  lastSignalCandle: number | null;
  strategy?: unknown;
}

export interface MetaSnapshot {
  meta: true;
  ledger: LedgerSnapshot;
  lastSignalCandle: number | null;
  leader: string | null;
  history: Record<string, number[]>;
}

// Всё, что движок сохраняет и откуда восстанавливается.
export interface EngineState {
  version: number;
  symbol: string;
  symbols?: string[]; // пары сессии; нет — одна пара symbol
  sessionStartedAt?: string; // начало сессии — от него считаются годовые
  orderPct?: number;
  enforceMinOrder?: boolean;
  lots?: Record<string, LotRules>; // правила ордера по парам — для подписи минимальной ставки
  interval: string;
  startBalance: number;
  market: string;
  feePct: number;
  slippagePct: number;
  orderUsdt: number;
  updatedAt: string;
  runs: number;
  uptimeSecTotal: number;
  lastRun: RunInfo | null;
  currentRun: RunInfo | null;
  bots: Record<string, Partial<BotSnapshot> & Partial<MetaSnapshot>>;
  feed?: FeedStatus;
}

// Откуда и насколько свежие данные: по ним видно, не решают ли боты по
// устаревшей цене.
export interface FeedStatus {
  source: 'поток' | 'опрос'; // что запустило последний тик
  streamConnected: boolean;
  lagSec: number | null; // через сколько секунд после закрытия свечи принято решение
  fetchMs: number | null; // сколько шёл ответ биржи на запрос свечей
  staleSkips: number; // тиков пропущено из-за устаревших данных с запуска
}

export interface RunInfo {
  runId: string;
  startedAt: string;
  runUptimeSec: number;
  ticks: number;
}

// Общий интерфейс обычного бота и мета-бота для цикла движка.
export interface Trader {
  readonly strategy: { readonly name: string };
  readonly ledger: { readonly equity: number; readonly position: number; readonly tradeCount: number };
  step(candles: readonly Candle[], price: number): StepResult;
  snapshot(): BotSnapshot | MetaSnapshot;
}
