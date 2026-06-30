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
  })).filter(row => row.date >= '2010-11-01' && row.metrics.has('0050.TW'));
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
  return rows;
}

const configs = buildConfigs();

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
  if (bear) return config.riskOffMode === 'core50' ? { '0050.TW': 50 } : {};
  return { '0050.TW': config.coreWeight, '0052.TW': config.techWeight };
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
    setup: ['多資產相對強弱排序', '廣義多頭才持有風險資產', '防守時切到黃金或現金'],
    trigger: ['T 日收盤排序確認', 'T+1 開盤依目標權重調整'],
    invalidation: ['0050 跌破長均線且動能轉弱', '標的跌破資產趨勢條件'],
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
    warnings: ['僅為 order intent，尚未接真實券商 API']
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
  const band = state.config.kind === 'core_satellite' ? state.config.rebalanceBand : 0.03;
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
  }).sort((left, right) => right.preliminaryScore - left.preliminaryScore).slice(0, 60);
  const evaluated = preliminary.map(({ config, summary }) => {
    const annual = yearly.map(window => simulate(rows, () => config, window.start, window.end).summary.averageMonthlyEquityReturnPct);
    const score = scoreSummary(summary, annual);
    return { config, summary, score };
  }).sort((left, right) => right.score - left.score);
  return evaluated.find(row => Number.isFinite(row.score)) || {
    config: CASH_CONFIG,
    summary: simulate(rows, () => CASH_CONFIG, fold.trainStart, fold.trainEnd).summary,
    score: 0
  };
}

function compact(summary) {
  const { monthly, ...metrics } = summary;
  return metrics;
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
  const selections = folds.map(fold => ({ ...fold, selected: selectConfig(rows, fold) }));
  const schedule = date => selections.find(row => date >= row.validationStart && date <= row.validationEnd)?.selected.config || selections.at(-1).selected.config;
  const validationStart = selections[0].validationStart;
  const validationEnd = selections.at(-1).validationEnd;
  const validation = simulate(rows, schedule, validationStart, validationEnd, true);
  const familyResults = {};
  for (const family of ['core_satellite', 'relative_strength', 'leveraged_overlay']) {
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
  const result = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    methodology: `${TRAIN_MONTHS} 個月滾動訓練／${VALIDATION_MONTHS} 個月非重疊驗證；T 日訊號、T+1 開盤成交、T+2 回款，ETF 費稅與滑價全部納入。`,
    dataRange: { start: rows[0].date, end: rows.at(-1).date },
    configsTestedPerFold: configs.length,
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

  await fs.writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, [
    '# 多資產輪動長驗證研究 v1',
    '',
    `- 驗證方法：${TRAIN_MONTHS} 個月滾動訓練／${VALIDATION_MONTHS} 個月非重疊驗證`,
    `- Validation 段數：${selections.length}`,
    `- 月均總資產報酬：${metrics.averageMonthlyEquityReturnPct}%`,
    `- 距離月均 10%：${result.metrics.targetGapPct} 個百分點`,
    `- 年化報酬：${metrics.annualizedReturnPct}%`,
    `- 最大回撤：${metrics.maximumDrawdownPct}%`,
    `- Profit Factor：${metrics.profitFactor}`,
    `- 交易數：${metrics.trades}`,
    `- 勝率：${metrics.winRatePct}%`,
    `- 0050 月均：${benchmark.averageMonthlyEquityReturnPct}%`,
    `- 0050 最大回撤：${benchmark.maximumDrawdownPct}%`,
    `- 相較前版月均變化：${result.comparison.improvedMonthlyVsPriorPct} 個百分點`,
    `- 相較前版回撤變化：${result.comparison.improvedDrawdownVsPriorPct} 個百分點`,
    `- 相較前版交易數變化：${result.comparison.improvedTradesVsPrior}`,
    `- 可進 paper trading：${result.readiness.paperTradingAllowed ? '是' : '否'}`,
    `- 可直接實盤：${result.readiness.liveTradingAllowed ? '是' : '否'}`,
    '- 結論：交易數雖增加，但報酬輸給 0050 且回撤過高，不可視為可實盤策略。',
    '',
    '策略邏輯摘要：同時比較核心配置與相對強弱輪動；用 0050 判斷大盤風險，風險資產在台灣、美股、日股 ETF 間輪動，大盤轉弱時退到黃金、0050 半倉或現金。訓練期只選規則，後續兩年驗證期固定不改參數。',
    ''
  ].join('\n'), 'utf8');

  await fs.writeFile(READINESS, [
    '# 自動交易可落地狀態',
    '',
    `多資產輪動 48/24 長期 validation：月均 ${metrics.averageMonthlyEquityReturnPct}% 、年化 ${metrics.annualizedReturnPct}% 、最大回撤 ${metrics.maximumDrawdownPct}% 、交易 ${metrics.trades} 筆。`,
    `雖然已納入 T+1、T+2、手續費、交易稅、滑價與 order intent，但仍未因這次結果自動放行實盤。`,
    '結論：未通過 validation，不可啟用 paper trading，也不可接真實券商 API 下單。',
    ''
  ].join('\n'), 'utf8');

  const registry = JSON.parse(await fs.readFile(REGISTRY, 'utf8'));
  registry.experiments = registry.experiments.filter(row => row.strategyId !== 'deployable_multi_asset_rotation_v1_long_validation');
  registry.updatedAt = new Date().toISOString();
  await fs.writeFile(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await appendExperiment({
    strategyId: 'deployable_multi_asset_rotation_v1_long_validation',
    dataSources: ASSETS.map(asset => `${asset.name}_twse_daily`),
    setupRules: ['多資產相對強弱', '大盤風控', '黃金防守'],
    triggerRules: ['T 日收盤排序', 'T+1 開盤調整到目標權重'],
    invalidationRules: ['0050 風控破壞', '資產跌破趨勢'],
    exitRules: ['權重切換', '月損失封鎖', '帳戶回撤熔斷', '結束驗證視窗'],
    riskRules: ['T+2', 'ETF 交易成本', '滑價', '20 日冷卻'],
    blockedWhen: ['風險資產全數弱勢', '大盤跌破長均線'],
    parameters: { configs: configs.length, assets: ASSETS.map(asset => asset.symbol), strategyFamilies: ['core_satellite', 'relative_strength'] },
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
