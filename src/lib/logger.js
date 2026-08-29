import { mkdir, appendFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { csvRow } from './csv.js';

const LOG_DIR = path.resolve(process.env.LOG_DIR || 'logs');
const EQUITY_FILE = path.join(LOG_DIR, 'equity.csv');
const TRADES_FILE = path.join(LOG_DIR, 'trades.csv');
const RUNS_FILE = path.join(LOG_DIR, 'runs.csv');

const HEADERS = [
  [EQUITY_FILE, ['time', 'symbol', 'bot', 'price', 'equity', 'position', 'trades', 'runId']],
  [TRADES_FILE, ['time', 'symbol', 'bot', 'side', 'price', 'pnlPct', 'runId']],
  [RUNS_FILE, ['time', 'event', 'runId', 'runUptimeSec', 'totalUptimeSec', 'ticks', 'note']],
];

let ready = null;

// Заголовок пишется только при создании файла — иначе он дублировался
// в середине лога при каждом рестарте контейнера.
async function ensureReady() {
  ready ??= (async () => {
    await mkdir(LOG_DIR, { recursive: true });
    for (const [file, header] of HEADERS) {
      const empty = await stat(file).then(info => info.size === 0, () => true);
      if (empty) await appendFile(file, csvRow(header));
    }
  })();
  return ready;
}

export async function logEquity({ symbol, bot, price, equity, position, trades, runId }) {
  await ensureReady();
  const row = [new Date().toISOString(), symbol, bot, price, equity.toFixed(4), position, trades, runId];
  await appendFile(EQUITY_FILE, csvRow(row));
}

export async function logTrade({ symbol, bot, side, price, pnlPct, runId }) {
  await ensureReady();
  const row = [new Date().toISOString(), symbol, bot, side, price, pnlPct ?? '', runId];
  await appendFile(TRADES_FILE, csvRow(row));
}

// event: start | stop | crash — по этим строкам считается наработка каждого запуска.
export async function logRun({ event, runId, runUptimeSec, totalUptimeSec, ticks, note }) {
  await ensureReady();
  const row = [new Date().toISOString(), event, runId, runUptimeSec, totalUptimeSec, ticks, note ?? ''];
  await appendFile(RUNS_FILE, csvRow(row));
}
