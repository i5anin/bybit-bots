// Бэктест из командной строки:
//   npm run backtest -w server -- --symbols DOGEUSDT,ZKUSDT --intervals 15,60,240 --days 90 --stop 3
// Без --symbols берёт текущую пару и топ-10 по волатильности (как в отчётах).
// Каждая стратегия проверяется в четырёх вариантах: как сейчас, с фильтром
// тренда, со стоп-лоссом и с обоими. Итог — сводка в консоль и все цифры
// в builds/backtest-<дата>.json.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/app-config.js';
import { BybitClient } from '../market/bybit.js';
import { rankVolatility } from '../market/volatility.js';
import { withTrendFilter } from '../trading/strategies/filters.js';
import { ACTIVE_STRATEGIES } from '../trading/strategies/index.js';
import type { Costs, LotRules } from '../trading/types.js';
import { passes, runBacktest, type BacktestResult } from './backtest.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const config = loadConfig();
const client = new BybitClient({ baseUrl: config.bybitBaseUrl, category: config.bybitCategory, timeoutMs: 30_000 });
const days = Number(arg('days') ?? 90);
const stopPct = Number(arg('stop') ?? 3);
const intervals = (arg('intervals') ?? '15,60,240').split(',');
const symbols = arg('symbols')?.split(',')
  ?? [...new Set([config.symbol, ...rankVolatility(await client.tickers()).slice(0, 10).map(v => v.symbol)])];

const VARIANTS = {
  base: { label: 'как сейчас', trend: false, stop: 0 },
  trend: { label: 'фильтр тренда', trend: true, stop: 0 },
  stop: { label: `стоп ${stopPct} %`, trend: false, stop: stopPct },
  both: { label: `тренд + стоп ${stopPct} %`, trend: true, stop: stopPct },
} as const;
const variants = (arg('variants') ?? 'base,trend,stop,both').split(',') as (keyof typeof VARIANTS)[];

const to = Date.now();
const from = to - days * 86_400_000;
const pad = (s: string | number, n: number) => String(s).padStart(n);
const f = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
const short = (name: string) => name.replace(/\s*\(.*?\)/g, '');

interface Run extends BacktestResult { symbol: string; interval: string; variant: string }
const runs: Run[] = [];

for (const symbol of symbols) {
  const lot: LotRules = await client.lotRules(symbol).catch(() => ({ minOrderAmt: 5, minOrderQty: 0, qtyStep: 0 }));
  const costs: Costs = { feePct: config.feePct, slippagePct: config.slippagePct, lot, orderUsdt: config.orderUsdt };
  for (const interval of intervals) {
    try {
      const candles = await client.history(symbol, interval, from, to);
      for (const key of variants) {
        const v = VARIANTS[key];
        const factories = v.trend ? ACTIVE_STRATEGIES.map(fac => withTrendFilter(fac)) : ACTIVE_STRATEGIES;
        const r = runBacktest(candles, factories, {
          startBalance: config.startBalance,
          costs,
          metaWindow: Math.round(1440 / Number(interval)),
          stopLossPct: v.stop,
        });
        runs.push({ symbol, interval, variant: v.label, ...r });
        const span = ((r.to - r.from) / 86_400_000).toFixed(0);
        const ok = r.strategies.filter(s => passes(s, r)).length;
        const best = r.strategies.slice(0, 2).map(s => `${short(s.name)} ${f(s.pnlPct)}%`).join(', ');
        console.log(`${symbol.padEnd(12)} ${pad(interval, 3)}м ${pad(span, 3)}д  ${v.label.padEnd(16)} `
          + `цена ${pad(f(r.marketPct), 6)}%  лот ${pad(f(r.lotHoldPct), 5)}%  прошли ${pad(ok, 2)}/${r.strategies.length}  лучшие: ${best}`);
      }
    } catch (err) {
      console.log(`${symbol.padEnd(12)} ${pad(interval, 3)}м  пропуск: ${(err as Error).message}`);
    }
  }
}

console.log('\n# По вариантам');
for (const label of variants.map(k => VARIANTS[k].label)) {
  const mine = runs.filter(r => r.variant === label);
  const all = mine.flatMap(r => r.strategies);
  const avg = all.reduce((s, x) => s + x.pnlPct, 0) / (all.length || 1);
  const ok = mine.reduce((n, r) => n + r.strategies.filter(s => passes(s, r)).length, 0);
  console.log(`${label.padEnd(16)} средний итог ${pad(f(avg), 6)} %  прошли ${ok} из ${all.length}`);
}

const passed = runs.flatMap(r => r.strategies.filter(s => passes(s, r)).map(s => ({ r, s })))
  .sort((a, b) => b.s.lastPct - a.s.lastPct);
console.log(`\n# Прошли проверку: ${passed.length} (плюс на обоих отрезках и лучше, чем держать лот)`);
for (const { r, s } of passed.slice(0, 30)) {
  console.log(`✅ ${r.symbol} ${r.interval}м ${r.variant} · ${s.name}: ${f(s.pnlPct)} % (2/3 ${f(s.firstPct)}, 1/3 ${f(s.lastPct)}, сделок ${s.trades}, просадка ${s.maxDrawdownPct.toFixed(1)} %)`);
}

const outDir = fileURLToPath(new URL('../../../builds/', import.meta.url));
await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const file = `${outDir}backtest-${stamp}.json`;
await writeFile(file, JSON.stringify({
  days, intervals, symbols, stopPct,
  config: { feePct: config.feePct, slippagePct: config.slippagePct, startBalance: config.startBalance },
  runs,
}, null, 2));
console.log(`\nJSON: ${file}`);
