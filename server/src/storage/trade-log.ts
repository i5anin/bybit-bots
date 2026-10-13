import { appendFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { csvRow, type CsvValue } from './csv.js';

const HEADERS = {
  equity: ['time', 'symbol', 'bot', 'price', 'equity', 'position', 'trades', 'runId'],
  trades: ['time', 'symbol', 'bot', 'side', 'price', 'pnlPct', 'runId'],
  runs: ['time', 'event', 'runId', 'runUptimeSec', 'totalUptimeSec', 'ticks', 'note'],
} as const;

export type LogName = keyof typeof HEADERS;

export interface EquityEntry {
  symbol: string;
  bot: string;
  price: number;
  equity: number;
  position: 0 | 1;
  trades: number;
  runId: string;
}

export interface TradeEntry {
  symbol: string;
  bot: string;
  side: 'buy' | 'sell';
  price: number;
  pnlPct?: number;
  runId: string;
}

// event: start | stop | crash | resume — по этим строкам считается наработка каждого запуска.
export interface RunEntry {
  event: 'start' | 'stop' | 'crash' | 'resume';
  runId: string;
  runUptimeSec: number;
  totalUptimeSec: number;
  ticks: number;
  note?: string;
}

// CSV-логи для анализа и для истории на панели. Формат прежний.
export class TradeLog {
  private dirReady: Promise<unknown> | null = null;

  constructor(readonly dir: string, private readonly now: () => Date = () => new Date()) {}

  file(name: LogName): string {
    return path.join(this.dir, `${name}.csv`);
  }

  // Заголовок проверяется перед каждой записью, а не один раз на запуск: если лог
  // убрали в архив при работающем боте, новый файл иначе начался бы без заголовка.
  private async append(name: LogName, rows: readonly (readonly CsvValue[])[]): Promise<void> {
    this.dirReady ??= mkdir(this.dir, { recursive: true });
    await this.dirReady;
    const file = this.file(name);
    const empty = await stat(file).then(info => info.size === 0, () => true);
    const text = (empty ? csvRow(HEADERS[name]) : '') + rows.map(csvRow).join('');
    await appendFile(file, text);
  }

  // Все боты за тик — одной записью: читатель панели не застанет тик наполовину.
  async equity(entries: readonly EquityEntry[]): Promise<void> {
    const time = this.now().toISOString();
    await this.append('equity', entries.map(e =>
      [time, e.symbol, e.bot, e.price, e.equity.toFixed(4), e.position, e.trades, e.runId]));
  }

  async trade(e: TradeEntry): Promise<void> {
    await this.append('trades', [[this.now().toISOString(), e.symbol, e.bot, e.side, e.price, e.pnlPct ?? '', e.runId]]);
  }

  async run(e: RunEntry): Promise<void> {
    await this.append('runs', [[
      this.now().toISOString(), e.event, e.runId, e.runUptimeSec, e.totalUptimeSec, e.ticks, e.note ?? '',
    ]]);
  }
}
