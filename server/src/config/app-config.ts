import path from 'node:path';

// Все настройки из окружения — в одном месте и с типами. Имена переменных
// прежние, .env на сервере менять не нужно.
export interface AppConfig {
  symbol: string;
  interval: string;
  startBalance: number;
  startRub: number;
  pollMs: number;
  feePct: number;
  slippagePct: number;
  orderUsdt: number;
  metaWindowCandles: number;
  metaSwitchMarginPct: number;
  bybitBaseUrl: string;
  bybitCategory: string;
  bybitTimeoutMs: number;
  dataDir: string;
  logDir: string;
  clientDir: string;
  port: number;
  staleSec: number;
  rubPerUsdt: number;
  telegram: {
    token: string;
    chatId: string;
    minPnlPct: number;
    digestHour: number;
    intervalMs: number;
    publicUrl: string;
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key}=${raw}: ожидалось число`);
  return value;
}

function str(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

export function loadConfig(env: Env = process.env, cwd = process.cwd()): AppConfig {
  return {
    symbol: str(env, 'SYMBOL', 'DOGEUSDT'),
    interval: str(env, 'INTERVAL', '5'),
    startBalance: num(env, 'START_BALANCE', 100),
    startRub: num(env, 'START_RUB', 0),
    pollMs: num(env, 'POLL_MS', 60_000),
    feePct: num(env, 'FEE_PCT', 0.1),
    slippagePct: num(env, 'SLIPPAGE_PCT', 0.02),
    orderUsdt: num(env, 'ORDER_USDT', 0),
    metaWindowCandles: num(env, 'META_WINDOW_CANDLES', 288),
    metaSwitchMarginPct: num(env, 'META_SWITCH_MARGIN_PCT', 0.5),
    bybitBaseUrl: str(env, 'BYBIT_BASE_URL', 'https://api.bybit.com'),
    bybitCategory: str(env, 'BYBIT_CATEGORY', 'spot'),
    bybitTimeoutMs: num(env, 'BYBIT_TIMEOUT_MS', 15_000),
    // STATE_DIR/LOGS_DIR — имена прежних бота и панели, оставлены для совместимости.
    dataDir: path.resolve(cwd, str(env, 'DATA_DIR', str(env, 'STATE_DIR', 'data'))),
    logDir: path.resolve(cwd, str(env, 'LOG_DIR', str(env, 'LOGS_DIR', 'logs'))),
    clientDir: path.resolve(cwd, str(env, 'CLIENT_DIR', 'client/dist')),
    port: num(env, 'WEB_PORT', 3004),
    staleSec: num(env, 'STALE_SEC', 300),
    rubPerUsdt: num(env, 'RUB_PER_USDT', 85),
    telegram: {
      token: str(env, 'TELEGRAM_BOT_TOKEN', ''),
      chatId: str(env, 'TELEGRAM_CHAT_ID', ''),
      minPnlPct: num(env, 'TELEGRAM_MIN_PNL_PCT', 0.5),
      digestHour: num(env, 'TELEGRAM_DIGEST_HOUR', 21),
      intervalMs: num(env, 'NOTIFY_INTERVAL_MS', 60_000),
      publicUrl: str(env, 'WEB_PUBLIC_URL', ''),
    },
  };
}

// Рынок в состоянии: смена тестнета на реальный рынок сбрасывает счёт.
export function marketId(config: Pick<AppConfig, 'bybitBaseUrl' | 'bybitCategory'>): string {
  return `${config.bybitBaseUrl.includes('testnet') ? 'testnet' : 'mainnet'}:${config.bybitCategory}`;
}
