import fs from 'node:fs/promises';
import { decisionToOrderIntent } from '../lib/order-intent-generator.mjs';
import {
  deterministicScore,
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

const QUALITY = new URL('../../data/quality/financial-quality.json', import.meta.url);
const QUALITY_VALIDATION = new URL('../../data/quality/validation-report.json', import.meta.url);
const REVENUE = new URL('../../data/revenue/monthly-revenue.json', import.meta.url);
const REVENUE_VALIDATION = new URL('../../data/revenue/validation-report.json', import.meta.url);
const INSTITUTIONAL = new URL('../../data/institutional/institutional-trades.json', import.meta.url);
const MARGIN = new URL('../../data/margin/margin-trades.json', import.meta.url);
const OUTPUT = new URL('../../data/research/quality-hunter-v1.json', import.meta.url);
const REPORT = new URL('../../docs/QUALITY_HUNTER_V1.md', import.meta.url);
const READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);

const readJson = (url, fallback = null) => fs.readFile(url, 'utf8').then(JSON.parse).catch(error => {
  if (error.code === 'ENOENT') return fallback;
  throw error;
});

const families = [
  {
    id: 'revenue_eps_growth_breakout',
    name: '營收成長＋EPS 成長＋突破',
    variants: [20, 30, 50].flatMap(revenueYoy => [20, 50].map(epsYoy => ({
      id: `rev${revenueYoy}_eps${epsYoy}`,
      name: `營收 YoY>${revenueYoy}% 且 EPS YoY>${epsYoy}%`,
      filter: row => row.revenue.YoY > revenueYoy && row.quality.epsYoY > epsYoy
    })))
  },
  {
    id: 'revenue_margin_improvement',
    name: '營收成長＋毛利率改善',
    variants: [
      { id: 'gross_yoy', name: '營收加速＋毛利率 YoY 改善', filter: row => row.revenue.yoyAcceleration && row.quality.grossMarginYoYChange > 0 && row.quality.operatingMarginYoYChange > -1 },
      { id: 'gross_qoq', name: '營收加速＋毛利率 QoQ 改善', filter: row => row.revenue.yoyAcceleration && row.quality.grossMarginQoQChange > 0 && row.quality.operatingMarginQoQChange > -1 },
      { id: 'margin_streak', name: '毛利率與營益率連續改善', filter: row => row.quality.grossMarginImprovingStreak && row.quality.operatingMarginImprovingStreak && row.revenue.YoY > 10 }
    ]
  },
  {
    id: 'eps_turnaround_high_confirm',
    name: 'EPS 轉正／創高＋價格確認',
    variants: [
      { id: 'eps_turn_positive', name: 'EPS 由虧轉盈', filter: row => row.quality.epsTurnPositive && row.revenue.YoY > 0 },
      { id: 'eps_high4', name: 'EPS 創 4 季新高', filter: row => row.quality.epsHigh4 && row.revenue.YoY > 10 },
      { id: 'eps_high8', name: 'EPS 創 8 季新高', filter: row => row.quality.epsHigh8 && row.revenue.YoY > 10 }
    ]
  },
  {
    id: 'exclude_fake_growth',
    name: '排除假成長',
    variants: [
      { id: 'real_growth', name: '營收成長且 EPS／毛利／營益不惡化', filter: row => row.revenue.YoY > 20 && row.quality.epsYoY > 0 && row.quality.grossMarginYoYChange >= 0 && row.quality.operatingMarginYoYChange >= 0 }
    ]
  }
];

const entries = [
  { id: 'next_open', name: '公布後隔日開盤', filter: row => row.eventAge <= 5 },
  { id: 'breakout20', name: '突破 20 日高點', filter: row => row.observation.factors.breakout20 && row.observation.factors.volumeRatio20 >= 1.15 },
  { id: 'ma20_pullback', name: '回測 MA20 不破', filter: row => row.observation.factors.distanceMa20 >= -2 && row.observation.factors.distanceMa20 <= 2.5 && row.observation.factors.ma20Slope > 0 && row.observation.day.close > row.observation.day.open },
  { id: 'restrengthen', name: '整理後重新轉強', filter: row => row.observation.factors.return20 > 3 && row.observation.factors.return5 >= -6 && row.observation.factors.return5 <= 4 && row.observation.day.close > row.observation.prior.high }
];

