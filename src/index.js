import 'dotenv/config';
import { fetchKlines } from './lib/bybit.js';
import { Bot } from './bot.js';

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

const SYMBOL = process.env.SYMBOL || 'BTCUSDT';
const INTERVAL = process.env.INTERVAL || '5';
const START_BALANCE = Number(process.env.START_BALANCE || 100);
const POLL_MS = Number(process.env.POLL_MS || 60000);

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
]; // ровно 10 ботов (grid избыточен рядом с martingale — оставлен в strategies/ на выбор)

const bots = factories.map(factory => new Bot(factory(), START_BALANCE));

function printStatus() {
  console.clear();
  console.log(`Bybit Testnet · ${SYMBOL} · ${INTERVAL}m · старт ${START_BALANCE} у.е. на бота\n`);
  console.table(bots.map(bot => bot.status()));
}

async function tick() {
  try {
    const candles = await fetchKlines(SYMBOL, INTERVAL, 100);
    bots.forEach(bot => bot.step(candles));
    printStatus();
  } catch (err) {
    console.error('Ошибка опроса рынка:', err.message);
  }
}

await tick();
setInterval(tick, POLL_MS);
