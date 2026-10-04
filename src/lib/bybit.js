// Публичный REST Bybit, ключи не нужны. По умолчанию — реальный спотовый рынок.
const BASE_URL = process.env.BYBIT_BASE_URL || 'https://api.bybit.com';
const CATEGORY = process.env.BYBIT_CATEGORY || 'spot';

export const MARKET = `${BASE_URL.includes('testnet') ? 'testnet' : 'mainnet'}:${CATEGORY}`;

export async function fetchKlines(symbol, interval, limit = 100) {
  const url = `${BASE_URL}/v5/market/kline?category=${CATEGORY}&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Bybit kline request failed: ${res.status}`);
  }
  const json = await res.json();
  if (json.retCode !== 0) {
    throw new Error(`Bybit API error: ${json.retMsg}`);
  }
  // Bybit отдаёт свечи от новых к старым — разворачиваем в хронологический порядок.
  return json.result.list
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
export async function fetchLotRules(symbol) {
  const url = `${BASE_URL}/v5/market/instruments-info?category=${CATEGORY}&symbol=${symbol}`;
  const json = await (await fetch(url)).json();
  const lot = json?.result?.list?.[0]?.lotSizeFilter;
  if (!lot) throw new Error(`Нет правил лота для ${symbol}`);
  return {
    minOrderAmt: Number(lot.minOrderAmt ?? 0),
    minOrderQty: Number(lot.minOrderQty ?? 0),
    qtyStep: Number(lot.basePrecision ?? 0),
  };
}
