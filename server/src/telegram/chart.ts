import { Resvg } from '@resvg/resvg-js';

// Картинка для отчёта в Telegram: сверху цена за сутки с отметками сделок,
// снизу — сколько заработал каждый бот. Рисуется в SVG и переводится в PNG
// без браузера и системных библиотек.

export interface ChartPoint {
  time: number; // мс
  price: number;
}

export interface ChartTrade {
  time: number;
  price: number;
  side: 'buy' | 'sell';
}

export interface ChartBar {
  name: string;
  total: number; // ₽ с начала
  period: number | null; // ₽ за час или сутки
  highlight?: boolean;
}

export interface ChartInput {
  title: string;
  subtitle: string;
  prices: readonly ChartPoint[];
  trades: readonly ChartTrade[];
  bars: readonly ChartBar[];
  periodLabel: string; // «за час», «за сутки»
}

const W = 1080;
const PAD = 40;
const C = {
  bg: '#12151c',
  card: '#171b24',
  line: '#252b38',
  text: '#dfe4ee',
  dim: '#7f8798',
  up: '#4ec9a0',
  down: '#ff6b6b',
  price: '#8fb4ff',
  highlight: '#1e2433',
};
const FONT = "DejaVu Sans, 'Segoe UI', Arial, sans-serif";

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function text(x: number, y: number, body: string, attrs = ''): string {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${FONT}" ${attrs}>${esc(body)}</text>`;
}

function rub(v: number, sign = true): string {
  const r = Math.round(v);
  const abs = Math.abs(r).toLocaleString('ru-RU').replace(/\s/g, ' ');
  return `${r > 0 && sign ? '+' : r < 0 ? '−' : sign ? '±' : ''}${abs} ₽`;
}

export function priceLabel(v: number): string {
  return v.toFixed(v < 1 ? 5 : v < 100 ? 3 : 1);
}

// Шкала цены с запасом по краям, чтобы линия не прилипала к рамке.
function priceScale(prices: readonly number[]): [number, number] {
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const pad = (max - min || max * 0.01 || 1) * 0.08;
  return [min - pad, max + pad];
}

function pricePanel(input: ChartInput, top: number, height: number): string {
  const left = 110;
  const right = W - PAD;
  const bottom = top + height;
  const out: string[] = [
    `<rect x="${PAD / 2}" y="${top - 20}" width="${W - PAD}" height="${height + 60}" rx="14" fill="${C.card}" stroke="${C.line}"/>`,
  ];
  const pts = input.prices;
  if (pts.length < 2) {
    out.push(text(W / 2, top + height / 2, 'нет данных о цене', `fill="${C.dim}" font-size="24" text-anchor="middle"`));
    return out.join('');
  }
  const [lo, hi] = priceScale(pts.map(p => p.price));
  const t0 = pts[0]!.time;
  const t1 = pts[pts.length - 1]!.time;
  const x = (t: number) => left + ((t - t0) / (t1 - t0 || 1)) * (right - left);
  const y = (p: number) => bottom - ((p - lo) / (hi - lo)) * height;

  for (let i = 0; i <= 4; i += 1) {
    const v = lo + ((hi - lo) * i) / 4;
    const gy = y(v);
    out.push(`<line x1="${left}" y1="${gy.toFixed(1)}" x2="${right}" y2="${gy.toFixed(1)}" stroke="${C.line}" stroke-width="1"/>`);
    out.push(text(left - 12, gy + 7, priceLabel(v), `fill="${C.dim}" font-size="19" text-anchor="end"`));
  }
  // Подписи времени — на круглых часах, кратных трём, по местному времени сервера.
  for (const p of pts) {
    const d = new Date(p.time);
    if (d.getMinutes() === 0 && d.getHours() % 3 === 0) {
      const gx = x(p.time);
      out.push(`<line x1="${gx.toFixed(1)}" y1="${top}" x2="${gx.toFixed(1)}" y2="${bottom}" stroke="${C.line}" stroke-dasharray="4 6"/>`);
      out.push(text(gx, bottom + 30, `${String(d.getHours()).padStart(2, '0')}:00`, `fill="${C.dim}" font-size="19" text-anchor="middle"`));
    }
  }

  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.time).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ');
  out.push(`<path d="${path} L${right},${bottom} L${left},${bottom} Z" fill="url(#area)"/>`);
  out.push(`<path d="${path}" fill="none" stroke="${C.price}" stroke-width="3" stroke-linejoin="round"/>`);

  // Сделки ботов: покупка — зелёный треугольник вверх, продажа — красный вниз.
  for (const t of input.trades) {
    if (t.time < t0 || t.time > t1 || t.price < lo || t.price > hi) continue;
    const tx = x(t.time);
    const ty = y(t.price);
    const shape = t.side === 'buy'
      ? `${tx},${ty + 4} ${tx - 7},${ty + 16} ${tx + 7},${ty + 16}`
      : `${tx},${ty - 4} ${tx - 7},${ty - 16} ${tx + 7},${ty - 16}`;
    out.push(`<polygon points="${shape}" fill="${t.side === 'buy' ? C.up : C.down}" fill-opacity="0.85"/>`);
  }

  const last = pts[pts.length - 1]!;
  out.push(`<circle cx="${x(last.time).toFixed(1)}" cy="${y(last.price).toFixed(1)}" r="6" fill="${C.price}"/>`);
  return out.join('');
}

