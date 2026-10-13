import { Module } from '@nestjs/common';
import { StatsModule } from './stats/stats.module.js';
import { TradingModule } from './trading/trading.module.js';

@Module({
  imports: [TradingModule, StatsModule],
})
export class AppModule {}
