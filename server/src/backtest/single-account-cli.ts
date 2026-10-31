import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BybitClient } from '../market/bybit.js';
import { runSingleAccount, SINGLE_ACCOUNT_DEFAULTS, type MarketHistory } from './single-account.js';

/** Загружает непрерывную часовую историю четырёх заранее заданных ликвидных пар.
 * main использует локальный кэш для повторяемости; ошибки биржи не заменяются
 * вымышленным лотом. SHA-256 исходных данных записывается в отчёт.
 */
async function loadMarkets(cacheDir: string): Promise<MarketHistory[]> {
  const client = new BybitClient({ baseUrl: 'https://api.bybit.com', category: 'spot', timeoutMs: 30_000 });
  const end = Date.parse('2026-10-30T00:00:00Z');
  await mkdir(cacheDir, { recursive: true });
  const markets: MarketHistory[] = [];
  for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT']) {
    const file = `${cacheDir}/${symbol}.json`;
    let market: MarketHistory;
    try {
      market = JSON.parse(await readFile(file, 'utf8')) as MarketHistory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      market = { symbol, lot: await client.lotRules(symbol),
        candles: await client.history(symbol, '60', end - 365 * 86_400_000, end) };
      await writeFile(file, JSON.stringify(market));
    }
    if (market.symbol !== symbol) throw new Error(`Неверная пара в кэше: ${file}`);
    markets.push(market);
  }
  return markets;
}

/** Выполняет ограниченный подбор девяти окон только на участке разработки.
 * Последние 60 дней используются после выбора; первоначальные результаты этого
 * периода уже изучались, поэтому это повторная историческая проверка, а не
 * нетронутая независимая выборка. Все попытки сохраняются, убытки не скрываются.
 * Команда из корня: npm run single-account -w server (cwd нормализуется ниже).
 */
export async function main(): Promise<void> {
  const root = new URL('../../../', import.meta.url);
  const markets = await loadMarkets(fileURLToPath(new URL('builds/single-bot-cache/', root)));
  const from = Date.parse('2026-02-05T00:00:00Z');
  const holdout = Date.parse('2026-08-31T00:00:00Z');
  const to = Date.parse('2026-10-30T00:00:00Z');
  const trials = [];
  for (const trainDays of [30, 60, 90]) {
    for (const tradeDays of [7, 14, 30]) {
      const options = { ...SINGLE_ACCOUNT_DEFAULTS, trainDays, tradeDays };
      const development = runSingleAccount(markets, from, holdout, options);
      trials.push({ options, development });
      console.log(`${trainDays}/${tradeDays}: ${development.endRub.toFixed(2)} ₽; сделок ${development.periods.reduce((n, p) => n + p.trades, 0)}`);
    }
  }
  const selected = [...trials].sort((a, b) => b.development.pnlRub - a.development.pnlRub)[0]!;
  const validation = runSingleAccount(markets, holdout, to, selected.options);
  const stressed = runSingleAccount(markets, holdout, to, {
    ...selected.options, feePct: selected.options.feePct * 2, slippagePct: selected.options.slippagePct * 2,
  });
  const checks = {
    positiveDevelopment: selected.development.pnlRub > 0,
    positiveValidation: validation.pnlRub > 0,
    positiveDoubleCosts: stressed.pnlRub > 0,
    enoughValidationTrades: validation.periods.reduce((n, p) => n + p.trades, 0) >= 10,
    drawdownWithin8Pct: validation.maxDrawdownPct <= 8,
    beatsReferenceDeposit: validation.pnlRub > selected.options.startRub * 0.16 * ((to - holdout) / 86_400_000) / 365,
  };
  const report = { createdAt: new Date().toISOString(), from, holdout, to,
    limitations: ['Повторная историческая проверка; контрольный участок ранее просматривался.',
      'Текущие правила лота применены к прошлой истории.',
      'Фиксированный курс RUB/USDT, без валютной переоценки.',
      'Просадка по открытиям/закрытиям; внутрисвечной риск и ликвидность не моделируются.',
      'Предел убытка проверяется на открытиях свечей и может превышаться при разрывах цены.',
      'Закрытие в конце периода предполагается по последней цене закрытия с издержками.'],
    datasets: markets.map(m => ({ symbol: m.symbol, candles: m.candles.length,
      sha256: createHash('sha256').update(JSON.stringify(m)).digest('hex'), lot: m.lot })),
    trials, selectedOptions: selected.options, validation, stressed,
    referenceDeposit: { annualPct: 16, hypothetical: true,
      incomeRub: selected.options.startRub * 0.16 * ((to - holdout) / 86_400_000) / 365 }, checks,
    accepted: Object.values(checks).every(Boolean) };
  const output = fileURLToPath(new URL('builds/single-account-search-20261030.json', root));
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ selectedOptions: selected.options, validation, stressed, checks, accepted: report.accepted, output }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
