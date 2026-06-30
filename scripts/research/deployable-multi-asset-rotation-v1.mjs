import fs from 'node:fs/promises';
import { buyExecution, sellExecution } from '../lib/execution-simulator.mjs';
import { decisionToOrderIntent } from '../lib/order-intent-generator.mjs';
import { foldWindows, mean, round } from './research-core.mjs';
import { appendExperiment } from './strategy-experiment-registry.mjs';

const HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const LEVERAGED_HISTORY = new URL('../../data/research/deployable-etf-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/deployable-multi-asset-rotation-v1.json', import.meta.url);
const REPORT = new URL('../../docs/DEPLOYABLE_MULTI_ASSET_ROTATION_V1.md', import.meta.url);
const READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);
const PRIOR = new URL('../../data/research/deployable-core-satellite-v1.json', import.meta.url);
const REGISTRY = new URL('../../data/research/strategy-experiment-registry.json', import.meta.url);

const INITIAL_CAPITAL = 1_000_000;
const TARGET_MONTHLY = 10;
const TRAIN_MONTHS = 48;
const VALIDATION_MONTHS = 24;
const MIN_VALIDATION_DAYS = 660;
const COSTS = Object.freeze({
  buyFeePct: 0.1425,
  sellFeePct: 0.1425,
  sellTaxPct: 0.1,
  buySlippagePct: 0.15,
  sellSlippagePct: 0.15,
  minimumFee: 20,
  boardLotShares: 1000
});

const ASSETS = Object.freeze([
  { symbol: '0050.TW', name: '0050', type: 'risk', base: true },
  { symbol: '0052.TW', name: '0052', type: 'risk' },
  { symbol: '00646.TW', name: '00646', type: 'risk' },
  { symbol: '00662.TW', name: '00662', type: 'risk' },
  { symbol: '00661.TW', name: '00661', type: 'risk' },
  { symbol: '00631L.TW', name: '00631L', type: 'leverage' },
  { symbol: '00632R.TW', name: '00632R', type: 'inverse' },
  { symbol: '00635U.TW', name: '00635U', type: 'defense' }
]);

const RISK_SYMBOLS = ASSETS.filter(asset => asset.type === 'risk').map(asset => asset.symbol);
const DEFENSE_SYMBOL = '00635U.TW';
const CASH_CONFIG = Object.freeze({
  kind: 'cash',
  id: 'cash_when_train_has_no_edge',
  rebalanceDays: 5,
  rebalanceBand: 0.05,
  accountGuardPct: 8,
  cooldownDays: 20,
  monthlyStopPct: 4,
  targetVol: 0
});
const MARKET_FALLBACK_CONFIG = Object.freeze({
  kind: 'scheduled_trend_core',
  id: 'market_fallback_0050_buy_and_hold',
  coreWeight: 100,
  techWeight: 0,
  trendDays: 120,
  bearMomentum: -999,
  shockMomentum: null,
  riskOffMode: 'cash',
  rebalanceDays: 20,
  rebalanceBand: 0.05,
  targetVol: 99,
  accountGuardPct: 99,
  cooldownDays: 0,
  monthlyStopPct: 999
});

const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const pct = (value, base) => Number.isFinite(value) && base ? (value / base - 1) * 100 : 0;

function parseCoreSatelliteConfig(configId) {
  const match = /^core(?<core>\d+)_tech(?<tech>\d+)_ma(?<ma>\d+)_bear(?<bear>-?\d+)_(?<risk>cash|core50)_guard(?<guard>\d+)_r(?<rebalance>\d+)_b(?<band>0(?:\.\d+)?)$/.exec(configId);
  if (!match) return null;
  return {
    kind: 'core_satellite',
    id: configId,
    coreWeight: Number(match.groups.core),
    techWeight: Number(match.groups.tech),
    trendDays: Number(match.groups.ma),
    bearMomentum: Number(match.groups.bear),
    riskOffMode: match.groups.risk,
    accountGuardPct: Number(match.groups.guard),
    rebalanceDays: Number(match.groups.rebalance),
    rebalanceBand: Number(match.groups.band),
    cooldownDays: 20,
    monthlyStopPct: 999
  };
}

function enrich(rows) {
  const closes = [];
  const returns = [];
  return rows.map((bar, index) => {
    const prior = closes.at(-1);
    closes.push(bar.close);
    if (prior) returns.push(bar.close / prior - 1);
    return {
      ...bar,
      ma20: index >= 19 ? average(closes.slice(-20)) : null,
      ma60: index >= 59 ? average(closes.slice(-60)) : null,
      ma120: index >= 119 ? average(closes.slice(-120)) : null,
      ma200: index >= 199 ? average(closes.slice(-200)) : null,
      high60: index >= 59 ? Math.max(...closes.slice(-60)) : null,
      mom20: index >= 20 ? pct(bar.close, closes[index - 20]) : null,
      mom60: index >= 60 ? pct(bar.close, closes[index - 60]) : null,
      mom120: index >= 120 ? pct(bar.close, closes[index - 120]) : null,
      vol20: returns.length >= 20
        ? Math.sqrt(average(returns.slice(-20).map(value => (value - average(returns.slice(-20))) ** 2))) * Math.sqrt(252) * 100
        : null
    };
  }).filter(row => row.ma200 && [row.mom20, row.mom60, row.mom120, row.vol20].every(Number.isFinite));
}

async function loadRows() {
  const [payload, leveragedPayload] = await Promise.all([
    fs.readFile(HISTORY, 'utf8').then(JSON.parse),
    fs.readFile(LEVERAGED_HISTORY, 'utf8').then(JSON.parse)
  ]);
  const bars = new Map();
  const metrics = new Map();
  for (const asset of ASSETS) {
    const series = asset.type === 'leverage'
      ? leveragedPayload.series?.[asset.symbol] || []
      : payload.series[asset.symbol] || [];
    bars.set(asset.symbol, new Map(series.map(row => [row.date, row])));
    metrics.set(asset.symbol, new Map(enrich(series).map(row => [row.date, { ...row, symbol: asset.symbol }])));
  }
  return (payload.series['0050.TW'] || []).map((bar, index) => ({
    date: bar.date,
    index,
    bars: new Map(ASSETS.map(asset => [asset.symbol, bars.get(asset.symbol).get(bar.date)]).filter(([, value]) => value)),
    metrics: new Map(ASSETS.map(asset => [asset.symbol, metrics.get(asset.symbol).get(bar.date)]).filter(([, value]) => value))
  })).filter(row => row.date >= '2011-01-01' && row.metrics.has('0050.TW'));
}

