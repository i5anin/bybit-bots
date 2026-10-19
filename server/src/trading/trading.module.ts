import { Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig, type AppConfig } from '../config/app-config.js';
import { BybitClient } from '../market/bybit.js';
import { StateStore } from '../storage/state-store.js';
import { TradeLog } from '../storage/trade-log.js';
import { EngineService } from './engine.service.js';

@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    {
      provide: BybitClient,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) =>
        new BybitClient({ baseUrl: c.bybitBaseUrl, category: c.bybitCategory, timeoutMs: c.bybitTimeoutMs }),
    },
    { provide: StateStore, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new StateStore(c.dataDir) },
    { provide: TradeLog, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new TradeLog(c.logDir) },
    EngineService,
  ],
  exports: [APP_CONFIG, BybitClient, StateStore, TradeLog, EngineService],
})
export class TradingModule {}
