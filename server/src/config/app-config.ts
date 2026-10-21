import path from 'node:path';

// Все настройки из окружения — в одном месте и с типами. Имена переменных
// прежние, .env на сервере менять не нужно.
export interface AppConfig {
  symbol: string;
  // Пары: явный список (SYMBOLS=A,B) или топ-N по волатильности (SYMBOLS=top:100),
  // выбранный один раз на старте сессии. Пусто — одна пара SYMBOL.
  symbols: string[];
  symbolsTop: number;
  symbolsMinTurnover: number;
  interval: string;
  startBalance: number;
  startRub: number;
  pollMs: number;
  feePct: number;
  slippagePct: number;
  orderUsdt: number;
  orderPct: number;
  enforceMinOrder: boolean;
  metaWindowCandles: number;
  metaSwitchMarginPct: number;
  bybitBaseUrl: string;
  bybitCategory: string;
  bybitTimeoutMs: number;
  // Поток свечей WebSocket: решение сразу после закрытия свечи, а не на опросе.
  bybitStream: boolean;
  bybitStreamUrl: string;
  dataDir: string;
  logDir: string;
  clientDir: string;
  port: number;
  staleSec: number;
  bankRatePct: number;
  rubPerUsdt: number;
  telegram: {
    token: string;
    chatId: string;
    minPnlPct: number;
    // Сообщения о каждой прибыльной сделке. Выключены по умолчанию: при ставке 1 %
    // это копейки, владелец ждёт только «нормальных денег» (ступени +25 %).
    tradeAlerts: boolean;
    digestHour: number;
    // Отчёт каждый час с dayFrom до dayTo включительно (местное время, TZ);
    // ночью отчётов нет, а сделки приходят без звука.
    hourly: boolean;
    dayFrom: number;
    dayTo: number;
    // Отвечать на /now и кнопку «Обновить» (опрос getUpdates).
    commands: boolean;
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

function pairSpec(raw: string): { symbols: string[]; symbolsTop: number } {
  const top = /^top:(\d+)$/i.exec(raw);
  if (top) return { symbols: [], symbolsTop: Number(top[1]) };
  return { symbols: raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean), symbolsTop: 0 };
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on', 'да'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off', 'нет'].includes(raw)) return false;
  throw new Error(`${key}=${env[key]}: ожидалось 1 или 0`);
}

export function loadConfig(env: Env = process.env, cwd = process.cwd()): AppConfig {
  return {
    symbol: str(env, 'SYMBOL', 'DOGEUSDT'),
    ...pairSpec(str(env, 'SYMBOLS', '')),
    symbolsMinTurnover: num(env, 'SYMBOLS_MIN_TURNOVER', 500_000),
    interval: str(env, 'INTERVAL', '5'),
    startBalance: num(env, 'START_BALANCE', 100),
    startRub: num(env, 'START_RUB', 0),
    pollMs: num(env, 'POLL_MS', 60_000),
    feePct: num(env, 'FEE_PCT', 0.1),
    slippagePct: num(env, 'SLIPPAGE_PCT', 0.02),
    orderUsdt: num(env, 'ORDER_USDT', 0),
    // Ставка не больше 2 % счёта — правило владельца; больше конфиг не даст.
    orderPct: Math.min(2, Math.max(0, num(env, 'ORDER_PCT', 0))),
    enforceMinOrder: bool(env, 'ENFORCE_MIN_ORDER', true),
    metaWindowCandles: num(env, 'META_WINDOW_CANDLES', 288),
    metaSwitchMarginPct: num(env, 'META_SWITCH_MARGIN_PCT', 0.5),
    bybitBaseUrl: str(env, 'BYBIT_BASE_URL', 'https://api.bybit.com'),
    bybitCategory: str(env, 'BYBIT_CATEGORY', 'spot'),
    bybitTimeoutMs: num(env, 'BYBIT_TIMEOUT_MS', 15_000),
    bybitStream: bool(env, 'BYBIT_STREAM', true),
    bybitStreamUrl: str(env, 'BYBIT_STREAM_URL',
      `${str(env, 'BYBIT_BASE_URL', '').includes('testnet') ? 'wss://stream-testnet.bybit.com' : 'wss://stream.bybit.com'}`
      + `/v5/public/${str(env, 'BYBIT_CATEGORY', 'spot')}`),
    // STATE_DIR/LOGS_DIR — имена прежних бота и панели, оставлены для совместимости.
    dataDir: path.resolve(cwd, str(env, 'DATA_DIR', str(env, 'STATE_DIR', 'data'))),
    logDir: path.resolve(cwd, str(env, 'LOG_DIR', str(env, 'LOGS_DIR', 'logs'))),
    clientDir: path.resolve(cwd, str(env, 'CLIENT_DIR', 'client/dist')),
    port: num(env, 'WEB_PORT', 3004),
    staleSec: num(env, 'STALE_SEC', 300),
    // Ставка вклада, % годовых: с ней сравнивается доходность ботов.
    bankRatePct: num(env, 'BANK_RATE_PCT', 16),
    rubPerUsdt: num(env, 'RUB_PER_USDT', 85),
    telegram: {
      token: str(env, 'TELEGRAM_BOT_TOKEN', ''),
      chatId: str(env, 'TELEGRAM_CHAT_ID', ''),
      minPnlPct: num(env, 'TELEGRAM_MIN_PNL_PCT', 0.5),
      tradeAlerts: bool(env, 'TELEGRAM_TRADE_ALERTS', false),
      digestHour: num(env, 'TELEGRAM_DIGEST_HOUR', 21),
      hourly: bool(env, 'TELEGRAM_HOURLY', true),
      dayFrom: num(env, 'TELEGRAM_DAY_FROM', 9),
      dayTo: num(env, 'TELEGRAM_DAY_TO', 22),
      commands: bool(env, 'TELEGRAM_COMMANDS', true),
      intervalMs: num(env, 'NOTIFY_INTERVAL_MS', 60_000),
      publicUrl: str(env, 'WEB_PUBLIC_URL', ''),
    },
  };
}

// Час входит в дневное окно; окно может переходить через полночь (22 → 2).
export function inDayHours(hour: number, from: number, to: number): boolean {
  return from <= to ? hour >= from && hour <= to : hour >= from || hour <= to;
}

// Рынок в состоянии: смена тестнета на реальный рынок сбрасывает счёт.
export function marketId(config: Pick<AppConfig, 'bybitBaseUrl' | 'bybitCategory'>): string {
  return `${config.bybitBaseUrl.includes('testnet') ? 'testnet' : 'mainnet'}:${config.bybitCategory}`;
}
