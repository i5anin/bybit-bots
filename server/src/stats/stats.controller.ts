import { Controller, Get, Inject, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TelegramService } from '../telegram/telegram.service.js';
import { PairChartService } from './pair-chart.service.js';
import { StatsService } from './stats.service.js';
import type { Health, PairDetail, Stats } from './stats.types.js';

@Controller('api')
export class StatsController {
  constructor(
    @Inject(StatsService) private readonly stats: StatsService,
    @Inject(TelegramService) private readonly telegram: TelegramService,
    @Inject(PairChartService) private readonly charts: PairChartService,
  ) {}

  @Get('pair/:symbol')
  async getPair(@Param('symbol') symbol: string, @Res({ passthrough: true }) res: Response): Promise<PairDetail> {
    res.setHeader('cache-control', 'no-store');
    const detail = await this.stats.pairDetail(symbol.toUpperCase());
    if (!detail.bots.length) throw new NotFoundException(`нет пары ${symbol}`);
    return detail;
  }

  // График пары: цена за сутки, входы и выходы её ботов, заработок каждого.
  @Get('pair/:symbol/chart.png')
  async getPairChart(@Param('symbol') symbol: string, @Res() res: Response): Promise<void> {
    const png = await this.charts.render(symbol.toUpperCase());
    if (!png) throw new NotFoundException(`нет пары ${symbol}`);
    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'max-age=60');
    res.end(png);
  }

  @Get('stats')
  async getStats(@Res({ passthrough: true }) res: Response): Promise<Stats> {
    res.setHeader('cache-control', 'no-store');
    return this.stats.stats();
  }

  // Для Uptime Kuma и healthcheck: 503, пока бот не пишет состояние.
  @Get('health')
  async getHealth(@Res({ passthrough: true }) res: Response): Promise<Health> {
    const { status, ageSec } = await this.stats.health();
    const ok = status === 'running';
    res.status(ok ? 200 : 503).setHeader('cache-control', 'no-store');
    return { ok, bot: status, ageSec, telegram: this.telegram.enabled };
  }
}
