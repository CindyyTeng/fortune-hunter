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

const INSTITUTIONAL = new URL('../../data/institutional/institutional-trades.json', import.meta.url);
const SECTORS = new URL('../../data/sector/sector-classification.json', import.meta.url);
const REVENUE = new URL('../../data/revenue/monthly-revenue.json', import.meta.url);
const QUALITY = new URL('../../data/quality/financial-quality.json', import.meta.url);
const OUTPUT = new URL('../../data/research/edge-rotation-hunter-v1.json', import.meta.url);
const REPORT = new URL('../../docs/EDGE_ROTATION_HUNTER_V1.md', import.meta.url);
const READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);

const readJson = (url, fallback = null) => fs.readFile(url, 'utf8').then(JSON.parse).catch(error => {
  if (error.code === 'ENOENT') return fallback;
  throw error;
});

const rank = (sorted, value) => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return sorted.length ? low / sorted.length : 0;
};

function aggregateByEffectiveDate(records, fields) {
  const map = new Map();
  for (const row of records || []) {
    if (row.isPointInTimeSafe !== true || !row.effectiveDate) continue;
    const key = `${row.effectiveDate}|${row.symbol}`;
    const value = map.get(key) || Object.fromEntries(fields.map(field => [field, 0]));
    for (const field of fields) value[field] += Number(row[field]) || 0;
    map.set(key, value);
  }
  return map;
}

function latestSeries(records, keyField) {
  const bySymbol = new Map();
  for (const row of records || []) {
    if (!row.isPointInTimeSafe || !row.effectiveDate) continue;
    const list = bySymbol.get(row.symbol) || [];
    list.push(row);
    bySymbol.set(row.symbol, list);
  }
  for (const list of bySymbol.values()) {
    list.sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate) || String(left[keyField]).localeCompare(String(right[keyField])));
  }
  return bySymbol;
}

function buildSectorMetrics(context, sectorBySymbol, startDate, endDate) {
  const groups = new Map();
  iterateObservations(context, observation => {
    const sector = sectorBySymbol.get(observation.symbol);
    if (!sector) return;
    const key = `${observation.date}|${sector.sectorCode}`;
    const value = groups.get(key) || { date: observation.date, code: sector.sectorCode, name: sector.sectorName, count: 0, return5: 0, return20: 0, advancers: 0, highs: 0, valueRatio: 0 };
    value.count += 1;
    value.return5 += observation.factors.return5;
    value.return20 += observation.factors.return20;
    value.advancers += observation.day.close > observation.prior.close ? 1 : 0;
    value.highs += observation.factors.breakout20 ? 1 : 0;
    value.valueRatio += observation.factors.volumeRatio20 || 0;
    groups.set(key, value);
  }, { startDate, endDate });
  const byDate = new Map();
  for (const value of groups.values()) {
    const item = {
      code: value.code,
      name: value.name,
      constituents: value.count,
      return5: value.return5 / value.count,
      return20: value.return20 / value.count,
      advancersRatio: value.advancers / value.count,
      newHighRatio: value.highs / value.count,
      transactionValueChange: value.valueRatio / value.count - 1
    };
    item.score = item.return20 * 0.55 + item.return5 * 0.25 + item.advancersRatio * 6 + item.newHighRatio * 8 + Math.max(-1, Math.min(2, item.transactionValueChange));
    const list = byDate.get(value.date) || [];
    list.push(item);
    byDate.set(value.date, list);
  }
  const output = new Map();
  for (const [date, list] of byDate) {
    const scores = list.map(row => row.score).sort((a, b) => a - b);
    for (const row of list) {
      row.rank = rank(scores, row.score);
      row.top20 = row.rank >= 0.8;
      output.set(`${date}|${row.code}`, row);
    }
  }
  return output;
}

