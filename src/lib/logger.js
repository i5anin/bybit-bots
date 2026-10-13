import { mkdir, appendFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { csvRow } from './csv.js';

const LOG_DIR = path.resolve(process.env.LOG_DIR || 'logs');
const EQUITY_FILE = path.join(LOG_DIR, 'equity.csv');
const TRADES_FILE = path.join(LOG_DIR, 'trades.csv');
const RUNS_FILE = path.join(LOG_DIR, 'runs.csv');

const HEADERS = {
  [EQUITY_FILE]: ['time', 'symbol', 'bot', 'price', 'equity', 'position', 'trades', 'runId'],
  [TRADES_FILE]: ['time', 'symbol', 'bot', 'side', 'price', 'pnlPct', 'runId'],
  [RUNS_FILE]: ['time', 'event', 'runId', 'runUptimeSec', 'totalUptimeSec', 'ticks', 'note'],
};

let dirReady = null;

// Заголовок проверяется перед каждой записью, а не один раз на запуск: если лог
// убрали в архив при работающем боте, новый файл иначе начался бы без заголовка,
// и панель приняла бы первую строку данных за названия колонок.
async function append(file, rows) {
  dirReady ??= mkdir(LOG_DIR, { recursive: true });
  await dirReady;
  const empty = await stat(file).then(info => info.size === 0, () => true);
  const text = (empty ? csvRow(HEADERS[file]) : '') + rows.map(csvRow).join('');
  await appendFile(file, text);
}

// Все боты за тик — одной записью: читатель панели не застанет тик наполовину.
export async function logEquity(entries) {
  const time = new Date().toISOString();
  await append(EQUITY_FILE, entries.map(({ symbol, bot, price, equity, position, trades, runId }) =>
    [time, symbol, bot, price, equity.toFixed(4), position, trades, runId]));
}

export async function logTrade({ symbol, bot, side, price, pnlPct, runId }) {
  await append(TRADES_FILE, [[new Date().toISOString(), symbol, bot, side, price, pnlPct ?? '', runId]]);
}

// event: start | stop | crash | resume — по этим строкам считается наработка каждого запуска.
export async function logRun({ event, runId, runUptimeSec, totalUptimeSec, ticks, note }) {
  await append(RUNS_FILE, [[new Date().toISOString(), event, runId, runUptimeSec, totalUptimeSec, ticks, note ?? '']]);
}
