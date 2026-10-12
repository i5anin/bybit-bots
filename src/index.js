import 'dotenv/config';
import { fetchKlines, fetchLotRules, splitClosed, MARKET } from './lib/bybit.js';
import { logEquity, logTrade, logRun } from './lib/logger.js';
import { loadState, saveState, STATE_VERSION } from './lib/state.js';
import { formatDuration } from './lib/time.js';
import { Bot } from './bot.js';
import { MetaBot, META_DEFAULTS, metaName } from './metaBot.js';

import { createStrategy as smaCrossover } from './strategies/smaCrossover.js';
import { createStrategy as emaCrossover } from './strategies/emaCrossover.js';
import { createStrategy as rsiStrategy } from './strategies/rsiStrategy.js';
import { createStrategy as macdStrategy } from './strategies/macdStrategy.js';
import { createStrategy as bollingerBands } from './strategies/bollingerBands.js';
import { createStrategy as stochastic } from './strategies/stochastic.js';
import { createStrategy as breakout } from './strategies/breakout.js';
import { createStrategy as meanReversion } from './strategies/meanReversion.js';
import { createStrategy as emaRibbon } from './strategies/emaRibbon.js';
import { createStrategy as martingaleLite } from './strategies/martingaleLite.js';
import { createStrategy as adaptiveRegime } from './strategies/adaptiveRegime.js';

const SYMBOL = process.env.SYMBOL || 'BTCUSDT';
const INTERVAL = process.env.INTERVAL || '5';
const START_BALANCE = Number(process.env.START_BALANCE || 100);
const POLL_MS = Number(process.env.POLL_MS || 60000);
const FEE_PCT = Number(process.env.FEE_PCT ?? 0.1);
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT ?? 0.02);
const ORDER_USDT = Number(process.env.ORDER_USDT || 0);
const META_WINDOW = Number(process.env.META_WINDOW_CANDLES || META_DEFAULTS.windowCandles);
const META_MARGIN = Number(process.env.META_SWITCH_MARGIN_PCT ?? META_DEFAULTS.switchMarginPct);

const factories = [
  smaCrossover,
  emaCrossover,
  rsiStrategy,
  macdStrategy,
  bollingerBands,
  stochastic,
  breakout,
  meanReversion,
  emaRibbon,
  martingaleLite,
  adaptiveRegime,
]; // 11 ботов: десять с жёстким приёмом и один адаптивный (grid избыточен рядом с martingale — оставлен в strategies/ на выбор)

const lotRules = await fetchLotRules(SYMBOL);
const costs = { feePct: FEE_PCT, slippagePct: SLIPPAGE_PCT, lot: lotRules, orderUsdt: ORDER_USDT };

const runStartedAt = Date.now();
const runId = new Date(runStartedAt).toISOString();

const saved = await loadState();
const restored = isCompatible(saved) ? saved : null;
if (saved && !restored) {
  console.warn('Параметры запуска изменились — прежние результаты не применимы, счёт начат заново.');
}

// Простой между запусками: за это время цена ушла, поэтому опорные уровни
// стратегий и оценка позиций пересчитываются от текущего рынка.
const downtimeSec = restored?.updatedAt
  ? Math.max(0, (runStartedAt - Date.parse(restored.updatedAt)) / 1000)
  : 0;
const lastKnownPrice = restored
  ? Object.values(restored.bots ?? {}).map(b => b?.ledger?.lastPrice).find(Number.isFinite) ?? null
  : null;

const bots = factories.map(factory => {
  const strategy = factory();
  return new Bot(strategy, {
    startBalance: START_BALANCE,
    snapshot: restored?.bots?.[strategy.name],
    downtimeSec,
    costs,
  });
});

// Мета-бот идёт последним: решает уже по обновлённым позициям остальных.
bots.push(new MetaBot([...bots], {
  startBalance: START_BALANCE,
  snapshot: restored?.bots?.[metaName(bots.length)],
  costs,
  windowCandles: META_WINDOW,
  switchMarginPct: META_MARGIN,
}));

const baseUptimeSec = restored?.uptimeSecTotal ?? 0;
const runNumber = (restored?.runs ?? 0) + 1;
let ticks = 0;
let runUptimeSec = 0;
let stopping = false;
let timer = null;
let inFlight = null; // текущий тик: остановка дожидается его, а не пишет состояние параллельно

// currentRun в сохранённом состоянии = прошлый запуск не завершился штатно.
if (restored?.currentRun) {
  const crashed = restored.currentRun;
  await logRun({
    event: 'crash',
    runId: crashed.runId,
    runUptimeSec: Math.round(crashed.runUptimeSec ?? 0),
    totalUptimeSec: Math.round(baseUptimeSec),
    ticks: crashed.ticks ?? 0,
    note: 'нет штатной остановки (kill/сбой)',
  });
}

await logRun({
  event: 'start',
  runId,
  runUptimeSec: 0,
  totalUptimeSec: Math.round(baseUptimeSec),
  ticks: 0,
  note: restored ? `продолжение, запуск #${runNumber}` : `новое состояние, запуск #${runNumber}`,
});

function isCompatible(state) {
  return Boolean(state)
    && state.version === STATE_VERSION
    && state.symbol === SYMBOL
    && state.interval === INTERVAL
    && state.startBalance === START_BALANCE
    && state.market === MARKET
    && state.feePct === FEE_PCT
    && state.slippagePct === SLIPPAGE_PCT
    && state.orderUsdt === ORDER_USDT;
}

