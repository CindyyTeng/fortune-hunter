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

const REVENUE = new URL('../../data/revenue/monthly-revenue.json', import.meta.url);
const VALIDATION = new URL('../../data/revenue/validation-report.json', import.meta.url);
const INSTITUTIONAL = new URL('../../data/institutional/institutional-trades.json', import.meta.url);
const MARGIN = new URL('../../data/margin/margin-trades.json', import.meta.url);
const OUTPUT = new URL('../../data/research/revenue-hunter-v1.json', import.meta.url);
const REPORT = new URL('../../docs/REVENUE_HUNTER_V1.md', import.meta.url);
const READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);

const readJson = (url, fallback = null) => fs.readFile(url, 'utf8').then(JSON.parse).catch(error => {
  if (error.code === 'ENOENT') return fallback;
  throw error;
});

const families = [
  {
    id: 'growth_acceleration_breakout',
    name: '營收成長加速＋突破',
    variants: [20, 30, 50].map(yoy => ({ id: `yoy${yoy}`, name: `YoY>${yoy}% 且加速`, filter: row => row.revenue.YoY > yoy && row.revenue.yoyAcceleration }))
  },
  {
    id: 'decline_to_growth_strengthen',
    name: '營收由衰退轉成長＋價格轉強',
    variants: [{ id: 'turn_positive', name: 'YoY 由負轉正', filter: row => row.revenue.declineToGrowth && row.revenue.threeMonthCumulativeYoY > 0 }]
  },
  {
    id: 'revenue_high_institutional',
    name: '營收創高＋法人確認',
    variants: [
      { id: 'high12', name: '營收創 12 月新高', filter: row => row.revenue.revenueHigh12 },
      { id: 'high24', name: '營收創 24 月新高', filter: row => row.revenue.revenueHigh24 }
    ]
  },
  {
    id: 'strong_revenue_no_chase',
    name: '營收強但不追高',
    variants: [{ id: 'no_chase', name: 'YoY>20% 且排除追高', filter: row => row.revenue.YoY > 20 && (row.revenue.yoyAcceleration || row.revenue.revenueHigh12) }]
  }
];

const entries = [
  { id: 'announcement_next_open', name: '公布後隔日開盤', filter: row => row.eventAge <= 1 },
  { id: 'breakout20', name: '突破 20 日高點', filter: row => row.observation.factors.breakout20 && row.observation.factors.volumeRatio20 >= 1.2 },
  { id: 'ma20_pullback', name: '回測 MA20 不破', filter: row => row.observation.factors.distanceMa20 >= -2 && row.observation.factors.distanceMa20 <= 2 && row.observation.factors.ma20Slope > 0 && row.observation.day.close > row.observation.day.open },
  { id: 'restrengthen', name: '整理後重新轉強', filter: row => row.observation.factors.return20 > 5 && row.observation.factors.return5 >= -5 && row.observation.factors.return5 <= 3 && row.observation.day.close > row.observation.prior.high }
];

