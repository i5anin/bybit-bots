// Публичный поток свечей Bybit (WebSocket). Биржа присылает обновления свечи
// в реальном времени и отдельным сообщением с confirm=true — её закрытие:
// по нему движок принимает решение сразу, а не на следующем минутном опросе.
// Одно соединение на все пары; подписка пачками — Bybit spot принимает
// не больше 10 тем в одном запросе.

interface KlineMessage {
  topic?: string;
  data?: { start: number; confirm: boolean }[];
}

// Минимум от WebSocket, который нужен потоку: в тестах подставляется поддельный.
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface KlineStreamOptions {
  url: string;
  symbols: readonly string[];
  interval: string;
  onCandleClosed: (symbol: string, start: number) => void;
  log?: (message: string) => void;
  socket?: SocketFactory;
  pingMs?: number;
  maxBackoffMs?: number;
}

const TOPICS_PER_REQUEST = 10;

export class KlineStream {
  connected = false;
  lastMessageAt: number | null = null;
  private ws: SocketLike | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private stopped = false;
  private readonly topics: Map<string, string>; // тема → пара

  constructor(private readonly opts: KlineStreamOptions) {
    this.topics = new Map(opts.symbols.map(s => [`kline.${opts.interval}.${s}`, s]));
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  private clearTimers(): void {
    if (this.ping) clearInterval(this.ping);
    if (this.retry) clearTimeout(this.retry);
    this.ping = null;
    this.retry = null;
  }

  private connect(): void {
    const make = this.opts.socket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    const ws = make(this.opts.url);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.backoffMs = 1000;
      const all = [...this.topics.keys()];
      for (let i = 0; i < all.length; i += TOPICS_PER_REQUEST) {
        ws.send(JSON.stringify({ op: 'subscribe', args: all.slice(i, i + TOPICS_PER_REQUEST) }));
      }
      // Bybit закрывает соединение без пинга дольше 30 секунд.
      this.ping = setInterval(() => ws.send(JSON.stringify({ op: 'ping' })), this.opts.pingMs ?? 20_000);
      this.opts.log?.(`поток свечей подключён: ${all.length} пар`);
    };

    ws.onmessage = ev => {
      this.lastMessageAt = Date.now();
      let msg: KlineMessage;
      try {
        msg = JSON.parse(String(ev.data)) as KlineMessage;
      } catch {
        return;
      }
      const symbol = msg.topic ? this.topics.get(msg.topic) : undefined;
      if (!symbol) return;
      for (const k of msg.data ?? []) {
        if (k.confirm) this.opts.onCandleClosed(symbol, Number(k.start));
      }
    };

    // Обрыв — переподключение с растущей паузой: 1, 2, 4… до минуты.
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      this.clearTimers();
      if (this.stopped) return;
      if (was) this.opts.log?.('поток свечей оборвался, переподключаюсь');
      this.retry = setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 60_000);
    };
    ws.onerror = () => ws.close();
  }
}