const exits = [
  { id: 'ma20', name: '跌破 MA20', rewardRisk: 2, maxHoldingDays: 20, forced: row => row.observation.day.close < row.observation.ma20 },
  { id: 'entry_low', name: '跌破進場 K 低點', rewardRisk: 2, maxHoldingDays: 15, forced: (row, original) => row.observation.day.close < original.observation.day.low },
  { id: 'target15r', name: '1.5R 停利', rewardRisk: 1.5, maxHoldingDays: 12, forced: () => false },
  { id: 'target2r', name: '2R 停利', rewardRisk: 2, maxHoldingDays: 18, forced: () => false },
  { id: 'trailing', name: '移動停利', rewardRisk: null, maxHoldingDays: 25, trailing: { triggerPct: 6, lockPct: 2, givebackPct: 3 }, forced: () => false },
  { id: 'market_weak', name: '大盤轉弱出場', rewardRisk: 2, maxHoldingDays: 15, forced: row => ['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.observation.factors.regime) }
];

const topCounts = [3, 5, 10];
const configurations = family => family.variants.flatMap(variant => topCounts.flatMap(topCount => entries.flatMap(entry => exits.map(exit => ({
  id: `${variant.id}_top${topCount}_${entry.id}_${exit.id}`,
  name: `${variant.name}／Top ${topCount}／${entry.name}／${exit.name}`,
  family,
  variant,
  topCount,
  entry,
  exit
})))));

function aggregateByDate(records, fields) {
  const map = new Map();
  for (const row of records || []) {
    if (!row.isPointInTimeSafe || !row.effectiveDate) continue;
    const key = `${row.effectiveDate}|${row.symbol}`;
    const value = map.get(key) || Object.fromEntries(fields.map(field => [field, 0]));
    for (const field of fields) value[field] += Number(row[field]) || 0;
    map.set(key, value);
  }
  return map;
}

function buildThemeRanks(context) {
  const grouped = new Map();
  for (const [key, value] of context.themeReturns) {
    const split = key.indexOf('|');
    const date = key.slice(0, split);
    const theme = key.slice(split + 1);
    const list = grouped.get(date) || [];
    list.push({ theme, value: value.average });
    grouped.set(date, list);
  }
  const ranks = new Map();
  for (const [date, list] of grouped) {
    list.sort((left, right) => left.value - right.value);
    list.forEach((row, index) => ranks.set(`${date}|${row.theme}`, (index + 1) / list.length));
  }
  return ranks;
}

function latestSeries(records, keyField) {
  const bySymbol = new Map();
  for (const row of records.filter(value => value.isPointInTimeSafe && value.effectiveDate)) {
    const list = bySymbol.get(row.symbol) || [];
    list.push(row);
    bySymbol.set(row.symbol, list);
  }
  for (const list of bySymbol.values()) list.sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate) || String(left[keyField]).localeCompare(String(right[keyField])));
  return bySymbol;
}

