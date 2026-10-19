import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { APP_CONFIG, marketId, type AppConfig } from '../config/app-config.js';
import { BybitClient, splitClosed, withRetry } from '../market/bybit.js';
import { KlineStream } from '../market/bybit-stream.js';
import { STATE_VERSION, StateStore } from '../storage/state-store.js';
import { formatDuration } from '../storage/time.js';
import { TradeLog, type EquityEntry } from '../storage/trade-log.js';
import { Bot } from './bot.js';
import { MetaBot, metaName } from './meta-bot.js';
import { ACTIVE_STRATEGIES } from './strategies/index.js';
import type { Costs, EngineState, FeedStatus, LotRules, StrategyFactory, Trader } from './types.js';

// Сделка, о которой движок сообщает подписчикам (Telegram) сразу, в том же
// процессе: с точной прибылью в деньгах, которой нет в CSV-логе.
export interface TradeEvent {
  bot: string;
  side: 'buy' | 'sell';
  price: number;
  pnlPct?: number;
  pnlUsdt?: number;
  equity: number; // счёт бота сразу после сделки, USDT
  time: string;
}

export type TradeListener = (event: TradeEvent) => void;

// Торговый движок: раз в POLL_MS берёт свечи, даёт каждому боту принять
// решение по последней закрытой свече, пишет логи и состояние.
@Injectable()
export class EngineService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Engine');
  private bots: Trader[] = [];
  private lastState: EngineState | null = null;
  private restored: EngineState | null = null;
  private runId = '';
  private runStartedAt = 0;
  private runNumber = 1;
  private baseUptimeSec = 0;
  private downtimeSec = 0;
  private lastKnownPrice: number | null = null;
  private resumeLogged = false;
  private ticks = 0;
  private runUptimeSec = 0;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null; // текущий тик: остановка дожидается его
  private stopping = false;
  private stream: KlineStream | null = null;
  private lastDecidedCandle: number | null = null;
  private feed: FeedStatus = { source: 'опрос', streamConnected: false, lagSec: null, fetchMs: null, staleSkips: 0 };
  private started = false;
  private readonly tradeListeners = new Set<TradeListener>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(BybitClient) private readonly bybit: BybitClient,
    @Inject(StateStore) private readonly store: StateStore,
    @Inject(TradeLog) private readonly log: TradeLog,
  ) {}

  // Старт не держит запуск HTTP-сервера: если биржа недоступна, панель уже
  // отвечает и показывает, что бот ещё не работает.
  onApplicationBootstrap(): void {
    this.start().catch(err => {
      this.logger.error(`Движок не запустился: ${(err as Error).message}`);
      process.exitCode = 1;
      process.kill(process.pid, 'SIGTERM');
    });
  }

  async start(factories: readonly StrategyFactory[] = ACTIVE_STRATEGIES): Promise<void> {
    // Без правил лота торговать нельзя. Если биржа недоступна, ждём её здесь,
    // а не падаем: иначе Docker перезапускал бы контейнер по кругу.
    const lot = await withRetry(() => this.bybit.lotRules(this.config.symbol), {
      attempts: 8,
      onError: (err, delayMs) =>
        this.logger.warn(`Правила лота не получены (${(err as Error).message}), повтор через ${delayMs / 1000} с`),
    });
    if (this.stopping) return;
    await this.init(lot, factories);
    await this.tick();
    if (this.stopping) return;
    // Минутный опрос остаётся страховкой на случай обрыва потока.
    this.timer = setInterval(() => void this.tick('опрос'), this.config.pollMs);
    if (this.config.bybitStream) {
      this.stream = new KlineStream({
        url: this.config.bybitStreamUrl,
        symbol: this.config.symbol,
        interval: this.config.interval,
        onCandleClosed: start => void this.tick('поток', start + Number(this.config.interval) * 60_000),
        log: message => this.logger.log(message),
      });
      this.stream.start();
    }
  }

  async init(lot: LotRules, factories: readonly StrategyFactory[] = ACTIVE_STRATEGIES): Promise<void> {
    const c = this.config;
    const costs: Costs = { feePct: c.feePct, slippagePct: c.slippagePct, lot, orderUsdt: c.orderUsdt };

    this.runStartedAt = Date.now();
    this.runId = new Date(this.runStartedAt).toISOString();

    const saved = await this.store.load();
    const restored = saved && this.isCompatible(saved) ? saved : null;
    if (saved && !restored) {
      this.logger.warn('Параметры запуска изменились — прежние результаты не применимы, счёт начат заново.');
    }
    this.restored = restored;

    // Простой между запусками: за это время цена ушла, поэтому опорные уровни
    // стратегий и оценка позиций пересчитываются от текущего рынка.
    this.downtimeSec = restored?.updatedAt
      ? Math.max(0, (this.runStartedAt - Date.parse(restored.updatedAt)) / 1000)
      : 0;
    this.lastKnownPrice = restored
      ? Object.values(restored.bots ?? {}).map(b => b?.ledger?.lastPrice).find(Number.isFinite) ?? null
      : null;

    const bots: Trader[] = factories.map(factory => {
      const strategy = factory();
      return new Bot(strategy, {
        startBalance: c.startBalance,
        snapshot: restored?.bots?.[strategy.name] ?? null,
        downtimeSec: this.downtimeSec,
        costs,
      });
    });
    // Мета-бот идёт последним: решает уже по обновлённым позициям остальных.
    bots.push(new MetaBot([...bots], {
      startBalance: c.startBalance,
      snapshot: restored?.bots?.[metaName(bots.length)] ?? null,
      costs,
      windowCandles: c.metaWindowCandles,
      switchMarginPct: c.metaSwitchMarginPct,
    }));
    this.bots = bots;

    this.baseUptimeSec = restored?.uptimeSecTotal ?? 0;
    this.runNumber = (restored?.runs ?? 0) + 1;
    this.lastState = restored;

    // currentRun в сохранённом состоянии = прошлый запуск не завершился штатно.
    if (restored?.currentRun) {
      const crashed = restored.currentRun;
      await this.log.run({
        event: 'crash',
        runId: crashed.runId,
        runUptimeSec: Math.round(crashed.runUptimeSec ?? 0),
        totalUptimeSec: Math.round(this.baseUptimeSec),
        ticks: crashed.ticks ?? 0,
        note: 'нет штатной остановки (kill/сбой)',
      });
    }
    await this.log.run({
      event: 'start',
      runId: this.runId,
      runUptimeSec: 0,
      totalUptimeSec: Math.round(this.baseUptimeSec),
      ticks: 0,
      note: `${restored ? 'продолжение' : 'новое состояние'}, запуск #${this.runNumber}`,
    });
    this.started = true;
  }

  private isCompatible(state: EngineState): boolean {
    const c = this.config;
    return state.version === STATE_VERSION
      && state.symbol === c.symbol
      && state.interval === c.interval
      && state.startBalance === c.startBalance
      && state.market === marketId(c)
      && state.feePct === c.feePct
      && state.slippagePct === c.slippagePct
      && state.orderUsdt === c.orderUsdt;
  }

  private buildState(closing: boolean): EngineState {
    const c = this.config;
    const run = {
      runId: this.runId,
      startedAt: new Date(this.runStartedAt).toISOString(),
      runUptimeSec: this.runUptimeSec,
      ticks: this.ticks,
    };
    return {
      version: STATE_VERSION,
      symbol: c.symbol,
      interval: c.interval,
      startBalance: c.startBalance,
      market: marketId(c),
      feePct: c.feePct,
      slippagePct: c.slippagePct,
      orderUsdt: c.orderUsdt,
      updatedAt: new Date().toISOString(),
      runs: this.runNumber,
      uptimeSecTotal: this.baseUptimeSec + this.runUptimeSec,
      lastRun: run,
      currentRun: closing ? null : run,
      bots: Object.fromEntries(this.bots.map(bot => [bot.strategy.name, bot.snapshot()])),
      feed: this.feed,
    };
  }

  // Подписка на сделки; возвращает отписку.
  onTrade(listener: TradeListener): () => void {
    this.tradeListeners.add(listener);
    return () => this.tradeListeners.delete(listener);
  }

  // Ошибка подписчика не должна остановить тик.
  private emitTrade(event: TradeEvent): void {
    for (const listener of this.tradeListeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.warn(`Подписчик сделок упал: ${(err as Error).message}`);
      }
    }
  }

  // Последнее сохранённое состояние — его же видит панель.
  state(): EngineState | null {
    return this.lastState;
  }

  // Первый тик после восстановления фиксирует, насколько ушла цена за простой.
  private async logResumeGap(price: number): Promise<void> {
    if (this.resumeLogged || !this.restored) return;
    this.resumeLogged = true;
    const prev = this.lastKnownPrice;
    const gapPct = prev !== null && prev > 0 ? (price / prev - 1) * 100 : null;
    const gapText = gapPct === null
      ? 'прошлая цена неизвестна'
      : `цена ${prev} → ${price} (${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(2)} %)`;
    await this.log.run({
      event: 'resume',
      runId: this.runId,
      runUptimeSec: 0,
      totalUptimeSec: Math.round(this.baseUptimeSec),
      ticks: 0,
      note: `простой ${formatDuration(this.downtimeSec)}, ${gapText}`,
    });
  }

  // Новый тик не стартует, пока не закончился прошлый: при медленной бирже
  // setInterval иначе запускал бы их внахлёст, с двойными сделками.
  // closedUntil — конец свечи, о закрытии которой сообщил поток: Bybit шлёт
  // это событие на десятки миллисекунд раньше формального конца свечи.
  tick(source: FeedStatus['source'] = 'опрос', closedUntil = 0): Promise<void> {
    if (this.stopping || !this.started) return this.inFlight ?? Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runTick(source, closedUntil).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async runTick(source: FeedStatus['source'], closedUntil: number): Promise<void> {
    const c = this.config;
    try {
      const askedAt = Date.now();
      const all = await this.bybit.klines(c.symbol, c.interval, 101);
      const now = Math.max(Date.now(), closedUntil);
      const { closed: candles, price } = splitClosed(all, c.interval, now);
      if (!candles.length || price === null || !Number.isFinite(price)) {
        throw new Error('биржа вернула пустые свечи');
      }

      // Актуальность: последняя закрытая свеча должна быть только что закрытой.
      // Если она старше ещё одной свечи — биржа отдала устаревшие данные,
      // торговать по ним нельзя.
      const intervalMs = Number(c.interval) * 60_000;
      const lastClosed = candles[candles.length - 1]!.time;
      const ageMs = now - (lastClosed + intervalMs);
      // Задержку меряем только на решении по новой свече: тики опроса внутри
      // свечи ничего не решают, и их «свеча закрыта 3 минуты назад» — не опоздание.
      const decides = lastClosed !== this.lastDecidedCandle;
      this.feed = decides
        ? {
          source,
          streamConnected: this.stream?.connected ?? false,
          lagSec: Math.max(0, Math.round(ageMs / 100) / 10),
          fetchMs: Date.now() - askedAt,
          staleSkips: this.feed.staleSkips,
        }
        : { ...this.feed, streamConnected: this.stream?.connected ?? false };
      if (decides && ageMs <= intervalMs) this.lastDecidedCandle = lastClosed;
      if (ageMs > intervalMs) {
        this.feed.staleSkips += 1;
        this.logger.warn(`данные устарели: последняя свеча закрыта ${Math.round(ageMs / 1000)} с назад — тик пропущен`);
        return;
      }
      await this.logResumeGap(price);

      const equityRows: EquityEntry[] = [];
      for (const bot of this.bots) {
        const result = bot.step(candles, price);
        const name = bot.strategy.name;
        equityRows.push({
          symbol: c.symbol,
          bot: name,
          price: result.price,
          equity: result.equity,
          position: result.position > 0 ? 1 : 0,
          trades: bot.ledger.tradeCount,
          runId: this.runId,
        });
        if (result.trade) {
          await this.log.trade({
            symbol: c.symbol,
            bot: name,
            side: result.trade.side,
            price: result.trade.price,
            pnlPct: result.trade.pnlPct,
            runId: this.runId,
          });
          this.emitTrade({
            bot: name,
            side: result.trade.side,
            price: result.trade.price,
            pnlPct: result.trade.pnlPct,
            pnlUsdt: result.trade.pnlUsdt,
            equity: result.equity,
            time: new Date(result.trade.time).toISOString(),
          });
        }
      }
      await this.log.equity(equityRows);

      this.ticks += 1;
      this.runUptimeSec = (Date.now() - this.runStartedAt) / 1000;
      const state = this.buildState(false);
      await this.store.save(state);
      this.lastState = state;
      this.logStatus(price);
    } catch (err) {
      this.logger.error(`Ошибка опроса рынка: ${(err as Error).message}`);
    }
  }

  private logStatus(price: number): void {
    const c = this.config;
    const total = this.bots.reduce((sum, bot) => sum + bot.ledger.equity, 0);
    const invested = c.startBalance * this.bots.length;
    const pnlPct = (total / invested - 1) * 100;
    const inMarket = this.bots.filter(bot => bot.ledger.position > 0).length;
    const meta = this.bots[this.bots.length - 1] as MetaBot | undefined;
    this.logger.log(
      `тик ${this.ticks} · ${c.symbol} ${price} · в рынке ${inMarket}/${this.bots.length}`
      + ` · счёт ${total.toFixed(2)}/${invested.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)} %)`
      + ` · лидер ${meta?.leader ?? '—'}`
      + ` · ${this.feed.source}, через ${this.feed.lagSec} с после закрытия свечи, ответ биржи ${this.feed.fetchMs} мс`,
    );
  }

  // Штатная остановка (SIGTERM): дожидаемся тика, сохраняем закрытое состояние.
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.stream?.stop();
    await this.inFlight;
    if (!this.started) return;
    this.runUptimeSec = (Date.now() - this.runStartedAt) / 1000;
    try {
      const state = this.buildState(true);
      await this.store.save(state);
      this.lastState = state;
      await this.log.run({
        event: 'stop',
        runId: this.runId,
        runUptimeSec: Math.round(this.runUptimeSec),
        totalUptimeSec: Math.round(this.baseUptimeSec + this.runUptimeSec),
        ticks: this.ticks,
        note: signal ?? 'shutdown',
      });
      this.logger.log(`Остановка (${signal ?? 'shutdown'}). Наработка запуска ${formatDuration(this.runUptimeSec)},`
        + ` всего ${formatDuration(this.baseUptimeSec + this.runUptimeSec)}.`);
    } catch (err) {
      this.logger.error(`Ошибка сохранения состояния: ${(err as Error).message}`);
    }
  }
}
