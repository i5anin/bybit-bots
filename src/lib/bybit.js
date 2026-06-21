const BASE_URL = 'https://api-testnet.bybit.com';

// Публичный эндпоинт, ключи не нужны — котировки реальные с тестовой сети Bybit.
export async function fetchKlines(symbol, interval, limit = 100) {
  const url = `${BASE_URL}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;
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
