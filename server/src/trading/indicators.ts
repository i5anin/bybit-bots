export function closes(candles: readonly { close: number }[]): number[] {
  return candles.map(c => c.close);
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function sma(values: readonly number[], period: number): number | null {
  if (values.length < period) return null;
  return sum(values.slice(-period)) / period;
}

// EMA с затравкой из SMA первых period значений окна.
export function ema(values: readonly number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = sum(values.slice(0, period)) / period;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
  }
  return prev;
}

export function emaSeries(values: readonly number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [sum(values.slice(0, period)) / period];
  for (let i = period; i < values.length; i++) {
    out.push(values[i]! * k + out[out.length - 1]! * (1 - k));
  }
  return out;
}

// RSI по простым средним (вариант Катлера), а не по сглаживанию Уайлдера.
export function rsi(values: readonly number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  const slice = values.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i]! - slice[i - 1]!;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function stdDev(values: readonly number[], period: number): number {
  const slice = values.slice(-period);
  const mean = sum(slice) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}
