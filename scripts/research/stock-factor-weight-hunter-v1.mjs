import fs from 'node:fs/promises';
import { decisionToOrderIntent } from '../lib/order-intent-generator.mjs';
import {
  foldWindows,
  iterateObservations,
  loadResearchContext,
  mean,
  round,
  simulateSignalMap
} from './research-core.mjs';
import {
  appendExperiment,
  buildExperimentIdentity,
  loadRegistry,
  shouldSkipExperiment
} from './strategy-experiment-registry.mjs';

const NONLINEAR = process.argv.includes('--nonlinear-v1');
const OUTPUT = new URL(
  NONLINEAR
    ? '../../data/research/stock-nonlinear-factor-hunter-v1.json'
    : '../../data/research/stock-factor-weight-hunter-v1.json',
  import.meta.url
);
const REPORT = new URL(
  NONLINEAR
    ? '../../docs/STOCK_NONLINEAR_FACTOR_HUNTER_V1.md'
    : '../../docs/STOCK_FACTOR_WEIGHT_HUNTER_V1.md',
  import.meta.url
);
const READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);
const TARGET_MONTHLY = 5;
const nonlinearExperiment = {
  strategyId: 'stock_nonlinear_factor_hunter_v1',
  dataSources: ['OHLCV', '產業相對強弱', '大盤狀態'],
  setupRules: ['訓練期因子三分位', '前六因子', '兩兩交互格'],
  triggerRules: ['每日橫截面分數高於訓練期第 60 百分位'],
  invalidationRules: ['共用停損與帳戶風控'],
  exitRules: ['3／5／10 日、1.5R／2R、移動停利'],
  riskRules: { singlePositionPct: [18, 24], noLeverage: true },
  blockedWhen: ['空頭防守', '高波動', '低流動性', '長上影'],
  parameters: { trainMonths: 60, validationMonths: 12, factorGroups: 3, interactionFactors: 6 },
  trainPeriod: 'rolling 60 months',
  validationPeriod: 'rolling 12 months',
  costModel: '手續費、交易稅、雙邊滑價',
  executionModel: 'T+1 開盤可成交限價、T+2、共用投組模擬器'
};

const factorDefs = [
  ['relativeMarket20', row => row.factors.relativeMarket20],
  ['relativeTheme20', row => row.factors.relativeTheme20],
  ['return5', row => row.factors.return5],
  ['return20', row => row.factors.return20],
  ['return60', row => row.factors.return60],
  ['rangePosition20', row => row.factors.rangePosition20 * 10],
  ['volumeRatio20', row => Math.min(5, row.factors.volumeRatio20 || 0)],
  ['transactionValuePercentile', row => row.factors.transactionValuePercentile * 10],
  ['ma20Slope', row => row.factors.ma20Slope],
  ['ma60Slope', row => row.factors.ma60Slope],
  ['distanceMa20', row => row.factors.distanceMa20],
  ['atrPct', row => row.factors.atrPct],
  ['breakout20', row => row.factors.breakout20 ? 1 : 0],
  ['longLowerWick', row => row.factors.longLowerWick ? 1 : 0],
  ['longUpperWick', row => row.factors.longUpperWick ? 1 : 0],
  ['marketReturn20', row => row.factors.marketReturn20],
  ['marketVolatilityPercentile', row => (row.factors.marketVolatilityPercentile ?? 0.5) * 10]
].map(([id, value]) => ({ id, value }));

