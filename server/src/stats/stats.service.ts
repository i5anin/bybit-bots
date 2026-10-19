import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { createCsvTail, DecimatedSeries } from '../storage/csv-tail.js';
import type { CsvRecord } from '../storage/csv.js';
import { StateStore } from '../storage/state-store.js';
import { TradeLog } from '../storage/trade-log.js';
import { EngineService } from '../trading/engine.service.js';
import type { EngineState } from '../trading/types.js';
import { botStatus, buildStats, sparkOf, type EquityHistory } from './build-stats.js';
import { RatesService } from './rates.service.js';
import type { BotRunStatus, PairDetail, RunRow, Stats, TradeRow } from './stats.types.js';

// Добавляет строки equity.csv в прорежённые ряды по ботам.
export function addEquity(acc: EquityHistory, rows: readonly CsvRecord[]): EquityHistory {
  for (const row of rows) {
    const v = Number(row.equity);
    if (!row.bot || !Number.isFinite(v)) continue;
    const key = `${row.symbol}:${row.bot}`;
    let series = acc.series.get(key);
    if (!series) acc.series.set(key, (series = new DecimatedSeries()));
    series.push(v);
    const price = Number(row.price);
    if (Number.isFinite(price)) acc.lastPrice = price;
  }
  return acc;
}

// Данные панели: состояние — из движка, история — из CSV-логов (дочитываются
// по мере роста), курс — с ЦБ.
@Injectable()
export class StatsService {
  private readonly equity: EquityHistory = { series: new Map(), lastPrice: null };
  private readonly trades: TradeRow[] = [];
  private readonly runs: RunRow[] = [];
  private readonly tails: Record<'equity' | 'trades' | 'runs', () => Promise<void>>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EngineService) private readonly engine: EngineService,
    @Inject(StateStore) private readonly store: StateStore,
    @Inject(TradeLog) log: TradeLog,
    @Inject(RatesService) private readonly rates: RatesService,
  ) {
    this.tails = {
      equity: createCsvTail(log.file('equity'), {
        onRows: rows => addEquity(this.equity, rows),
        onReset: () => { this.equity.series.clear(); this.equity.lastPrice = null; },
      }),
      trades: createCsvTail(log.file('trades'), {
        onRows: rows => this.trades.push(...(rows as unknown as TradeRow[])),
        onReset: () => { this.trades.length = 0; },
      }),
      runs: createCsvTail(log.file('runs'), {
        onRows: rows => this.runs.push(...(rows as unknown as RunRow[])),
        onReset: () => { this.runs.length = 0; },
      }),
    };
  }

  // Пока движок не сделал первый тик (ждёт биржу), показываем сохранённое на диске.
  private async state(): Promise<EngineState | null> {
    return this.engine.state() ?? this.store.load();
  }

  async stats(now = Date.now()): Promise<Stats> {
    const [state, rate] = await Promise.all([
      this.state(),
      this.rates.rubPerUsd(now),
      this.tails.equity(),
      this.tails.trades(),
      this.tails.runs(),
    ]);
    return buildStats({
      state,
      equity: this.equity,
      trades: this.trades,
      runs: this.runs,
      rate,
      startRub: this.config.startRub,
      staleSec: this.config.staleSec,
      bankRatePct: this.config.bankRatePct,
      now,
    });
  }

  // Отчёт по одной паре: её 12 ботов с рядами счёта и её сделки.
  async pairDetail(symbol: string, now = Date.now()): Promise<PairDetail> {
    const stats = await this.stats(now);
    const pair = stats.pairs.find(p => p.name === symbol) ?? null;
    return {
      symbol,
      pair,
      bots: stats.bots.filter(b => b.symbol === symbol).map(b => ({ ...b, spark: sparkOf(this.equity, symbol, b.name) })),
      trades: this.trades.filter(t => t.symbol === symbol).slice(-100).reverse(),
    };
  }

  async allTrades(): Promise<readonly TradeRow[]> {
    await this.tails.trades();
    return this.trades;
  }

  async health(now = Date.now()): Promise<{ status: BotRunStatus; ageSec: number | null }> {
    return botStatus(await this.state(), now, this.config.staleSec);
  }
}