function barsPanel(input: ChartInput, top: number, rowH: number): string {
  const bars = input.bars;
  const nameRight = 400;
  const zoneLeft = nameRight + 20;
  const zoneRight = W - 230;
  // Шкала — только по заработку с начала: изменение за час в десятки раз
  // меньше, на общей шкале его полоска не видна, поэтому оно подписано числом.
  const values = bars.map(b => b.total);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const x = (v: number) => zoneLeft + ((v - lo) / span) * (zoneRight - zoneLeft);
  const zero = x(0);
  const height = bars.length * rowH;
  const hasPeriod = bars.some(b => b.period !== null);

  const out: string[] = [
    `<rect x="${PAD / 2}" y="${top - 70}" width="${W - PAD}" height="${height + 100}" rx="14" fill="${C.card}" stroke="${C.line}"/>`,
    text(PAD, top - 30, 'Заработок ботов с начала', `fill="${C.text}" font-size="26" font-weight="bold"`),
    hasPeriod ? text(W - PAD, top - 30, `ниже — ${input.periodLabel}`, `fill="${C.dim}" font-size="20" text-anchor="end"`) : '',
    `<line x1="${zero.toFixed(1)}" y1="${top - 6}" x2="${zero.toFixed(1)}" y2="${top + height}" stroke="${C.dim}" stroke-width="1.5"/>`,
  ];

  bars.forEach((b, i) => {
    const rowTop = top + i * rowH;
    const mid = rowTop + rowH / 2;
    if (b.highlight) {
      out.push(`<rect x="${PAD - 10}" y="${rowTop + 2}" width="${W - 2 * PAD + 20}" height="${rowH - 4}" rx="8" fill="${C.highlight}"/>`);
    }
    const name = b.name.length > 26 ? `${b.name.slice(0, 25)}…` : b.name;
    out.push(text(nameRight, mid + 7, name, `fill="${C.text}" font-size="21" text-anchor="end"${b.highlight ? ' font-weight="bold"' : ''}`));

    const tx = x(b.total);
    out.push(`<rect x="${Math.min(zero, tx).toFixed(1)}" y="${(mid - 11).toFixed(1)}" width="${Math.max(2, Math.abs(tx - zero)).toFixed(1)}" height="22" rx="4" fill="${b.total >= 0 ? C.up : C.down}"/>`);
    out.push(text(W - PAD, b.period === null ? mid + 8 : mid + 2, rub(b.total), `fill="${b.total >= 0 ? C.up : C.down}" font-size="22" font-weight="bold" text-anchor="end"`));
    if (b.period !== null) {
      const color = Math.round(b.period) > 0 ? C.up : Math.round(b.period) < 0 ? C.down : C.dim;
      out.push(text(W - PAD, mid + 22, `${input.periodLabel} ${rub(b.period)}`, `fill="${color}" font-size="16" text-anchor="end"`));
    }
  });
  return out.join('');
}

export function renderChartSvg(input: ChartInput): string {
  const priceTop = 150;
  const priceH = 340;
  const rowH = 50;
  const barsTop = priceTop + priceH + 140;
  const H = barsTop + input.bars.length * rowH + 50;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0" stop-color="${C.price}" stop-opacity="0.28"/><stop offset="1" stop-color="${C.price}" stop-opacity="0"/>`,
    `</linearGradient></defs>`,
    `<rect width="${W}" height="${H}" fill="${C.bg}"/>`,
    text(PAD, 62, input.title, `fill="${C.text}" font-size="36" font-weight="bold"`),
    text(PAD, 104, input.subtitle, `fill="${C.dim}" font-size="22"`),
    pricePanel(input, priceTop, priceH),
    barsPanel(input, barsTop, rowH),
    '</svg>',
  ].join('');
}

export function svgToPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' },
    fitTo: { mode: 'width', value: W },
  });
  return resvg.render().asPng();
}

export function renderChartPng(input: ChartInput): Buffer {
  return svgToPng(renderChartSvg(input));
}
