import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

const LOG_DIR = path.resolve('logs');
const EQUITY_FILE = path.join(LOG_DIR, 'equity.csv');
const TRADES_FILE = path.join(LOG_DIR, 'trades.csv');

let ready = false;

async function ensureReady() {
  if (ready) return;
  await mkdir(LOG_DIR, { recursive: true });
  await appendFile(EQUITY_FILE, 'time,symbol,bot,price,equity,position,trades\n', { flag: 'a' });
  await appendFile(TRADES_FILE, 'time,symbol,bot,side,price,pnlPct\n', { flag: 'a' });
  ready = true;
}

export async function logEquity({ symbol, bot, price, equity, position, trades }) {
  await ensureReady();
  const row = [new Date().toISOString(), symbol, bot, price, equity.toFixed(4), position, trades].join(',');
  await appendFile(EQUITY_FILE, row + '\n');
}

export async function logTrade({ symbol, bot, side, price, pnlPct }) {
  await ensureReady();
  const row = [new Date().toISOString(), symbol, bot, side, price, pnlPct ?? ''].join(',');
  await appendFile(TRADES_FILE, row + '\n');
}