const families = [
  {
    id: 'broad_liquid_stock',
    name: '高流動個股全因子排名',
    filter: row => row.factors.transactionValuePercentile >= 0.55
  },
  {
    id: 'bull_rs_stock',
    name: '多頭相對強勢個股',
    filter: row => row.factors.marketAboveMa60
      && row.factors.relativeMarket20 >= 0
      && !['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.factors.regime)
  },
  {
    id: 'breakout_reclaim_stock',
    name: '突破或站回強勢個股',
    filter: row => row.factors.marketAboveMa60
      && (row.factors.breakout20 || (row.day.close > row.ma20 && row.prior.close <= row.ma20))
      && row.day.close > row.day.open
  },
  {
    id: 'pullback_leader_stock',
    name: '領先股回檔後轉強',
    filter: row => row.factors.return60 >= 10
      && row.factors.relativeMarket20 >= 1
      && row.factors.distanceMa20 >= -5
      && row.factors.distanceMa20 <= 5
      && row.day.close > row.day.open
  }
];

const configs = families.flatMap(family => [3, 5, 10].flatMap(horizon => (
  [5, 8].flatMap(topCount => (
    [18, 24].flatMap(positionPct => (
      [1.5, 2].map(rewardRisk => ({
        id: `${family.id}_h${horizon}_top${topCount}_pct${positionPct}_rr${rewardRisk}`,
        name: `${family.name} / ${horizon}日 / Top${topCount} / ${positionPct}% / ${rewardRisk}R`,
        family,
        horizon,
        topCount,
        positionPct,
        rewardRisk,
        stopMult: rewardRisk >= 2 ? 1.2 : 1
      }))
    ))
  ))
)));

function isCommonStock(row) {
  return /^\d{4}$/.test(row.symbol)
    && !/(ETF|ETN|0050|正2|反1|槓桿|期貨)/i.test(`${row.name || ''}`);
}

function baseTradable(row) {
  const f = row.factors;
  return isCommonStock(row)
    && row.day.close >= 12
    && f.transactionValue >= 20_000_000
    && f.atrPct >= 1
    && f.atrPct <= 10
    && Math.abs(f.gapPct) <= 7
    && f.marketVolatilityPercentile <= 0.85
    && !f.longUpperWick;
}

function buildRows(context) {
  const rows = [];
  iterateObservations(context, row => {
    if (!baseTradable(row)) return;
    rows.push({
      symbol: row.symbol,
      name: row.name,
      market: row.market,
      date: row.date,
      nextDate: row.nextDate,
      nextOpen: row.nextOpen,
      day: {
        open: row.day.open,
        high: row.day.high,
        low: row.day.low,
        close: row.day.close
      },
      prior: {
        open: row.prior.open,
        high: row.prior.high,
        low: row.prior.low,
        close: row.prior.close
      },
      ma20: row.ma20,
      ma60: row.ma60,
      factors: { ...row.factors },
      forwardNetReturns: { ...row.forwardNetReturns },
      history: row.history,
      historyIndex: row.historyIndex
    });
  });
  return rows;
}

function percentile(sorted, value) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] <= value) low = mid + 1;
    else high = mid;
  }
  return sorted.length ? low / sorted.length : 0.5;
}

function buildModel(rows, horizon) {
  const weights = [];
  const percentiles = new Map();
  for (const factor of factorDefs) {
    const samples = rows
      .map(row => ({ value: factor.value(row), target: row.forwardNetReturns[horizon] }))
      .filter(row => Number.isFinite(row.value) && Number.isFinite(row.target));
    if (samples.length < 300) continue;
    samples.sort((a, b) => a.value - b.value);
    const size = Math.max(50, Math.floor(samples.length * 0.2));
    const low = samples.slice(0, size);
    const high = samples.slice(-size);
    const edge = mean(high.map(row => row.target)) - mean(low.map(row => row.target));
    if (!Number.isFinite(edge) || Math.abs(edge) < 0.08) continue;
    weights.push({ id: factor.id, weight: Math.max(-3, Math.min(3, edge)), value: factor.value });
    percentiles.set(factor.id, samples.map(row => row.value).sort((a, b) => a - b));
  }
  return { weights, percentiles };
}

function groupIndex(value, cuts) {
  if (!Number.isFinite(value)) return null;
  if (value <= cuts[0]) return 0;
  if (value <= cuts[1]) return 1;
  return 2;
}

function buildNonlinearModel(rows, horizon) {
  const factors = [];
  for (const factor of factorDefs) {
    const samples = rows
      .map(row => ({ value: factor.value(row), target: row.forwardNetReturns[horizon] }))
      .filter(row => Number.isFinite(row.value) && Number.isFinite(row.target))
      .sort((a, b) => a.value - b.value);
    if (samples.length < 900) continue;
    const cuts = [
      samples[Math.floor(samples.length / 3)].value,
      samples[Math.floor(samples.length * 2 / 3)].value
    ];
    const bins = [[], [], []];
    for (const sample of samples) bins[groupIndex(sample.value, cuts)].push(sample.target);
    if (bins.some(bin => bin.length < 300)) continue;
    const means = bins.map(mean);
    factors.push({
      id: factor.id,
      value: factor.value,
      cuts,
      means,
      edge: Math.max(...means) - Math.min(...means)
    });
  }
  factors.sort((a, b) => b.edge - a.edge);
  const selected = factors.slice(0, 6);
  const interactions = [];
  for (let left = 0; left < selected.length; left += 1) {
    for (let right = left + 1; right < selected.length; right += 1) {
      const sums = Array(9).fill(0);
      const counts = Array(9).fill(0);
      for (const row of rows) {
        const target = row.forwardNetReturns[horizon];
        const leftGroup = groupIndex(selected[left].value(row), selected[left].cuts);
        const rightGroup = groupIndex(selected[right].value(row), selected[right].cuts);
        if (!Number.isFinite(target) || leftGroup === null || rightGroup === null) continue;
        const cell = leftGroup * 3 + rightGroup;
        sums[cell] += target;
        counts[cell] += 1;
      }
      const cellMeans = sums.map((sum, index) => counts[index] >= 200
        ? sum / counts[index]
        : 0);
      interactions.push({
        left: selected[left],
        right: selected[right],
        means: cellMeans
      });
    }
  }
  const model = { kind: 'nonlinear', weights: selected, interactions, threshold: 0 };
  const trainScores = rows
    .filter((_, index) => index % 10 === 0)
    .map(row => nonlinearRawScore(row, model))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  model.threshold = trainScores[Math.floor(trainScores.length * 0.6)] || 0;
  return model;
}

