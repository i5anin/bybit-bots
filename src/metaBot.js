import { Ledger } from './lib/ledger.js';
import { round2 } from './bot.js';

// Авто-выбор: свой счёт, а решения копирует у той стратегии, что лучше всех
// заработала за последнее окно. Лидер меняется, только если новый обгоняет
// текущего с запасом, — иначе бот метался бы между равными и платил комиссии.
// Если за окно в плюсе нет никого, бот стоит вне рынка: копировать
// «наименее убыточную» — значит гарантированно терять вместе с ней.
export const META_DEFAULTS = Object.freeze({
  windowCandles: 288, // 288 × 5м = сутки
  switchMarginPct: 0.5,
});

export function metaName(count) {
  return `Авто-выбор лучшей (${count})`;
}

export class MetaBot {
  constructor(bots, { startBalance, snapshot = null, costs, ...options } = {}) {
    this.bots = bots;
    this.options = { ...META_DEFAULTS, ...options };
    this.strategy = { name: metaName(bots.length) };
    this.ledger = Ledger.from(snapshot?.ledger, startBalance, costs);
    this.lastSignalCandle = snapshot?.lastSignalCandle ?? null;
    this.leader = snapshot?.leader ?? null;
    this.history = snapshot?.history ?? {}; // имя бота → equity на закрытых свечах
  }

  // Вызывается после шагов остальных ботов: их позиции уже обновлены.
  step(candles, price) {
    this.ledger.mark(price);
    const candleTime = candles[candles.length - 1].time;
    if (candleTime === this.lastSignalCandle) return this.result('hold', null, price);
    this.lastSignalCandle = candleTime;

    this.record();
    this.leader = this.pickLeader();

    const leaderBot = this.bots.find(b => b.strategy.name === this.leader);
    const wantIn = Boolean(leaderBot && leaderBot.ledger.position > 0);
    if (wantIn && this.ledger.position === 0) {
      return this.result('buy', this.ledger.buy(price), price);
    }
    if (!wantIn && this.ledger.position > 0) {
      return this.result('sell', this.ledger.sell(price), price);
    }
    return this.result('hold', null, price);
  }

  record() {
    const keep = this.options.windowCandles + 1;
    for (const bot of this.bots) {
      const series = (this.history[bot.strategy.name] ??= []);
      series.push(bot.ledger.equity);
      if (series.length > keep) series.splice(0, series.length - keep);
    }
  }

  windowReturn(name) {
    const s = this.history[name];
    if (!s || s.length < 2 || !(s[0] > 0)) return 0;
    return (s[s.length - 1] / s[0] - 1) * 100;
  }

  pickLeader() {
    let best = null;
    let bestRet = 0; // ноль — порог: лидером может стать только стратегия в плюсе
    for (const bot of this.bots) {
      const r = this.windowReturn(bot.strategy.name);
      if (r > bestRet) { best = bot.strategy.name; bestRet = r; }
    }
    if (!best) return null;

    const current = this.bots.some(b => b.strategy.name === this.leader) ? this.leader : null;
    const currentRet = current ? this.windowReturn(current) : 0;
    if (current && currentRet > 0 && bestRet <= currentRet + this.options.switchMarginPct) {
      return current;
    }
    return best;
  }

  result(action, trade, price) {
    return { action, trade, price, equity: this.ledger.equity, position: this.ledger.position };
  }

  snapshot() {
    return {
      meta: true,
      ledger: this.ledger.toJSON(),
      lastSignalCandle: this.lastSignalCandle,
      leader: this.leader,
      history: this.history,
    };
  }

  status() {
    return {
      name: this.strategy.name,
      equity: round2(this.ledger.equity),
      position: this.ledger.position > 0 ? 'в позиции' : '—',
      trades: this.ledger.tradeCount,
      'pnl %': round2(this.ledger.realizedPnlPct),
      fees: round2(this.ledger.feesPaid),
      leader: this.leader ?? '—',
    };
  }
}
