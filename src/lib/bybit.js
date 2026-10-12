// Публичный REST Bybit, ключи не нужны. По умолчанию — реальный спотовый рынок.
const BASE_URL = process.env.BYBIT_BASE_URL || 'https://api.bybit.com';
const CATEGORY = process.env.BYBIT_CATEGORY || 'spot';
// Без таймаута зависший запрос держал бы тик вечно, и бот молча вставал.
const TIMEOUT_MS = Number(process.env.BYBIT_TIMEOUT_MS || 15000);

export const MARKET = `${BASE_URL.includes('testnet') ? 'testnet' : 'mainnet'}:${CATEGORY}`;

async function getJson(path) {
  const res = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Bybit ${path.split('?')[0]}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.retCode !== 0) throw new Error(`Bybit API error: ${json.retMsg}`);
  return json;
}

// Bybit отдаёт свечи от новых к старым — разворачиваем в хронологический порядок.
export function parseKlines(json) {
  return (json?.result?.list ?? [])
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

// Делит свечи на закрытые (по ним считается сигнал) и текущую цену (по ней
// исполнение). Закрытость определяется по времени, а не «последняя — открытая»:
// если биржа вдруг не вернёт текущую свечу, сигнал всё равно не потеряется.
export function splitClosed(candles, intervalMin, now = Date.now()) {
  const ms = Number(intervalMin) * 60_000;
  const closed = candles.filter(c => c.time + ms <= now);
  const last = candles[candles.length - 1];
  return { closed, price: last ? last.close : null };
}

export async function fetchKlines(symbol, interval, limit = 100) {
  const json = await getJson(
    `/v5/market/kline?category=${CATEGORY}&symbol=${symbol}&interval=${interval}&limit=${limit}`,
  );
  return parseKlines(json);
}

// Биржевые ограничения на ордер: минимальная сумма и шаг количества.
export function parseLotRules(json, symbol) {
  const lot = json?.result?.list?.[0]?.lotSizeFilter;
  if (!lot) throw new Error(`Нет правил лота для ${symbol}`);
  return {
    minOrderAmt: Number(lot.minOrderAmt ?? 0),
    minOrderQty: Number(lot.minOrderQty ?? 0),
    qtyStep: Number(lot.basePrecision ?? 0),
  };
}

export async function fetchLotRules(symbol) {
  const json = await getJson(`/v5/market/instruments-info?category=${CATEGORY}&symbol=${symbol}`);
  return parseLotRules(json, symbol);
}