function buildRows(context, institutionalRows, sectorRows, revenueRows, qualityRows, startDate, endDate) {
  const sectorBySymbol = new Map((sectorRows || []).map(row => [row.symbol, row]));
  const sectors = buildSectorMetrics(context, sectorBySymbol, startDate, endDate);
  const institutions = aggregateByEffectiveDate(institutionalRows, ['foreignNetBuy', 'trustNetBuy', 'dealerNetBuy']);
  const revenueBySymbol = latestSeries(revenueRows, 'revenueMonth');
  const qualityBySymbol = latestSeries(qualityRows, 'quarter');
  const marketDates = context.marketHistory.map(row => row.date);
  const marketIndex = new Map(marketDates.map((date, index) => [date, index]));
  const revenueState = new Map();
  const qualityState = new Map();
  const byDate = new Map();
  const addTopRow = row => {
    const date = row.observation.date;
    const list = byDate.get(date) || [];
    if (list.length < 80) {
      list.push(row);
    } else {
      let worst = 0;
      for (let index = 1; index < list.length; index += 1) {
        if (list[index].baseScore < list[worst].baseScore) worst = index;
      }
      if (row.baseScore <= list[worst].baseScore) return;
      list[worst] = row;
    }
    byDate.set(date, list);
  };
  iterateObservations(context, observation => {
    const sector = sectorBySymbol.get(observation.symbol);
    const sectorMetric = sector && sectors.get(`${observation.date}|${sector.sectorCode}`);
    if (!sectorMetric) return;
    const index = marketIndex.get(observation.date);
    const market60 = index >= 60 ? (context.marketHistory[index].close / context.marketHistory[index - 60].close - 1) * 100 : 0;
    const flow = { foreignNetBuy: 0, trustNetBuy: 0, dealerNetBuy: 0 };
    for (let offset = 0; offset < 5; offset += 1) {
      const value = institutions.get(`${marketDates[index - offset]}|${observation.symbol}`);
      if (!value) continue;
      flow.foreignNetBuy += value.foreignNetBuy;
      flow.trustNetBuy += value.trustNetBuy;
      flow.dealerNetBuy += value.dealerNetBuy;
    }
    const revList = revenueBySymbol.get(observation.symbol) || [];
    const qList = qualityBySymbol.get(observation.symbol) || [];
    const revCursor = revenueState.get(observation.symbol) || { index: -1 };
    const qCursor = qualityState.get(observation.symbol) || { index: -1 };
    while (revCursor.index + 1 < revList.length && revList[revCursor.index + 1].effectiveDate <= observation.date) revCursor.index += 1;
    while (qCursor.index + 1 < qList.length && qList[qCursor.index + 1].effectiveDate <= observation.date) qCursor.index += 1;
    revenueState.set(observation.symbol, revCursor);
    qualityState.set(observation.symbol, qCursor);
    const revenue = revList[revCursor.index] || null;
    const quality = qList[qCursor.index] || null;
    const institutionRatio = (flow.foreignNetBuy + flow.trustNetBuy) / Math.max(1, observation.day.volume);
    const f = observation.factors;
    const strongRegime = ['BULL_TREND', 'THEME_MOMENTUM', 'BULL_PULLBACK'].includes(f.regime) && f.marketAboveMa60 && f.marketReturn20 > -2;
    const row = {
      observation,
      sector: sectorMetric,
      flow,
      revenue,
      quality,
      institutionRatio,
      relative60: f.return60 - market60,
      strongRegime
    };
    row.qualityScore = (Number.isFinite(quality?.epsYoY) ? Math.min(80, Math.max(-40, quality.epsYoY)) * 0.15 : 0)
      + (Number.isFinite(quality?.grossMarginYoYChange) ? Math.min(8, Math.max(-6, quality.grossMarginYoYChange)) * 1.2 : 0)
      + (quality?.epsHigh4 ? 5 : 0)
      + (quality?.epsHigh8 ? 6 : 0);
    row.revenueScore = (Number.isFinite(revenue?.YoY) ? Math.min(80, Math.max(-40, revenue.YoY)) * 0.12 : 0)
      + (revenue?.yoyAcceleration ? 5 : 0)
      + (revenue?.revenueHigh12 ? 4 : 0);
    row.baseScore = f.relativeMarket20 * 1.2
      + row.relative60 * 0.5
      + sectorMetric.rank * 22
      + (sectorMetric.top20 ? 10 : 0)
      + (flow.foreignNetBuy > 0 && flow.trustNetBuy > 0 ? 8 : 0)
      + Math.min(8, Math.max(-8, institutionRatio * 100))
      + Math.min(10, Math.max(0, (f.volumeRatio20 - 1) * 5))
      + (f.breakout20 ? 8 : 0)
      + (f.distanceMa20 >= -2 && f.distanceMa20 <= 2.5 && f.ma20Slope > 0 ? 6 : 0)
      + row.qualityScore
      + row.revenueScore
      - Math.max(0, f.atrPct - 5) * 3
      - Math.max(0, Math.abs(f.gapPct) - 3) * 3;
    if (baseTradable(row) || row.baseScore > 30) addTopRow(row);
  }, { startDate, endDate });
  const byDateSymbol = new Map();
  const rows = [];
  for (const [date, list] of byDate) {
    list.sort((left, right) => right.baseScore - left.baseScore);
    list.forEach((row, index) => {
      row.dailyRank = index + 1;
      byDateSymbol.set(`${date}|${row.observation.symbol}`, row);
      rows.push(row);
    });
  }
  return { rows, byDate, byDateSymbol };
}