function nonlinearRawScore(row, model) {
  let score = 0;
  for (const factor of model.weights) {
    const group = groupIndex(factor.value(row), factor.cuts);
    if (group !== null) score += factor.means[group];
  }
  for (const interaction of model.interactions) {
    const left = groupIndex(interaction.left.value(row), interaction.left.cuts);
    const right = groupIndex(interaction.right.value(row), interaction.right.cuts);
    if (left !== null && right !== null) {
      score += interaction.means[left * 3 + right] * 0.35;
    }
  }
  return score * 10
    + (row.factors.marketAboveMa60 ? 3 : -6)
    - Math.max(0, row.factors.atrPct - 6) * 2;
}

function scoreRow(row, model) {
  if (model.kind === 'nonlinear') {
    return nonlinearRawScore(row, model) - model.threshold;
  }
  let score = 0;
  for (const factor of model.weights) {
    const value = factor.value(row);
    if (!Number.isFinite(value)) continue;
    score += factor.weight * (percentile(model.percentiles.get(factor.id), value) - 0.5);
  }
  return score * 100
    + (row.factors.marketAboveMa60 ? 5 : -8)
    - Math.max(0, row.factors.atrPct - 6) * 2
    - (row.factors.longUpperWick ? 10 : 0);
}

function addTop(map, date, candidate, limit) {
  const list = map.get(date) || [];
  list.push(candidate);
  list.sort((a, b) => b.score - a.score);
  map.set(date, list.slice(0, limit));
}

function makeCandidate(row, config, score) {
  const stopDistancePct = Math.max(3, Math.min(10, row.factors.atrPct * config.stopMult));
  const decision = {
    date: row.nextDate,
    symbol: row.symbol,
    action: 'BUY',
    strategyId: `${NONLINEAR ? 'stock_nonlinear_factor_hunter_v1' : 'stock_factor_weight_hunter_v1'}:${config.id}`,
    setup: [config.family.name, `訓練期因子分數 ${round(score, 2)}`],
    trigger: ['T日收盤後入選，T+1 開盤以可成交限價進場'],
    invalidation: [`跌破進場價約 ${round(stopDistancePct, 2)}% 或觸發共用風控`],
    entryPlan: {
      referencePrice: row.nextOpen,
      maximumAcceptablePrice: row.nextOpen * 1.006,
      orderType: 'MARKETABLE_LIMIT',
      timeInForce: 'ROD',
      session: 'REGULAR'
    },
    riskPlan: {
      stopPrice: row.nextOpen * (1 - stopDistancePct / 100),
      targetPrice: row.nextOpen * (1 + stopDistancePct * config.rewardRisk / 100),
      riskRewardRatio: config.rewardRisk,
      positionBudget: config.positionPct / 100 * 1_000_000,
      riskBudget: Math.min(12_000, config.positionPct / 100 * 1_000_000 * 0.08)
    },
    reason: config.name,
    warnings: ['研究用 order intent，未通過 validation 前不可實盤']
  };
  return {
    signalDate: row.date,
    entryDate: row.nextDate,
    symbol: row.symbol,
    name: row.name,
    market: row.market,
    regime: row.factors.regime,
    atrPct: row.factors.atrPct,
    score,
    futureBars: row.history.slice(row.historyIndex + 1, row.historyIndex + 41).map(bar => ({
      date: bar.date,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      price: bar.close
    })),
    stopDistancePct,
    rewardRisk: config.rewardRisk,
    maxHoldingDays: config.horizon,
    trailingStopRule: config.horizon >= 10 ? { triggerPct: 6, lockPct: 1.5, givebackPct: 4 } : null,
    positionPct: config.positionPct,
    accountRiskPct: config.positionPct >= 24 ? 1.2 : 0.8,
    setup: decision.setup,
    trigger: decision.trigger,
    invalidation: decision.invalidation,
    exitPlan: [`${config.horizon}日、${config.rewardRisk}R、共用停損停利`],
    reason: decision.reason,
    orderIntent: decisionToOrderIntent(decision, { account: { equity: 1_000_000, availableCash: 1_000_000 } })
  };
}

