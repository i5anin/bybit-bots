// Числа и даты для панели — в русской локали.

export function fixed(v: number, digits = 2): string {
  return Number(v).toFixed(digits);
}

export function money(v: number, digits = 2): string {
  return Number(v).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function signed(v: number, digits = 2): string {
  return (v > 0 ? '+' : '') + fixed(v, digits);
}

// Знаков после запятой — по величине: DOGE 0.08454, ETH 2450.3.
export function price(v: number): string {
  return fixed(v, v < 1 ? 5 : v < 100 ? 3 : 1);
}

export function trend(v: number): '' | 'up' | 'down' {
  return v > 0 ? 'up' : v < 0 ? 'down' : '';
}

export function hours(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h} ч ${m} м` : `${m} м`;
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { hour12: false });
}

export function time(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour12: false });
}

// Точки ломаной для графика-искры; null — рисовать нечего.
export function sparkPoints(values: readonly number[], w: number, h: number): string | null {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / span) * (h - 3) - 1.5;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}