const exits = [
  { id: 'ma20', name: '跌破 MA20', rewardRisk: 2, maxHoldingDays: 15, forced: (row, original) => row.observation.day.close < row.observation.ma20 },
  { id: 'entry_low', name: '跌破進場 K 低點', rewardRisk: 2, maxHoldingDays: 15, forced: (row, original) => row.observation.day.close < original.observation.day.low },
  { id: 'support', name: '跌破前高轉支撐', rewardRisk: 2, maxHoldingDays: 15, forced: (row, original) => row.observation.day.close < Math.min(original.observation.ma20, original.observation.priorHigh20) },
  { id: 'target15r', name: '1.5R 停利', rewardRisk: 1.5, maxHoldingDays: 10, forced: () => false },
  { id: 'target2r', name: '2R 停利', rewardRisk: 2, maxHoldingDays: 15, forced: () => false },
  { id: 'trailing', name: '移動停利', rewardRisk: null, maxHoldingDays: 20, trailing: { triggerPct: 5, lockPct: 1.5, givebackPct: 3 }, forced: () => false },
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

function buildResearchRows(context, revenueRows, institutionalRows, marginRows, startDate, endDate) {
  const revenueBySymbol = new Map();
  for (const row of revenueRows.filter(value => value.isPointInTimeSafe && value.effectiveDate)) {
    const list = revenueBySymbol.get(row.symbol) || [];
    list.push(row);
    revenueBySymbol.set(row.symbol, list);
  }
  for (const list of revenueBySymbol.values()) list.sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate));
  const flows = aggregateByDate(institutionalRows, ['foreignNetBuy', 'trustNetBuy', 'dealerNetBuy']);
  const margins = new Map((marginRows || []).filter(row => row.isPointInTimeSafe && row.effectiveDate).map(row => [`${row.effectiveDate}|${row.symbol}`, row]));
  const dates = context.marketHistory.map(row => row.date);
  const dateIndex = new Map(dates.map((date, index) => [date, index]));
  const themeRanks = buildThemeRanks(context);
  const states = new Map();
  const rows = [];
  const byDateSymbol = new Map();
  iterateObservations(context, observation => {
    const revenueList = revenueBySymbol.get(observation.symbol);
    if (!revenueList) return;
    const state = states.get(observation.symbol) || { cursor: -1 };
    while (state.cursor + 1 < revenueList.length && revenueList[state.cursor + 1].effectiveDate <= observation.date) state.cursor += 1;
    states.set(observation.symbol, state);
    const revenue = revenueList[state.cursor];
    if (!revenue) return;
    const eventAge = dateIndex.get(observation.date) - dateIndex.get(revenue.effectiveDate);
    if (eventAge < 0 || eventAge > 10) return;
    const revenueEligible = (revenue.YoY > 20 && revenue.yoyAcceleration)
      || revenue.declineToGrowth
      || revenue.revenueHigh12
      || revenue.revenueHigh24;
    if (!revenueEligible) return;
    const factors = observation.factors;
    if (factors.transactionValue < 30_000_000
      || factors.atrPct > 8
      || factors.distanceMa20 < -5
      || factors.distanceMa20 > 8
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
    const row = { observation, revenue, eventAge, flow, margin, institutionRatio, themeRank };
    row.score = Math.min(80, Math.max(-30, revenue.YoY || 0)) * 0.45
      + Math.min(40, Math.max(-20, revenue.threeMonthCumulativeYoY || 0)) * 0.2
      + (revenue.yoyAcceleration ? 10 : 0)
      + (revenue.revenueHigh12 ? 8 : 0)
      + (revenue.revenueHigh24 ? 8 : 0)
      + Math.min(10, observation.factors.relativeMarket20 * 0.6)
      + themeRank * 8
      + Math.min(8, Math.max(-8, institutionRatio * 100))
      + Math.min(6, Math.max(0, (observation.factors.volumeRatio20 - 1) * 4));
    rows.push(row);
    byDateSymbol.set(`${observation.date}|${observation.symbol}`, row);
  }, { startDate, endDate, symbols: new Set(revenueBySymbol.keys()) });
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
    && factors.distanceMa20 >= -5
    && factors.distanceMa20 <= 8
    && Math.abs(factors.gapPct) <= 5
    && factors.marketAboveMa60
    && !['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(factors.regime)
    && !row.margin?.marginOverheated;
  if (!common) return false;
  if (family.id === 'growth_acceleration_breakout') return row.observation.day.close > row.observation.ma20 && row.observation.ma20 > row.observation.ma60;
  if (family.id === 'decline_to_growth_strengthen') return factors.relativeMarket20 > 0 && row.observation.day.close >= row.observation.ma20 * 0.98;
  if (family.id === 'revenue_high_institutional') return row.institutionRatio > -0.03 && row.themeRank >= 0.5;
  return factors.gapPct <= 3 && factors.distanceMa20 <= 5 && !factors.longUpperWick;
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
  const setup = [config.family.name, config.variant.name, `營收月份 ${row.revenue.revenueMonth}`, `YoY ${round(row.revenue.YoY, 2)}%`];
  const trigger = [config.entry.name, '月營收資料只在保守 effectiveDate 後使用'];
  const invalidation = [config.exit.name, '大盤進入空頭或高波動時停止新倉'];
  const decision = {
    date: observation.nextDate,
    symbol: observation.symbol,
    action: 'BUY',
    strategyId: `revenue_hunter_v1:${config.id}`,
    setup,
    trigger,
    invalidation,
    entryPlan: { referencePrice: observation.nextOpen, maximumAcceptablePrice: observation.nextOpen * 1.005, orderType: 'MARKETABLE_LIMIT', timeInForce: 'ROD', session: 'REGULAR' },
    riskPlan: { stopPrice: observation.nextOpen * (1 - stopDistancePct / 100), targetPrice: config.exit.rewardRisk ? observation.nextOpen * (1 + stopDistancePct * config.exit.rewardRisk / 100) : null, riskRewardRatio: config.exit.rewardRisk || 2, positionBudget: 100_000, riskBudget: 5_000 },
    reason: config.name,
    warnings: ['尚未通過 validation 前不可紙上交易或實盤', '月營收公布時間採次月 10 日後 T+1 保守假設']
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
  return summary.averageMonthlyEquityReturnPct * 5 + pf * 0.5 + summary.maximumDrawdownPct * 0.04 + Math.min(1, summary.trades / 300);
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
  const metrics = {
    validationTrades: trades.length,
    validationAverageMonthlyEquityReturnPct: round(mean(monthly) || 0),
    targetGapPct: round(10 - (mean(monthly) || 0)),
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
    strategyId: `revenue_hunter_v1_${family.id}`,
    dataSources: ['daily_ohlcv', 'monthly_revenue_conservative_t_plus_1', 'institutional_point_in_time_t_plus_1_optional', 'margin_point_in_time_t_plus_1_optional'],
    setupRules: family.variants.map(row => row.name),
    triggerRules: entries.map(row => row.name),
    invalidationRules: ['跌破 MA20 或支撐', '大盤轉弱', '融資過熱', '營收資料尚未生效'],
    exitRules: exits.map(row => row.name),
    riskRules: ['單筆風險 0.5%', '單檔最多 10%', 'T+2', '集中持股 Top 3／5／10'],
    blockedWhen: ['跳空過大', 'ATR 過高', '離 MA20 過遠', '大盤跌破 MA60', '融資過熱'],
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
    notes: `Revenue Hunter v1：${family.name}`
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
        strategyId: `revenue:${config.id}`,
        maxOpenPositions: Math.min(config.topCount, 6)
      });
      const score = objective(train.summary);
      if (!best || score > best.score) best = { config, score, summary: train.summary };
    }
    const selected = signalMap(data, best.config, fold.validationStart, fold.validationEnd);
    const validation = simulateSignalMap(context, selected, {
      startDate: fold.validationStart,
      endDate: fold.validationEnd,
      strategyId: `revenue:${best.config.id}`,
      maxOpenPositions: Math.min(best.config.topCount, 6)
    });
    const random = simulateSignalMap(context, randomMap(data, selected, best.config, fold.validationStart, fold.validationEnd), {
      startDate: fold.validationStart,
      endDate: fold.validationEnd,
      strategyId: `revenue:${best.config.id}:fair_random`,
      maxOpenPositions: Math.min(best.config.topCount, 6)
    });
    results.push({ ...fold, selectedConfig: best.config, trainSummary: best.summary, validation, random, marketReturns: marketMonthly(context, fold.validationStart, fold.validationEnd) });
    console.log(`${family.name} ${fold.validationStart}：${best.config.name}，交易 ${validation.summary.trades}。`);
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

const [revenue, validation, institutional, margin] = await Promise.all([
  readJson(REVENUE, { records: [] }),
  readJson(VALIDATION, { status: 'MISSING_DATA' }),
  readJson(INSTITUTIONAL, { records: [] }),
  readJson(MARGIN, { records: [] })
]);

if (validation.status !== 'VALID') {
  const conclusion = '月營收資料不足，Revenue Hunter 未執行假回測。';
  await fs.writeFile(OUTPUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), status: 'DATA_MISSING', validation, conclusion }, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# Revenue Hunter v1\n\n${conclusion}\n`, 'utf8');
  console.log(conclusion);
} else {
  const context = await loadResearchContext();
  const effectiveDates = [...new Set(revenue.records.map(row => row.effectiveDate))].sort();
  const range = { start: effectiveDates[0], end: [effectiveDates.at(-1), context.endDate].sort()[0] };
  const folds = foldWindows(range.start, range.end, 36, 12);
  const data = buildResearchRows(context, revenue.records, institutional.records, margin.records, range.start, range.end);
  const familyResults = [];
  for (const family of families) familyResults.push(await runFamily(family, data, context, range, folds));
  const completed = familyResults.filter(row => row.status === 'COMPLETED');
  const best = completed.sort((left, right) => right.metrics.validationAverageMonthlyEquityReturnPct - left.metrics.validationAverageMonthlyEquityReturnPct)[0] || null;
  const passed = completed.filter(row => row.metrics.passed);
  const highProfit = completed.filter(row => row.metrics.highProfit);
  const conclusion = best
    ? (passed.length
      ? `${best.name} 通過最低候選門檻，但只能進紙上交易，不可實盤。`
      : `沒有策略通過 validation；最接近的是 ${best.name}，月均 ${best.metrics.validationAverageMonthlyEquityReturnPct}%，距離 10% 尚差 ${best.metrics.targetGapPct} 個百分點。`)
    : '沒有產生有效 Revenue Hunter 回測。';
  const result = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    status: completed.length ? 'COMPLETED' : 'NO_VALID_BACKTEST',
    data: { records: revenue.records.length, symbols: validation.symbols, months: validation.months, pointInTimeSafe: validation.pointInTimeSafeRecords, fullyVerifiedPointInTime: false, researchRows: data.rows.length },
    search: { families: families.length, variants: families.reduce((sum, family) => sum + family.variants.length, 0), configurations: families.reduce((sum, family) => sum + configurations(family).length, 0), topCounts, entries: entries.map(row => row.name), exits: exits.map(row => row.name) },
    walkForward: { trainMonths: 36, validationMonths: 12, stepMonths: 12, folds: folds.length },
    familyResults,
    bestStrategy: best ? { family: best.name, selectedStrategies: best.selectedStrategies, metrics: best.metrics } : null,
    readiness: { paperTradingAllowed: passed.length > 0, liveTradingAllowed: false, realBrokerAllowed: false, highProfitCandidates: highProfit.map(row => row.name) },
    conclusion
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const rows = completed.map(row => `| ${row.name} | ${row.metrics.validationTrades} | ${row.metrics.validationAverageMonthlyEquityReturnPct}% | ${row.metrics.validationAnnualizedReturnPct}% | ${row.metrics.validationProfitFactor} | ${row.metrics.validationMaximumDrawdownPct}% | ${row.metrics.validationWinRatePct}% | ${row.metrics.passed ? '通過' : '未通過'} |`).join('\n');
  await fs.writeFile(REPORT, `# Revenue Hunter v1\n\n${conclusion}\n\n| 策略家族 | 交易數 | 月均報酬 | 年化 | PF | 最大回撤 | 勝率 | 結果 |\n|---|---:|---:|---:|---:|---:|---:|---|\n${rows}\n\n- 月營收：${validation.symbols} 檔、${validation.months} 個月份，採次月 10 日後 T+1 保守使用。\n- 共測 ${result.search.families} 個家族、${result.search.configurations} 組設定。\n- 未通過 validation 前不可紙上交易、實盤或接真實券商下單。\n`, 'utf8');
  await fs.writeFile(READINESS, `# 自動交易落地判斷\n\n更新時間：${result.generatedAt}\n\n- Revenue Hunter：${conclusion}\n- 紙上交易：${passed.length ? `僅允許 ${passed.map(row => row.name).join('、')}` : '不可'}\n- 實盤：不可\n- 真實券商 API：不可\n- 訊號介面：支援 BUY／SELL／HOLD／SKIP 與 order intent，但只有通過 validation 才能啟用。\n\n下一步：${passed.length ? '先進行紙上交易驗證成交與滑價。' : '補 point-in-time 月營收實際公布日、財報品質（EPS／毛利率／營益率）與公司行動資料，再測基本面品質加事件型策略。'}\n`, 'utf8');
  console.log(conclusion);
}