const families = [
  {
    id: 'broad_bull_leader_rotation',
    name: '多頭廣域領漲輪動',
    filter: row => row.strongRegime && row.sector.rank >= 0.6 && row.observation.factors.relativeMarket20 > 0 && row.observation.factors.transactionValue >= 30_000_000,
    scoreBoost: row => row.baseScore + row.observation.factors.relativeMarket20 * 0.5
  },
  {
    id: 'liquid_momentum_rotation',
    name: '高成交值動能輪動',
    filter: row => row.strongRegime && row.observation.factors.transactionValuePercentile >= 0.75 && row.observation.factors.return20 > 0 && row.observation.factors.ma20AboveMa60,
    scoreBoost: row => row.baseScore + row.observation.factors.transactionValuePercentile * 10
  },
  {
    id: 'full_exposure_leader_rotation',
    name: '強勢盤滿曝險領漲輪動',
    filter: row => row.strongRegime && row.sector.top20 && row.observation.factors.relativeMarket20 > 3 && row.observation.factors.transactionValue >= 50_000_000,
    scoreBoost: row => row.baseScore
  },
  {
    id: 'post_event_leader_confirmation',
    name: '成長事件後領漲確認',
    filter: row => row.strongRegime && row.sector.rank >= 0.7 && ((row.revenue?.YoY > 20 && row.revenue?.yoyAcceleration) || row.quality?.epsHigh4 || row.quality?.epsHigh8) && row.observation.factors.relativeMarket20 > 0,
    scoreBoost: row => row.baseScore + row.qualityScore + row.revenueScore
  },
  {
    id: 'fresh_high_momentum',
    name: '強勢族群創高動能',
    filter: row => row.strongRegime && row.sector.top20 && row.observation.factors.breakout20 && row.observation.factors.volumeRatio20 >= 1.2,
    scoreBoost: row => row.baseScore + 8
  },
  {
    id: 'leader_pullback_reentry',
    name: '領漲股回測 MA20 再進場',
    filter: row => row.strongRegime && row.sector.rank >= 0.75 && row.observation.factors.return60 > 8 && row.observation.factors.distanceMa20 >= -2 && row.observation.factors.distanceMa20 <= 2.5,
    scoreBoost: row => row.baseScore + 5
  }
];

const entryModes = [
  { id: 'rank_next_open', name: '進榜隔日開盤', filter: () => true },
  { id: 'breakout_confirm', name: '突破確認', filter: row => row.observation.factors.breakout20 },
  { id: 'pullback_turn', name: '回測轉強', filter: row => row.observation.factors.distanceMa20 >= -2 && row.observation.factors.distanceMa20 <= 2.5 && row.observation.day.close > row.observation.day.open },
  { id: 'volume_restrengthen', name: '放量重新轉強', filter: row => row.observation.factors.volumeRatio20 >= 1.25 && row.observation.day.close > row.observation.prior.high }
];

const exitModes = [
  { id: 'rank_drop_ma20', name: '跌出前 30 或跌破 MA20', rewardRisk: 2, maxHoldingDays: 15, forced: row => row.dailyRank > 30 || row.observation.day.close < row.observation.ma20 },
  { id: 'rank_drop_market_weak', name: '跌出前 30 或大盤轉弱', rewardRisk: 2, maxHoldingDays: 15, forced: row => row.dailyRank > 30 || !row.strongRegime },
  { id: 'trailing_fast', name: '快速移動停利', rewardRisk: 1.5, maxHoldingDays: 12, trailing: { triggerPct: 4, lockPct: 1, givebackPct: 2.5 }, forced: row => !row.strongRegime },
  { id: 'trailing_wide', name: '寬鬆移動停利', rewardRisk: 2, maxHoldingDays: 20, trailing: { triggerPct: 6, lockPct: 2, givebackPct: 4 }, forced: row => row.observation.day.close < row.observation.ma20 }
];

