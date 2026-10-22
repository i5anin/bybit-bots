import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { APP_CONFIG, marketId, type AppConfig } from '../config/app-config.js';
import { BybitClient, splitClosed, withRetry } from '../market/bybit.js';
import { KlineStream, type SocketFactory } from '../market/bybit-stream.js';
import { rankVolatility } from '../market/volatility.js';
import { STATE_VERSION, StateStore } from '../storage/state-store.js';
import { formatDuration } from '../storage/time.js';
import { TradeLog, type EquityEntry } from '../storage/trade-log.js';
import { Bot } from './bot.js';
import { MetaBot, metaName } from './meta-bot.js';
import { ACTIVE_STRATEGIES } from './strategies/index.js';
import type { Candle, Costs, EngineState, FeedStatus, LotRules, StrategyFactory, Trader } from './types.js';

// Сделка, о которой движок сообщает подписчикам (Telegram) сразу, в том же
// процессе: с точной прибылью в деньгах, которой нет в CSV-логе.
export interface TradeEvent {
  symbol: string;
  bot: string;
  side: 'buy' | 'sell';
  price: number;
  pnlPct?: number;
  pnlUsdt?: number;
  equity: number; // счёт бота сразу после сделки, USDT
  time: string;
}

export type TradeListener = (event: TradeEvent) => void;

// Одна пара: свои 11 стратегий и свой «Авто-выбор», у каждого свой счёт.
export interface Market {
  symbol: string;
  bots: Trader[];
  lastDecided: number | null;
  price: number | null;
}

// Ключ бота в state.json: при одной паре — имя стратегии (как раньше),
// при нескольких — «ПАРА:стратегия».
export function botKey(symbol: string, name: string, multi: boolean): string {
  return multi ? `${symbol}:${name}` : name;
}

export function parseBotKey(key: string, fallback: string): { symbol: string; name: string } {
  const m = /^([A-Z0-9]+USDT):(.+)$/.exec(key);
  return m ? { symbol: m[1]!, name: m[2]! } : { symbol: fallback, name: key };
}

// Параллельно, но не больше limit запросов к бирже одновременно.
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

