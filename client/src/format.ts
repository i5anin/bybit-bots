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

// Рубли: меньше 10 ₽ — с копейками (при ставке 1 % изменения — копейки).
export function rub(v: number, sign = false): string {
  const small = Math.abs(v) < 10 && Math.abs(v) >= 0.005;
  const text = money(Math.abs(v), small ? 2 : 0);
  const r = small ? Math.round(v * 100) : Math.round(v);
  if (!sign) return `${r < 0 ? '−' : ''}${text} ₽`;
  return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${text} ₽`;
}

// Годовые; null — ещё мало данных (первые часы сессии).
export function apr(v: number | null): string {
  return v === null ? '—' : `${signed(v, 1)} %`;
}

export function pairName(symbol: string): string {
  return symbol.replace(/USDT$/, '');
}

export function shortName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, '') || name;
}

// Доля комиссий от дохода до комиссий; null — дохода до комиссий не было.
export function feesShare(pct: number | null): string {
  return pct === null ? 'съели весь доход' : `${money(pct, 1)} % дохода`;
}

// Ячейка «Комиссии» сводной таблицы: доллары и доля от дохода.
export function feesText(g: { feesUsd: number; feesShareOfIncomePct: number | null }): string {
  return `${money(g.feesUsd, 2)} $ · ${feesShare(g.feesShareOfIncomePct)}`;
}

// Холдеры (DCA с усреднением) подсвечиваются в таблицах, чтобы их было видно среди остальных.
export function isHolder(strategyName: string): boolean {
  return strategyName.startsWith('DCA-холдер');
}
