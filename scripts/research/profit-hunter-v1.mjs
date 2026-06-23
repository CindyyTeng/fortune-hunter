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
const MARGIN = new URL('../../data/margin/margin-trades.json', import.meta.url);
const MARGIN_VALIDATION = new URL('../../data/margin/validation-report.json', import.meta.url);
const SECTORS = new URL('../../data/sector/sector-classification.json', import.meta.url);
const OUTPUT = new URL('../../data/research/profit-hunter-v1.json', import.meta.url);
const REPORT = new URL('../../docs/PROFIT_HUNTER_V1.md', import.meta.url);
const REGISTRY = new URL('../../data/research/strategy-experiment-registry.json', import.meta.url);

const readJson = url => fs.readFile(url, 'utf8').then(JSON.parse);
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
  for (const row of records) {
    if (row.isPointInTimeSafe !== true || row.effectiveDate <= row.date) continue;
    const key = `${row.effectiveDate}|${row.symbol}`;
    const value = map.get(key) || Object.fromEntries(fields.map(field => [field, 0]));
    for (const field of fields) value[field] += Number(row[field]) || 0;
    map.set(key, value);
  }
  return map;
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
      code: value.code, name: value.name, constituents: value.count,
      return5: value.return5 / value.count, return20: value.return20 / value.count,
      advancersRatio: value.advancers / value.count, newHighRatio: value.highs / value.count,
      transactionValueChange: value.valueRatio / value.count - 1
    };
    item.score = item.return5 * 0.25 + item.return20 * 0.45 + item.advancersRatio * 5 + item.newHighRatio * 5 + Math.max(-1, Math.min(2, item.transactionValueChange));
    const list = byDate.get(value.date) || [];
    list.push(item);
    byDate.set(value.date, list);
  }
  const output = new Map();
  for (const [date, list] of byDate) {
    const scores = list.map(value => value.score).sort((a, b) => a - b);
    for (const value of list) {
      value.rank = rank(scores, value.score);
      value.top20 = value.rank >= 0.8;
      output.set(`${date}|${value.code}`, value);
    }
  }
  return output;
}

function buildRows(context, institutionalRows, marginRows, sectorRows, startDate, endDate) {
  const sectorBySymbol = new Map(sectorRows.map(row => [row.symbol, row]));
  const sectors = buildSectorMetrics(context, sectorBySymbol, startDate, endDate);
  const institutions = aggregateByEffectiveDate(institutionalRows, ['foreignNetBuy', 'trustNetBuy', 'dealerNetBuy']);
  const margins = new Map(marginRows.filter(row => row.isPointInTimeSafe && row.effectiveDate > row.date).map(row => [`${row.effectiveDate}|${row.symbol}`, row]));
  const marketDates = context.marketHistory.map(row => row.date);
  const marketIndex = new Map(marketDates.map((date, index) => [date, index]));
  const rows = [];
  iterateObservations(context, observation => {
    const sector = sectorBySymbol.get(observation.symbol);
    const sectorMetric = sector && sectors.get(`${observation.date}|${sector.sectorCode}`);
    const flow = institutions.get(`${observation.date}|${observation.symbol}`);
    const margin = margins.get(`${observation.date}|${observation.symbol}`);
    if (!sectorMetric || !flow || !margin) return;
    const index = marketIndex.get(observation.date);
    const market60 = index >= 60 ? (context.marketHistory[index].close / context.marketHistory[index - 60].close - 1) * 100 : 0;
    const marginIncreasePriceWeak = margin.marginChange > 0 && observation.day.close <= observation.prior.close;
    rows.push({
      observation, sector: sectorMetric, flow, margin: { ...margin, marginIncreasePriceWeak },
      relative60: observation.factors.return60 - market60
    });
  }, { startDate, endDate });

  const byDate = new Map();
  for (const row of rows) {
    const list = byDate.get(row.observation.date) || [];
    list.push(row);
    byDate.set(row.observation.date, list);
  }
  const byDateSymbol = new Map();
  for (const list of byDate.values()) {
    const rel20 = list.map(row => row.observation.factors.relativeMarket20).sort((a, b) => a - b);
    const rel60 = list.map(row => row.relative60).sort((a, b) => a - b);
    const institution = list.map(row => row.flow.foreignNetBuy + row.flow.trustNetBuy).sort((a, b) => a - b);
    for (const row of list) {
      const factors = row.observation.factors;
      const sync = row.flow.foreignNetBuy > 0 && row.flow.trustNetBuy > 0;
      row.score = rank(rel20, factors.relativeMarket20) * 20
        + rank(rel60, row.relative60) * 15
        + row.sector.rank * 20
        + (row.sector.top20 ? 8 : 0)
        + (sync ? 10 : 0)
        + rank(institution, row.flow.foreignNetBuy + row.flow.trustNetBuy) * 8
        + Math.min(2, factors.volumeRatio20 || 0) * 4
        + (factors.breakout20 ? 6 : 0)
        + (factors.distanceMa20 >= -2 && factors.distanceMa20 <= 2 && factors.ma20Slope > 0 ? 5 : 0)
        + (row.margin.shortCoverPressure && row.sector.top20 ? 4 : 0)
        - Math.max(0, factors.atrPct - 4) * 3
        - (row.margin.marginIncreasePriceWeak ? 10 : 0)
        - (row.margin.marginOverheated ? 20 : 0);
      row.positionPct = row.margin.shortMarginRatio >= 30 ? 4.5 : 9;
    }
    list.sort((a, b) => b.score - a.score);
    list.forEach((row, index) => {
      row.dailyRank = index + 1;
      byDateSymbol.set(`${row.observation.date}|${row.observation.symbol}`, row);
    });
  }
  return { rows, byDate, byDateSymbol };
}

