import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG, inDayHours, type AppConfig } from '../config/app-config.js';
import { BybitClient } from '../market/bybit.js';
import { rankVolatility } from '../market/volatility.js';
import { RatesService } from '../stats/rates.service.js';
import { StatsService } from '../stats/stats.service.js';
import { EngineService, type TradeEvent } from '../trading/engine.service.js';
import { priceLabel, renderChartPng } from './chart.js';
import { PairChartService } from '../stats/pair-chart.service.js';
import {
  chartSections, esc, pairClassic, pairRichHtml, pct, reportClassic, reportRichHtml, rub, tradeClassic, tradeRichHtml,
  type ReportInput, type ReportKind,
} from './report.js';
import { TelegramApi, type Update } from './telegram-api.js';

// Что уже отправлено и с чем сравнивать: «за час» — от счетов на момент
// прошлого часового отчёта, «за сутки» — от прошлого итога дня.
export interface Seen {
  lastDigestDay: string | null;
  lastDigestAt: string | null;
  digestRub: Record<string, number>;
  digestPrice: number | null;
  lastReportKey: string | null;
  goalLevels?: Record<string, number>; // пройденные ступени +25 % по группам
  lastReportAt: string | null;
  reportRub: Record<string, number>;
  reportPrice: number | null;
}

const EMPTY_SEEN: Seen = {
  lastDigestDay: null, lastDigestAt: null, digestRub: {}, digestPrice: null,
  lastReportKey: null, lastReportAt: null, reportRub: {}, reportPrice: null,
};

const HOUR_MS = 3_600_000;
const MAX_ALERTS_PER_HOUR = 3;
// «Нормальные деньги» по правилу владельца: каждая ступень — капитал ×1.25.
const GOAL_STEP = 1.25;
const STALE_COMMAND_SEC = 300; // команду, пролежавшую дольше (сервер стоял), не выполняем
const FIRST_REPORT_DELAY_MS = 15_000; // дать движку сделать первый тик после запуска

function localDay(d: Date): string {
  return d.toLocaleDateString('sv-SE'); // ГГГГ-ММ-ДД в местном времени (TZ)
}

