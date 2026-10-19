import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { BybitClient } from '../market/bybit.js';
import { priceLabel, renderChartPng } from '../telegram/chart.js';
import { StatsService } from './stats.service.js';

const DAY_MS = 86_400_000;

// График одной пары: цена за сутки, входы и выходы её ботов, заработок каждого
// из её 12 ботов. Отдаётся панели (/api/pair/:symbol/chart.png) и в Telegram (/pair).
@Injectable()
export class PairChartService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(BybitClient) private readonly bybit: BybitClient,
    @Inject(StatsService) private readonly stats: StatsService,
  ) {}

  async render(symbol: string, now = Date.now()): Promise<Buffer | null> {
    const detail = await this.stats.pairDetail(symbol, now);
    if (!detail.bots.length) return null;
    const candles = await this.bybit.klines(symbol, '15', 96).catch(() => []);
    const dayAgo = new Date(now - DAY_MS).toISOString();
    const p = detail.pair;
    return renderChartPng({
      title: `${symbol.replace(/USDT$/, '')} · ${detail.bots.length} ботов`,
      subtitle: [
        p?.price ? `цена ${priceLabel(p.price)} $` : '',
        p ? `боты пары: ${Math.round(p.equityRub)} ₽ из ${Math.round(p.investedRub)} ₽` : '',
        p?.minOrderUsdt ? `мин. ордер биржи ${p.minOrderUsdt} $` : '',
      ].filter(Boolean).join(' · '),
      prices: candles.map(c => ({ time: c.time, price: c.close })),
      trades: detail.trades.filter(t => t.time > dayAgo).map(t => ({
        time: Date.parse(t.time), price: Number(t.price), side: t.side === 'buy' ? 'buy' as const : 'sell' as const,
      })),
      sections: [{
        title: 'Заработок ботов пары с начала',
        bars: detail.bots.map(b => ({ name: b.name, total: b.pnlRub, period: null, highlight: b.isMeta })),
      }],
      periodLabel: '',
    });
  }

  symbols(): string[] {
    return this.config.symbols;
  }
}
