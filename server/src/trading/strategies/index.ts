import type { StrategyFactory } from '../types.js';
import { mediumHolder, patientHolder, quickHolder } from './dca-holder.js';
import { adaptiveRegime } from './adaptive-regime.js';
import { emaCrossover, smaCrossover } from './crossovers.js';
import { bollingerBands, macd, meanReversion, rsi, stochastic } from './oscillators.js';
import { grid, martingaleLite } from './stateful.js';
import { donchianBreakout, emaRibbon } from './trend.js';

// Порядок важен: он же порядок ботов в цикле, и мета-бот считает их число
// в своём имени («Авто-выбор лучшей (14)»), по которому восстанавливается.
// Grid не включена: рядом с Martingale-lite она ничего не добавляет.
export const ACTIVE_STRATEGIES: readonly StrategyFactory[] = [
  smaCrossover,
  emaCrossover,
  rsi,
  macd,
  bollingerBands,
  stochastic,
  donchianBreakout,
  meanReversion,
  emaRibbon,
  martingaleLite,
  adaptiveRegime,
  quickHolder,
  mediumHolder,
  patientHolder,
];

export const ALL_STRATEGIES: readonly StrategyFactory[] = [...ACTIVE_STRATEGIES, grid];
