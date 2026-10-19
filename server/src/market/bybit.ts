import type { Candle, LotRules } from '../trading/types.js';
import type { Ticker } from './volatility.js';

interface BybitResponse<T> {
  retCode: number;
  retMsg: string;
  result?: { list?: T[] };
}

type KlineRow = [string, string, string, string, string, string, ...string[]];

interface InstrumentRow {
  lotSizeFilter?: { minOrderAmt?: string; minOrderQty?: string; basePrecision?: string };
}

export interface BybitOptions {
  baseUrl: string;
  category: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

// Публичный REST Bybit, ключи не нужны.
export class BybitClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: BybitOptions) {
    this.fetchFn = options.fetch ?? fetch;
  }

  private async getJson<T>(path: string): Promise<BybitResponse<T>> {
    // Без таймаута зависший запрос держал бы тик вечно, и бот молча вставал.
    const res = await this.fetchFn(`${this.options.baseUrl}${path}`, {
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!res.ok) throw new Error(`Bybit ${path.split('?')[0]}: HTTP ${res.status}`);
    const json = (await res.json()) as BybitResponse<T>;
    if (json.retCode !== 0) throw new Error(`Bybit API error: ${json.retMsg}`);
    return json;
  }

  async klines(symbol: string, interval: string, limit = 100): Promise<Candle[]> {
    const { category } = this.options;
    return parseKlines(await this.getJson<KlineRow>(
      `/v5/market/kline?category=${category}&symbol=${symbol}&interval=${interval}&limit=${limit}`,
    ));
  }

  // История свечей за период: Bybit отдаёт не больше 1000 за запрос,
  // поэтому листаем назад от to. Незакрытая последняя свеча отбрасывается.
  async history(symbol: string, interval: string, from: number, to = Date.now()): Promise<Candle[]> {
    const { category } = this.options;
    const byTime = new Map<number, Candle>();
    let end = to;
    while (end > from) {
      const page = parseKlines(await this.getJson<KlineRow>(
        `/v5/market/kline?category=${category}&symbol=${symbol}&interval=${interval}&start=${from}&end=${end}&limit=1000`,
      ));
      if (!page.length) break;
      for (const c of page) byTime.set(c.time, c);
      const oldest = page[0]!.time;
      if (oldest <= from || page.length < 1000) break;
      end = oldest - 1;
    }
    const ms = Number(interval) * 60_000;
    return [...byTime.values()].sort((a, b) => a.time - b.time).filter(c => c.time + ms <= to);
  }

  // Тикеры всех пар категории: цена, размах и оборот за 24 часа.
  async tickers(): Promise<Ticker[]> {
    const json = await this.getJson<Record<string, string>>(`/v5/market/tickers?category=${this.options.category}`);
    return (json.result?.list ?? []).map(r => ({
      symbol: r.symbol ?? '',
      lastPrice: Number(r.lastPrice),
      highPrice24h: Number(r.highPrice24h),
      lowPrice24h: Number(r.lowPrice24h),
      price24hPcnt: Number(r.price24hPcnt),
      turnover24h: Number(r.turnover24h),
    }));
  }

  async lotRules(symbol: string): Promise<LotRules> {
    const { category } = this.options;
    return parseLotRules(
      await this.getJson<InstrumentRow>(`/v5/market/instruments-info?category=${category}&symbol=${symbol}`),
      symbol,
    );
  }
}

// Bybit отдаёт свечи от новых к старым — разворачиваем в хронологический порядок.
export function parseKlines(json: { result?: { list?: KlineRow[] } }): Candle[] {
  return (json.result?.list ?? [])
    .map(([startTime, open, high, low, close, volume]) => ({
      time: Number(startTime),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    }))
    .reverse();
}

// Биржевые ограничения на ордер: минимальная сумма и шаг количества.
export function parseLotRules(json: { result?: { list?: InstrumentRow[] } }, symbol: string): LotRules {
  const lot = json.result?.list?.[0]?.lotSizeFilter;
  if (!lot) throw new Error(`Нет правил лота для ${symbol}`);
  return {
    minOrderAmt: Number(lot.minOrderAmt ?? 0),
    minOrderQty: Number(lot.minOrderQty ?? 0),
    qtyStep: Number(lot.basePrecision ?? 0),
  };
}

// Делит свечи на закрытые (по ним считается сигнал) и текущую цену (по ней
// исполнение). Закрытость определяется по времени, а не «последняя — открытая»:
// если биржа вдруг не вернёт текущую свечу, сигнал всё равно не потеряется.
export function splitClosed(candles: readonly Candle[], intervalMin: string | number, now = Date.now()) {
  const ms = Number(intervalMin) * 60_000;
  const closed = candles.filter(c => c.time + ms <= now);
  const last = candles[candles.length - 1];
  return { closed, price: last ? last.close : null };
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  onError?: (err: unknown, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

// Повтор с растущей паузой: 5, 10, 20 с… но не дольше минуты между попытками.
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 5, baseMs = 5000, maxMs = 60_000, onError } = options;
  const wait = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      const delayMs = Math.min(maxMs, baseMs * 2 ** (i - 1));
      onError?.(err, delayMs);
      await wait(delayMs);
    }
  }
}
