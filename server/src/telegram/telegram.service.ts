import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { StatsService } from '../stats/stats.service.js';
import type { Stats, TradeRow } from '../stats/stats.types.js';

interface Seen {
  lastTradeTime: string | null;
  lastDigestDay: string | null;
}

function escapeHtml(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function tradeMessage(t: TradeRow, symbol: string): string {
  const pnl = Number(t.pnlPct).toFixed(2);
  const time = new Date(t.time).toLocaleTimeString('ru-RU', { hour12: false });
  return [
    '✅ <b>Прибыльная сделка</b>',
    '',
    `Стратегия: <b>${escapeHtml(t.bot)}</b>`,
    `Инструмент: ${escapeHtml(t.symbol || symbol)}`,
    `Направление: ${escapeHtml(t.side)}`,
    `Цена: ${escapeHtml(t.price)}`,
    `Результат: <b>+${pnl} %</b>`,
    `Время: ${time}`,
  ].join('\n');
}

export function digestMessage(stats: Stats, webUrl: string): string {
  const lines = stats.bots.slice(0, 5).map((b, i) => {
    const sign = b.pnlPct >= 0 ? '+' : '';
    return `${i + 1}. ${escapeHtml(b.name)} — <b>${sign}${b.pnlPct} %</b> (${Math.round(b.equityRub)} ₽)`;
  });
  const hours = Math.floor(stats.uptimeSecTotal / 3600);
  const win = stats.totals.winRatePct;
  return [
    `📊 <b>Сводка за сутки</b> — ${escapeHtml(stats.symbol)}`,
    '',
    ...lines,
    '',
    `В плюсе: <b>${stats.totals.inProfit}</b> из ${stats.bots.length}`,
    `Сделок всего: ${stats.totals.tradesTotal}` + (win === null ? '' : `, доля удачных: <b>${win} %</b>`),
    `Старт у каждого бота: ${Math.round(stats.startRub)} ₽ (${stats.startBalance} USDT)`,
    `Наработка: ${hours} ч, запусков: ${stats.runs}`,
    webUrl ? `\n<a href="${escapeHtml(webUrl)}">Подробности</a>` : '',
  ].join('\n');
}

// Оповещения в Telegram: удачные сделки сразу, сводка — раз в сутки.
// Без токена в окружении молча не работает: движок и панель от этого не страдают.
@Injectable()
export class TelegramService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Telegram');
  private readonly seenFile: string;
  private timer: NodeJS.Timeout | null = null;
  readonly enabled: boolean;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(StatsService) private readonly stats: StatsService,
  ) {
    this.enabled = Boolean(config.telegram.token && config.telegram.chatId);
    this.seenFile = path.join(config.dataDir, 'notify-state.json');
  }

  onApplicationBootstrap(): void {
    this.logger.log(`оповещения ${this.enabled ? 'включены' : 'выключены (нет токена)'}`);
    if (!this.enabled) return;
    void this.stats.stats()
      .then(stats => this.sendStartupNotice(stats))
      .catch(err => this.logger.warn(`приветствие не ушло: ${(err as Error).message}`));
    this.timer = setInterval(() => void this.loop(), this.config.telegram.intervalMs);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async loop(): Promise<void> {
    try {
      const [stats, trades] = await Promise.all([this.stats.stats(), this.stats.allTrades()]);
      await this.tick(stats, trades);
    } catch (err) {
      this.logger.warn(`проход не удался: ${(err as Error).message}`);
    }
  }

  private async loadSeen(): Promise<Seen> {
    try {
      return JSON.parse(await readFile(this.seenFile, 'utf8')) as Seen;
    } catch {
      return { lastTradeTime: null, lastDigestDay: null };
    }
  }

  private async saveSeen(seen: Seen): Promise<void> {
    await mkdir(path.dirname(this.seenFile), { recursive: true });
    await writeFile(this.seenFile, JSON.stringify(seen, null, 2));
  }

  private async send(html: string): Promise<boolean> {
    if (!this.enabled) return false;
    const { token, chatId } = this.config.telegram;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        this.logger.warn(`отказ ${res.status} ${(await res.text()).slice(0, 200)}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`не отправлено: ${(err as Error).message}`);
      return false;
    }
  }

  // Один проход: свежие удачные сделки плюс сводка, если её сегодня не слали.
  async tick(stats: Stats, trades: readonly TradeRow[], now = new Date()): Promise<void> {
    if (!this.enabled) return;
    const { minPnlPct, digestHour, publicUrl } = this.config.telegram;
    const seen = await this.loadSeen();
    let changed = false;

    // Только закрытые сделки в плюс: пустой pnlPct означает вход в позицию.
    const fresh = trades.filter(t => {
      const pnl = Number(t.pnlPct);
      return t.pnlPct !== '' && Number.isFinite(pnl) && pnl >= minPnlPct
        && (!seen.lastTradeTime || t.time > seen.lastTradeTime);
    });
    for (const t of fresh.slice(-10)) {
      if (await this.send(tradeMessage(t, stats.symbol))) {
        seen.lastTradeTime = t.time;
        changed = true;
      }
    }
    // Сдвигаем метку даже без отправок, иначе старые сделки проверялись бы вечно.
    const lastAny = trades.at(-1)?.time;
    if (lastAny && (!seen.lastTradeTime || lastAny > seen.lastTradeTime)) {
      seen.lastTradeTime = lastAny;
      changed = true;
    }

    const today = now.toISOString().slice(0, 10);
    if (now.getHours() >= digestHour && seen.lastDigestDay !== today) {
      if (await this.send(digestMessage(stats, publicUrl))) {
        seen.lastDigestDay = today;
        changed = true;
      }
    }

    if (changed) await this.saveSeen(seen);
  }

  private async sendStartupNotice(stats: Stats): Promise<void> {
    const { minPnlPct, digestHour, publicUrl } = this.config.telegram;
    await this.send([
      '🤖 <b>Наблюдение запущено</b>',
      '',
      `Инструмент: ${escapeHtml(stats.symbol)}, таймфрейм ${escapeHtml(stats.interval)}м`,
      `Стратегий: ${stats.bots.length}`,
      `Порог оповещения: от +${minPnlPct} %`,
      `Сводка: ежедневно после ${digestHour}:00`,
      publicUrl ? `\n<a href="${escapeHtml(publicUrl)}">Панель</a>` : '',
    ].join('\n'));
  }
}