const entryModes = [
  { id: 'rank_next_open', name: '排名進榜隔日開盤', filter: () => true },
  { id: 'breakout_next_open', name: '突破前高隔日買', filter: row => row.observation.factors.breakout20 },
  { id: 'ma20_pullback', name: '回測 MA20 不破後買', filter: row => row.observation.factors.distanceMa20 >= -2 && row.observation.factors.distanceMa20 <= 2 && row.observation.factors.ma20Slope > 0 && row.observation.day.close > row.observation.day.open },
  { id: 'restrengthen', name: '強勢整理後重新轉強', filter: row => row.observation.factors.return20 >= 5 && row.observation.factors.return5 >= -4 && row.observation.factors.return5 <= 3 && row.observation.day.close > row.observation.prior.high }
];
const exitModes = [
  { id: 'ma20_entry_low', name: '跌破 MA20／進場 K 低點', rewardRisk: 2, forced: (row, original) => row.observation.day.close < row.observation.ma20 || row.observation.day.close < original.observation.day.low },
  { id: 'support_2r', name: '跌破前高轉支撐／2R', rewardRisk: 2, forced: (row, original) => row.observation.day.close < Math.min(original.observation.priorHigh20, original.observation.nextOpen) },
  { id: 'trailing_15r', name: '1.5R／移動停利', rewardRisk: 1.5, trailing: { triggerPct: 4, lockPct: 1, givebackPct: 3 }, forced: () => false },
  { id: 'rank30_market', name: '跌出前 30／大盤轉弱', rewardRisk: 2, forced: row => row.dailyRank > 30 || ['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.observation.factors.regime) }
];
const topCounts = [3, 5, 10, 20];
const configurations = topCounts.flatMap(topCount => entryModes.flatMap(entry => exitModes.map(exit => ({
  id: `top${topCount}_${entry.id}_${exit.id}`, topCount, entry, exit,
  name: `Top ${topCount}｜${entry.name}｜${exit.name}`
}))));

const baseTradable = row => row.observation.factors.transactionValue >= 30_000_000
  && row.observation.factors.atrPct <= 8
  && !row.margin.marginOverheated
  && !row.margin.marginIncreasePriceWeak
  && !['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.observation.factors.regime)
  && Math.abs(row.observation.factors.gapPct) <= 5;

function candidate(row, config, byDateSymbol) {
  const observation = row.observation;
  const support = Math.min(observation.day.low, observation.ma20, observation.priorHigh20 || observation.day.low);
  const stopDistancePct = Math.min(8, Math.max(2, (observation.nextOpen / Math.min(observation.nextOpen * 0.98, support) - 1) * 100));
  const bars = observation.futureBars.map(value => ({ ...value }));
  for (let index = 0; index + 1 < bars.length; index += 1) {
    const futureRow = byDateSymbol.get(`${bars[index].date}|${observation.symbol}`);
    if (futureRow && config.exit.forced(futureRow, row)) {
      bars[index + 1].forcedExit = { price: bars[index + 1].open, reason: config.exit.name, type: config.exit.id };
      break;
    }
  }
  const setup = ['多因子排名', `分數 ${round(row.score, 2)}`, `${row.sector.name} 強度 ${round(row.sector.rank * 100, 1)}%`];
  const trigger = [config.entry.name, 'T 日收盤確認，T+1 執行'];
  const invalidation = [config.exit.name, '融資過熱或融資增加但價格轉弱時不進場'];
  const decision = {
    date: observation.nextDate, symbol: observation.symbol, action: 'BUY', strategyId: config.id,
    setup, trigger, invalidation,
    entryPlan: { referencePrice: observation.nextOpen, maximumAcceptablePrice: observation.nextOpen * 1.005, orderType: 'MARKETABLE_LIMIT', timeInForce: 'ROD', session: 'REGULAR' },
    riskPlan: { stopPrice: observation.nextOpen * (1 - stopDistancePct / 100), targetPrice: observation.nextOpen * (1 + stopDistancePct * config.exit.rewardRisk / 100), riskRewardRatio: config.exit.rewardRisk, positionBudget: row.positionPct / 100 * 1_000_000, riskBudget: 5_000 },
    reason: `${config.name} 條件成立`, warnings: ['產業分類為現行靜態分類；僅供 validation']
  };
  return {
    signalDate: observation.date, entryDate: observation.nextDate, symbol: observation.symbol, name: observation.name,
    market: observation.market, regime: observation.factors.regime, atrPct: observation.factors.atrPct,
    score: row.score, futureBars: bars, stopDistancePct, rewardRisk: config.exit.rewardRisk,
    maxHoldingDays: 10, trailingStopRule: config.exit.trailing, positionPct: row.positionPct,
    setup, trigger, invalidation, exitPlan: config.exit.name, reason: decision.reason,
    orderIntent: decisionToOrderIntent(decision, { account: { equity: 1_000_000, availableCash: 1_000_000 } })
  };
}

function signalMap(data, config, startDate, endDate) {
  const map = new Map();
  for (const [date, list] of data.byDate) {
    if (date < startDate || date > endDate) continue;
    const selected = list.filter(row => baseTradable(row) && config.entry.filter(row)).slice(0, config.topCount);
    if (selected.length) map.set(date, selected.map(row => candidate(row, config, data.byDateSymbol)));
  }
  return map;
}

function randomMap(data, selectedMap, config, startDate, endDate) {
  const map = new Map();
  for (const [date, selected] of selectedMap) {
    if (date < startDate || date > endDate) continue;
    const pool = (data.byDate.get(date) || []).filter(baseTradable)
      .sort((a, b) => deterministicScore(`${date}|${b.observation.symbol}`) - deterministicScore(`${date}|${a.observation.symbol}`));
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
    buyOrderIntents: trades.filter(row => row.orderIntent).length,
    sellDecisions: trades.length,
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
    actionsAndIntents: metrics.buyOrderIntents === trades.length && metrics.sellDecisions === trades.length,
    historicalSectorPointInTime: false
  };
  metrics.passed = Object.values(metrics.checks).every(Boolean);
  metrics.nearTenPercent = metrics.validationAverageMonthlyEquityReturnPct >= 8;
  return metrics;
}

function registryInput(range, metrics = null) {
  return {
    strategyId: 'profit_hunter_multifactor_margin_v1',
    dataSources: ['daily_ohlcv', 'institutional_point_in_time_t_plus_1', 'sector_static_current_classification_v1', 'margin_point_in_time_t_plus_1'],
    setupRules: ['多因子每日排名，測試 Top 3／5／10／20'],
    triggerRules: entryModes.map(row => row.name), invalidationRules: ['融資過熱', '融資增加但價格轉弱', 'ATR 過高', '空頭或高波動大盤'],
    exitRules: exitModes.map(row => row.name), riskRules: ['單筆風險 0.5%', '集中持股', '券資比高時部位減半', 'T+2'],
    blockedWhen: ['融資過熱', '成交值低於三千萬元', 'ATR 高於 8%', '大盤防守狀態'],
    parameters: { configurations: configurations.map(row => row.id), dataset: `${range.start}_${range.end}` },
    trainPeriod: { months: 36 }, validationPeriod: { months: 12, stepMonths: 12 },
    costModel: { buyFeePct: 0.1425, sellFeePct: 0.1425, sellTaxPct: 0.3, slippagePct: 0.15 },
    executionModel: { entry: 'next_open_market', settlement: 'T+2', simulator: 'shared' },
    metrics, resultStatus: metrics ? (metrics.passed ? 'passed' : 'failed') : 'inconclusive',
    failureReason: metrics?.passed ? null : 'Validation 未達完整門檻。',
    passedMinimum: metrics?.passed === true, passedHighProfit: metrics?.nearTenPercent === true && metrics?.passed === true,
    allowRetest: false, coreRulesChanged: true, notes: 'Profit Hunter v1 多因子排名與融資券新資料。'
  };
}

const [institutional, margin, marginValidation, sectors] = await Promise.all([
  readJson(INSTITUTIONAL), readJson(MARGIN), readJson(MARGIN_VALIDATION), readJson(SECTORS)
]);
if (marginValidation.status !== 'VALID') {
  const registry = await readJson(REGISTRY);
  registry.experiments = registry.experiments.filter(row => row.strategyId !== 'profit_hunter_multifactor_margin_v1');
  registry.updatedAt = new Date().toISOString();
  await fs.writeFile(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  const report = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    status: 'DATA_INSUFFICIENT',
    marginValidation,
    configurationsPrepared: configurations.length,
    validationCompleted: false,
    metrics: null,
    readiness: { paperTradingAllowed: false, liveTradingAllowed: false, realBrokerAllowed: false },
    conclusion: `融資融券資料不足：上市 ${marginValidation.twseDates || 0} 日、上櫃 ${marginValidation.tpexDates || 0} 日；Profit Hunter 未完成有效 validation。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# Profit Hunter v1\n\n${report.conclusion}\n\n- 已建立 64 組多因子排名、進場與出場搜尋組合。\n- 因市場別資料覆蓋不平衡，本次不產生績效結論。\n- 紙上交易：不可。\n- 實盤：不可。\n`, 'utf8');
  console.log(report.conclusion);
  process.exit(0);
}
const dates = [...new Set(margin.records.map(row => row.effectiveDate))].sort();
const context = await loadResearchContext();
const range = { start: dates[0], end: [dates.at(-1), context.endDate].sort()[0] };
const preInput = registryInput(range);
const identity = buildExperimentIdentity(preInput);
const precheck = shouldSkipExperiment(await loadRegistry(), identity, preInput);
if (precheck.skip) {
  console.log(`Profit Hunter 跳過重複實驗：${precheck.reason}`);
  process.exit(0);
}
const data = buildRows(context, institutional.records || [], margin.records || [], sectors.records || [], range.start, range.end);
const folds = foldWindows(range.start, range.end, 36, 12);
const foldResults = [];
for (const fold of folds) {
  let best;
  for (const config of configurations) {
    const result = simulateSignalMap(context, signalMap(data, config, fold.trainStart, fold.trainEnd), {
      startDate: fold.trainStart, endDate: fold.trainEnd, strategyId: config.id,
      holdingDays: 10, maxOpenPositions: Math.min(config.topCount, 6)
    });
    const score = objective(result.summary);
    if (!best || score > best.score) best = { config, score, summary: result.summary };
  }
  const selected = signalMap(data, best.config, fold.validationStart, fold.validationEnd);
  const validation = simulateSignalMap(context, selected, {
    startDate: fold.validationStart, endDate: fold.validationEnd, strategyId: best.config.id,
    holdingDays: 10, maxOpenPositions: Math.min(best.config.topCount, 6)
  });
  const random = simulateSignalMap(context, randomMap(data, selected, best.config, fold.validationStart, fold.validationEnd), {
    startDate: fold.validationStart, endDate: fold.validationEnd, strategyId: `${best.config.id}:fair_random`,
    holdingDays: 10, maxOpenPositions: Math.min(best.config.topCount, 6)
  });
  foldResults.push({ ...fold, selectedConfig: best.config, trainSummary: best.summary, validation, random, marketReturns: marketMonthly(context, fold.validationStart, fold.validationEnd) });
  console.log(`Fold ${fold.validationStart}：${best.config.name}，交易 ${validation.summary.trades}。`);
}
const metrics = combine(foldResults);
await appendExperiment(registryInput(range, metrics));
const selectedNames = [...new Set(foldResults.map(row => row.selectedConfig.name))];
const report = {
  generatedAt: new Date().toISOString(), branch: 'institutional-data-fetcher-v1', experiment: identity,
  data: { marginRecords: margin.records.length, marginDates: marginValidation.uniqueDates, researchRows: data.rows.length, sectorPointInTimeSafe: false },
  search: { configurationsTested: configurations.length, topCounts, entryModes: entryModes.map(row => row.name), exitModes: exitModes.map(row => row.name) },
  walkForward: { trainMonths: 36, validationMonths: 12, stepMonths: 12, folds: folds.length },
  selectedStrategies: selectedNames,
  folds: foldResults.map(row => ({
    trainStart: row.trainStart, trainEnd: row.trainEnd, validationStart: row.validationStart, validationEnd: row.validationEnd,
    selectedConfig: row.selectedConfig.name, trainSummary: row.trainSummary, validationSummary: row.validation.summary, randomSummary: row.random.summary
  })),
  metrics,
  readiness: { paperTradingAllowed: metrics.passed, liveTradingAllowed: false, realBrokerAllowed: false },
  conclusion: metrics.passed
    ? '策略通過最低 validation 門檻，但只能進紙上交易，不可實盤。'
    : `沒有策略通過 validation；最佳月均 ${metrics.validationAverageMonthlyEquityReturnPct}%，距離 10% 尚差 ${metrics.targetGapPct} 個百分點。`
};
await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# Profit Hunter v1\n\n${report.conclusion}\n\n- 測試組合：${configurations.length}\n- 驗證交易：${metrics.validationTrades}\n- 月均總資產報酬：${metrics.validationAverageMonthlyEquityReturnPct}%\n- 年化報酬：${metrics.validationAnnualizedReturnPct}%\n- Profit Factor：${metrics.validationProfitFactor}\n- 最大回撤：${metrics.validationMaximumDrawdownPct}%\n- 勝率：${metrics.validationWinRatePct}%\n- 大盤月均：${metrics.marketAverageMonthlyReturnPct}%\n- 公平隨機月均：${metrics.randomAverageMonthlyReturnPct}%\n- 紙上交易：${metrics.passed ? '僅可進入下一階段' : '不可'}\n- 實盤：不可\n\n限制：產業分類仍是現行靜態分類，不是歷史 point-in-time。\n`, 'utf8');
console.log(report.conclusion);