function buildResearchRows(context, qualityRows, revenueRows, institutionalRows, marginRows, startDate, endDate) {
  const qualityBySymbol = latestSeries(qualityRows, 'quarter');
  const revenueBySymbol = latestSeries(revenueRows, 'revenueMonth');
  const symbols = new Set([...qualityBySymbol.keys()].filter(symbol => revenueBySymbol.has(symbol)));
  const flows = aggregateByDate(institutionalRows, ['foreignNetBuy', 'trustNetBuy', 'dealerNetBuy']);
  const margins = new Map((marginRows || []).filter(row => row.isPointInTimeSafe && row.effectiveDate).map(row => [`${row.effectiveDate}|${row.symbol}`, row]));
  const dates = context.marketHistory.map(row => row.date);
  const dateIndex = new Map(dates.map((date, index) => [date, index]));
  const themeRanks = buildThemeRanks(context);
  const qualityStates = new Map();
  const revenueStates = new Map();
  const rows = [];
  const byDateSymbol = new Map();
  iterateObservations(context, observation => {
    if (!symbols.has(observation.symbol)) return;
    const qualityList = qualityBySymbol.get(observation.symbol);
    const revenueList = revenueBySymbol.get(observation.symbol);
    const qualityState = qualityStates.get(observation.symbol) || { cursor: -1 };
    const revenueState = revenueStates.get(observation.symbol) || { cursor: -1 };
    while (qualityState.cursor + 1 < qualityList.length && qualityList[qualityState.cursor + 1].effectiveDate <= observation.date) qualityState.cursor += 1;
    while (revenueState.cursor + 1 < revenueList.length && revenueList[revenueState.cursor + 1].effectiveDate <= observation.date) revenueState.cursor += 1;
    qualityStates.set(observation.symbol, qualityState);
    revenueStates.set(observation.symbol, revenueState);
    const quality = qualityList[qualityState.cursor];
    const revenue = revenueList[revenueState.cursor];
    if (!quality || !revenue) return;
    const eventEffective = [quality.effectiveDate, revenue.effectiveDate].sort().at(-1);
    const eventAge = dateIndex.get(observation.date) - dateIndex.get(eventEffective);
    if (eventAge < 0 || eventAge > 70) return;
    if (!Number.isFinite(quality.EPS) || !Number.isFinite(revenue.YoY)) return;
    const factors = observation.factors;
    if (factors.transactionValue < 30_000_000
      || factors.atrPct > 8
      || factors.distanceMa20 < -6
      || factors.distanceMa20 > 10
      || Math.abs(factors.gapPct) > 5
      || !factors.marketAboveMa60
      || ['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(factors.regime)) return;
    const index = dateIndex.get(observation.date);
    const flow = { foreignNetBuy: 0, trustNetBuy: 0, dealerNetBuy: 0 };
    for (let offset = 0; offset < 5; offset += 1) {
      const value = flows.get(`${dates[index - offset]}|${observation.symbol}`);
      if (!value) continue;
      flow.foreignNetBuy += value.foreignNetBuy;
      flow.trustNetBuy += value.trustNetBuy;
      flow.dealerNetBuy += value.dealerNetBuy;
    }
    const margin = margins.get(`${observation.date}|${observation.symbol}`) || null;
    const institutionRatio = (flow.foreignNetBuy + flow.trustNetBuy) / Math.max(1, observation.day.volume);
    const themeRank = themeRanks.get(`${observation.date}|${observation.theme}`) || 0.5;
    const row = { observation, quality, revenue, eventAge, flow, margin, institutionRatio, themeRank };
    row.score = Math.min(80, Math.max(-40, revenue.YoY || 0)) * 0.25
      + Math.min(80, Math.max(-40, quality.epsYoY || 0)) * 0.35
      + Math.min(12, Math.max(-8, quality.grossMarginYoYChange || 0)) * 1.4
      + Math.min(12, Math.max(-8, quality.operatingMarginYoYChange || 0)) * 1.4
      + (quality.epsHigh4 ? 7 : 0)
      + (quality.epsHigh8 ? 9 : 0)
      + (quality.epsTurnPositive ? 8 : 0)
      + Math.min(10, observation.factors.relativeMarket20 * 0.6)
      + themeRank * 8
      + Math.min(8, Math.max(-8, institutionRatio * 100))
      + Math.min(6, Math.max(0, (observation.factors.volumeRatio20 - 1) * 4));
    rows.push(row);
    byDateSymbol.set(`${observation.date}|${observation.symbol}`, row);
  }, { startDate, endDate, symbols });
  const byDate = new Map();
  for (const row of rows) {
    const list = byDate.get(row.observation.date) || [];
    list.push(row);
    byDate.set(row.observation.date, list);
  }
  for (const list of byDate.values()) list.sort((left, right) => right.score - left.score);
  return { rows, byDate, byDateSymbol };
}

function tradable(row, family) {
  const factors = row.observation.factors;
  const common = factors.transactionValue >= 30_000_000
    && factors.atrPct <= 8
    && factors.distanceMa20 >= -6
    && factors.distanceMa20 <= 10
    && Math.abs(factors.gapPct) <= 5
    && factors.marketAboveMa60
    && !factors.longUpperWick
    && !['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(factors.regime)
    && !row.margin?.marginOverheated;
  if (!common) return false;
  if (family.id === 'revenue_eps_growth_breakout') return row.observation.day.close > row.observation.ma20 && row.observation.ma20 > row.observation.ma60;
  if (family.id === 'revenue_margin_improvement') return row.quality.grossMarginYoYChange > 0 && row.observation.factors.relativeMarket20 > -2;
  if (family.id === 'eps_turnaround_high_confirm') return row.observation.day.close >= row.observation.ma20 * 0.98;
  return row.quality.epsYoY > 0 && row.quality.grossMarginYoYChange >= 0 && row.quality.operatingMarginYoYChange >= 0;
}

function candidate(row, config, byDateSymbol) {
  const observation = row.observation;
  const support = Math.min(observation.day.low, observation.ma20, observation.priorHigh20 || observation.day.low);
  const stopDistancePct = Math.min(8, Math.max(2.5, (observation.nextOpen / Math.min(observation.nextOpen * 0.975, support) - 1) * 100));
  const bars = observation.futureBars.map(value => ({ ...value }));
  for (let index = 0; index + 1 < bars.length; index += 1) {
    const future = byDateSymbol.get(`${bars[index].date}|${observation.symbol}`);
    if (future && config.exit.forced(future, row)) {
      bars[index + 1].forcedExit = { price: bars[index + 1].open, reason: config.exit.name, type: config.exit.id };
      break;
    }
  }
  const setup = [config.family.name, config.variant.name, `財報季度 ${row.quality.quarter}`, `營收月份 ${row.revenue.revenueMonth}`];
  const trigger = [config.entry.name, '月營收與財報只在 effectiveDate 後使用'];
  const invalidation = [config.exit.name, '大盤轉弱或品質成長條件失效時不續抱'];
  const decision = {
    date: observation.nextDate,
    symbol: observation.symbol,
    action: 'BUY',
    strategyId: `quality_hunter_v1:${config.id}`,
    setup,
    trigger,
    invalidation,
    entryPlan: { referencePrice: observation.nextOpen, maximumAcceptablePrice: observation.nextOpen * 1.005, orderType: 'MARKETABLE_LIMIT', timeInForce: 'ROD', session: 'REGULAR' },
    riskPlan: { stopPrice: observation.nextOpen * (1 - stopDistancePct / 100), targetPrice: config.exit.rewardRisk ? observation.nextOpen * (1 + stopDistancePct * config.exit.rewardRisk / 100) : null, riskRewardRatio: config.exit.rewardRisk || 2, positionBudget: 100_000, riskBudget: 5_000 },
    reason: config.name,
    warnings: ['尚未通過 validation 前不可紙上交易或實盤', '財報公布時間採保守 T+1 假設']
  };
  return {
    signalDate: observation.date,
    entryDate: observation.nextDate,
    symbol: observation.symbol,
    name: observation.name,
    market: observation.market,
    regime: observation.factors.regime,
    atrPct: observation.factors.atrPct,
    score: row.score,
    futureBars: bars,
    stopDistancePct,
    rewardRisk: config.exit.rewardRisk,
    maxHoldingDays: config.exit.maxHoldingDays,
    trailingStopRule: config.exit.trailing,
    positionPct: Math.min(10, 80 / config.topCount),
    setup,
    trigger,
    invalidation,
    exitPlan: config.exit.name,
    reason: decision.reason,
    orderIntent: decisionToOrderIntent(decision, { account: { equity: 1_000_000, availableCash: 1_000_000 } })
  };
}

function signalMap(data, config, startDate, endDate) {
  const map = new Map();
  for (const [date, list] of data.byDate) {
    if (date < startDate || date > endDate) continue;
    const selected = list.filter(row => config.variant.filter(row) && tradable(row, config.family) && config.entry.filter(row)).slice(0, config.topCount);
    if (selected.length) map.set(date, selected.map(row => candidate(row, config, data.byDateSymbol)));
  }
  return map;
}

function randomMap(data, selectedMap, config, startDate, endDate) {
  const map = new Map();
  for (const [date, selected] of selectedMap) {
    if (date < startDate || date > endDate) continue;
    const pool = (data.byDate.get(date) || [])
      .filter(row => config.variant.filter(row) && tradable(row, config.family) && config.entry.filter(row))
      .sort((left, right) => deterministicScore(`${date}|${right.observation.symbol}`) - deterministicScore(`${date}|${left.observation.symbol}`));
    map.set(date, pool.slice(0, selected.length).map(row => candidate(row, config, data.byDateSymbol)));
  }
  return map;
}

function marketMonthly(context, startDate, endDate) {
  let prior;
  const closes = new Map();
  for (const row of context.marketHistory.filter(row => row.date <= endDate)) {
    if (row.date < startDate) prior = row.close;
    else closes.set(row.date.slice(0, 7), row.close);
  }
  const returns = [];
  for (const close of closes.values()) {
    if (prior) returns.push((close / prior - 1) * 100);
    prior = close;
  }
  return returns;
}

function objective(summary) {
  const pf = Number.isFinite(summary.profitFactor) ? Math.min(summary.profitFactor, 3) : 0;
  return summary.averageMonthlyEquityReturnPct * 6 + pf * 0.7 + summary.maximumDrawdownPct * 0.05 + Math.min(1, summary.trades / 300);
}

function combine(folds) {
  const trades = folds.flatMap(row => row.validation.trades);
  const monthly = folds.flatMap(row => row.validation.summary.monthly.map(value => value.equityReturnPct));
  const random = folds.flatMap(row => row.random.summary.monthly.map(value => value.equityReturnPct));
  const market = folds.flatMap(row => row.marketReturns);
  const gains = trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(trades.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
  const compounded = monthly.reduce((value, row) => value * (1 + row / 100), 1);
  const symbols = new Map();
  for (const trade of trades) symbols.set(trade.symbol, (symbols.get(trade.symbol) || 0) + 1);
  const averageMonthly = mean(monthly) || 0;
  const metrics = {
    validationTrades: trades.length,
    validationAverageMonthlyEquityReturnPct: round(averageMonthly),
    targetGapPct: round(10 - averageMonthly),
    validationAnnualizedReturnPct: round(monthly.length ? (compounded ** (12 / monthly.length) - 1) * 100 : 0),
    validationProfitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    validationMaximumDrawdownPct: round(Math.min(0, ...folds.map(row => row.validation.summary.maximumDrawdownPct))),
    validationWinRatePct: round(trades.filter(row => row.realizedPnl > 0).length / Math.max(1, trades.length) * 100),
    marketAverageMonthlyReturnPct: round(mean(market) || 0),
    randomAverageMonthlyReturnPct: round(mean(random) || 0),
    concentrationPct: round(trades.length ? Math.max(...symbols.values()) / trades.length * 100 : 100),
    orderIntents: trades.filter(row => row.orderIntent).length,
    supportedActions: ['BUY', 'SELL', 'HOLD', 'SKIP']
  };
  metrics.checks = {
    tradeCount: metrics.validationTrades > 300,
    beatsMarket: metrics.validationAverageMonthlyEquityReturnPct > metrics.marketAverageMonthlyReturnPct,
    beatsRandom: metrics.validationAverageMonthlyEquityReturnPct > metrics.randomAverageMonthlyReturnPct,
    profitFactor: metrics.validationProfitFactor > 1.15,
    drawdown: metrics.validationMaximumDrawdownPct > -20,
    diversified: metrics.concentrationPct < 20,
    positiveAfterCosts: metrics.validationAverageMonthlyEquityReturnPct > 0,
    actionsAndIntents: metrics.orderIntents === trades.length
  };
  metrics.passed = Object.values(metrics.checks).every(Boolean);
  metrics.highProfit = metrics.passed && metrics.validationAverageMonthlyEquityReturnPct > 2 && metrics.validationProfitFactor > 1.3 && metrics.validationAnnualizedReturnPct > 30;
  return metrics;
}

function registryInput(family, range, metrics = null) {
  return {
    strategyId: `quality_hunter_v1_${family.id}`,
    dataSources: ['daily_ohlcv', 'monthly_revenue_conservative_t_plus_1', 'financial_quality_conservative_t_plus_1', 'institutional_point_in_time_t_plus_1_optional', 'margin_point_in_time_t_plus_1_optional'],
    setupRules: family.variants.map(row => row.name),
    triggerRules: entries.map(row => row.name),
    invalidationRules: ['跌破 MA20 或進場 K 低點', '大盤轉弱', '融資過熱', '營收或財報尚未生效'],
    exitRules: exits.map(row => row.name),
    riskRules: ['單筆風險 0.5%', '單檔最多 10%', 'T+2', '集中持股 Top 3／5／10'],
    blockedWhen: ['跳空過大', 'ATR 過高', '離 MA20 過遠', '大盤跌破 MA60', '長上影線', '假成長'],
    parameters: { configurations: configurations(family).map(row => row.id), range },
    trainPeriod: { months: 36 },
    validationPeriod: { months: 12, stepMonths: 12 },
    costModel: { buyFeePct: 0.1425, sellFeePct: 0.1425, sellTaxPct: 0.3, slippagePct: 0.15 },
    executionModel: { entry: 'next_open_market', settlement: 'T+2', simulator: 'shared' },
    metrics,
    resultStatus: metrics ? (metrics.passed ? 'passed' : 'failed') : 'inconclusive',
    failureReason: metrics?.passed ? null : 'Validation 未達完整門檻。',
    passedMinimum: metrics?.passed === true,
    passedHighProfit: metrics?.highProfit === true,
    allowRetest: false,
    coreRulesChanged: true,
    notes: `Quality Hunter v1：${family.name}`
  };
}

async function runFamily(family, data, context, range, folds) {
  const identity = buildExperimentIdentity(registryInput(family, range));
  const registry = await loadRegistry();
  const precheck = shouldSkipExperiment(registry, identity, registryInput(family, range));
  if (precheck.skip) {
    const previous = registry.experiments.find(row => row.experimentHash === identity.experimentHash);
    return {
      id: family.id,
      name: family.name,
      status: previous?.metrics ? 'COMPLETED' : 'SKIPPED',
      skippedDuplicate: true,
      reason: precheck.reason,
      configurationsEvaluated: 0,
      selectedStrategies: ['沿用相同 experimentHash 的既有 validation 結果'],
      metrics: previous?.metrics || null,
      folds: []
    };
  }
  const configs = configurations(family);
  const results = [];
  for (const fold of folds) {
    let best;
    for (const config of configs) {
      const train = simulateSignalMap(context, signalMap(data, config, fold.trainStart, fold.trainEnd), {
        startDate: fold.trainStart,
        endDate: fold.trainEnd,
        strategyId: `quality:${config.id}`,
        maxOpenPositions: Math.min(config.topCount, 6)
      });
      const score = objective(train.summary);
      if (!best || score > best.score) best = { config, score, summary: train.summary };
    }
    const selected = signalMap(data, best.config, fold.validationStart, fold.validationEnd);
    const validation = simulateSignalMap(context, selected, {
      startDate: fold.validationStart,
      endDate: fold.validationEnd,
      strategyId: `quality:${best.config.id}`,
      maxOpenPositions: Math.min(best.config.topCount, 6)
    });
    const random = simulateSignalMap(context, randomMap(data, selected, best.config, fold.validationStart, fold.validationEnd), {
      startDate: fold.validationStart,
      endDate: fold.validationEnd,
      strategyId: `quality:${best.config.id}:fair_random`,
      maxOpenPositions: Math.min(best.config.topCount, 6)
    });
    results.push({ ...fold, selectedConfig: best.config, trainSummary: best.summary, validation, random, marketReturns: marketMonthly(context, fold.validationStart, fold.validationEnd) });
    console.log(`${family.name} ${fold.validationStart}：${best.config.name}，交易 ${validation.summary.trades} 筆。`);
  }
  const metrics = combine(results);
  await appendExperiment(registryInput(family, range, metrics));
  return {
    id: family.id,
    name: family.name,
    status: 'COMPLETED',
    experiment: identity,
    configurationsEvaluated: configs.length,
    metrics,
    selectedStrategies: [...new Set(results.map(row => row.selectedConfig.name))],
    folds: results.map(row => ({
      trainStart: row.trainStart,
      trainEnd: row.trainEnd,
      validationStart: row.validationStart,
      validationEnd: row.validationEnd,
      selectedConfig: row.selectedConfig.name,
      trainSummary: row.trainSummary,
      validationSummary: row.validation.summary,
      randomSummary: row.random.summary
    }))
  };
}

const [quality, qualityValidation, revenue, revenueValidation, institutional, margin] = await Promise.all([
  readJson(QUALITY, { records: [] }),
  readJson(QUALITY_VALIDATION, { status: 'MISSING_DATA' }),
  readJson(REVENUE, { records: [] }),
  readJson(REVENUE_VALIDATION, { status: 'MISSING_DATA' }),
  readJson(INSTITUTIONAL, { records: [] }),
  readJson(MARGIN, { records: [] })
]);

if (qualityValidation.status !== 'VALID' || revenueValidation.status !== 'VALID') {
  const conclusion = '獲利品質或月營收資料不足，Quality Hunter 未產生假績效。';
  await fs.writeFile(OUTPUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), status: 'DATA_MISSING', qualityValidation, revenueValidation, conclusion }, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# Quality Hunter v1\n\n${conclusion}\n`, 'utf8');
  console.log(conclusion);
} else {
  const context = await loadResearchContext();
  const effectiveDates = [...new Set(quality.records.map(row => row.effectiveDate))].sort();
  const range = { start: effectiveDates[0], end: [effectiveDates.at(-1), context.endDate].sort()[0] };
  const folds = foldWindows(range.start, range.end, 36, 12);
  const data = buildResearchRows(context, quality.records, revenue.records, institutional.records, margin.records, range.start, range.end);
  const familyResults = [];
  for (const family of families) familyResults.push(await runFamily(family, data, context, range, folds));
  const completed = familyResults.filter(row => row.status === 'COMPLETED' && row.metrics);
  const best = completed.sort((left, right) => right.metrics.validationAverageMonthlyEquityReturnPct - left.metrics.validationAverageMonthlyEquityReturnPct)[0] || null;
  const passed = completed.filter(row => row.metrics.passed);
  const highProfit = completed.filter(row => row.metrics.highProfit);
  const conclusion = best
    ? (passed.length
      ? `${best.name} 通過最低 validation，可進入後續紙上交易評估，但不可直接實盤。`
      : `沒有策略通過 validation；目前最接近的是 ${best.name}，月均 ${best.metrics.validationAverageMonthlyEquityReturnPct}%，距離 10% 還差 ${best.metrics.targetGapPct} 個百分點。`)
    : '沒有可用 Quality Hunter 回測結果。';
  const result = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    status: completed.length ? 'COMPLETED' : 'NO_VALID_BACKTEST',
    data: {
      qualityRecords: quality.records.length,
      qualitySymbols: qualityValidation.symbols,
      qualityQuarters: qualityValidation.quarters,
      qualityPointInTimeSafe: qualityValidation.pointInTimeSafeRecords,
      revenueRecords: revenue.records.length,
      researchRows: data.rows.length
    },
    search: {
      families: families.length,
      variants: families.reduce((sum, family) => sum + family.variants.length, 0),
      configurations: families.reduce((sum, family) => sum + configurations(family).length, 0),
      topCounts,
      entries: entries.map(row => row.name),
      exits: exits.map(row => row.name)
    },
    walkForward: { trainMonths: 36, validationMonths: 12, stepMonths: 12, folds: folds.length },
    familyResults,
    bestStrategy: best ? { family: best.name, selectedStrategies: best.selectedStrategies, metrics: best.metrics } : null,
    readiness: { paperTradingAllowed: passed.length > 0, liveTradingAllowed: false, realBrokerAllowed: false, highProfitCandidates: highProfit.map(row => row.name) },
    conclusion
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const rows = completed.map(row => `| ${row.name} | ${row.metrics.validationTrades} | ${row.metrics.validationAverageMonthlyEquityReturnPct}% | ${row.metrics.validationAnnualizedReturnPct}% | ${row.metrics.validationProfitFactor} | ${row.metrics.validationMaximumDrawdownPct}% | ${row.metrics.validationWinRatePct}% | ${row.metrics.passed ? '通過' : '未通過'} |`).join('\n');
  await fs.writeFile(REPORT, `# Quality Hunter v1\n\n${conclusion}\n\n| 策略家族 | 交易數 | 月均報酬 | 年化 | PF | 最大回撤 | 勝率 | 結果 |\n|---|---:|---:|---:|---:|---:|---:|---|\n${rows}\n\n- 資料：${qualityValidation.symbols} 檔、${qualityValidation.quarters} 季，財報採保守 T+1。\n- 測試：${result.search.families} 個家族、${result.search.configurations} 組設定。\n- 未通過 validation 的策略不可紙上交易、不可實盤、不可接券商 API。\n`, 'utf8');
  await fs.writeFile(READINESS, `# 自動交易落地判斷\n\n更新時間：${result.generatedAt}\n\n- Quality Hunter：${conclusion}\n- 可紙上交易：${passed.length ? `需人工再驗收：${passed.map(row => row.name).join('、')}` : '不可'}\n- 可實盤：不可\n- 可接真實券商 API：不可\n\n下一步：${passed.length ? '先做 paper trading dry-run 與人工驗收。' : '單靠 OHLCV、法人、族群、融資券、月營收與財報品質仍未找到可用策略；下一步應補「財報精確公布日、財報細項、法人持股比例、主力/分點或分鐘級成交資料」，或轉向事件驅動／盤中流動性策略。'}\n`, 'utf8');
  console.log(conclusion);
}
