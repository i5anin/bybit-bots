// Разовая нормализация старых логов: имена ботов с запятыми не были
// экранированы, а заголовок дописывался при каждом рестарте.
// Итог — валидный CSV по RFC 4180 + колонка runId (пустая для старых строк).
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { csvRow, parseCsvLine } from '../src/lib/csv.js';

const LOG_DIR = path.resolve(process.env.LOG_DIR || 'logs');

const FILES = [
  {
    name: 'equity.csv',
    header: ['time', 'symbol', 'bot', 'price', 'equity', 'position', 'trades', 'runId'],
    head: 2, // time, symbol
    tail: 4, // price, equity, position, trades
  },
  {
    name: 'trades.csv',
    header: ['time', 'symbol', 'bot', 'side', 'price', 'pnlPct', 'runId'],
    head: 2, // time, symbol
    tail: 3, // side, price, pnlPct
  },
];

for (const spec of FILES) {
  const file = path.join(LOG_DIR, spec.name);
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    console.log(`${spec.name}: пропущен (${err.code})`);
    continue;
  }

  const lines = raw.split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines[0] === spec.header.join(',')) {
    console.log(`${spec.name}: уже в новом формате`);
    continue;
  }

  const oldHeader = spec.header.slice(0, -1).join(',');
  const rows = [];
  let skipped = 0;

  for (const line of lines) {
    if (line === oldHeader || line.startsWith('time,symbol,')) {
      skipped += 1;
      continue;
    }
    const fields = parseCsvLine(line);
    if (fields.length < spec.head + spec.tail + 1) {
      skipped += 1;
      continue;
    }
    const bot = fields.slice(spec.head, fields.length - spec.tail).join(',');
    rows.push([
      ...fields.slice(0, spec.head),
      bot,
      ...fields.slice(fields.length - spec.tail),
      '', // runId неизвестен для исторических строк
    ]);
  }

  await copyFile(file, `${file}.bak`);
  await writeFile(file, csvRow(spec.header) + rows.map(csvRow).join(''));
  console.log(`${spec.name}: строк ${rows.length}, отброшено ${skipped}, бэкап ${spec.name}.bak`);
}