const topCounts = [5, 8, 10];
const configurations = families.flatMap(family => topCounts.flatMap(topCount => entryModes.flatMap(entry => exitModes.map(exit => ({
  id: `${family.id}_top${topCount}_${entry.id}_${exit.id}`,
  name: `${family.name}／Top ${topCount}／${entry.name}／${exit.name}`,
  family,
  topCount,
  entry,
  exit
})))));

function baseTradable(row) {
  const f = row.observation.factors;
  return f.transactionValue >= 30_000_000
    && f.atrPct <= 7
    && Math.abs(f.gapPct) <= 5
    && f.distanceMa20 >= -5
    && f.distanceMa20 <= 10
    && !f.longUpperWick
    && row.strongRegime;
}

function candidate(row, config, byDateSymbol) {
  const observation = row.observation;
  const support = Math.min(observation.day.low, observation.ma20, observation.priorHigh20 || observation.day.low);
  const stopDistancePct = Math.min(7, Math.max(2.2, (observation.nextOpen / Math.min(observation.nextOpen * 0.98, support) - 1) * 100));
  const bars = observation.futureBars.map(value => ({ ...value }));
  for (let index = 0; index + 1 < bars.length; index += 1) {
    const futureRow = byDateSymbol.get(`${bars[index].date}|${observation.symbol}`);
    if (futureRow && config.exit.forced(futureRow, row)) {
      bars[index + 1].forcedExit = { price: bars[index + 1].open, reason: config.exit.name, type: config.exit.id };
      break;
    }
  }
  const setup = [config.family.name, `排名 ${row.dailyRank}`, `產業強度 ${round(row.sector.rank * 100, 1)}%`, `分數 ${round(row.score, 2)}`];
  const trigger = [config.entry.name, 'T 日收盤確認，T+1 以共用成交模擬器進場'];
  const invalidation = [config.exit.name, '大盤不再強勢或跌出強勢排名就降曝險'];
  const decision = {
    date: observation.nextDate,
    symbol: observation.symbol,
    action: 'BUY',
    strategyId: `edge_rotation_hunter_v1:${config.id}`,
    setup,
    trigger,
    invalidation,
    entryPlan: { referencePrice: observation.nextOpen, maximumAcceptablePrice: observation.nextOpen * 1.005, orderType: 'MARKETABLE_LIMIT', timeInForce: 'ROD', session: 'REGULAR' },
    riskPlan: { stopPrice: observation.nextOpen * (1 - stopDistancePct / 100), targetPrice: observation.nextOpen * (1 + stopDistancePct * config.exit.rewardRisk / 100), riskRewardRatio: config.exit.rewardRisk, positionBudget: 90_000, riskBudget: 5_000 },
    reason: `${config.name} 條件成立`,
    warnings: ['策略尚未通過 validation 前不可紙上交易或實盤', '產業分類仍是現行靜態分類']
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
    positionPct: 9,
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
    const selected = list
      .filter(row => baseTradable(row) && config.family.filter(row) && config.entry.filter(row))
      .map(row => ({ ...row, score: config.family.scoreBoost(row) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, config.topCount);
    if (selected.length) map.set(date, selected.map(row => candidate(row, config, data.byDateSymbol)));
  }
  return map;
}

function randomMap(data, selectedMap, config, startDate, endDate) {
  const map = new Map();
  for (const [date, selected] of selectedMap) {
    if (date < startDate || date > endDate) continue;
    const pool = (data.byDate.get(date) || [])
      .filter(row => baseTradable(row) && config.family.filter(row) && config.entry.filter(row))
      .sort((left, right) => deterministicScore(`${date}|${right.observation.symbol}`) - deterministicScore(`${date}|${left.observation.symbol}`));
    map.set(date, pool.slice(0, selected.length).map(row => candidate(row, config, data.byDateSymbol)));
  }
  return map;
}

function marketMonthly(context, startDate, endDate) {
  let prior;
  const ends = new Map();
  for (const row of context.marketHistory.filter(row => row.date <= endDate)) {
    if (row.date < startDate) prior = row.close;
    else ends.set(row.date.slice(0, 7), row.close);
  }
  const returns = [];
  for (const close of ends.values()) {
    if (prior) returns.push((close / prior - 1) * 100);
    prior = close;
  }
  return returns;
}

function objective(summary) {
  const pf = Number.isFinite(summary.profitFactor) ? Math.min(summary.profitFactor, 3) : 0;
  return summary.averageMonthlyEquityReturnPct * 7 + pf * 0.8 + summary.maximumDrawdownPct * 0.06 + Math.min(1, summary.trades / 300);
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
  metrics.nearTenPercent = metrics.validationAverageMonthlyEquityReturnPct >= 8;
  return metrics;
}

function registryInput(range, metrics = null) {
  return {
    strategyId: 'edge_rotation_hunter_v1',
    dataSources: ['daily_ohlcv', 'institutional_point_in_time_t_plus_1', 'sector_static_current_classification_v1', 'monthly_revenue_optional', 'financial_quality_optional'],
    setupRules: families.map(row => row.name),
    triggerRules: entryModes.map(row => row.name),
    invalidationRules: ['大盤不再強勢', '跌出前 30', '跌破 MA20', '移動停利'],
    exitRules: exitModes.map(row => row.name),
    riskRules: ['單筆風險 0.5%', '單檔最多約 9%', '強勢盤最多 80% 曝險', '弱勢盤空手', 'T+2'],
    blockedWhen: ['大盤低於 MA60', '非強勢市場狀態', 'ATR 過高', '跳空過大', '長上影線'],
    parameters: { configurations: configurations.map(row => row.id), range, fullExposure: true },
    trainPeriod: { months: 36 },
    validationPeriod: { months: 12, stepMonths: 12 },
    costModel: { buyFeePct: 0.1425, sellFeePct: 0.1425, sellTaxPct: 0.3, slippagePct: 0.15 },
    executionModel: { entry: 'next_open_market', settlement: 'T+2', simulator: 'shared' },
    metrics,
    resultStatus: metrics ? (metrics.passed ? 'passed' : 'failed') : 'inconclusive',
    failureReason: metrics?.passed ? null : 'Validation 未達完整門檻。',
    passedMinimum: metrics?.passed === true,
    passedHighProfit: metrics?.nearTenPercent === true && metrics?.passed === true,
    allowRetest: false,
    coreRulesChanged: true,
    notes: 'Edge Rotation Hunter v1：強勢盤滿曝險輪動，弱勢盤空手。'
  };
}

async function main() {
  const [institutional, sectors, revenue, quality] = await Promise.all([
    readJson(INSTITUTIONAL, { records: [] }),
    readJson(SECTORS, { records: [] }),
    readJson(REVENUE, { records: [] }),
    readJson(QUALITY, { records: [] })
  ]);
  const dates = [...new Set((institutional.records || []).filter(row => row.isPointInTimeSafe && row.effectiveDate).map(row => row.effectiveDate))].sort();
  const context = await loadResearchContext();
  const range = { start: dates[0] || context.startDate, end: [dates.at(-1) || context.endDate, context.endDate].sort()[0] };
  const folds = foldWindows(range.start, range.end, 36, 12);
  const identity = buildExperimentIdentity(registryInput(range));
  const precheck = shouldSkipExperiment(await loadRegistry(), identity, registryInput(range));
  if (precheck.skip) {
    const registry = await loadRegistry();
    const previous = registry.experiments.find(row => row.experimentHash === identity.experimentHash);
    const report = {
      generatedAt: new Date().toISOString(),
      status: previous?.metrics ? 'COMPLETED_FROM_REGISTRY' : 'SKIPPED',
      reason: precheck.reason,
      bestStrategy: previous?.metrics ? { metrics: previous.metrics } : null,
      conclusion: previous?.metrics ? '沿用相同 experimentHash 的既有 validation 結果。' : '策略已被 registry 跳過。'
    };
    await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(report.conclusion);
    return;
  }
  const data = buildRows(context, institutional.records || [], sectors.records || [], revenue.records || [], quality.records || [], range.start, range.end);
  const foldResults = [];
  for (const fold of folds) {
    let best;
    for (const config of configurations) {
      const train = simulateSignalMap(context, signalMap(data, config, fold.trainStart, fold.trainEnd), {
        startDate: fold.trainStart,
        endDate: fold.trainEnd,
        strategyId: `edge:${config.id}`,
        maxOpenPositions: config.topCount
      });
      const score = objective(train.summary);
      if (!best || score > best.score) best = { config, score, summary: train.summary };
    }
    const selected = signalMap(data, best.config, fold.validationStart, fold.validationEnd);
    const validation = simulateSignalMap(context, selected, {
      startDate: fold.validationStart,
      endDate: fold.validationEnd,
      strategyId: `edge:${best.config.id}`,
      maxOpenPositions: best.config.topCount
    });
    const random = simulateSignalMap(context, randomMap(data, selected, best.config, fold.validationStart, fold.validationEnd), {
      startDate: fold.validationStart,
      endDate: fold.validationEnd,
      strategyId: `edge:${best.config.id}:fair_random`,
      maxOpenPositions: best.config.topCount
    });
    foldResults.push({ ...fold, selectedConfig: best.config, trainSummary: best.summary, validation, random, marketReturns: marketMonthly(context, fold.validationStart, fold.validationEnd) });
    console.log(`${fold.validationStart}：${best.config.name}，交易 ${validation.summary.trades} 筆。`);
  }
  const metrics = combine(foldResults);
  await appendExperiment(registryInput(range, metrics));
  const passed = metrics.passed;
  const report = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    status: 'COMPLETED',
    data: {
      institutionalDates: dates.length,
      sectorPointInTimeSafe: false,
      revenueRecords: revenue.records?.length || 0,
      qualityRecords: quality.records?.length || 0,
      researchRows: data.rows.length
    },
    search: { configurations: configurations.length, families: families.map(row => row.name), topCounts, entries: entryModes.map(row => row.name), exits: exitModes.map(row => row.name) },
    walkForward: { trainMonths: 36, validationMonths: 12, stepMonths: 12, folds: folds.length },
    bestStrategy: {
      selectedStrategies: [...new Set(foldResults.map(row => row.selectedConfig.name))],
      metrics
    },
    readiness: { paperTradingAllowed: passed, liveTradingAllowed: false, realBrokerAllowed: false },
    conclusion: passed
      ? 'Edge Rotation Hunter v1 通過最低 validation，但仍只能進入人工驗收與紙上交易，不可直接實盤。'
      : `沒有策略通過 validation；Edge Rotation Hunter v1 月均 ${metrics.validationAverageMonthlyEquityReturnPct}%，距離 10% 還差 ${metrics.targetGapPct} 個百分點。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# Edge Rotation Hunter v1\n\n${report.conclusion}\n\n| 交易數 | 月均報酬 | 年化 | PF | 最大回撤 | 勝率 | 大盤月均 | 隨機月均 |\n|---:|---:|---:|---:|---:|---:|---:|---:|\n| ${metrics.validationTrades} | ${metrics.validationAverageMonthlyEquityReturnPct}% | ${metrics.validationAnnualizedReturnPct}% | ${metrics.validationProfitFactor} | ${metrics.validationMaximumDrawdownPct}% | ${metrics.validationWinRatePct}% | ${metrics.marketAverageMonthlyReturnPct}% | ${metrics.randomAverageMonthlyReturnPct}% |\n\n- 核心：強勢盤滿曝險輪動，弱勢盤空手。\n- 使用資料：OHLCV、法人、產業、月營收、獲利品質。\n- 產業分類仍是現行靜態分類，因此不能宣稱完全 point-in-time 全市場驗證。\n- 未通過 validation 前不可 paper trading、不可實盤、不可接券商 API。\n`, 'utf8');
  await fs.writeFile(READINESS, `# 自動交易落地判斷\n\n更新時間：${report.generatedAt}\n\n- Edge Rotation Hunter：${report.conclusion}\n- 紙上交易：${passed ? '需人工驗收後才可 dry-run' : '不可'}\n- 實盤：不可\n- 真實券商 API：不可\n\n下一步：${passed ? '先做紙上交易 dry-run 與逐筆成交驗收。' : '目前仍沒有接近月均 10% 的 validation 策略；下一步不要再堆日線因子，應補分鐘線／主力分點／法人持股比例或做事件驅動盤中策略。'}\n`, 'utf8');
  console.log(report.conclusion);
}

await main();