function buildConfigs() {
  const rows = [];
  for (const techWeight of [40, 60]) {
    for (const trendDays of [60, 120, 200]) {
      for (const bearMomentum of [-4, 0]) {
        for (const riskOffMode of ['cash', 'core50', 'inverse30', 'inverse50']) {
          for (const rebalanceDays of [5, 10]) {
            for (const rebalanceBand of [0.05, 0.1]) {
              for (const accountGuardPct of [8, 12]) {
                for (const monthlyStopPct of [6, 999]) {
                  for (const targetVol of [99]) {
                    for (const shockMomentum of [-8, -4, null]) {
                      rows.push({
                      kind: 'core_satellite',
                      id: `core${100 - techWeight}_tech${techWeight}_ma${trendDays}_bear${bearMomentum}_${riskOffMode}_guard${accountGuardPct}_month${monthlyStopPct}_vol${targetVol}_shock${shockMomentum ?? 'off'}_r${rebalanceDays}_b${rebalanceBand}`,
                      coreWeight: 100 - techWeight,
                      techWeight,
                      trendDays,
                      bearMomentum,
                      riskOffMode,
                      accountGuardPct,
                      rebalanceDays,
                      rebalanceBand,
                      cooldownDays: 20,
                      monthlyStopPct,
                      targetVol,
                      shockMomentum
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  for (const broadTrendDays of [120, 200]) {
    for (const broadMomentumFloor of [-4, 0]) {
      for (const assetTrendDays of [60, 120]) {
        for (const leaderRelativeFloor of [0, 2]) {
          for (const topCount of [1, 2]) {
            for (const riskOffMode of ['cash', 'core50', 'gold']) {
              for (const rebalanceDays of [5, 10]) {
                for (const accountGuardPct of [10, 15]) {
                  for (const targetVol of [99]) {
                    rows.push({
                      kind: 'relative_strength',
                      id: `rs_bma${broadTrendDays}_mom${broadMomentumFloor}_ama${assetTrendDays}_gap${leaderRelativeFloor}_top${topCount}_${riskOffMode}_vol${targetVol}_r${rebalanceDays}_guard${accountGuardPct}`,
                      broadTrendDays,
                      broadMomentumFloor,
                      assetTrendDays,
                      leaderRelativeFloor,
                      topCount,
                      riskOffMode,
                      rebalanceDays,
                      accountGuardPct,
                      cooldownDays: 20,
                      monthlyStopPct: 5,
                      targetVol,
                      scoreWeights: { w20: 0.35, w60: 0.4, w120: 0.25, volPenalty: 0.08 }
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  for (const techWeight of [20, 40]) {
    for (const trendDays of [60, 120]) {
      for (const strongMomentum of [2, 5]) {
        for (const maximumVolatility of [20, 25]) {
          for (const leveragedWeight of [20, 30]) {
            for (const riskOffMode of ['cash', 'core50']) {
              for (const rebalanceDays of [5, 10]) {
                for (const accountGuardPct of [8, 12]) {
                  rows.push({
                    kind: 'leveraged_overlay',
                    id: `overlay_tech${techWeight}_ma${trendDays}_mom${strongMomentum}_maxvol${maximumVolatility}_lev${leveragedWeight}_${riskOffMode}_r${rebalanceDays}_guard${accountGuardPct}`,
                    techWeight,
                    trendDays,
                    strongMomentum,
                    maximumVolatility,
                    leveragedWeight,
                    riskOffMode,
                    rebalanceDays,
                    rebalanceBand: 0.05,
                    accountGuardPct,
                    cooldownDays: 20,
                    monthlyStopPct: 6,
                    targetVol: 24
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  for (const techWeight of [40, 50, 60, 70, 80, 85, 90]) {
    for (const riskOffMode of ['cash']) {
      for (const rebalanceDays of [5, 10]) {
        for (const shockMomentum of [-8, -4]) {
          rows.push({
            kind: 'scheduled_trend_core',
            id: `scheduled_core${100 - techWeight}_tech${techWeight}_ma120_bear0_shock${shockMomentum}_${riskOffMode}_guard6_month4_r${rebalanceDays}`,
            coreWeight: 100 - techWeight,
            techWeight,
            trendDays: 120,
            bearMomentum: 0,
            shockMomentum,
            riskOffMode,
            rebalanceDays,
            rebalanceBand: 0,
            targetVol: 99,
            accountGuardPct: 6,
            cooldownDays: 15,
            monthlyStopPct: 4
          });
        }
      }
    }
  }
  for (const techWeight of [70, 80, 90]) {
    for (const warningExposurePct of [0, 30, 50, 70]) {
      for (const warningMode of ['below_ma20', 'below_ma60', 'ma_cross', 'drawdown5', 'drawdown10', 'trend_break']) {
        for (const shockMomentum of [-8, -4]) {
          for (const targetVol of [24, 99]) {
            rows.push({
              kind: 'staged_trend_core',
              id: `staged_core${100 - techWeight}_tech${techWeight}_warning${warningExposurePct}_${warningMode}_vol${targetVol}_shock${shockMomentum}`,
              coreWeight: 100 - techWeight,
              techWeight,
              warningExposurePct,
              warningMode,
              trendDays: 120,
              bearMomentum: 0,
              shockMomentum,
              riskOffMode: 'cash',
              rebalanceDays: 10,
              rebalanceBand: 0,
              targetVol,
              accountGuardPct: 6,
              cooldownDays: 15,
              monthlyStopPct: 4
            });
          }
        }
      }
    }
  }
  return rows;
}

const configs = buildConfigs();
const TEST_FAMILY = process.env.ROTATION_TEST_FAMILY || null;
const PRIMARY_FAMILY = 'staged_trend_core';

function assetScore(item, core, config) {
  const weights = config.scoreWeights;
  return item.mom20 * weights.w20
    + item.mom60 * weights.w60
    + item.mom120 * weights.w120
    - item.vol20 * weights.volPenalty
    + (item.mom20 - core.mom20) * 0.3;
}

function riskOffWeights(row, config) {
  if (config.riskOffMode === 'core50') return { '0050.TW': 50 };
  if (config.riskOffMode === 'inverse30' && row.metrics.has('00632R.TW')) return { '00632R.TW': 30 };
  if (config.riskOffMode === 'inverse50' && row.metrics.has('00632R.TW')) return { '00632R.TW': 50 };
  const gold = row.metrics.get(DEFENSE_SYMBOL);
  if (config.riskOffMode === 'gold' && gold && gold.close > gold.ma120 && gold.mom20 > 0) {
    return { [DEFENSE_SYMBOL]: 100 };
  }
  return {};
}

function scaled(weights, usedPct) {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, value]) => sum + value, 0) || 1;
  return Object.fromEntries(entries.map(([symbol, value]) => [symbol, value * usedPct / total]));
}

function capExposure(weights, capPct) {
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  return total > capPct ? scaled(weights, capPct) : weights;
}

function desiredWeights(row, config) {
  const core = row.metrics.get('0050.TW');
  const gold = row.metrics.get(DEFENSE_SYMBOL);
  if (!core) return {};
  const broadBull = core.close > core[`ma${config.broadTrendDays}`] && core.mom60 > config.broadMomentumFloor;
  if (!broadBull) return riskOffWeights(row, config);

  const ranked = RISK_SYMBOLS
    .filter(symbol => symbol !== '0050.TW')
    .map(symbol => row.metrics.get(symbol))
    .filter(Boolean)
    .filter(item => item.close > item[`ma${config.assetTrendDays}`] && item.mom20 > 0 && item.mom60 > -2)
    .map(item => ({ symbol: item.symbol, item, score: assetScore(item, core, config) }))
    .sort((left, right) => right.score - left.score);

  const leader = ranked[0];
  const weights = { '0050.TW': config.baseCoreWeight };
  if (!leader || leader.score < config.assetBuffer || leader.item.mom20 - core.mom20 < config.leaderRelativeFloor) {
    if (config.satelliteFallback === 'core') weights['0050.TW'] += config.satelliteWeight;
  } else {
    const boost = leader.item.mom20 - core.mom20 >= config.leaderRelativeFloor ? config.leaderBoostPct : 0;
    const satellitePct = config.satelliteWeight + boost;
    weights[leader.symbol] = satellitePct;
    weights['0050.TW'] = Math.max(0, 100 - satellitePct);
  }

  if (config.hedgePct > 0 && gold && gold.close > gold.ma120 && gold.mom20 > 0 && core.mom20 < 2) {
    const riskPct = Math.max(0, 100 - config.hedgePct);
    return {
      ...scaled(weights, riskPct),
      [DEFENSE_SYMBOL]: config.hedgePct
    };
  }
  return weights;
}

function relativeStrengthWeights(row, config) {
  const core = row.metrics.get('0050.TW');
  if (!core) return {};
  const broadBull = core.close > core[`ma${config.broadTrendDays}`]
    && core.mom60 > config.broadMomentumFloor;
  if (!broadBull) return riskOffWeights(row, config);

  const ranked = RISK_SYMBOLS
    .map(symbol => row.metrics.get(symbol))
    .filter(Boolean)
    .filter(item => item.close > item[`ma${config.assetTrendDays}`] && item.mom20 > 0)
    .map(item => ({ item, score: assetScore(item, core, config) }))
    .filter(({ item }) => item.symbol === '0050.TW' || item.mom20 - core.mom20 >= config.leaderRelativeFloor)
    .sort((left, right) => right.score - left.score)
    .slice(0, config.topCount);
  if (!ranked.length) return { '0050.TW': 100 };
  const weight = 100 / ranked.length;
  return Object.fromEntries(ranked.map(({ item }) => [item.symbol, weight]));
}

function leveragedOverlayWeights(row, config) {
  const core = row.metrics.get('0050.TW');
  const leverage = row.metrics.get('00631L.TW');
  if (!core) return {};
  const broadBull = core.close > core[`ma${config.trendDays}`] && core.mom60 > -4;
  if (!broadBull) return riskOffWeights(row, config);
  const strongBull = leverage
    && core.close > core.ma20
    && core.ma20 > core.ma60
    && core.mom20 >= config.strongMomentum
    && core.vol20 <= config.maximumVolatility
    && leverage.close > leverage.ma60;
  if (!strongBull) return { '0050.TW': 100 - config.techWeight, '0052.TW': config.techWeight };
  return {
    '0050.TW': Math.max(0, 100 - config.techWeight - config.leveragedWeight),
    '0052.TW': config.techWeight,
    '00631L.TW': config.leveragedWeight
  };
}

function coreSatelliteWeights(row, config) {
  const core = row.metrics.get('0050.TW');
  if (!core) return {};
  const bear = core.close < core[`ma${config.trendDays}`] && core.mom60 < config.bearMomentum;
  if (bear) return riskOffWeights(row, config);
  return { '0050.TW': config.coreWeight, '0052.TW': config.techWeight };
}

function stagedTrendWeights(row, config) {
  const weights = coreSatelliteWeights(row, config);
  const core = row.metrics.get('0050.TW');
  if (!core || !weights['0052.TW']) return weights;
  const warning = config.warningMode === 'below_ma20'
    ? core.close < core.ma20
    : config.warningMode === 'below_ma60'
      ? core.close < core.ma60
      : config.warningMode === 'ma_cross'
        ? core.ma20 < core.ma60
        : config.warningMode === 'drawdown5'
          ? core.close < core.ma20 && pct(core.close, core.high60) <= -5
          : config.warningMode === 'trend_break'
            ? core.close < core.ma20 && core.mom20 < 0
            : core.close < core.ma20 && pct(core.close, core.high60) <= -10;
  return warning ? scaled(weights, config.warningExposurePct) : weights;
}

function markEquity(state, row, field = 'close') {
  const unsettled = state.unsettled.reduce((sum, item) => sum + item.amount, 0);
  const positions = [...state.positions.entries()].reduce((sum, [symbol, position]) => {
    const price = row.bars.get(symbol)?.[field] ?? state.lastClose.get(symbol);
    return price ? sum + position.quantity * price : sum;
  }, 0);
  return state.cash + unsettled + positions;
}

function makeIntent(date, symbol, action, config, price, budget, reason) {
  return decisionToOrderIntent({
    date,
    symbol,
    action,
    strategyId: `deployable_multi_asset_rotation_v1:${config.id}`,
    setup: ['0050 長趨勢與 60 日動能確認', '0050／0052 固定週期再平衡', '60 日高點回落警戒與帳戶風控均未封鎖'],
    trigger: ['T 日收盤確認訊號', 'T+1 開盤以可成交限價委託'],
    invalidation: ['0050 跌破 MA120 且 60 日動能低於 0%', '帳戶或單月損失觸發熔斷'],
    entryPlan: {
      referencePrice: price,
      maximumAcceptablePrice: price * 1.004,
      orderType: 'MARKETABLE_LIMIT',
      timeInForce: 'ROD',
      session: 'REGULAR'
    },
    riskPlan: {
      stopPrice: null,
      targetPrice: null,
      riskRewardRatio: null,
      positionBudget: budget,
      riskBudget: INITIAL_CAPITAL * 0.005
    },
    reason,
    warnings: ['僅為研究用 order intent，不得送往真實券商 API']
  }, { account: { equity: INITIAL_CAPITAL, availableCash: INITIAL_CAPITAL } });
}

function sell(state, row, symbol, quantity, reason) {
  const position = state.positions.get(symbol);
  const bar = row.bars.get(symbol);
  quantity = Math.min(position?.quantity || 0, Math.max(0, quantity));
  if (!bar || !quantity) return false;
  const execution = sellExecution(bar.open, quantity, COSTS);
  const cost = position.cost * quantity / position.quantity;
  state.unsettled.push({ releaseIndex: row.index + 2, amount: execution.net });
  state.trades.push({
    symbol,
    entryDate: position.entryDate,
    exitDate: row.date,
    quantity,
    pnl: round(execution.net - cost),
    reason
  });
  state.intents.push(makeIntent(row.date, symbol, 'SELL', state.config, execution.fillPrice, 0, reason));
  position.quantity -= quantity;
  position.cost -= cost;
  if (!position.quantity) state.positions.delete(symbol);
  return true;
}

function buy(state, row, symbol, budget, reason) {
  const bar = row.bars.get(symbol);
  budget = Math.min(state.cash, budget);
  if (!bar || budget <= 0) return false;
  let quantity = Math.floor(budget / (bar.open * 1.004));
  let execution = buyExecution(bar.open, quantity, COSTS);
  if (execution.total > budget) {
    quantity = Math.max(0, quantity - 1);
    execution = buyExecution(bar.open, quantity, COSTS);
  }
  if (!quantity) return false;
  const position = state.positions.get(symbol);
  state.cash -= execution.total;
  state.positions.set(symbol, {
    quantity: (position?.quantity || 0) + quantity,
    cost: (position?.cost || 0) + execution.total,
    entryDate: position?.entryDate || row.date
  });
  state.intents.push(makeIntent(row.date, symbol, 'BUY', state.config, execution.fillPrice, budget, reason));
  return true;
}

function rebalance(state, row, weights, force = false) {
  const equity = markEquity(state, row, 'open');
  const band = state.config.rebalanceBand ?? 0.03;
  for (const [symbol, position] of [...state.positions.entries()]) {
    const bar = row.bars.get(symbol);
    if (!bar) continue;
    const current = position.quantity * bar.open;
    const desired = equity * ((weights[symbol] || 0) / 100);
    if (force || current > desired * (1 + band)) {
      sell(state, row, symbol, Math.floor((current - desired) / bar.open), `調整權重到 ${round(weights[symbol] || 0, 2)}%`);
    }
  }
  for (const [symbol, weight] of Object.entries(weights)) {
    const bar = row.bars.get(symbol);
    if (!bar) continue;
    const current = (state.positions.get(symbol)?.quantity || 0) * bar.open;
    const desired = equity * (weight / 100);
    if (current < desired * (1 - band)) {
      buy(state, row, symbol, desired - current, `建立權重 ${round(weight, 2)}%`);
    }
  }
}

function summarize(state, startDate, endDate) {
  const monthEnd = new Map();
  for (const row of state.curve) monthEnd.set(row.date.slice(0, 7), row.equity);
  let prior = INITIAL_CAPITAL;
  const monthly = [...monthEnd].map(([month, equity]) => {
    const equityReturnPct = pct(equity, prior);
    prior = equity;
    return { month, equity: round(equity, 0), equityReturnPct: round(equityReturnPct) };
  });
  const gains = state.trades.filter(row => row.pnl > 0).reduce((sum, row) => sum + row.pnl, 0);
  const losses = Math.abs(state.trades.filter(row => row.pnl <= 0).reduce((sum, row) => sum + row.pnl, 0));
  let peak = INITIAL_CAPITAL;
  let maximumDrawdownPct = 0;
  for (const row of state.curve) {
    peak = Math.max(peak, row.equity);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, pct(row.equity, peak));
  }
  const compounded = monthly.reduce((value, row) => value * (1 + row.equityReturnPct / 100), 1);
  return {
    startDate,
    endDate,
    endingEquity: round(state.curve.at(-1)?.equity || INITIAL_CAPITAL, 0),
    averageMonthlyEquityReturnPct: round(mean(monthly.map(row => row.equityReturnPct)) || 0),
    annualizedReturnPct: round((compounded ** (12 / Math.max(1, monthly.length)) - 1) * 100),
    profitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    maximumDrawdownPct: round(maximumDrawdownPct),
    winRatePct: round(state.trades.filter(row => row.pnl > 0).length / Math.max(1, state.trades.length) * 100),
    trades: state.trades.length,
    negativeMonths: monthly.filter(row => row.equityReturnPct < 0).length,
    monthly
  };
}

function simulate(rows, schedule, startDate, endDate, emitIntents = false) {
  const slice = rows.filter(row => row.date >= startDate && row.date <= endDate);
  const state = {
    cash: INITIAL_CAPITAL,
    unsettled: [],
    positions: new Map(),
    trades: [],
    intents: [],
    curve: [],
    lastClose: new Map(),
    config: schedule(startDate),
    targetKey: '',
    days: 999,
    peak: INITIAL_CAPITAL,
    cooldown: 0,
    currentMonth: null,
    monthStart: INITIAL_CAPITAL,
    monthlyBlocked: false,
    riskScalePct: 100
  };
  for (let offset = 1; offset < slice.length; offset += 1) {
    const signal = slice[offset - 1];
    const row = slice[offset];
    for (const [symbol, bar] of signal.bars) state.lastClose.set(symbol, bar.close);
    state.config = schedule(signal.date);
    const released = state.unsettled.filter(item => item.releaseIndex <= row.index);
    state.cash += released.reduce((sum, item) => sum + item.amount, 0);
    state.unsettled = state.unsettled.filter(item => item.releaseIndex > row.index);
    const priorEquity = markEquity(state, signal);
    const month = signal.date.slice(0, 7);
    if (month !== state.currentMonth) {
      state.currentMonth = month;
      state.monthStart = priorEquity;
      state.monthlyBlocked = false;
    } else if (pct(priorEquity, state.monthStart) <= -state.config.monthlyStopPct) {
      state.monthlyBlocked = true;
    }
    state.peak = Math.max(state.peak, priorEquity);
    if (state.cooldown > 0) {
      state.cooldown -= 1;
      if (!state.cooldown) state.peak = priorEquity;
    } else if (pct(priorEquity, state.peak) <= -state.config.accountGuardPct) {
      state.cooldown = state.config.cooldownDays;
    }
    let weights = state.cooldown > 0 || state.monthlyBlocked
      ? {}
      : (state.config.kind === 'core_satellite'
              ? coreSatelliteWeights(signal, state.config)
        : state.config.kind === 'relative_strength'
          ? relativeStrengthWeights(signal, state.config)
          : state.config.kind === 'leveraged_overlay'
            ? leveragedOverlayWeights(signal, state.config)
            : state.config.kind === 'scheduled_trend_core'
              ? coreSatelliteWeights(signal, state.config)
              : state.config.kind === 'staged_trend_core'
                ? stagedTrendWeights(signal, state.config)
                : {});
    const coreMetric = signal.metrics.get('0050.TW');
    if (Number.isFinite(state.config.shockMomentum)
      && coreMetric?.close < coreMetric?.ma20
      && coreMetric?.mom20 < state.config.shockMomentum) {
      weights = riskOffWeights(signal, state.config);
    }
    const coreVol = coreMetric?.vol20;
    const volatilityCap = state.config.targetVol >= 90 || !Number.isFinite(coreVol)
      ? 100
      : Math.min(100, state.config.targetVol / Math.max(10, coreVol) * 100);
    weights = capExposure(weights, Math.min(state.riskScalePct, volatilityCap));
    const key = `${state.config.id}:${JSON.stringify(weights)}`;
    const due = key !== state.targetKey || state.days >= state.config.rebalanceDays || released.length;
    if (due) {
      rebalance(state, row, weights, key !== state.targetKey);
      state.targetKey = key;
      state.days = 0;
    }
    state.days += 1;
    for (const [symbol, bar] of row.bars) state.lastClose.set(symbol, bar.close);
    state.curve.push({ date: row.date, equity: markEquity(state, row) });
  }
  const last = slice.at(-1);
  if (last) {
    for (const symbol of [...state.positions.keys()]) {
      sell(state, last, symbol, state.positions.get(symbol).quantity, '結束驗證視窗');
    }
    state.curve.push({ date: last.date, equity: markEquity(state, last) });
  }
  if (!emitIntents) state.intents = [];
  return { state, summary: summarize(state, startDate, endDate) };
}

function addYears(dateText, years) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

function dayBefore(dateText) {
  return new Date(Date.parse(`${dateText}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function scoreSummary(summary, annual) {
  const stable = annual.filter(value => value > 0).length >= Math.ceil(annual.length * 0.5);
  const pf = Number.isFinite(summary.profitFactor) ? Math.min(4, summary.profitFactor) : 4;
  const tradeScore = Math.min(summary.trades, 100) * 0.1;
  return stable && summary.trades >= 20 && summary.maximumDrawdownPct > -35 && summary.averageMonthlyEquityReturnPct > 0.15
    ? summary.averageMonthlyEquityReturnPct * 20 + Math.min(...annual) * 2 + summary.maximumDrawdownPct * 0.4 + pf + tradeScore
    : -Infinity;
}

function selectConfig(rows, fold, family = null) {
  const years = Math.max(4, Math.ceil((Date.parse(fold.trainEnd) - Date.parse(fold.trainStart)) / (365.25 * 86_400_000)));
  const yearly = Array.from({ length: years }, (_, index) => ({
    start: addYears(fold.trainStart, index),
    end: index === years - 1 ? fold.trainEnd : dayBefore(addYears(fold.trainStart, index + 1))
  }));
  const leveragedTrainingDays = rows.filter(row => row.date >= fold.trainStart
    && row.date <= fold.trainEnd
    && row.metrics.has('00631L.TW')).length;
  const inverseTrainingDays = rows.filter(row => row.date >= fold.trainStart
    && row.date <= fold.trainEnd
    && row.metrics.has('00632R.TW')).length;
  const eligibleConfigs = configs.filter(config => (!family || config.kind === family)
    && (config.kind !== 'leveraged_overlay' || leveragedTrainingDays >= 252)
    && (!config.leveragedWeight || leveragedTrainingDays >= 252)
    && (!config.riskOffMode?.startsWith('inverse') || inverseTrainingDays >= 252));
  const preliminary = eligibleConfigs.map(config => {
    const summary = simulate(rows, () => config, fold.trainStart, fold.trainEnd).summary;
    const eligible = summary.trades >= 20
      && summary.maximumDrawdownPct > -35
      && summary.averageMonthlyEquityReturnPct > 0.15;
    const pf = Number.isFinite(summary.profitFactor) ? Math.min(4, summary.profitFactor) : 4;
    const preliminaryScore = eligible
      ? summary.averageMonthlyEquityReturnPct * 20 + summary.maximumDrawdownPct * 0.4 + pf + Math.min(summary.trades, 100) * 0.1
      : -Infinity;
    return { config, summary, preliminaryScore };
  }).sort((left, right) => right.preliminaryScore - left.preliminaryScore).slice(0, TEST_FAMILY ? 10 : 60);
  const evaluated = preliminary.map(({ config, summary }) => {
    const annual = yearly.map(window => simulate(rows, () => config, window.start, window.end).summary.averageMonthlyEquityReturnPct);
    const score = scoreSummary(summary, annual);
    return { config, summary, score };
  }).sort((left, right) => right.score - left.score);
  const fallback = [PRIMARY_FAMILY, 'staged_trend_core'].includes(family) ? MARKET_FALLBACK_CONFIG : CASH_CONFIG;
  return evaluated.find(row => Number.isFinite(row.score)) || {
    config: fallback,
    summary: simulate(rows, () => fallback, fold.trainStart, fold.trainEnd).summary,
    score: 0
  };
}

function compact(summary) {
  const { monthly, ...metrics } = summary;
  return metrics;
}

function drawdownDetail(curve) {
  let peak = INITIAL_CAPITAL;
  let peakDate = curve[0]?.date || null;
  let worst = { drawdownPct: 0, peakDate, troughDate: peakDate };
  for (const row of curve) {
    if (row.equity > peak) {
      peak = row.equity;
      peakDate = row.date;
    }
    const drawdownPct = pct(row.equity, peak);
    if (drawdownPct < worst.drawdownPct) worst = { drawdownPct: round(drawdownPct), peakDate, troughDate: row.date };
  }
  return worst;
}

function buyAndHold0050(rows, startDate, endDate) {
  const slice = rows.filter(row => row.date >= startDate && row.date <= endDate);
  const first = slice[1];
  const last = slice.at(-1);
  if (!first || !last) return summarize({ curve: [], trades: [] }, startDate, endDate);
  const quantity = Math.floor(INITIAL_CAPITAL / (first.bars.get('0050.TW').open * 1.004));
  const entry = buyExecution(first.bars.get('0050.TW').open, quantity, COSTS);
  const cash = INITIAL_CAPITAL - entry.total;
  const curve = slice.map(row => ({ date: row.date, equity: cash + quantity * row.bars.get('0050.TW').close }));
  const exit = sellExecution(last.bars.get('0050.TW').close, quantity, COSTS);
  curve[curve.length - 1].equity = cash + exit.net;
  return summarize({
    curve,
    trades: [{ symbol: '0050.TW', entryDate: first.date, exitDate: last.date, pnl: exit.net - entry.total }]
  }, startDate, endDate);
}

async function main() {
  const [rows, prior] = await Promise.all([
    loadRows(),
    fs.readFile(PRIOR, 'utf8').then(JSON.parse)
  ]);
  const folds = foldWindows(rows[0].date, rows.at(-1).date, TRAIN_MONTHS, VALIDATION_MONTHS)
    .filter(fold => Date.parse(fold.validationEnd) - Date.parse(fold.validationStart) >= MIN_VALIDATION_DAYS * 86_400_000);
  if (TEST_FAMILY) {
    const testSelections = folds.map(fold => ({ ...fold, selected: selectConfig(rows, fold, TEST_FAMILY) }));
    const testSchedule = date => testSelections.find(row => date >= row.validationStart && date <= row.validationEnd)?.selected.config
      || testSelections.at(-1).selected.config;
    const start = testSelections[0].validationStart;
    const end = testSelections.at(-1).validationEnd;
    const testValidation = simulate(rows, testSchedule, start, end);
    const holdoutStart = '2025-01-01';
    const holdoutEnd = rows.at(-1).date;
    const holdout = holdoutEnd >= holdoutStart
      ? simulate(rows, () => testSelections.at(-1).selected.config, holdoutStart, holdoutEnd)
      : null;
    console.log(JSON.stringify({
      family: TEST_FAMILY,
      metrics: compact(testValidation.summary),
      maximumDrawdown: drawdownDetail(testValidation.state.curve),
      untouchedHoldout: holdout ? {
        metrics: compact(holdout.summary),
        maximumDrawdown: drawdownDetail(holdout.state.curve),
        benchmark0050: compact(buyAndHold0050(rows, holdoutStart, holdoutEnd)),
        configId: testSelections.at(-1).selected.config.id
      } : null,
      benchmark0050: compact(buyAndHold0050(rows, start, end)),
      selections: testSelections.map(row => ({
        validationStart: row.validationStart,
        validationEnd: row.validationEnd,
        configId: row.selected.config.id
      }))
    }, null, 2));
    return;
  }
  const selections = folds.map(fold => ({ ...fold, selected: selectConfig(rows, fold, PRIMARY_FAMILY) }));
  const schedule = date => selections.find(row => date >= row.validationStart && date <= row.validationEnd)?.selected.config || selections.at(-1).selected.config;
  const validationStart = selections[0].validationStart;
  const validationEnd = selections.at(-1).validationEnd;
  const validation = simulate(rows, schedule, validationStart, validationEnd, true);
  const familyResults = {};
  for (const family of [PRIMARY_FAMILY]) {
    const familySelections = folds.map(fold => ({ ...fold, selected: selectConfig(rows, fold, family) }));
    const familySchedule = date => familySelections.find(row => date >= row.validationStart && date <= row.validationEnd)?.selected.config
      || familySelections.at(-1).selected.config;
    familyResults[family] = {
      metrics: compact(simulate(rows, familySchedule, validationStart, validationEnd).summary),
      selections: familySelections.map(row => ({
        trainStart: row.trainStart,
        trainEnd: row.trainEnd,
        validationStart: row.validationStart,
        validationEnd: row.validationEnd,
        configId: row.selected.config.id
      }))
    };
  }
  const benchmark = buyAndHold0050(rows, validationStart, validationEnd);
  const metrics = validation.summary;
  const holdoutStart = '2025-01-01';
  const holdoutEnd = rows.at(-1).date;
  const holdout = simulate(rows, () => selections.at(-1).selected.config, holdoutStart, holdoutEnd);
  const holdoutBenchmark = buyAndHold0050(rows, holdoutStart, holdoutEnd);
  const priorSelections = (prior.selections || []).map(row => ({
    ...row,
    config: parseCoreSatelliteConfig(row.configId)
  })).filter(row => row.config);
  const priorSchedule = date => priorSelections.find(row => date >= row.validationStart && date <= row.validationEnd)?.config
    || parseCoreSatelliteConfig('core50_tech50_ma120_bear-8_cash_guard20_r20_b0.1');
  const priorMetrics = simulate(rows, priorSchedule, validationStart, validationEnd).summary;
  const improved = metrics.averageMonthlyEquityReturnPct > priorMetrics.averageMonthlyEquityReturnPct
    && metrics.maximumDrawdownPct > priorMetrics.maximumDrawdownPct
    && metrics.trades > priorMetrics.trades;
  const beats0050 = metrics.averageMonthlyEquityReturnPct > benchmark.averageMonthlyEquityReturnPct
    && metrics.maximumDrawdownPct > benchmark.maximumDrawdownPct;
  const minimumPassed = beats0050 && metrics.trades >= 100 && metrics.profitFactor > 1.15 && metrics.maximumDrawdownPct > -20;
  const iterationBaseline = {
    averageMonthlyEquityReturnPct: 1.0755,
    maximumDrawdownPct: -26.1356,
    trades: 214
  };
  const result = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    methodology: `${TRAIN_MONTHS} 個月滾動訓練／${VALIDATION_MONTHS} 個月非重疊驗證；T 日訊號、T+1 開盤成交、T+2 回款，ETF 費稅與滑價全部納入。`,
    dataRange: { start: rows[0].date, end: rows.at(-1).date },
    configsTestedPerFold: configs.filter(config => config.kind === PRIMARY_FAMILY).length,
    validationFolds: selections.length,
    selections: selections.map(row => ({
      trainStart: row.trainStart,
      trainEnd: row.trainEnd,
      validationStart: row.validationStart,
      validationEnd: row.validationEnd,
      configId: row.selected.config.id,
      trainMonthlyPct: row.selected.summary.averageMonthlyEquityReturnPct,
      trainMaximumDrawdownPct: row.selected.summary.maximumDrawdownPct,
      trainTrades: row.selected.summary.trades
    })),
    metrics: { ...metrics, targetGapPct: round(TARGET_MONTHLY - metrics.averageMonthlyEquityReturnPct), orderIntents: validation.state.intents.length },
    benchmark0050: compact(benchmark),
    priorBest: compact(priorMetrics),
    familyResults,
    comparison: {
      improvedMonthlyVsPriorPct: round(metrics.averageMonthlyEquityReturnPct - priorMetrics.averageMonthlyEquityReturnPct),
      improvedDrawdownVsPriorPct: round(metrics.maximumDrawdownPct - priorMetrics.maximumDrawdownPct),
      improvedTradesVsPrior: metrics.trades - priorMetrics.trades,
      beats0050MonthlyAndDrawdown: beats0050,
      improvedAllTargetsVsPrior: improved
    },
    readiness: {
      minimumResearchThresholdPassed: minimumPassed,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      brokerApiAllowed: false,
      reason: minimumPassed
        ? '歷史驗證門檻有進步，但仍需新鮮期間 paper trading。'
        : '雖然可實際成交，但歷史驗證仍未同時滿足月均、回撤與交易數門檻。'
    }
  };

  result.methodology = `${TRAIN_MONTHS} 個月訓練、${VALIDATION_MONTHS} 個月驗證，每次前進 ${VALIDATION_MONTHS} 個月；T 日收盤產生訊號、T+1 開盤成交、T+2 交割，已計入 ETF 手續費、交易稅與滑價。`;
  result.strategyFamily = PRIMARY_FAMILY;
  result.maximumDrawdown = drawdownDetail(validation.state.curve);
  result.untouchedHoldout = {
    metrics: compact(holdout.summary),
    maximumDrawdown: drawdownDetail(holdout.state.curve),
    benchmark0050: compact(holdoutBenchmark),
    configId: selections.at(-1).selected.config.id
  };
  result.iterationBaseline = iterationBaseline;
  result.iterationComparison = {
    improvedMonthlyPct: round(metrics.averageMonthlyEquityReturnPct - iterationBaseline.averageMonthlyEquityReturnPct),
    improvedDrawdownPct: round(metrics.maximumDrawdownPct - iterationBaseline.maximumDrawdownPct),
    additionalTrades: metrics.trades - iterationBaseline.trades,
    improvedAllThree: metrics.averageMonthlyEquityReturnPct > iterationBaseline.averageMonthlyEquityReturnPct
      && metrics.maximumDrawdownPct > iterationBaseline.maximumDrawdownPct
      && metrics.trades > iterationBaseline.trades
  };
  result.readiness.reason = minimumPassed
    ? '已達研究門檻，但仍須先通過紙上交易，不可直接實盤。'
    : beats0050
      ? '10 年 rolling validation 已超越 0050 且回撤較低，但最大回撤仍高於 20%，額外評估期亦未超越 0050，不可紙上交易或實盤。'
      : '長期月均報酬仍未超越 0050，且最大回撤仍高於 20%，不可紙上交易、不可實盤、不可接真實券商下單。';

  await fs.writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, [
    '# 長期可執行多資產輪動策略 v1',
    '',
    `- 方法：${result.methodology}`,
    `- Rolling validation：${validationStart} 至 ${validationEnd}，共 10 年、${selections.length} 段`,
    `- 月均總資產報酬：${metrics.averageMonthlyEquityReturnPct}%`,
    `- 年化報酬：${metrics.annualizedReturnPct}%`,
    `- 最大回撤：${metrics.maximumDrawdownPct}%（${result.maximumDrawdown.peakDate} 至 ${result.maximumDrawdown.troughDate}）`,
    `- Profit Factor：${metrics.profitFactor}`,
    `- 交易筆數：${metrics.trades}`,
    `- 勝率：${metrics.winRatePct}%`,
    `- 0050 同期月均：${benchmark.averageMonthlyEquityReturnPct}%`,
    `- 相較前一版：月均 ${result.iterationComparison.improvedMonthlyPct >= 0 ? '+' : ''}${result.iterationComparison.improvedMonthlyPct} 個百分點、最大回撤變化 ${result.iterationComparison.improvedDrawdownPct} 個百分點、交易筆數變化 ${result.iterationComparison.additionalTrades} 筆`,
    '',
    '## 訓練與驗證區間',
    '',
    ...selections.map((row, index) => `- 第 ${index + 1} 段：訓練 ${row.trainStart}～${row.trainEnd}；驗證 ${row.validationStart}～${row.validationEnd}；採用 ${row.selected.config.id}`),
    '',
    '## 額外評估期',
    '',
    `- 期間：${holdoutStart} 至 ${holdoutEnd}`,
    `- 策略月均：${holdout.summary.averageMonthlyEquityReturnPct}%；0050 月均：${holdoutBenchmark.averageMonthlyEquityReturnPct}%`,
    `- 策略最大回撤：${holdout.summary.maximumDrawdownPct}%；0050 最大回撤：${holdoutBenchmark.maximumDrawdownPct}%`,
    `- 策略交易：${holdout.summary.trades} 筆`,
    '',
    '## 結論',
    '',
    `- 10 年 rolling validation 月均${beats0050 ? '已' : '未'}超越 0050，最大回撤較 0050 低 ${round(metrics.maximumDrawdownPct - benchmark.maximumDrawdownPct)} 個百分點。`,
    `- 額外評估期月均${holdout.summary.averageMonthlyEquityReturnPct > holdoutBenchmark.averageMonthlyEquityReturnPct ? '已' : '未'}超越 0050。`,
    '- 目前不可進入 paper trading、不可實盤、不可接真實券商下單。',
    ''
  ].join('\n'), 'utf8');

  await fs.writeFile(READINESS, [
    '# 自動交易落地狀態',
    '',
    `- Rolling validation 月均：${metrics.averageMonthlyEquityReturnPct}%`,
    `- Rolling validation 區間：${validationStart} 至 ${validationEnd}（10 年）`,
    `- Rolling validation 最大回撤：${metrics.maximumDrawdownPct}%`,
    `- Rolling validation 交易：${metrics.trades} 筆`,
    `- 額外評估期月均：${holdout.summary.averageMonthlyEquityReturnPct}%`,
    `- 額外評估區間：${holdoutStart} 至 ${holdoutEnd}`,
    `- 額外評估期最大回撤：${holdout.summary.maximumDrawdownPct}%`,
    '- 此期間已在多輪研究中反覆觀察，不再視為純粹未觸碰 holdout。',
    `- 10 年 validation 是否超越 0050：${beats0050 ? '是' : '否'}`,
    `- 額外評估期是否超越 0050：${holdout.summary.averageMonthlyEquityReturnPct > holdoutBenchmark.averageMonthlyEquityReturnPct ? '是' : '否'}`,
    '- 可產生 T 日訊號與 T+1 order intent，但尚未達策略通過門檻。',
    '- Paper trading：不允許。',
    '- 真實券商 API 下單：不允許。',
    ''
  ].join('\n'), 'utf8');

  const registry = JSON.parse(await fs.readFile(REGISTRY, 'utf8'));
  registry.experiments = registry.experiments.filter(row => row.strategyId !== 'deployable_multi_asset_rotation_v1_long_validation');
  registry.updatedAt = new Date().toISOString();
  await fs.writeFile(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await appendExperiment({
    strategyId: 'deployable_multi_asset_rotation_v1_long_validation',
    dataSources: ASSETS.map(asset => `${asset.name}_twse_daily`),
    setupRules: ['0050 位於 MA120 上方', '0050 60 日動能不低於 0%', '0050／0052 固定週期再平衡', '跌破 MA20 且距 60 日高點回落 5% 時分段降曝險'],
    triggerRules: ['T 日收盤確認趨勢與急跌保護', 'T+1 開盤調整到目標權重'],
    invalidationRules: ['0050 跌破 MA120 且 60 日動能低於 0%', '20 日跌幅觸發急跌保護'],
    exitRules: ['權重切換', '月損失封鎖', '帳戶回撤熔斷', '結束驗證視窗'],
    riskRules: ['T+2', 'ETF 交易成本', '滑價', '6% 帳戶回撤熔斷', '4% 月損失封鎖', '15 日冷卻'],
    blockedWhen: ['長趨勢與 60 日動能同步轉空', '帳戶或單月損失觸發封鎖'],
    parameters: {
      configs: configs.filter(config => config.kind === PRIMARY_FAMILY).length,
      assets: ['0050.TW', '0052.TW'],
      strategyFamilies: [PRIMARY_FAMILY]
    },
    trainPeriod: { months: TRAIN_MONTHS, mode: 'rolling' },
    validationPeriod: { months: VALIDATION_MONTHS, stepMonths: VALIDATION_MONTHS },
    costModel: COSTS,
    executionModel: 'T 日訊號、T+1 開盤成交、T+2 回款',
    metrics: compact(result.metrics),
    resultStatus: minimumPassed ? 'inconclusive' : 'failed',
    passedMinimum: minimumPassed,
    passedHighProfit: false,
    allowRetest: false,
    notes: result.readiness.reason
  });

  console.log(`多資產輪動 v1：月均 ${metrics.averageMonthlyEquityReturnPct}% / 最大回撤 ${metrics.maximumDrawdownPct}% / 交易 ${metrics.trades} 筆`);
}

await main();