function signalMap(rows, config, model, startDate, endDate) {
  const map = new Map();
  for (const row of rows) {
    if (row.date < startDate || row.date > endDate) continue;
    if (!config.family.filter(row)) continue;
    const score = scoreRow(row, model);
    if (score < 0) continue;
    addTop(map, row.date, makeCandidate(row, config, score), config.topCount);
  }
  return map;
}

function quickConfigScore(rows, config, model, startDate, endDate) {
  const byDate = new Map();
  for (const row of rows) {
    if (row.date < startDate || row.date > endDate) continue;
    if (!config.family.filter(row)) continue;
    const score = scoreRow(row, model);
    if (score < 0) continue;
    const list = byDate.get(row.date) || [];
    list.push({ row, score });
    byDate.set(row.date, list);
  }
  const selected = [];
  for (const list of byDate.values()) {
    list.sort((a, b) => b.score - a.score);
    selected.push(...list.slice(0, config.topCount));
  }
  const returns = selected
    .map(item => item.row.forwardNetReturns[config.horizon])
    .filter(Number.isFinite);
  if (returns.length < 200) return { score: -Infinity, trades: returns.length, average: 0, winRate: 0 };
  const average = mean(returns);
  const winRate = returns.filter(value => value > 0).length / returns.length * 100;
  return {
    trades: returns.length,
    average,
    winRate,
    score: average * 12 + winRate * 0.08 + Math.min(600, returns.length) / 80
  };
}

function riskRules(config) {
  return {
    maxAccountRiskPct: config.positionPct >= 24 ? 1.2 : 0.8,
    maxSinglePositionPct: Math.min(35, config.positionPct + 5),
    exposureLimits: {
      BULL_TREND: 90,
      THEME_MOMENTUM: 90,
      BULL_PULLBACK: 65,
      RANGE_BOUND: 30,
      HIGH_VOLATILITY: 0,
      BEAR_DEFENSE: 0
    },
    drawdownBlockPct: 10,
    drawdownBlockDays: 15,
    monthlyLossBlockPct: 6,
    dailyLossBlockPct: 3,
    dailyLossBlockDays: 1,
    losingStreakCount: 5,
    losingStreakBlockDays: 10
  };
}

function objective(summary) {
  if (!summary || summary.trades < 80 || summary.averageMonthlyEquityReturnPct <= 0) return -Infinity;
  const pf = Number.isFinite(summary.profitFactor) ? Math.min(3, summary.profitFactor) : 3;
  return summary.averageMonthlyEquityReturnPct * 12
    + pf * 5
    + Math.min(300, summary.trades) / 35
    + summary.maximumDrawdownPct * 0.6
    - summary.negativeMonths * 0.15
    - summary.concentrationPct * 0.04;
}

function marketReturns(context, startDate, endDate) {
  const ends = new Map();
  let prior = null;
  for (const row of context.marketHistory) {
    if (row.date < startDate) prior = row.close;
    else if (row.date <= endDate) ends.set(row.date.slice(0, 7), row.close);
  }
  const rows = [];
  for (const close of ends.values()) {
    if (prior) rows.push((close / prior - 1) * 100);
    prior = close;
  }
  return rows;
}

