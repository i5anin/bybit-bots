import { afterEach, describe, expect, it, vi } from 'vitest';
import { BybitClient, parseLotRules, splitClosed, withRetry } from '../src/market/bybit.js';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const kline = (t: number, close = 1) => [String(t), '1', '2', '0.5', String(close), '10'];
const opts = { baseUrl: 'https://api.test', category: 'spot', timeoutMs: 1000 };

afterEach(() => vi.unstubAllGlobals());

describe('BybitClient', () => {
  it('без своего fetch берёт глобальный и разворачивает свечи в хронологию', async () => {
    const fetchMock = vi.fn(async () => ok({ retCode: 0, retMsg: 'OK', result: { list: [kline(2000, 3), kline(1000, 2)] } }));
    vi.stubGlobal('fetch', fetchMock);
    const candles = await new BybitClient(opts).klines('DOGEUSDT', '1');
    expect(candles.map(c => c.time)).toEqual([1000, 2000]);
    expect(candles[1]).toMatchObject({ open: 1, high: 2, low: 0.5, close: 3, volume: 10 });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/v5/market/kline?category=spot&symbol=DOGEUSDT&interval=1&limit=100');
  });

  it('HTTP-ошибка и ошибка API становятся исключениями', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })));
    await expect(new BybitClient(opts).klines('X', '1')).rejects.toThrow('Bybit /v5/market/kline: HTTP 502');
    vi.stubGlobal('fetch', vi.fn(async () => ok({ retCode: 10001, retMsg: 'bad' })));
    await expect(new BybitClient(opts).tickers()).rejects.toThrow('Bybit API error: bad');
  });

  it('пустой ответ — пустые свечи и тикеры', async () => {
    const fetchFn = vi.fn(async () => ok({ retCode: 0, retMsg: 'OK' })) as unknown as typeof fetch;
    const client = new BybitClient({ ...opts, fetch: fetchFn });
    expect(await client.klines('X', '1')).toEqual([]);
    expect(await client.tickers()).toEqual([]);
  });

  it('тикеры переводятся в числа, без символа — пустая строка', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ retCode: 0, retMsg: 'OK', result: { list: [
      { symbol: 'DOGEUSDT', lastPrice: '0.1', highPrice24h: '0.2', lowPrice24h: '0.05', price24hPcnt: '0.01', turnover24h: '1000' },
      { lastPrice: '1' },
    ] } })));
    const list = await new BybitClient(opts).tickers();
    expect(list[0]).toEqual({ symbol: 'DOGEUSDT', lastPrice: 0.1, highPrice24h: 0.2, lowPrice24h: 0.05, price24hPcnt: 0.01, turnover24h: 1000 });
    expect(list[1]!.symbol).toBe('');
  });

  it('правила лота берутся из instruments-info', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ retCode: 0, retMsg: 'OK', result: { list: [
      { lotSizeFilter: { minOrderAmt: '5', minOrderQty: '1', basePrecision: '0.1' } },
    ] } })));
    expect(await new BybitClient(opts).lotRules('DOGEUSDT')).toEqual({ minOrderAmt: 5, minOrderQty: 1, qtyStep: 0.1 });
  });

  describe('history', () => {
    // Страница как у Bybit: от новых к старым.
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => kline(from + i * 60_000)).reverse();

    it('листает назад страницами по 1000 и отбрасывает незакрытую свечу', async () => {
      const to = 2000 * 60_000 + 30_000;
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(ok({ retCode: 0, retMsg: 'OK', result: { list: page(1001 * 60_000, 1000) } }))
        .mockResolvedValueOnce(ok({ retCode: 0, retMsg: 'OK', result: { list: page(500 * 60_000, 502) } }));
      vi.stubGlobal('fetch', fetchMock);
      const candles = await new BybitClient(opts).history('X', '1', 500 * 60_000, to);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(candles[0]!.time).toBe(500 * 60_000);
      expect(candles.at(-1)!.time).toBe(1999 * 60_000);
      expect(new Set(candles.map(c => c.time)).size).toBe(candles.length);
    });

    it('останавливается на пустой странице и когда дошла до начала', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ok({ retCode: 0, retMsg: 'OK', result: { list: [] } })));
      expect(await new BybitClient(opts).history('X', '1', 0, 1000)).toEqual([]);
      vi.stubGlobal('fetch', vi.fn(async () => ok({ retCode: 0, retMsg: 'OK', result: { list: page(0, 1000) } })));
      expect(await new BybitClient(opts).history('X', '1', 0, 2000 * 60_000)).toHaveLength(1000);
    });

    it('без to берёт текущее время, а при from ≥ to ничего не запрашивает', async () => {
      const fetchMock = vi.fn(async () => ok({ retCode: 0, retMsg: 'OK', result: { list: [kline(0)] } }));
      vi.stubGlobal('fetch', fetchMock);
      expect(await new BybitClient(opts).history('X', '1', 0)).toHaveLength(1);
      expect(await new BybitClient(opts).history('X', '1', 10, 5)).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('parseLotRules', () => {
  it('без правил — ошибка, без полей — нули', () => {
    expect(() => parseLotRules({}, 'X')).toThrow('Нет правил лота для X');
    expect(parseLotRules({ result: { list: [{ lotSizeFilter: {} }] } }, 'X')).toEqual({ minOrderAmt: 0, minOrderQty: 0, qtyStep: 0 });
  });
});

describe('splitClosed', () => {
  it('закрытые — по времени, цена — последней свечи; без свечей цены нет', () => {
    const c = (time: number, close: number) => ({ time, open: 1, high: 1, low: 1, close, volume: 1 });
    expect(splitClosed([c(0, 1), c(60_000, 2)], '1', 100_000)).toEqual({ closed: [c(0, 1)], price: 2 });
    expect(splitClosed([], 1).price).toBeNull();
  });
});

describe('withRetry', () => {
  it('повторяет с растущей паузой до успеха', async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValueOnce(new Error('a')).mockRejectedValueOnce(new Error('b')).mockResolvedValue(7);
    const onError = vi.fn();
    expect(await withRetry(fn, { baseMs: 10, maxMs: 15, onError, sleep: async ms => { delays.push(ms); } })).toBe(7);
    expect(delays).toEqual([10, 15]);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('после последней попытки пробрасывает ошибку; по умолчанию ждёт через setTimeout', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockRejectedValue(new Error('нет'));
      const done = withRetry(fn, { attempts: 2, baseMs: 5 });
      const check = expect(done).rejects.toThrow('нет');
      await vi.advanceTimersByTimeAsync(5);
      await check;
      expect(fn).toHaveBeenCalledTimes(2);
      await expect(withRetry(fn, { attempts: 1 })).rejects.toThrow('нет');
    } finally {
      vi.useRealTimers();
    }
  });

  it('без опций успех с первого раза', async () => {
    expect(await withRetry(async () => 1)).toBe(1);
  });
});
