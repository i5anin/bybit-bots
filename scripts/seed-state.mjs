// Разовый перенос накопленного результата из CSV-логов в data/state.json,
// чтобы переход на персистентное состояние не обнулил счёт ботов.
// Запускать после migrate-logs.mjs и только при остановленном контейнере.
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCsvLine } from '../src/lib/csv.js';
import { saveState, STATE_VERSION, STATE_FILE } from '../src/lib/state.js';
import { formatDuration } from '../src/lib/time.js';

const LOG_DIR = path.resolve(process.env.LOG_DIR || 'logs');
const SYMBOL = process.env.SYMBOL || 'BTCUSDT';
const INTERVAL = process.env.INTERVAL || '5';
const START_BALANCE = Number(process.env.START_BALANCE || 100);
const POLL_MS = Number(process.env.POLL_MS || 60000);
const GAP_MS = POLL_MS * 3; // больший разрыв между записями = контейнер стоял

const equityRows = await readCsv(path.join(LOG_DIR, 'equity.csv'));
const tradeRows = await readCsv(path.join(LOG_DIR, 'trades.csv'));
if (equityRows.length === 0) {
  console.error('equity.csv пуст — переносить нечего.');
  process.exit(1);
}

const lastByBot = new Map();
for (const row of equityRows) lastByBot.set(row.bot, row);

const tradeStats = new Map();
for (const row of tradeRows) {
  const stat = tradeStats.get(row.bot) ?? { count: 0, realizedPnlPct: 0, lastBuyPrice: null, open: false };
  stat.count += 1;
  if (row.side === 'buy') {
    stat.lastBuyPrice = Number(row.price);
    stat.open = true;
  }
  if (row.side === 'sell') {
    stat.realizedPnlPct += Number(row.pnlPct) || 0;
    stat.open = false;
  }
  tradeStats.set(row.bot, stat);
}

const bots = {};
for (const [bot, row] of lastByBot) {
  const stat = tradeStats.get(bot) ?? { count: 0, realizedPnlPct: 0, lastBuyPrice: null };
  const price = Number(row.price);
  const equity = Number(row.equity);
  const inPosition = row.position === '1' && Number.isFinite(price) && price > 0;

  bots[bot] = {
    ledger: {
      cash: inPosition ? 0 : equity,
      position: inPosition ? equity / price : 0,
      entryPrice: inPosition ? (stat.lastBuyPrice ?? price) : 0,
      lastPrice: price,
      tradeCount: Math.max(stat.count, Number(row.trades) || 0),
      realizedPnlPct: stat.realizedPnlPct,
    },
    strategy: null, // опорные уровни стратегий пересчитаются от текущей цены
  };
}

const { uptimeSec, runs, lastSeen } = measureUptime(equityRows);

await saveState({
  version: STATE_VERSION,
  symbol: SYMBOL,
  interval: INTERVAL,
  startBalance: START_BALANCE,
  updatedAt: new Date(lastSeen).toISOString(),
  runs,
  uptimeSecTotal: uptimeSec,
  lastRun: null,
  currentRun: null,
  bots,
});

const totalEquity = Object.values(bots).reduce((sum, b) => sum + b.ledger.cash + b.ledger.position * b.ledger.lastPrice, 0);
console.log(`Состояние перенесено: ${STATE_FILE}`);
console.log(`Ботов ${Object.keys(bots).length}, суммарно ${totalEquity.toFixed(2)} из ${(START_BALANCE * Object.keys(bots).length).toFixed(2)} у.е.`);
console.log(`Историческая наработка ${formatDuration(uptimeSec)} за ${runs} запуск(ов), последняя запись ${new Date(lastSeen).toISOString()}`);

async function readCsv(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/).filter(line => line.trim() !== '');
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const fields = parseCsvLine(line);
    return Object.fromEntries(header.map((key, i) => [key, fields[i] ?? '']));
  });
}

// Наработка = сумма интервалов между соседними записями без длинных разрывов.
function measureUptime(rows) {
  const stamps = [...new Set(rows.map(row => Date.parse(row.time)))]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  let uptimeMs = 0;
  let runs = stamps.length > 0 ? 1 : 0;
  for (let i = 1; i < stamps.length; i += 1) {
    const delta = stamps[i] - stamps[i - 1];
    if (delta <= GAP_MS) uptimeMs += delta;
    else runs += 1;
  }
  return { uptimeSec: Math.round(uptimeMs / 1000), runs, lastSeen: stamps[stamps.length - 1] };
}
