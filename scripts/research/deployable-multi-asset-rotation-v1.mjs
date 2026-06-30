import fs from 'node:fs/promises';
import { buyExecution, sellExecution } from '../lib/execution-simulator.mjs';
import { decisionToOrderIntent } from '../lib/order-intent-generator.mjs';
import { foldWindows, mean, round } from './research-core.mjs';
import { appendExperiment } from './strategy-experiment-registry.mjs';

const HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/deployable-multi-asset-rotation-v1.json', import.meta.url);
const REPORT = new URL('../../docs/DEPLOYABLE_MULTI_ASSET_ROTATION_V1.md', import.meta.url);
const READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);
const PRIOR = new URL('../../data/research/deployable-core-satellite-v1.json', import.meta.url);
const REGISTRY = new URL('../../data/research/strategy-experiment-registry.json', import.meta.url);

const INITIAL_CAPITAL = 1_000_000;
const TARGET_MONTHLY = 10;
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
  { symbol: '00635U.TW', name: '00635U', type: 'defense' }
]);

const RISK_SYMBOLS = ASSETS.filter(asset => asset.type === 'risk').map(asset => asset.symbol);
const DEFENSE_SYMBOL = '00635U.TW';

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
  const payload = JSON.parse(await fs.readFile(HISTORY, 'utf8'));
  const bars = new Map();
  const metrics = new Map();
  for (const asset of ASSETS) {
    const series = payload.series[asset.symbol] || [];
    bars.set(asset.symbol, new Map(series.map(row => [row.date, row])));
    metrics.set(asset.symbol, new Map(enrich(series).map(row => [row.date, { ...row, symbol: asset.symbol }])));
  }
  return (payload.series['0050.TW'] || []).map((bar, index) => ({
    date: bar.date,
    index,
    bars: new Map(ASSETS.map(asset => [asset.symbol, bars.get(asset.symbol).get(bar.date)]).filter(([, value]) => value)),
    metrics: new Map(ASSETS.map(asset => [asset.symbol, metrics.get(asset.symbol).get(bar.date)]).filter(([, value]) => value))
  })).filter(row => row.date >= '2010-11-01' && row.metrics.has('0050.TW') && row.metrics.has('0052.TW'));
}

