// Публичный поток свечей Bybit (WebSocket). Биржа присылает обновления свечи
// в реальном времени и отдельным сообщением с confirm=true — её закрытие:
// по нему движок принимает решение сразу, а не на следующем минутном опросе.

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
  symbol: string;
  interval: string;
  onCandleClosed: (start: number) => void;
  log?: (message: string) => void;
  socket?: SocketFactory;
  pingMs?: number;
  maxBackoffMs?: number;
}

export class KlineStream {
  connected = false;
  lastMessageAt: number | null = null;
  private ws: SocketLike | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private stopped = false;
  private readonly topic: string;

  constructor(private readonly opts: KlineStreamOptions) {
    this.topic = `kline.${opts.interval}.${opts.symbol}`;
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
      ws.send(JSON.stringify({ op: 'subscribe', args: [this.topic] }));
      // Bybit закрывает соединение без пинга дольше 30 секунд.
      this.ping = setInterval(() => ws.send(JSON.stringify({ op: 'ping' })), this.opts.pingMs ?? 20_000);
      this.opts.log?.(`поток ${this.topic} подключён`);
    };

    ws.onmessage = ev => {
      this.lastMessageAt = Date.now();
      let msg: KlineMessage;
      try {
        msg = JSON.parse(String(ev.data)) as KlineMessage;
      } catch {
        return;
      }
      if (msg.topic !== this.topic) return;
      for (const k of msg.data ?? []) {
        if (k.confirm) this.opts.onCandleClosed(Number(k.start));
      }
    };

    // Обрыв — переподключение с растущей паузой: 1, 2, 4… до минуты.
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      this.clearTimers();
      if (this.stopped) return;
      if (was) this.opts.log?.(`поток ${this.topic} оборвался, переподключаюсь`);
      this.retry = setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 60_000);
    };
    ws.onerror = () => ws.close();
  }
}