// Оповещения в Telegram: каждый час днём — итоги часа с графиком, раз в день —
// итог дня, прибыльные сделки — сразу (ночью без звука), /now — отчёт по
// запросу. Без токена в окружении молча не работает: движок и панель от этого
// не страдают.
@Injectable()
export class TelegramService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Telegram');
  private readonly seenFile: string;
  private readonly api: TelegramApi;
  private timers: NodeJS.Timeout[] = [];
  private unsubscribe: (() => void) | null = null;
  private polling: AbortController | null = null;
  private ticking: Promise<ReportKind | null> | null = null;
  private richFailed = false;
  private alertTimes: number[] = [];
  readonly enabled: boolean;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(StatsService) private readonly stats: StatsService,
    @Inject(RatesService) private readonly rates: RatesService,
    @Inject(EngineService) private readonly engine: EngineService,
    @Inject(BybitClient) private readonly bybit: BybitClient,
    @Inject(PairChartService) private readonly pairCharts: PairChartService,
    fetchFn: typeof fetch = fetch,
  ) {
    const { token, chatId } = config.telegram;
    this.enabled = Boolean(token && chatId);
    this.seenFile = path.join(config.dataDir, 'notify-state.json');
    this.api = new TelegramApi(token, chatId, fetchFn);
  }

  schedule(): string {
    const t = this.config.telegram;
    const hourly = t.hourly ? `каждый час с ${t.dayFrom}:00 до ${t.dayTo}:00` : 'без часовых отчётов';
    return `${hourly}, итог дня в ${t.digestHour}:00`;
  }

  onApplicationBootstrap(): void {
    const t = this.config.telegram;
    if (!this.enabled) {
      this.logger.log('оповещения выключены: нет TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID');
      return;
    }
    this.logger.log(`оповещения включены: ${this.schedule()}, сделки от +${t.minPnlPct} %`);
    this.unsubscribe = this.engine.onTrade(e => void this.notifyTrade(e));
    void this.sendStartupNotice();
    this.timers.push(setTimeout(() => void this.tick(), FIRST_REPORT_DELAY_MS));
    this.timers.push(setInterval(() => void this.tick(), t.intervalMs));
    if (t.commands) {
      void this.api.setCommands([
        { command: 'now', description: 'Результаты прямо сейчас' },
        { command: 'pair', description: 'Отчёт по паре: /pair ZK' },
        { command: 'help', description: 'Что и когда присылает бот' },
      ]);
      void this.pollCommands();
    }
  }

  onApplicationShutdown(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.unsubscribe?.();
    this.polling?.abort();
  }

  // Rich-сообщение; если Telegram его не принял — фото с подписью и текст.
  private async deliver(rich: string, classic: { caption: string; text: string }, photo: Buffer | null, silent = false): Promise<boolean> {
    if (!this.enabled) return false;
    const res = await this.api.sendRichMessage(rich, photo, { silent });
    if (res.ok) return true;
    if (!this.richFailed) {
      this.logger.warn(`rich-сообщение не принято (${res.description}), отправляю обычным`);
      this.richFailed = true;
    }
    let ok = false;
    if (photo) ok = (await this.api.sendPhoto(photo, classic.caption, { silent })).ok;
    const text = await this.api.sendMessage(classic.text, { silent });
    if (!text.ok) this.logger.warn(`Telegram отказал: ${text.description}`);
    return ok || text.ok;
  }

  private startRub(rubPerUsd: number): number {
    return this.config.startRub > 0 ? this.config.startRub : this.config.startBalance * rubPerUsd;
  }

  // Закрытая сделка с прибылью от порога — сразу; ночью без звука. Ботов может
  // быть 1200, поэтому не больше трёх таких сообщений в час, остальное — в отчёте.
  async notifyTrade(e: TradeEvent, now = new Date()): Promise<boolean> {
    if (!this.enabled || e.side !== 'sell' || e.pnlPct === undefined) return false;
    if (e.pnlPct < this.config.telegram.minPnlPct) return false;
    this.alertTimes = this.alertTimes.filter(t => now.getTime() - t < HOUR_MS);
    if (this.alertTimes.length >= MAX_ALERTS_PER_HOUR) return false;
    this.alertTimes.push(now.getTime());
    const { value } = await this.rates.rubPerUsd();
    const ctx = { rubPerUsd: value, startRub: this.startRub(value) };
    const silent = !this.isDay(now);
    const res = await this.api.sendRichMessage(tradeRichHtml(e, ctx), null, { silent });
    if (res.ok) return true;
    return (await this.api.sendMessage(tradeClassic(e, ctx), { silent })).ok;
  }

  private isDay(now: Date): boolean {
    const t = this.config.telegram;
    return inDayHours(now.getHours(), t.dayFrom, t.dayTo);
  }

  private async loadSeen(): Promise<Seen> {
    try {
      return { ...EMPTY_SEEN, ...(JSON.parse(await readFile(this.seenFile, 'utf8')) as Partial<Seen>) };
    } catch {
      return { ...EMPTY_SEEN };
    }
  }

  private async saveSeen(seen: Seen): Promise<void> {
    await mkdir(path.dirname(this.seenFile), { recursive: true });
    await writeFile(this.seenFile, JSON.stringify(seen, null, 2));
  }

  // Собирает отчёт: текст, запасной текст и картинку (если удалось нарисовать).
  async buildReport(kind: ReportKind, seen: Seen, now: Date, step: (text: string) => Promise<void> = async () => {}) {
    await step('Беру счета ботов');
    const [stats, trades] = await Promise.all([this.stats.stats(now.getTime()), this.stats.allTrades()]);
    const multi = stats.symbols.length > 1;
    const isDay = kind === 'day';
    const sinceIso = (isDay ? seen.lastDigestAt : seen.lastReportAt)
      ?? new Date(now.getTime() - (isDay ? 24 : 1) * HOUR_MS).toISOString();
    const prev = isDay ? seen.digestRub : seen.reportRub;
    await step('Беру цены с биржи');
    // Цена и рейтинг волатильности нужны только при одной паре: при многих
    // отчёт сравнивает сами пары.
    const [candles, tickers] = multi ? [[], []] : await Promise.all([
      this.bybit.klines(stats.symbol, '15', 96).catch(() => []),
      this.bybit.tickers().catch(() => []),
    ]);

    const input: ReportInput = {
      kind,
      stats,
      prevRub: Object.keys(prev).length ? prev : null,
      prevPrice: isDay ? seen.digestPrice : seen.reportPrice,
      price24hAgo: candles[0]?.open ?? null,
      trades: trades.filter(t => t.time > sinceIso),
      now,
      webUrl: this.config.telegram.publicUrl,
      hasPhoto: false,
      refreshButton: this.config.telegram.commands,
      schedule: this.schedule(),
      volatility: multi ? [] : rankVolatility(tickers),
    };

    await step('Рисую график');
    let photo: Buffer | null = null;
    try {
      const dayAgo = new Date(now.getTime() - 24 * HOUR_MS).toISOString();
      const t = stats.totals;
      const what = kind === 'day' ? 'итог дня' : kind === 'hour' ? `итоги часа ${String(now.getHours()).padStart(2, '0')}:00` : 'сейчас';
      photo = renderChartPng({
        title: multi ? `${stats.symbols.length} пар × ${stats.strategies.length} стратегий · ${what}` : `${stats.symbol} · ${what}`,
        subtitle: [
          !multi && stats.price ? `цена ${priceLabel(stats.price)} $` : '',
          `все ${t.bots}: ${rub(t.equityRub)} из ${rub(t.investedRub)}`,
          t.aprPct === null ? '' : `${pct(t.aprPct, 1)} годовых, вклад ${stats.bankRatePct} %`,
        ].filter(Boolean).join(' · ').replace(/\u00a0/g, ' '),
        prices: multi ? undefined : candles.map(c => ({ time: c.time, price: c.close })),
        trades: multi ? undefined : trades.filter(x => x.time > dayAgo).map(x => ({
          time: Date.parse(x.time), price: Number(x.price), side: x.side === 'buy' ? 'buy' as const : 'sell' as const,
        })),
        sections: chartSections(stats, input.prevRub),
        periodLabel: kind === 'day' ? 'за сутки' : kind === 'hour' ? 'за час' : 'с отчёта',
      });
      input.hasPhoto = true;
    } catch (err) {
      this.logger.warn(`график не нарисован: ${(err as Error).message}`);
    }
    return { input, stats, photo };
  }

  private snapshot(stats: { bots: { key: string; equityRub: number }[] }): Record<string, number> {
    return Object.fromEntries(stats.bots.map(b => [b.key, Math.round(b.equityRub * 100) / 100]));
  }

  // Раз в минуту: итог дня, если пора, иначе отчёт за час, если он ещё не ушёл
  // и сейчас не ночь. Отчёт за пропущенные часы не досылается — только текущий.
  tick(now = new Date()): Promise<ReportKind | null> {
    if (!this.enabled) return Promise.resolve(null);
    this.ticking ??= this.runTick(now).finally(() => { this.ticking = null; });
    return this.ticking;
  }

  private async runTick(now: Date): Promise<ReportKind | null> {
    const t = this.config.telegram;
    try {
      const seen = await this.loadSeen();
      const day = localDay(now);
      const hourKey = `${day} ${String(now.getHours()).padStart(2, '0')}`;
      const digestDue = now.getHours() >= t.digestHour && seen.lastDigestDay !== day;
      const hourlyDue = t.hourly && this.isDay(now) && seen.lastReportKey !== hourKey;
      await this.checkGoal(seen, now);
      if (!digestDue && !hourlyDue) return null;

      const kind: ReportKind = digestDue ? 'day' : 'hour';
      const { input, stats, photo } = await this.buildReport(kind, seen, now);
      if (!stats.bots.length) return null;
      const sent = await this.deliver(reportRichHtml(input), reportClassic(input), photo);
      if (!sent) return null;

      // Итог дня заменяет отчёт своего часа, поэтому обновляет и часовой снимок.
      const snap = this.snapshot(stats);
      const next: Seen = { ...seen, lastReportKey: hourKey, lastReportAt: now.toISOString(), reportRub: snap, reportPrice: stats.price };
      if (kind === 'day') {
        Object.assign(next, { lastDigestDay: day, lastDigestAt: now.toISOString(), digestRub: snap, digestPrice: stats.price });
      }
      await this.saveSeen(next);
      return kind;
    } catch (err) {
      this.logger.warn(`отчёт не отправлен: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Сообщение «есть результат» — только про лучшего из лучших: из всех ботов,
   * стратегий (сумма по парам) и пар берётся один с наибольшей доходностью от
   * капитала. Пишем, когда он проходит очередную ступень +25 %: 1000 → 1250 →
   * 1563 → 1953 ₽… (каждая ступень ×1.25 к предыдущей). Правило владельца:
   * не присылать каждый час, только «нормальные деньги».
   * Вызывается из runTick раз в минуту. Пройденные ступени хранятся в
   * notify-state.json (goalLevels: группа → номер ступени), поэтому о каждой
   * ступени сообщение одно. Возвращает true, если сообщение ушло.
   */
  async checkGoal(seen: Seen, now: Date): Promise<boolean> {
    const stats = await this.stats.stats(now.getTime());
    const pair = (s: string) => s.replace(/USDT$/, '');
    const candidates = [
      { id: 'all', title: `Все ${stats.totals.bots} ботов`, pnlRub: stats.totals.pnlRub, capital: stats.totals.investedRub },
      ...stats.strategies.map(g => ({ id: `strategy:${g.name}`, title: `Стратегия ${g.name}`, pnlRub: g.pnlRub, capital: g.investedRub })),
      ...(stats.symbols.length > 1 ? stats.pairs.map(g => ({ id: `pair:${g.name}`, title: `Пара ${pair(g.name)}`, pnlRub: g.pnlRub, capital: g.investedRub })) : []),
      ...stats.bots.map(b => ({ id: `bot:${b.key}`, title: `Бот ${pair(b.symbol)} · ${b.name}`, pnlRub: b.pnlRub, capital: stats.startRub })),
    ].filter(c => c.capital > 0);
    const best = candidates.sort((x, y) => y.pnlRub / y.capital - x.pnlRub / x.capital)[0];
    if (!best) return false;

    const ratio = (best.capital + best.pnlRub) / best.capital; // 1.30 = капитал вырос на 30 %
    const level = ratio >= GOAL_STEP ? Math.floor(Math.log(ratio) / Math.log(GOAL_STEP) + 1e-9) : 0;
    const levels = seen.goalLevels ?? {};
    if (level <= (levels[best.id] ?? 0)) return false;

    const target = best.capital * GOAL_STEP ** level;
    const html = `<h2>💰 ${esc(best.title)}: ${rub(best.capital + best.pnlRub)} из ${rub(best.capital)}</h2>`
      + `<p>Лучший из всех: капитал вырос на <b>${pct((ratio - 1) * 100, 1)}</b>, пройдена ступень ${rub(target)}. `
      + `Следующая — ${rub(target * GOAL_STEP)}.</p>`;
    const text = html.replace(/<[^>]+>/g, ' ');
    if (!(await this.deliver(html, { caption: text, text }, null))) return false;
    seen.goalLevels = { ...levels, [best.id]: level };
    await this.saveSeen(seen);
    return true;
  }

  // Отчёт по запросу: изменения — с прошлого часового отчёта, снимок не трогаем.
  async sendNow(now = new Date()): Promise<boolean> {
    const seen = await this.loadSeen();
    const { input, stats, photo } = await this.buildReport('now', seen, now, this.progress());
    if (!stats.bots.length) return (await this.api.sendMessage('Данных пока нет: бот ещё не сделал ни одного тика')).ok;
    return this.deliver(reportRichHtml(input), reportClassic(input), photo);
  }

  // Отчёт по одной паре: график цены с входами и выходами её ботов и таблица 12 ботов.
  async sendPair(raw: string, now = new Date()): Promise<boolean> {
    const stats = await this.stats.stats(now.getTime());
    const want = raw.toUpperCase().replace(/USDT$/, '');
    if (!want) {
      const list = stats.pairs.slice(0, 20).map(p => p.name.replace(/USDT$/, '')).join(', ');
      return (await this.api.sendMessage(`Напиши пару: <code>/pair ZK</code>\nЛучшие сейчас: ${esc(list)}`)).ok;
    }
    const symbol = `${want}USDT`;
    if (!stats.symbols.includes(symbol)) return (await this.api.sendMessage(`Пары ${esc(want)} нет среди торгуемых`)).ok;
    const step = this.progress();
    await step(`Собираю отчёт по ${want}`);
    const detail = await this.stats.pairDetail(symbol, now.getTime());
    await step('Рисую график');
    const photo = await this.pairCharts.render(symbol, now.getTime()).catch(() => null);
    const classic = pairClassic(detail);
    return this.deliver(pairRichHtml(detail, stats, Boolean(photo)), { caption: classic, text: classic }, photo);
  }

  // Анимация, пока собирается отчёт по запросу: черновик с <tg-thinking>, шаги
  // которого Telegram плавно сменяет; готовый отчёт его заменяет. Если черновики
  // не поддерживаются — статус «отправляет фото…».
  private progress(): (text: string) => Promise<void> {
    const draftId = Math.floor(Date.now() / 1000) % 2_000_000_000 || 1;
    let drafts = true;
    return async text => {
      if (drafts) {
        const res = await this.api.sendDraft(draftId, `<tg-thinking>${esc(text)}…</tg-thinking>`);
        if (res.ok) return;
        drafts = false;
        this.logger.warn(`черновик не принят (${res.description}), показываю статус`);
      }
      await this.api.chatAction('upload_photo');
    };
  }

  // Только из настроенного чата: бот публичный, найти его может кто угодно.
  async handleUpdate(u: Update, nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
    const mine = (id: number | undefined) => id !== undefined && String(id) === this.config.telegram.chatId;
    if (u.callback_query) {
      const q = u.callback_query;
      if (!mine(q.message?.chat.id) || q.data !== 'now') return;
      await this.api.answerCallback(q.id, 'Собираю свежий отчёт…');
      await this.sendNow();
      return;
    }
    const m = u.message;
    if (!m || !mine(m.chat.id) || !m.text) return;
    if (m.date !== undefined && nowSec - m.date > STALE_COMMAND_SEC) return;
    const command = m.text.trim().split(/[\s@]/)[0]?.toLowerCase();
    if (command === '/now') await this.sendNow();
    else if (command === '/pair') await this.sendPair(m.text.trim().split(/\s+/)[1] ?? '');
    else if (command === '/start' || command === '/help') await this.sendStartupNotice();
  }

  private async pollCommands(): Promise<void> {
    this.polling = new AbortController();
    const { signal } = this.polling;
    let offset = 0;
    let warned = false;
    while (!signal.aborted) {
      const res = await this.api.getUpdates(offset, 50, signal);
      if (signal.aborted) break;
      if (!res.ok) {
        if (!warned) this.logger.warn(`команды не принимаются: ${res.description}`);
        warned = true;
        await new Promise(r => setTimeout(r, 10_000));
        continue;
      }
      warned = false;
      for (const u of res.result ?? []) {
        offset = u.update_id + 1;
        await this.handleUpdate(u).catch(err => this.logger.warn(`команда не выполнена: ${(err as Error).message}`));
      }
    }
  }

  async sendStartupNotice(): Promise<void> {
    const t = this.config.telegram;
    const items = [
      t.hourly ? `каждый час с <b>${t.dayFrom}:00</b> до <b>${t.dayTo}:00</b> — итоги часа с графиком` : '',
      `в <b>${t.digestHour}:00</b> — итог дня: счёт и заработок каждого бота`,
      `прибыльные сделки от <b>+${t.minPnlPct} %</b> — сразу, ночью без звука`,
      t.commands ? '<b>/now</b> — результаты прямо сейчас, <b>/pair ZK</b> — отчёт и график по паре' : '',
    ].filter(Boolean);
    const rich = `<h2>🤖 Боты Bybit на связи</h2><p>${esc(this.config.symbol)}, свечи ${esc(this.config.interval)} мин. Буду присылать:</p>`
      + `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
    const classic = ['🤖 <b>Боты Bybit на связи</b>', ...items.map(i => `• ${i}`)].join('\n');
    await this.deliver(rich, { caption: classic, text: classic }, null);
  }
}