function buildState({ closing }) {
  return {
    version: STATE_VERSION,
    symbol: SYMBOL,
    interval: INTERVAL,
    startBalance: START_BALANCE,
    market: MARKET,
    feePct: FEE_PCT,
    slippagePct: SLIPPAGE_PCT,
    orderUsdt: ORDER_USDT,
    updatedAt: new Date().toISOString(),
    runs: runNumber,
    uptimeSecTotal: baseUptimeSec + runUptimeSec,
    lastRun: { runId, startedAt: new Date(runStartedAt).toISOString(), runUptimeSec, ticks },
    currentRun: closing ? null : { runId, startedAt: new Date(runStartedAt).toISOString(), runUptimeSec, ticks },
    bots: Object.fromEntries(bots.map(bot => [bot.strategy.name, bot.snapshot()])),
  };
}

// В терминале — таблица, в логах контейнера — одна строка на тик:
// таблица в 15 строк раз в минуту раздувала docker-лог без пользы.
function printStatus(price) {
  const totalEquity = bots.reduce((sum, bot) => sum + bot.ledger.equity, 0);
  const invested = START_BALANCE * bots.length;
  const pnlPct = (totalEquity / invested - 1) * 100;

  if (!process.stdout.isTTY) {
    const inMarket = bots.filter(bot => bot.ledger.position > 0).length;
    const meta = bots[bots.length - 1];
    console.log(
      `тик ${ticks} · ${SYMBOL} ${price} · в рынке ${inMarket}/${bots.length}`
      + ` · счёт ${totalEquity.toFixed(2)}/${invested.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)} %)`
      + ` · лидер ${meta.leader ?? '—'}`,
    );
    return;
  }

  console.clear();
  console.log(`Bybit ${MARKET} · комиссия ${FEE_PCT}% · лот ≥ ${lotRules.minOrderAmt} USDT · ${SYMBOL} · ${INTERVAL}m · старт ${START_BALANCE} у.е. на бота`);
  console.log(
    `Запуск #${runNumber} · в работе ${formatDuration(runUptimeSec)}`
    + ` · всего ${formatDuration(baseUptimeSec + runUptimeSec)} · тиков ${ticks}\n`,
  );
  console.table(bots.map(bot => bot.status()));
  console.log(
    `Суммарно ${totalEquity.toFixed(2)} из ${invested.toFixed(2)} у.е.`
    + ` (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)} %)`,
  );
}

let resumeLogged = false;

// Первый тик после восстановления фиксирует, насколько ушла цена за простой:
// позиции переоцениваются по ней, и решения принимаются уже от текущего уровня.
async function logResumeGap(price) {
  if (resumeLogged || !restored) return;
  resumeLogged = true;

  const gapPct = Number.isFinite(lastKnownPrice) && lastKnownPrice > 0
    ? (price / lastKnownPrice - 1) * 100
    : null;
  const gapText = gapPct === null
    ? 'прошлая цена неизвестна'
    : `цена ${lastKnownPrice} → ${price} (${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(2)} %)`;

  await logRun({
    event: 'resume',
    runId,
    runUptimeSec: 0,
    totalUptimeSec: Math.round(baseUptimeSec),
    ticks: 0,
    note: `простой ${formatDuration(downtimeSec)}, ${gapText}`,
  });
}

// Новый тик не стартует, пока не закончился прошлый: при медленной бирже
// setInterval иначе запускал бы их внахлёст, с двойными сделками.
function tick() {
  if (stopping || inFlight) return inFlight;
  inFlight = runTick().finally(() => { inFlight = null; });
  return inFlight;
}

async function runTick() {
  try {
    const all = await fetchKlines(SYMBOL, INTERVAL, 101);
    const { closed: candles, price } = splitClosed(all, INTERVAL);
    if (!candles.length || !Number.isFinite(price)) throw new Error('биржа вернула пустые свечи');
    await logResumeGap(price);

    for (const bot of bots) {
      const result = bot.step(candles, price);
      const name = bot.strategy.name;

      await logEquity({
        symbol: SYMBOL,
        bot: name,
        price: result.price,
        equity: result.equity,
        position: result.position > 0 ? 1 : 0,
        trades: bot.ledger.tradeCount,
        runId,
      });

      if (result.trade) {
        await logTrade({
          symbol: SYMBOL,
          bot: name,
          side: result.trade.side,
          price: result.trade.price,
          pnlPct: result.trade.pnlPct,
          runId,
        });
      }
    }

    ticks += 1;
    runUptimeSec = (Date.now() - runStartedAt) / 1000;
    await saveState(buildState({ closing: false }));
    printStatus(price);
  } catch (err) {
    console.error('Ошибка опроса рынка:', err.message);
  }
}

async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  await inFlight;
  runUptimeSec = (Date.now() - runStartedAt) / 1000;

  try {
    await saveState(buildState({ closing: true }));
    await logRun({
      event: 'stop',
      runId,
      runUptimeSec: Math.round(runUptimeSec),
      totalUptimeSec: Math.round(baseUptimeSec + runUptimeSec),
      ticks,
      note: reason,
    });
    console.log(`\nОстановка (${reason}). Наработка запуска ${formatDuration(runUptimeSec)},`
      + ` всего ${formatDuration(baseUptimeSec + runUptimeSec)}.`);
  } catch (err) {
    console.error('Ошибка сохранения состояния:', err.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await tick();
timer = setInterval(tick, POLL_MS);
