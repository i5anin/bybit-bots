import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG, inDayHours, type AppConfig } from '../config/app-config.js';
import { BybitClient } from '../market/bybit.js';
import { RatesService } from '../stats/rates.service.js';
import { StatsService } from '../stats/stats.service.js';
import { EngineService, type TradeEvent } from '../trading/engine.service.js';
import { priceLabel, renderChartPng } from './chart.js';
import {
  esc, pct, reportClassic, reportRichHtml, rub, tradeClassic, tradeRichHtml,
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
  lastReportAt: string | null;
  reportRub: Record<string, number>;
  reportPrice: number | null;
}

const EMPTY_SEEN: Seen = {
  lastDigestDay: null, lastDigestAt: null, digestRub: {}, digestPrice: null,
  lastReportKey: null, lastReportAt: null, reportRub: {}, reportPrice: null,
};

const HOUR_MS = 3_600_000;
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
  readonly enabled: boolean;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(StatsService) private readonly stats: StatsService,
    @Inject(RatesService) private readonly rates: RatesService,
    @Inject(EngineService) private readonly engine: EngineService,
    @Inject(BybitClient) private readonly bybit: BybitClient,
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

  // Закрытая сделка с прибылью от порога — сразу; ночью без звука.
  async notifyTrade(e: TradeEvent, now = new Date()): Promise<boolean> {
    if (!this.enabled || e.side !== 'sell' || e.pnlPct === undefined) return false;
    if (e.pnlPct < this.config.telegram.minPnlPct) return false;
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
  async buildReport(kind: ReportKind, seen: Seen, now: Date) {
    const [stats, trades] = await Promise.all([this.stats.stats(now.getTime()), this.stats.allTrades()]);
    const isDay = kind === 'day';
    const sinceIso = (isDay ? seen.lastDigestAt : seen.lastReportAt)
      ?? new Date(now.getTime() - (isDay ? 24 : 1) * HOUR_MS).toISOString();
    const prev = isDay ? seen.digestRub : seen.reportRub;
    const candles = await this.bybit.klines(this.config.symbol, '15', 96).catch(() => []);

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
    };

    let photo: Buffer | null = null;
    try {
      const dayAgo = new Date(now.getTime() - 24 * HOUR_MS).toISOString();
      const total = stats.bots.reduce((s, b) => s + b.equityRub, 0);
      const dayPct = stats.price && input.price24hAgo ? (stats.price / input.price24hAgo - 1) * 100 : null;
      photo = renderChartPng({
        title: `${stats.symbol} · ${kind === 'day' ? 'итог дня' : kind === 'hour' ? `итоги часа ${String(now.getHours()).padStart(2, '0')}:00` : 'сейчас'}`,
        subtitle: [
          stats.price ? `цена ${priceLabel(stats.price)} $` : '',
          dayPct === null ? '' : `${pct(dayPct)} за сутки`,
          `все ${stats.bots.length}: ${rub(total)} из ${rub(stats.startRub * stats.bots.length)}`,
        ].filter(Boolean).join(' · ').replace(/ /g, ' '),
        prices: candles.map(c => ({ time: c.time, price: c.close })),
        trades: trades.filter(t => t.time > dayAgo).map(t => ({
          time: Date.parse(t.time), price: Number(t.price), side: t.side === 'buy' ? 'buy' as const : 'sell' as const,
        })),
        bars: stats.bots.map(b => ({
          name: b.name,
          total: b.equityRub - stats.startRub,
          period: input.prevRub?.[b.name] === undefined ? null : b.equityRub - input.prevRub[b.name]!,
          highlight: b.isMeta,
        })),
        periodLabel: kind === 'day' ? 'за сутки' : kind === 'hour' ? 'за час' : 'с отчёта',
      });
      input.hasPhoto = true;
    } catch (err) {
      this.logger.warn(`график не нарисован: ${(err as Error).message}`);
    }
    return { input, stats, photo };
  }

  private snapshot(stats: { bots: { name: string; equityRub: number }[] }): Record<string, number> {
    return Object.fromEntries(stats.bots.map(b => [b.name, Math.round(b.equityRub * 100) / 100]));
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

  // Отчёт по запросу: изменения — с прошлого часового отчёта, снимок не трогаем.
  async sendNow(now = new Date()): Promise<boolean> {
    const seen = await this.loadSeen();
    const { input, stats, photo } = await this.buildReport('now', seen, now);
    if (!stats.bots.length) return (await this.api.sendMessage('Данных пока нет: бот ещё не сделал ни одного тика')).ok;
    return this.deliver(reportRichHtml(input), reportClassic(input), photo);
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
      t.commands ? '<b>/now</b> — результаты прямо сейчас' : '',
    ].filter(Boolean);
    const rich = `<h2>🤖 Боты Bybit на связи</h2><p>${esc(this.config.symbol)}, свечи ${esc(this.config.interval)} мин. Буду присылать:</p>`
      + `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
    const classic = ['🤖 <b>Боты Bybit на связи</b>', ...items.map(i => `• ${i}`)].join('\n');
    await this.deliver(rich, { caption: classic, text: classic }, null);
  }
}