// Торговый движок: на каждую закрытую свечу (по потоку или опросу) берёт
// свечи всех пар, даёт каждому боту принять решение, пишет логи и состояние.
@Injectable()
export class EngineService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Engine');
  private markets: Market[] = [];
  private lastState: EngineState | null = null;
  private restored: EngineState | null = null;
  private runId = '';
  private runStartedAt = 0;
  private runNumber = 1;
  private baseUptimeSec = 0;
  private downtimeSec = 0;
  private resumeLogged = false;
  private ticks = 0;
  private runUptimeSec = 0;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null; // текущий тик: остановка дожидается его
  private stopping = false;
  private stream: KlineStream | null = null;
  private feed: FeedStatus = { source: 'опрос', streamConnected: false, lagSec: null, fetchMs: null, staleSkips: 0 };
  private started = false;
  private sessionStartedAt: string | null = null;
  private lots: Record<string, LotRules> = {};
  private readonly tradeListeners = new Set<TradeListener>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(BybitClient) private readonly bybit: BybitClient,
    @Inject(StateStore) private readonly store: StateStore,
    @Inject(TradeLog) private readonly log: TradeLog,
    // В тестах — поддельный сокет; в работе — WebSocket из Node.
    private readonly socket?: SocketFactory,
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

  private get multi(): boolean {
    return this.config.symbolsTop > 0 || this.config.symbols.length > 1;
  }

  // Пары сессии: явный список, сохранённый в состоянии топ или свежий топ
  // по волатильности. Топ выбирается один раз — иначе каждый перезапуск
  // менял бы набор пар и обнулял счёт.
  async resolveSymbols(saved: EngineState | null): Promise<string[]> {
    const c = this.config;
    if (c.symbols.length) return c.symbols;
    if (!c.symbolsTop) return [c.symbol];
    if (saved?.symbols?.length === c.symbolsTop && this.isCompatible(saved, saved.symbols)) return saved.symbols;
    const tickers = await withRetry(() => this.bybit.tickers(), { attempts: 8 });
    return rankVolatility(tickers, { minTurnover: c.symbolsMinTurnover, limit: c.symbolsTop }).map(v => v.symbol);
  }

  async start(factories: readonly StrategyFactory[] = ACTIVE_STRATEGIES): Promise<void> {
    const saved = await this.store.load();
    const symbols = await this.resolveSymbols(saved);
    // Без правил лота торговать нельзя. Если биржа недоступна, ждём её здесь,
    // а не падаем: иначе Docker перезапускал бы контейнер по кругу.
    const lots = new Map<string, LotRules>();
    await mapLimit(symbols, 8, async symbol => {
      const lot = await withRetry(() => this.bybit.lotRules(symbol), {
        attempts: 8,
        onError: (err, delayMs) =>
          this.logger.warn(`Правила лота ${symbol} не получены (${(err as Error).message}), повтор через ${delayMs / 1000} с`),
      }).catch(() => null);
      if (lot) lots.set(symbol, lot);
    });
    if (this.stopping) return;
    await this.init(symbols.filter(s => lots.has(s)), lots, factories);
    await this.tick();
    if (this.stopping) return;
    // Минутный опрос остаётся страховкой на случай обрыва потока.
    this.timer = setInterval(() => void this.tick('опрос'), this.config.pollMs);
    if (this.config.bybitStream) {
      const intervalMs = Number(this.config.interval) * 60_000;
      this.stream = new KlineStream({
        url: this.config.bybitStreamUrl,
        symbols: this.markets.map(m => m.symbol),
        interval: this.config.interval,
        onCandleClosed: (_, start) => void this.tick('поток', start + intervalMs),
        log: message => this.logger.log(message),
        socket: this.socket,
      });
      this.stream.start();
    }
  }

  async init(symbols: readonly string[], lots: Map<string, LotRules> | LotRules, factories: readonly StrategyFactory[] = ACTIVE_STRATEGIES): Promise<void> {
    const c = this.config;
    this.runStartedAt = Date.now();
    this.runId = new Date(this.runStartedAt).toISOString();

    const saved = await this.store.load();
    const restored = saved && this.isCompatible(saved, symbols) ? saved : null;
    if (saved && !restored) {
      this.logger.warn('Параметры запуска изменились — прежние результаты не применимы, счёт начат заново.');
    }
    this.restored = restored;

    // Простой между запусками: за это время цена ушла, поэтому опорные уровни
    // стратегий и оценка позиций пересчитываются от текущего рынка.
    this.downtimeSec = restored?.updatedAt
      ? Math.max(0, (this.runStartedAt - Date.parse(restored.updatedAt)) / 1000)
      : 0;

    const multi = this.multi;
    this.sessionStartedAt = restored?.sessionStartedAt ?? (restored ? null : this.runId);
    this.lots = {};
    this.markets = symbols.map(symbol => {
      const lot = lots instanceof Map ? lots.get(symbol)! : lots;
      this.lots[symbol] = lot;
      const costs: Costs = {
        feePct: c.feePct, slippagePct: c.slippagePct, lot, orderUsdt: c.orderUsdt,
        orderPct: c.orderPct, enforceMinOrder: c.enforceMinOrder,
      };
      const bots: Trader[] = factories.map(factory => {
        const strategy = factory();
        return new Bot(strategy, {
          startBalance: c.startBalance,
          snapshot: restored?.bots?.[botKey(symbol, strategy.name, multi)] ?? null,
          downtimeSec: this.downtimeSec,
          costs,
        });
      });
      // Мета-бот идёт последним: решает уже по обновлённым позициям остальных.
      bots.push(new MetaBot([...bots], {
        startBalance: c.startBalance,
        snapshot: restored?.bots?.[botKey(symbol, metaName(bots.length), multi)] ?? null,
        costs,
        windowCandles: c.metaWindowCandles,
        switchMarginPct: c.metaSwitchMarginPct,
      }));
      return { symbol, bots, lastDecided: null, price: null };
    });

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
      note: `${restored ? 'продолжение' : 'новое состояние'}, запуск #${this.runNumber}, пар ${symbols.length}`,
    });
    this.started = true;
  }

  private isCompatible(state: EngineState, symbols: readonly string[]): boolean {
    const c = this.config;
    const savedSymbols = state.symbols ?? [state.symbol];
    return state.version === STATE_VERSION
      && savedSymbols.join(',') === symbols.join(',')
      && state.interval === c.interval
      && state.startBalance === c.startBalance
      && state.market === marketId(c)
      && state.feePct === c.feePct
      && state.slippagePct === c.slippagePct
      && state.orderUsdt === c.orderUsdt
      && (state.orderPct ?? 0) === c.orderPct
      && (state.enforceMinOrder ?? true) === c.enforceMinOrder;
  }

  private buildState(closing: boolean): EngineState {
    const c = this.config;
    const run = {
      runId: this.runId,
      startedAt: new Date(this.runStartedAt).toISOString(),
      runUptimeSec: this.runUptimeSec,
      ticks: this.ticks,
    };
    const multi = this.multi;
    return {
      version: STATE_VERSION,
      symbol: this.markets[0]?.symbol ?? c.symbol,
      symbols: this.markets.map(m => m.symbol),
      interval: c.interval,
      startBalance: c.startBalance,
      market: marketId(c),
      feePct: c.feePct,
      slippagePct: c.slippagePct,
      orderUsdt: c.orderUsdt,
      orderPct: c.orderPct,
      enforceMinOrder: c.enforceMinOrder,
      lots: this.lots,
      ...(this.sessionStartedAt ? { sessionStartedAt: this.sessionStartedAt } : {}),
      updatedAt: new Date().toISOString(),
      runs: this.runNumber,
      uptimeSecTotal: this.baseUptimeSec + this.runUptimeSec,
      lastRun: run,
      currentRun: closing ? null : run,
      bots: Object.fromEntries(this.markets.flatMap(m =>
        m.bots.map(bot => [botKey(m.symbol, bot.strategy.name, multi), bot.snapshot()]))),
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

  // Последнее состояние — его же видит панель. В памяти оно обновляется каждый
  // тик, на диск пишется, когда боты принимали решения (раз в свечу).
  state(): EngineState | null {
    return this.lastState;
  }

  marketSymbols(): string[] {
    return this.markets.map(m => m.symbol);
  }

  // Первый тик после восстановления фиксирует простой.
  private async logResumeGap(): Promise<void> {
    if (this.resumeLogged || !this.restored) return;
    this.resumeLogged = true;
    await this.log.run({
      event: 'resume',
      runId: this.runId,
      runUptimeSec: 0,
      totalUptimeSec: Math.round(this.baseUptimeSec),
      ticks: 0,
      note: `простой ${formatDuration(this.downtimeSec)}, пар ${this.markets.length}`,
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
    const intervalMs = Number(c.interval) * 60_000;
    try {
      const askedAt = Date.now();
      const fetched = await mapLimit(this.markets, 10, m =>
        this.bybit.klines(m.symbol, c.interval, 101).catch(() => null as Candle[] | null));
      const fetchMs = Date.now() - askedAt;
      const now = Math.max(Date.now(), closedUntil);
      await this.logResumeGap();

      const equityRows: EquityEntry[] = [];
      let decided = 0;
      let stale = 0;
      let maxLagMs = 0;
      for (let i = 0; i < this.markets.length; i += 1) {
        const m = this.markets[i]!;
        const all = fetched[i];
        if (!all) continue;
        const { closed: candles, price } = splitClosed(all, c.interval, now);
        if (!candles.length || price === null || !Number.isFinite(price)) continue;

        // Актуальность: последняя закрытая свеча должна быть только что закрытой.
        // Если она старше ещё одной свечи — биржа отдала устаревшие данные.
        const lastClosed = candles[candles.length - 1]!.time;
        const ageMs = now - (lastClosed + intervalMs);
        if (ageMs > intervalMs) {
          stale += 1;
          continue;
        }
        m.price = price;
        const decides = lastClosed !== m.lastDecided;
        if (decides) {
          m.lastDecided = lastClosed;
          decided += 1;
          maxLagMs = Math.max(maxLagMs, ageMs);
        }
        for (const bot of m.bots) {
          const result = bot.step(candles, price);
          const name = bot.strategy.name;
          // Счёт пишем раз в свечу: 1200 ботов × каждую минуту — сотни МБ в сутки.
          if (decides) {
            equityRows.push({
              symbol: m.symbol,
              bot: name,
              price: result.price,
              equity: result.equity,
              position: result.position > 0 ? 1 : 0,
              trades: bot.ledger.tradeCount,
              runId: this.runId,
            });
          }
          if (result.trade) {
            await this.log.trade({
              symbol: m.symbol,
              bot: name,
              side: result.trade.side,
              price: result.trade.price,
              pnlPct: result.trade.pnlPct,
              runId: this.runId,
            });
            this.emitTrade({
              symbol: m.symbol,
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
      }
      if (equityRows.length) await this.log.equity(equityRows);

      // Задержку меряем только на решениях по новой свече: тики опроса внутри
      // свечи ничего не решают, и «свеча закрыта 3 минуты назад» — не опоздание.
      this.feed = decided
        ? { source, streamConnected: this.stream?.connected ?? false, lagSec: Math.round(maxLagMs / 100) / 10, fetchMs, staleSkips: this.feed.staleSkips + stale }
        : { ...this.feed, streamConnected: this.stream?.connected ?? false, staleSkips: this.feed.staleSkips + stale };
      if (stale) this.logger.warn(`данные устарели по ${stale} из ${this.markets.length} пар — эти пары пропущены`);

      this.ticks += 1;
      this.runUptimeSec = (Date.now() - this.runStartedAt) / 1000;
      const state = this.buildState(false);
      this.lastState = state;
      if (decided || this.markets.length === 1) await this.store.save(state);
      if (decided) this.logStatus(decided);
    } catch (err) {
      this.logger.error(`Ошибка опроса рынка: ${(err as Error).message}`);
    }
  }

  private logStatus(decided: number): void {
    const bots = this.markets.flatMap(m => m.bots);
    const total = bots.reduce((sum, bot) => sum + bot.ledger.equity, 0);
    const invested = this.config.startBalance * bots.length;
    const pnlPct = (total / invested - 1) * 100;
    const inMarket = bots.filter(bot => bot.ledger.position > 0).length;
    const first = this.markets[0];
    const pair = this.markets.length === 1 && first ? `${first.symbol} ${first.price}` : `пар ${decided}/${this.markets.length}`;
    this.logger.log(
      `тик ${this.ticks} · ${pair} · в рынке ${inMarket}/${bots.length}`
      + ` · счёт ${total.toFixed(2)}/${invested.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)} %)`
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