function aggregate(folds) {
  const monthly = folds.flatMap(row => row.validation.summary.monthly.map(item => item.equityReturnPct));
  const trades = folds.flatMap(row => row.validation.trades);
  const market = folds.flatMap(row => row.marketReturns);
  const gains = trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(trades.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
  const symbols = new Map();
  for (const trade of trades) symbols.set(trade.symbol, (symbols.get(trade.symbol) || 0) + 1);
  const averageMonthly = mean(monthly) || 0;
  const metrics = {
    validationStart: folds[0]?.validationStart || null,
    validationEnd: folds.at(-1)?.validationEnd || null,
    validationMonths: monthly.length,
    validationTrades: trades.length,
    validationAverageMonthlyEquityReturnPct: round(averageMonthly),
    targetGapPct: round(TARGET_MONTHLY - averageMonthly),
    validationAnnualizedReturnPct: round(monthly.length ? ((monthly.reduce((v, r) => v * (1 + r / 100), 1)) ** (12 / monthly.length) - 1) * 100 : 0),
    validationProfitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    validationMaximumDrawdownPct: round(Math.min(0, ...folds.map(row => row.validation.summary.maximumDrawdownPct))),
    validationWinRatePct: round(trades.filter(row => row.realizedPnl > 0).length / Math.max(1, trades.length) * 100),
    marketAverageMonthlyReturnPct: round(mean(market) || 0),
    concentrationPct: round(trades.length ? Math.max(...symbols.values()) / trades.length * 100 : 100),
    orderIntentCoveragePct: round(trades.filter(row => row.orderIntent).length / Math.max(1, trades.length) * 100)
  };
  metrics.checks = {
    monthlyAtLeastTarget: metrics.validationAverageMonthlyEquityReturnPct >= TARGET_MONTHLY,
    tradeCount: metrics.validationTrades > 300,
    beatsMarket: metrics.validationAverageMonthlyEquityReturnPct > metrics.marketAverageMonthlyReturnPct,
    profitFactor: metrics.validationProfitFactor > 1.15,
    drawdown: metrics.validationMaximumDrawdownPct > -20,
    diversified: metrics.concentrationPct < 20,
    orderIntent: metrics.orderIntentCoveragePct === 100
  };
  metrics.passedDeployable = Object.values(metrics.checks).every(Boolean);
  return metrics;
}

async function main() {
  if (NONLINEAR) {
    const registry = await loadRegistry();
    const identity = buildExperimentIdentity(nonlinearExperiment);
    const skip = shouldSkipExperiment(registry, identity, nonlinearExperiment);
    if (skip.skip) {
      console.log(`跳過非線性因子實驗：${skip.reason}`);
      return;
    }
  }
  const context = await loadResearchContext();
  const rows = buildRows(context);
  const folds = foldWindows(context.startDate, context.endDate, 60, 12);
  const validations = [];
  const selections = [];
  for (const fold of folds) {
    const trainRows = rows.filter(row => row.date >= fold.trainStart && row.date <= fold.trainEnd);
    const models = new Map([3, 5, 10].map(horizon => [
      horizon,
      NONLINEAR ? buildNonlinearModel(trainRows, horizon) : buildModel(trainRows, horizon)
    ]));
    let best = null;
    for (const config of configs) {
      const model = models.get(config.horizon);
      if (!model?.weights.length) continue;
      const quick = quickConfigScore(rows, config, model, fold.trainStart, fold.trainEnd);
      if (!best || quick.score > best.score) best = { config, model, quick, score: quick.score };
    }
    if (!best) continue;
    const train = simulateSignalMap(context, signalMap(rows, best.config, best.model, fold.trainStart, fold.trainEnd), {
      startDate: fold.trainStart,
      endDate: fold.trainEnd,
      maxOpenPositions: best.config.topCount,
      strategyId: `stock_factor_weight_train:${best.config.id}`,
      riskRules: riskRules(best.config)
    });
    const validation = simulateSignalMap(context, signalMap(rows, best.config, best.model, fold.validationStart, fold.validationEnd), {
      startDate: fold.validationStart,
      endDate: fold.validationEnd,
      maxOpenPositions: best.config.topCount,
      strategyId: `stock_factor_weight_validation:${best.config.id}`,
      riskRules: riskRules(best.config)
    });
    validations.push({
      trainStart: fold.trainStart,
      trainEnd: fold.trainEnd,
      validationStart: fold.validationStart,
      validationEnd: fold.validationEnd,
      configId: best.config.id,
      configName: best.config.name,
      modelFactors: best.model.weights.map(row => ({
        id: row.id,
        weight: round(row.weight),
        edge: round(row.edge)
      })),
      interactionCount: best.model.interactions?.length || 0,
      train,
      validation,
      marketReturns: marketReturns(context, fold.validationStart, fold.validationEnd)
    });
    selections.push({
      trainStart: fold.trainStart,
      trainEnd: fold.trainEnd,
      validationStart: fold.validationStart,
      validationEnd: fold.validationEnd,
      configName: best.config.name,
      trainQuickAverageNetPct: round(best.quick.average),
      trainQuickWinRatePct: round(best.quick.winRate),
      trainQuickTrades: best.quick.trades,
      trainMonthlyPct: train.summary.averageMonthlyEquityReturnPct,
      trainDrawdownPct: train.summary.maximumDrawdownPct,
      trainTrades: train.summary.trades,
      validationMonthlyPct: validation.summary.averageMonthlyEquityReturnPct,
      validationDrawdownPct: validation.summary.maximumDrawdownPct,
      validationTrades: validation.summary.trades
    });
  }
  const metrics = aggregate(validations);
  const output = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    strategyId: NONLINEAR ? 'stock_nonlinear_factor_hunter_v1' : 'stock_factor_weight_hunter_v1',
    objective: '個股為主，訓練期自動計算因子權重，尋找月均 5% 以上且可實盤策略',
    data: {
      rows: rows.length,
      universe: '個股；ETF/0050 不作交易標的，0050/大盤只作比較基準'
    },
    walkForward: { trainMonths: 60, validationMonths: 12, folds: validations.length },
    configurationsTested: configs.length,
    selections,
    metrics,
    readiness: {
      paperTradingAllowed: metrics.passedDeployable,
      liveTradingAllowed: false,
      brokerApiAllowed: false,
      reason: metrics.passedDeployable
        ? '僅可進紙上交易；實盤仍需新期間驗證與人工核准。'
        : '未達月均 5% 或其他可實盤門檻，不可 paper trading、不可實盤。'
    },
    conclusion: metrics.passedDeployable
      ? `找到通過最低門檻的個股策略：月均 ${metrics.validationAverageMonthlyEquityReturnPct}%。`
      : `尚未找到月均 5% 以上的可實盤個股策略；目前月均 ${metrics.validationAverageMonthlyEquityReturnPct}%，距離目標 ${metrics.targetGapPct} 個百分點。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# ${NONLINEAR ? '純個股非線性因子 Hunter v1' : 'Stock Factor Weight Hunter v1'}\n\n${output.conclusion}\n\n| 指標 | 結果 |\n|---|---:|\n| 驗證期間 | ${metrics.validationStart} 至 ${metrics.validationEnd} |\n| 驗證月數 | ${metrics.validationMonths} |\n| 交易筆數 | ${metrics.validationTrades} |\n| 月均總資產報酬 | ${metrics.validationAverageMonthlyEquityReturnPct}% |\n| 距離 5% 目標 | ${metrics.targetGapPct}% |\n| 年化報酬 | ${metrics.validationAnnualizedReturnPct}% |\n| Profit Factor | ${metrics.validationProfitFactor ?? '-'} |\n| 最大回撤 | ${metrics.validationMaximumDrawdownPct}% |\n| 勝率 | ${metrics.validationWinRatePct}% |\n| 大盤月均 | ${metrics.marketAverageMonthlyReturnPct}% |\n\n## 判斷\n\n- 策略標的只使用個股，不使用 ETF/0050 當交易主體。\n- 每段 validation 的模型只由前 60 個月 train 資料產生，validation 不調參。\n- ${NONLINEAR ? '模型使用訓練期分位數與最多 15 組兩兩因子交互，低樣本格不計分。' : '模型使用訓練期單因子權重。'}\n- 未通過前不可 paper trading、不可實盤、不可接真實券商 API。\n`, 'utf8');
  await fs.writeFile(READINESS, `# 自動交易落地狀態\n\n${output.readiness.reason}\n\n最新個股因子權重搜尋：月均 ${metrics.validationAverageMonthlyEquityReturnPct}%，最大回撤 ${metrics.validationMaximumDrawdownPct}%，交易 ${metrics.validationTrades} 筆。\n\n- Paper trading：${output.readiness.paperTradingAllowed ? '可進一步人工審核' : '不可'}\n- 實盤：不可\n- 券商 API 真實下單：不可\n`, 'utf8');
  if (NONLINEAR) {
    await appendExperiment({
      ...nonlinearExperiment,
      metrics,
      resultStatus: metrics.passedDeployable ? 'passed' : 'failed',
      failureReason: metrics.passedDeployable
        ? null
        : 'validation 月均、Profit Factor 與最大回撤未通過門檻',
      passedMinimum: metrics.passedDeployable,
      passedHighProfit: false,
      allowRetest: false
    });
  }
  console.log(JSON.stringify({
    output: OUTPUT.pathname,
    report: REPORT.pathname,
    metrics,
    conclusion: output.conclusion
  }, null, 2));
}

await main().catch(error => {
  console.error(error);
  process.exit(1);
});
