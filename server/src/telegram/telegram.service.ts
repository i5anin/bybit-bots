import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { RatesService } from '../stats/rates.service.js';
import { StatsService } from '../stats/stats.service.js';
import type { Stats, TradeRow } from '../stats/stats.types.js';
import { EngineService, type TradeEvent } from '../trading/engine.service.js';

// Что уже отправлено: сводка — раз в день, а «за сутки» в ней считается
// от счетов на момент прошлой сводки.
interface Seen {
  lastDigestDay: string | null;
  lastDigestAt: string | null;
  digestRub: Record<string, number>;
}

const EMPTY_SEEN: Seen = { lastDigestDay: null, lastDigestAt: null, digestRub: {} };

function escapeHtml(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// «1 234 ₽» с неразрывными пробелами, чтобы сумма не переносилась по частям;
// знак — у прибыли и убытка.
const NBSP = ' ';
function rub(v: number, sign = false): string {
  const text = `${Math.abs(Math.round(v)).toLocaleString('ru-RU').replace(/\s/g, NBSP)}${NBSP}₽`;
  if (!sign) return Math.round(v) < 0 ? `−${text}` : text;
  return Math.round(v) > 0 ? `+${text}` : Math.round(v) < 0 ? `−${text}` : `±${text}`;
}

function pct(v: number): string {
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)} %`;
}

export interface TradeMessageContext {
  rubPerUsd: number;
  startRub: number;
}

export function tradeMessage(e: TradeEvent, ctx: TradeMessageContext): string {
  const profitRub = (e.pnlUsdt ?? 0) * ctx.rubPerUsd;
  const equityRub = e.equity * ctx.rubPerUsd;
  return [
    `✅ <b>${rub(profitRub, true)}</b> (${pct(e.pnlPct ?? 0)}) — ${escapeHtml(e.bot)}`,
    `Продажа по ${e.price}, прибыль $${(e.pnlUsdt ?? 0).toFixed(4)} после комиссий`,
    `Счёт бота: <b>${rub(equityRub)}</b>, с начала ${rub(equityRub - ctx.startRub, true)}`,
  ].join('\n');
}

export function digestMessage(stats: Stats, seen: Seen, trades: readonly TradeRow[], webUrl: string, now: Date): string {
  const hasPrev = Object.keys(seen.digestRub).length > 0;
  const lines = stats.bots.map((b, i) => {
    const sinceStart = b.equityRub - stats.startRub;
    const prev = seen.digestRub[b.name];
    const day = prev === undefined ? '' : ` · за сутки ${rub(b.equityRub - prev, true)}`;
    const follows = b.isMeta ? `\n    ${b.leader ? `повторяет ${escapeHtml(b.leader)}` : 'вне рынка: в плюсе никого'}` : '';
    return `${i + 1}. ${escapeHtml(b.name)} — <b>${rub(b.equityRub)}</b> (${rub(sinceStart, true)})${day}${follows}`;
  });

  const total = stats.bots.reduce((s, b) => s + b.equityRub, 0);
  const invested = stats.startRub * stats.bots.length;
  const prevTotal = hasPrev ? Object.values(seen.digestRub).reduce((s, v) => s + v, 0) : null;
  const since = seen.lastDigestAt;
  const dayTrades = trades.filter(t => !since || t.time > since);
  const dayClosed = dayTrades.filter(t => t.pnlPct !== '');
  const dayWins = dayClosed.filter(t => Number(t.pnlPct) > 0).length;
  const date = now.toLocaleDateString('ru-RU');

  return [
    `📊 <b>Итог дня ${date}</b> — ${escapeHtml(stats.symbol)}`,
    `У каждого бота старт ${rub(stats.startRub)}. В скобках — сколько заработал с начала.`,
    '',
    ...lines,
    '',
    `<b>Все ${stats.bots.length} вместе: ${rub(total)} из ${rub(invested)} (${rub(total - invested, true)})</b>`
      + (prevTotal === null ? '' : `, за сутки ${rub(total - prevTotal, true)}`),
    `В плюсе с начала: ${stats.bots.filter(b => b.equityRub > stats.startRub).length} из ${stats.bots.length}`,
    `Сделок ${since ? 'за сутки' : 'всего'}: ${dayTrades.length}, закрыто ${dayClosed.length}`
      + (dayClosed.length ? `, в плюс ${dayWins}` : ''),
    `Курс ${stats.rubPerUsd.toFixed(2)} ₽ за $ (${escapeHtml(stats.rateSource)})`,
    webUrl ? `\n<a href="${escapeHtml(webUrl)}">Панель</a>` : '',
  ].join('\n');
}

// Оповещения в Telegram: итог дня со счётом и заработком каждого бота и
// прибыльные сделки с суммой. Без токена в окружении молча не работает:
// движок и панель от этого не страдают.
@Injectable()
export class TelegramService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Telegram');
  private readonly seenFile: string;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  readonly enabled: boolean;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(StatsService) private readonly stats: StatsService,
    @Inject(RatesService) private readonly rates: RatesService,
    @Inject(EngineService) private readonly engine: EngineService,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.enabled = Boolean(config.telegram.token && config.telegram.chatId);
    this.seenFile = path.join(config.dataDir, 'notify-state.json');
  }

  onApplicationBootstrap(): void {
    this.logger.log(this.enabled
      ? `оповещения включены: сделки от +${this.config.telegram.minPnlPct} %, итог дня после ${this.config.telegram.digestHour}:00`
      : 'оповещения выключены: нет TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID');
    if (!this.enabled) return;
    this.unsubscribe = this.engine.onTrade(e => void this.notifyTrade(e));
    void this.sendStartupNotice();
    this.timer = setInterval(() => void this.digestIfDue(), this.config.telegram.intervalMs);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
  }

  async send(html: string): Promise<boolean> {
    if (!this.enabled) return false;
    const { token, chatId } = this.config.telegram;
    try {
      const res = await this.fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        this.logger.warn(`Telegram отказал: ${res.status} ${(await res.text()).slice(0, 200)}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`не отправлено: ${(err as Error).message}`);
      return false;
    }
  }

  private startRub(rubPerUsd: number): number {
    return this.config.startRub > 0 ? this.config.startRub : this.config.startBalance * rubPerUsd;
  }

  // Закрытая сделка с прибылью от порога — сразу, с суммой в рублях и долларах.
  async notifyTrade(e: TradeEvent): Promise<boolean> {
    if (!this.enabled || e.side !== 'sell' || e.pnlPct === undefined) return false;
    if (e.pnlPct < this.config.telegram.minPnlPct) return false;
    const { value } = await this.rates.rubPerUsd();
    return this.send(tradeMessage(e, { rubPerUsd: value, startRub: this.startRub(value) }));
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

  // Итог дня — один раз в сутки, после DIGEST_HOUR по времени контейнера (TZ).
  async digestIfDue(now = new Date()): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const seen = await this.loadSeen();
      const today = now.toLocaleDateString('sv-SE'); // ГГГГ-ММ-ДД в местном времени
      if (now.getHours() < this.config.telegram.digestHour || seen.lastDigestDay === today) return false;

      const [stats, trades] = await Promise.all([this.stats.stats(now.getTime()), this.stats.allTrades()]);
      if (!stats.bots.length) return false;
      const sent = await this.send(digestMessage(stats, seen, trades, this.config.telegram.publicUrl, now));
      if (!sent) return false;
      await this.saveSeen({
        lastDigestDay: today,
        lastDigestAt: now.toISOString(),
        digestRub: Object.fromEntries(stats.bots.map(b => [b.name, b.equityRub])),
      });
      return true;
    } catch (err) {
      this.logger.warn(`итог дня не отправлен: ${(err as Error).message}`);
      return false;
    }
  }

  private async sendStartupNotice(): Promise<void> {
    const { minPnlPct, digestHour, publicUrl } = this.config.telegram;
    await this.send([
      '🤖 <b>Боты Bybit на связи</b>',
      '',
      `${escapeHtml(this.config.symbol)}, свечи ${escapeHtml(this.config.interval)} мин`,
      `Итог дня — после ${digestHour}:00: счёт и заработок каждого бота`,
      `Сделки — сразу, если прибыль от +${minPnlPct} %`,
      publicUrl ? `\n<a href="${escapeHtml(publicUrl)}">Панель</a>` : '',
    ].join('\n'));
  }
}
