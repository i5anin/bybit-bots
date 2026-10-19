import { Module } from '@nestjs/common';
import { TelegramService } from '../telegram/telegram.service.js';
import { TradingModule } from '../trading/trading.module.js';
import { PairChartService } from './pair-chart.service.js';
import { RatesService } from './rates.service.js';
import { StatsController } from './stats.controller.js';
import { StatsService } from './stats.service.js';

@Module({
  imports: [TradingModule],
  controllers: [StatsController],
  providers: [RatesService, StatsService, PairChartService, TelegramService],
})
export class StatsModule {}
