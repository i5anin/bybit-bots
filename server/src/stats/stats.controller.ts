import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TelegramService } from '../telegram/telegram.service.js';
import { StatsService } from './stats.service.js';
import type { Health, Stats } from './stats.types.js';

@Controller('api')
export class StatsController {
  constructor(
    @Inject(StatsService) private readonly stats: StatsService,
    @Inject(TelegramService) private readonly telegram: TelegramService,
  ) {}

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
