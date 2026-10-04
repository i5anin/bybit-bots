import { Ledger } from './lib/ledger.js';

// Авто-выбор: свой счёт, а решения копирует у той стратегии, что лучше всех
// заработала за последнее окно. Лидер меняется, только если новый обгоняет
// текущего с запасом, — иначе бот метался бы между равными и платил комиссии.
const WINDOW = Number(process.env.META_WINDOW_CANDLES || 288); // 288 × 5м = сутки
const MARGIN_PCT = Number(process.env.META_SWITCH_MARGIN_PCT || 0.5);

export class MetaBot {
  constructor(bots, startBalance, snapshot) {
    this.bots = bots;
    this.strategy = { name: `Авто-выбор лучшей (${bots.length})` };
    this.ledger = Ledger.from(snapshot?.ledger, startBalance);
    this.lastSignalCandle = snapshot?.lastSignalCandle ?? null;
    this.leader = snapshot?.leader ?? null;
    this.history = snapshot?.history ?? {}; // имя бота → equity на закрытых свечах
  }

  // Вызывается после шагов остальных ботов: их позиции уже обновлены.
  step(candles, price) {
    this.ledger.mark(price);
    const candleTime = candles[candles.length - 1].time;
    const idle = { action: 'hold', trade: null, price, equity: this.ledger.equity, position: this.ledger.position };
    if (candleTime === this.lastSignalCandle) return idle;
    this.lastSignalCandle = candleTime;

    for (const bot of this.bots) {
      const series = (this.history[bot.strategy.name] ??= []);
      series.push(bot.ledger.equity);
      if (series.length > WINDOW + 1) series.splice(0, series.length - WINDOW - 1);
    }
    this.leader = this.pickLeader();

    const leaderBot = this.bots.find(b => b.strategy.name === this.leader);
    if (!leaderBot) return idle;

    let action = 'hold';
    let trade = null;
    const leaderIn = leaderBot.ledger.position > 0;
    if (leaderIn && this.ledger.position === 0) {
      action = 'buy';
      trade = this.ledger.buy(price);
    } else if (!leaderIn && this.ledger.position > 0) {
      action = 'sell';
      trade = this.ledger.sell(price);
    }
    return { action, trade, price, equity: this.ledger.equity, position: this.ledger.position };
  }

  windowReturn(name) {
    const s = this.history[name];
    if (!s || s.length < 2 || !(s[0] > 0)) return 0;
    return (s[s.length - 1] / s[0] - 1) * 100;
  }

  pickLeader() {
    let best = null;
    let bestRet = -Infinity;
    for (const bot of this.bots) {
      const r = this.windowReturn(bot.strategy.name);
      if (r > bestRet) { best = bot.strategy.name; bestRet = r; }
    }
    if (!this.leader || !this.bots.some(b => b.strategy.name === this.leader)) return best;
    return bestRet > this.windowReturn(this.leader) + MARGIN_PCT ? best : this.leader;
  }

  snapshot() {
    return {
      ledger: this.ledger.toJSON(),
      lastSignalCandle: this.lastSignalCandle,
      leader: this.leader,
      history: this.history,
    };
  }

  status() {
    return {
      name: this.strategy.name,
      equity: Math.round(this.ledger.equity * 100) / 100,
      position: this.ledger.position > 0 ? 'в позиции' : '—',
      trades: this.ledger.tradeCount,
      'pnl %': Math.round(this.ledger.realizedPnlPct * 100) / 100,
      fees: Math.round(this.ledger.feesPaid * 100) / 100,
      leader: this.leader ?? '—',
    };
  }
}
