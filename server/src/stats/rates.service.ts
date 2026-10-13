import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import type { Rate } from './build-stats.js';

const RATE_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';
const HOUR_MS = 3_600_000;
const RETRY_MS = 600_000;

// Курс рубля к доллару по ЦБ: USDT считаем равным доллару. Обновляется раз
// в час; если ЦБ недоступен — прошлое значение или RUB_PER_USDT из окружения.
@Injectable()
export class RatesService {
  private rate: Rate;
  private nextAt = 0;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.rate = { value: config.rubPerUsdt, source: 'env' };
  }

  async rubPerUsd(now = Date.now()): Promise<Rate> {
    if (now < this.nextAt) return this.rate;
    try {
      const res = await this.fetchFn(RATE_URL, { signal: AbortSignal.timeout(5000) });
      const json = (await res.json()) as { Valute?: { USD?: { Value?: number } } };
      const value = Number(json.Valute?.USD?.Value);
      if (Number.isFinite(value) && value > 0) this.rate = { value, source: 'ЦБ РФ' };
      this.nextAt = now + HOUR_MS;
    } catch {
      this.nextAt = now + RETRY_MS;
    }
    return this.rate;
  }
}