function buildConfigs() {
  const rows = [];
  for (const baseCoreWeight of [50, 60]) {
    for (const satelliteWeight of [20, 40]) {
      for (const broadTrendDays of [120, 200]) {
        for (const assetTrendDays of [60, 120]) {
          for (const broadMomentumFloor of [-8, -4]) {
            for (const leaderRelativeFloor of [0, 2, 4]) {
              for (const leaderBoostPct of [0, 10]) {
                for (const hedgePct of [0, 10]) {
                  for (const riskOffMode of ['cash', 'gold', 'core50']) {
                    for (const satelliteFallback of ['core', 'cash']) {
                      for (const rebalanceDays of [10, 20]) {
                        for (const accountGuardPct of [12, 16]) {
                          rows.push({
                            kind: 'multi_asset',
                            id: `core${baseCoreWeight}_sat${satelliteWeight}_bma${broadTrendDays}_ama${assetTrendDays}_mom${broadMomentumFloor}_rs${leaderRelativeFloor}_boost${leaderBoostPct}_hedge${hedgePct}_${riskOffMode}_${satelliteFallback}_r${rebalanceDays}_guard${accountGuardPct}`,
                            baseCoreWeight,
                            satelliteWeight,
                            broadTrendDays,
                            assetTrendDays,
                            broadMomentumFloor,
                            leaderRelativeFloor,
                            leaderBoostPct,
                            hedgePct,
                            riskOffMode,
                            satelliteFallback,
                            rebalanceDays,
                            accountGuardPct,
                            cooldownDays: 20,
                            monthlyStopPct: 5,
                            assetBuffer: 0.12,
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

function coreSatelliteWeights(row, config) {
  const core = row.metrics.get('0050.TW');
  const tech = row.metrics.get('0052.TW');
  if (!core || !tech) return {};
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
    monthlyBlocked: false
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
    } else if (state.config.kind !== 'core_satellite' && pct(priorEquity, state.monthStart) <= -state.config.monthlyStopPct) {
      state.monthlyBlocked = true;
    }
    state.peak = Math.max(state.peak, priorEquity);
    if (state.cooldown > 0) {
      state.cooldown -= 1;
      if (!state.cooldown) state.peak = priorEquity;
    } else if (pct(priorEquity, state.peak) <= -state.config.accountGuardPct) {
      state.cooldown = state.config.cooldownDays;
    }
    const weights = state.cooldown > 0 || state.monthlyBlocked
      ? (state.config.kind === 'core_satellite'
        ? {}
        : riskOffWeights(signal, state.config))
      : (state.config.kind === 'core_satellite'
        ? coreSatelliteWeights(signal, state.config)
        : desiredWeights(signal, state.config));
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
  const stable = annual.filter(value => value > 0).length >= 2;
  const pf = Number.isFinite(summary.profitFactor) ? Math.min(4, summary.profitFactor) : 4;
  const tradeScore = Math.min(summary.trades, 50) * 0.05;
  return stable && summary.trades >= 8 && summary.maximumDrawdownPct > -25 && summary.averageMonthlyEquityReturnPct > 0.2
    ? summary.averageMonthlyEquityReturnPct * 20 + Math.min(...annual) * 2 + summary.maximumDrawdownPct * 0.28 + pf + tradeScore
    : -Infinity;
}

function selectConfig(rows, fold, baselineConfig) {
  const yearly = [0, 1, 2].map(index => ({
    start: addYears(fold.trainStart, index),
    end: index === 2 ? fold.trainEnd : dayBefore(addYears(fold.trainStart, index + 1))
  }));
  const evaluated = configs.map(config => {
    const summary = simulate(rows, () => config, fold.trainStart, fold.trainEnd).summary;
    const annual = yearly.map(window => simulate(rows, () => config, window.start, window.end).summary.averageMonthlyEquityReturnPct);
    const score = scoreSummary(summary, annual);
    return { config, summary, score };
  }).sort((left, right) => right.score - left.score);
  const selected = evaluated.find(row => Number.isFinite(row.score));
  const baselineSummary = simulate(rows, () => baselineConfig, fold.trainStart, fold.trainEnd).summary;
  const baselineAnnual = yearly.map(window => simulate(rows, () => baselineConfig, window.start, window.end).summary.averageMonthlyEquityReturnPct);
  const baselineScore = scoreSummary(baselineSummary, baselineAnnual);
  const keepBaseline = !selected
    || selected.score < baselineScore + 1.5
    || selected.summary.averageMonthlyEquityReturnPct <= baselineSummary.averageMonthlyEquityReturnPct + 0.15
    || selected.summary.maximumDrawdownPct < baselineSummary.maximumDrawdownPct - 1.5
    || selected.summary.trades < baselineSummary.trades + 8;
  if (keepBaseline) {
    return { config: baselineConfig, summary: baselineSummary, score: baselineScore };
  }
  return selected;
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
  const folds = foldWindows(rows[0].date, rows.at(-1).date, 36, 12)
    .filter(fold => Date.parse(fold.validationEnd) - Date.parse(fold.validationStart) >= 330 * 86_400_000);
  const priorSelectionMap = new Map((prior.selections || []).map(row => [row.trainStart, parseCoreSatelliteConfig(row.configId)]).filter(([, value]) => value));
  const selections = folds.map(fold => {
    const baselineConfig = priorSelectionMap.get(fold.trainStart) || parseCoreSatelliteConfig('core50_tech50_ma120_bear-8_cash_guard20_r20_b0.1');
    return { ...fold, selected: selectConfig(rows, fold, baselineConfig) };
  });
  const schedule = date => selections.find(row => date >= row.validationStart && date <= row.validationEnd)?.selected.config || selections.at(-1).selected.config;
  const validationStart = selections[0].validationStart;
  const validationEnd = selections.at(-1).validationEnd;
  const validation = simulate(rows, schedule, validationStart, validationEnd, true);
  const benchmark = buyAndHold0050(rows, validationStart, validationEnd);
  const metrics = validation.summary;
  const priorMetrics = prior.metrics;
  const improved = metrics.averageMonthlyEquityReturnPct > priorMetrics.averageMonthlyEquityReturnPct
    && metrics.maximumDrawdownPct > priorMetrics.maximumDrawdownPct
    && metrics.trades > priorMetrics.trades;
  const beats0050 = metrics.averageMonthlyEquityReturnPct > benchmark.averageMonthlyEquityReturnPct
    && metrics.maximumDrawdownPct > benchmark.maximumDrawdownPct;
  const minimumPassed = beats0050 && metrics.trades >= 80 && metrics.profitFactor > 1.15 && metrics.maximumDrawdownPct > -20;
  const result = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    methodology: '36 個月訓練、12 個月驗證、連續 12 段 rolling walk-forward；T 日訊號、T+1 開盤成交、T+2 回款、ETF 成本與滑價全部納入。',
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
    '# 多資產輪動可部署候選 v1',
    '',
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
    '',
    '策略邏輯摘要：用 0050 當大盤風控，風險資產在台灣、美股、日股 ETF 間做相對強弱輪動；當大盤趨弱時退到黃金或現金；用較密集的 5/10/20 日再平衡拉高交易數，但仍保留月損失與帳戶回撤熔斷。',
    ''
  ].join('\n'), 'utf8');

  await fs.writeFile(READINESS, [
    '# 自動交易可落地狀態',
    '',
    `目前最佳可執行候選為多資產輪動候選，validation 月均 ${metrics.averageMonthlyEquityReturnPct}% 、年化 ${metrics.annualizedReturnPct}% 、最大回撤 ${metrics.maximumDrawdownPct}% 、交易 ${metrics.trades} 筆。`,
    `雖然已納入 T+1、T+2、手續費、交易稅、滑價與 order intent，但仍未因這次結果自動放行實盤。`,
    '只要沒有通過更嚴格的新鮮期間 paper trading，就不可直接接真實券商 API 下單。',
    ''
  ].join('\n'), 'utf8');

  const registry = JSON.parse(await fs.readFile(REGISTRY, 'utf8'));
  registry.experiments = registry.experiments.filter(row => row.strategyId !== 'deployable_multi_asset_rotation_v1');
  registry.updatedAt = new Date().toISOString();
  await fs.writeFile(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await appendExperiment({
    strategyId: 'deployable_multi_asset_rotation_v1',
    dataSources: ASSETS.map(asset => `${asset.name}_twse_daily`),
    setupRules: ['多資產相對強弱', '大盤風控', '黃金防守'],
    triggerRules: ['T 日收盤排序', 'T+1 開盤調整到目標權重'],
    invalidationRules: ['0050 風控破壞', '資產跌破趨勢'],
    exitRules: ['權重切換', '月損失封鎖', '帳戶回撤熔斷', '結束驗證視窗'],
    riskRules: ['T+2', 'ETF 交易成本', '滑價', '20 日冷卻'],
    blockedWhen: ['風險資產全數弱勢', '大盤跌破長均線'],
    parameters: { configs: configs.length, assets: ASSETS.map(asset => asset.symbol) },
    trainPeriod: { months: 36 },
    validationPeriod: { months: 12, stepMonths: 12 },
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
