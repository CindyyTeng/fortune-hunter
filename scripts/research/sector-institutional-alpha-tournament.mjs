import fs from 'node:fs/promises';
import { netReturnPct } from '../lib/execution-simulator.mjs';
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

const SECTOR_DATA = new URL('../../data/sector/sector-classification.json', import.meta.url);
const SECTOR_VALIDATION = new URL('../../data/sector/validation-report.json', import.meta.url);
const INSTITUTIONAL_DATA = new URL('../../data/institutional/institutional-trades.json', import.meta.url);
const INSTITUTIONAL_VALIDATION = new URL('../../data/institutional/validation-report.json', import.meta.url);
const OUTPUT = new URL('../../data/research/sector-institutional-alpha-tournament.json', import.meta.url);
const REPORT = new URL('../../docs/SECTOR_INSTITUTIONAL_ALPHA_TOURNAMENT.md', import.meta.url);
const READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);

const readJson = url => fs.readFile(url, 'utf8').then(JSON.parse);
const percentile = (sorted, value) => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return sorted.length ? low / sorted.length : 0;
};

function safeInstitutionalRows(payload) {
  return (payload.records || []).filter(row => row.isPointInTimeSafe === true && row.effectiveDate > row.date);
}

function buildFlowMap(records, marketDates) {
  const dateSet = new Set(marketDates);
  const map = new Map();
  for (const row of records) {
    if (!dateSet.has(row.effectiveDate)) continue;
    const key = `${row.effectiveDate}|${row.symbol}`;
    const flow = map.get(key) || { foreign: 0, trust: 0, dealer: 0 };
    flow.foreign += Number(row.foreignNetBuy) || 0;
    flow.trust += Number(row.trustNetBuy) || 0;
    flow.dealer += Number(row.dealerNetBuy) || 0;
    map.set(key, flow);
  }
  return map;
}

function buildSectorMetrics(context, sectorBySymbol, startDate, endDate) {
  const aggregates = new Map();
  iterateObservations(context, observation => {
    const sector = sectorBySymbol.get(observation.symbol);
    if (!sector) return;
    const key = `${observation.date}|${sector.sectorCode}`;
    const row = aggregates.get(key) || {
      date: observation.date, sectorCode: sector.sectorCode, sectorName: sector.sectorName,
      count: 0, return5: 0, return10: 0, return20: 0, advancers: 0, newHigh20: 0,
      transactionValue: 0, normalTransactionValue: 0
    };
    row.count += 1;
    row.return5 += observation.factors.return5;
    row.return10 += (observation.day.close / observation.history[observation.historyIndex - 10].close - 1) * 100;
    row.return20 += observation.factors.return20;
    row.advancers += observation.day.close > observation.prior.close ? 1 : 0;
    row.newHigh20 += observation.factors.breakout20 ? 1 : 0;
    row.transactionValue += observation.factors.transactionValue;
    row.normalTransactionValue += observation.ma20 * observation.averageVolume20;
    aggregates.set(key, row);
  }, { startDate, endDate });

  const byDate = new Map();
  for (const row of aggregates.values()) {
    const metric = {
      date: row.date,
      sectorCode: row.sectorCode,
      sectorName: row.sectorName,
      constituents: row.count,
      return5: row.return5 / row.count,
      return10: row.return10 / row.count,
      return20: row.return20 / row.count,
      advancersRatio: row.advancers / row.count,
      newHigh20Ratio: row.newHigh20 / row.count,
      transactionValueChange: row.transactionValue / Math.max(1, row.normalTransactionValue) - 1
    };
    const list = byDate.get(row.date) || [];
    list.push(metric);
    byDate.set(row.date, list);
  }
  const metrics = new Map();
  for (const list of byDate.values()) {
    const scores = list.map(row => row.return5 * 0.2 + row.return10 * 0.3 + row.return20 * 0.35
      + row.advancersRatio * 5 + row.newHigh20Ratio * 5 + Math.max(-1, Math.min(2, row.transactionValueChange)))
      .sort((a, b) => a - b);
    for (const row of list) {
      row.score = row.return5 * 0.2 + row.return10 * 0.3 + row.return20 * 0.35
        + row.advancersRatio * 5 + row.newHigh20Ratio * 5 + Math.max(-1, Math.min(2, row.transactionValueChange));
      row.rank = percentile(scores, row.score);
      row.top20 = row.rank >= 0.8;
      metrics.set(`${row.date}|${row.sectorCode}`, row);
    }
  }
  return metrics;
}

function buildResearchRows(context, records, sectorRecords, startDate, endDate) {
  const marketDates = context.marketHistory.map(row => row.date);
  const dateIndex = new Map(marketDates.map((date, index) => [date, index]));
  const flowMap = buildFlowMap(records, marketDates);
  const sectorBySymbol = new Map(sectorRecords.map(row => [row.symbol, row]));
  const sectorMetrics = buildSectorMetrics(context, sectorBySymbol, startDate, endDate);
  const rows = [];
  iterateObservations(context, observation => {
    const sector = sectorBySymbol.get(observation.symbol);
    const current = flowMap.get(`${observation.date}|${observation.symbol}`);
    if (!sector || !current) return;
    const sectorRow = sectorMetrics.get(`${observation.date}|${sector.sectorCode}`);
    if (!sectorRow || sectorRow.constituents < 3) return;
    const index = dateIndex.get(observation.date);
    const priorFlow = offset => flowMap.get(`${marketDates[index - offset]}|${observation.symbol}`) || { foreign: 0, trust: 0, dealer: 0 };
    const flow = { ...current, trust5: 0, trust10: 0, total5: 0 };
    for (let offset = 0; offset < 10; offset += 1) {
      const value = priorFlow(offset);
      if (offset < 5) {
        flow.trust5 += value.trust;
        flow.total5 += value.trust + value.foreign + value.dealer;
      }
      flow.trust10 += value.trust;
    }
    const market20 = observation.factors.marketReturn20 || 0;
    rows.push({
      observation,
      flow,
      sector: {
        ...sectorRow,
        stockRelative5: observation.factors.return5 - sectorRow.return5,
        stockRelative20: observation.factors.return20 - sectorRow.return20,
        stockRelativeMarket20: observation.factors.relativeMarket20,
        beatsMarket: sectorRow.return20 > market20
      }
    });
  }, { startDate, endDate });

  const rowsByDate = new Map();
  for (const row of rows) {
    const list = rowsByDate.get(row.observation.date) || [];
    list.push(row);
    rowsByDate.set(row.observation.date, list);
  }
  for (const list of rowsByDate.values()) {
    for (const field of ['trust5', 'trust10']) {
      const sorted = list.map(row => row.flow[field]).sort((a, b) => a - b);
      for (const row of list) row.flow[`${field}Rank`] = percentile(sorted, row.flow[field]);
    }
  }
  return { rows, rowsByDate };
}

const baseTradable = row => row.observation.factors.transactionValue >= 30_000_000
  && row.observation.factors.atrPct <= 8
  && Math.abs(row.observation.factors.gapPct) <= 5;
const FAMILIES = [
  {
    id: 'sector_sync_institutional_buy', name: '強勢族群內外資＋投信同步買超', definitions: [
      ['top20_sync', '前 20% 族群且外資、投信同步買超', row => row.sector.top20 && row.flow.foreign > 0 && row.flow.trust > 0],
      ['top20_sync_strong_stock', '同步買超且個股強於族群', row => row.sector.top20 && row.flow.foreign > 0 && row.flow.trust > 0 && row.sector.stockRelative20 > 0],
      ['top20_sync_breadth', '同步買超且族群上漲擴散', row => row.sector.top20 && row.flow.foreign > 0 && row.flow.trust > 0 && row.sector.advancersRatio >= 0.55],
      ['top20_sync_new_highs', '同步買超且族群新高擴散', row => row.sector.top20 && row.flow.foreign > 0 && row.flow.trust > 0 && row.sector.newHigh20Ratio >= 0.15]
    ]
  },
  {
    id: 'sector_trust_intensity', name: '強勢族群內投信買超強度', definitions: [
      ['trust5_top', '強勢族群且投信五日買超前 20%', row => row.sector.top20 && row.flow.trust5 > 0 && row.flow.trust5Rank >= 0.8],
      ['trust10_top', '強勢族群且投信十日買超前 20%', row => row.sector.top20 && row.flow.trust10 > 0 && row.flow.trust10Rank >= 0.8],
      ['trust5_relative', '投信五日強買且個股強於族群', row => row.sector.top20 && row.flow.trust5Rank >= 0.8 && row.sector.stockRelative20 > 0],
      ['trust10_breadth', '投信十日強買且族群上漲家數過半', row => row.sector.top20 && row.flow.trust10Rank >= 0.8 && row.sector.advancersRatio >= 0.55]
    ]
  },
  {
    id: 'sector_institutional_diffusion', name: '法人買超＋族群擴散', definitions: [
      ['buy_breadth', '法人買超且族群上漲家數達六成', row => row.flow.total5 > 0 && row.sector.advancersRatio >= 0.6 && row.sector.beatsMarket],
      ['buy_new_highs', '法人買超且族群創新高比例擴散', row => row.flow.total5 > 0 && row.sector.newHigh20Ratio >= 0.2 && row.sector.beatsMarket],
      ['buy_value_expand', '法人買超且族群成交值擴張', row => row.flow.total5 > 0 && row.sector.transactionValueChange >= 0.15 && row.sector.rank >= 0.6],
      ['buy_full_diffusion', '法人買超且上漲、新高與成交值同步', row => row.flow.total5 > 0 && row.sector.advancersRatio >= 0.55 && row.sector.newHigh20Ratio >= 0.1 && row.sector.transactionValueChange > 0]
    ]
  },
  {
    id: 'sector_weakness_exclusion', name: '避開弱勢族群', definitions: [
      ['exclude_bottom20', '法人買超並排除後 20% 族群', row => row.flow.trust > 0 && row.flow.foreign >= 0 && row.sector.rank >= 0.2],
      ['upper60', '法人買超且族群強度位於前 60%', row => row.flow.trust > 0 && row.flow.foreign >= 0 && row.sector.rank >= 0.4],
      ['upper40', '法人買超且族群強度位於前 40%', row => row.flow.trust > 0 && row.flow.foreign >= 0 && row.sector.rank >= 0.6],
      ['top20', '法人買超且僅做前 20% 族群', row => row.flow.trust > 0 && row.flow.foreign >= 0 && row.sector.top20]
    ]
  }
].map(family => ({ ...family, definitions: family.definitions.map(([id, name, filter]) => ({ id, name, filter })) }));

function addCandidate(map, date, candidate, limit = 6) {
  const list = map.get(date) || [];
  list.push(candidate);
  list.sort((a, b) => b.score - a.score);
  map.set(date, list.slice(0, limit));
}

function makeCandidate(row, family, definition) {
  if (!baseTradable(row) || !definition.filter(row)) return null;
  const { observation, flow, sector } = row;
  const stopDistancePct = Math.min(8, Math.max(2, observation.factors.atrPct * 1.5));
  const decision = {
    date: observation.nextDate, symbol: observation.symbol, action: 'BUY', strategyId: `${family.id}:${definition.id}`,
    setup: [family.name, definition.name, `${sector.sectorName}強度分位 ${round(sector.rank * 100, 1)}%`],
    trigger: ['T 日收盤確認，T+1 下一交易日開盤進場'],
    invalidation: ['ATR 1.5 倍停損', '族群或大盤轉弱時由投組風控降曝險'],
    entryPlan: { referencePrice: observation.nextOpen, maximumAcceptablePrice: observation.nextOpen * 1.005, orderType: 'MARKETABLE_LIMIT', timeInForce: 'ROD', session: 'REGULAR' },
    riskPlan: { stopPrice: observation.nextOpen * (1 - stopDistancePct / 100), targetPrice: observation.nextOpen * (1 + stopDistancePct * 2 / 100), riskRewardRatio: 2, positionBudget: 90_000, riskBudget: 5_000 },
    reason: `${definition.name}條件成立`, warnings: ['僅供回測；產業分類為現行靜態分類']
  };
  return {
    signalDate: observation.date, entryDate: observation.nextDate, symbol: observation.symbol, name: observation.name,
    market: observation.market, regime: observation.factors.regime, atrPct: observation.factors.atrPct,
    score: sector.rank * 50 + (flow.trust5Rank || 0) * 25 + (flow.trust10Rank || 0) * 15 + sector.stockRelative20,
    futureBars: observation.futureBars, stopDistancePct, rewardRisk: 2, maxHoldingDays: 10,
    setup: decision.setup, trigger: decision.trigger, invalidation: decision.invalidation,
    exitPlan: '2R 停利、ATR 停損或最長持有 10 個交易日', reason: decision.reason,
    orderIntent: decisionToOrderIntent(decision, { account: { equity: 1_000_000, availableCash: 1_000_000 } })
  };
}

function signalMap(rows, family, definition, startDate, endDate) {
  const map = new Map();
  for (const row of rows) {
    if (row.observation.date < startDate || row.observation.date > endDate) continue;
    const candidate = makeCandidate(row, family, definition);
    if (candidate) addCandidate(map, row.observation.date, candidate);
  }
  return map;
}

function fairRandomMap(selected, rowsByDate, family, startDate, endDate) {
  const map = new Map();
  for (const [date, selectedRows] of selected) {
    if (date < startDate || date > endDate) continue;
    const pool = (rowsByDate.get(date) || []).filter(baseTradable)
      .sort((a, b) => deterministicScore(`${family.id}|${date}|${b.observation.symbol}`) - deterministicScore(`${family.id}|${date}|${a.observation.symbol}`));
    for (const row of pool.slice(0, selectedRows.length)) {
      const candidate = makeCandidate(row, family, { id: 'fair_random', name: '公平隨機', filter: () => true });
      if (candidate) addCandidate(map, date, { ...candidate, score: deterministicScore(`${date}|${candidate.symbol}`) });
    }
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

function trainingScore(summary) {
  const pf = Number.isFinite(summary.profitFactor) ? Math.min(summary.profitFactor, 3) : 0;
  return summary.averageMonthlyReturnPct + pf * 0.25 + summary.maximumDrawdownPct * 0.04 - Math.max(0, 30 - summary.trades) * 0.08;
}

function combineFolds(folds) {
  const trades = folds.flatMap(row => row.validation.trades);
  const monthly = folds.flatMap(row => row.validation.summary.monthly.map(value => value.equityReturnPct));
  const randomMonthly = folds.flatMap(row => row.random.summary.monthly.map(value => value.equityReturnPct));
  const marketMonthlyReturns = folds.flatMap(row => row.marketReturns);
  const gains = trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(trades.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
  const compounded = monthly.reduce((value, row) => value * (1 + row / 100), 1);
  const symbols = new Map();
  for (const trade of trades) symbols.set(trade.symbol, (symbols.get(trade.symbol) || 0) + 1);
  const metrics = {
    validationTrades: trades.length,
    validationAverageMonthlyEquityReturnPct: round(mean(monthly) || 0),
    validationAnnualizedReturnPct: round(monthly.length ? (compounded ** (12 / monthly.length) - 1) * 100 : 0),
    validationProfitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    validationMaximumDrawdownPct: round(Math.min(0, ...folds.map(row => row.validation.summary.maximumDrawdownPct))),
    validationWinRatePct: round(trades.filter(row => row.realizedPnl > 0).length / Math.max(1, trades.length) * 100),
    marketAverageMonthlyReturnPct: round(mean(marketMonthlyReturns) || 0),
    randomAverageMonthlyReturnPct: round(mean(randomMonthly) || 0),
    concentrationPct: round(trades.length ? Math.max(...symbols.values()) / trades.length * 100 : 100)
  };
  metrics.minimumChecks = {
    tradeCount: metrics.validationTrades > 300,
    beatsMarket: metrics.validationAverageMonthlyEquityReturnPct > metrics.marketAverageMonthlyReturnPct,
    profitFactor: metrics.validationProfitFactor > 1.15,
    drawdown: metrics.validationMaximumDrawdownPct > -20,
    beatsRandom: metrics.validationAverageMonthlyEquityReturnPct > metrics.randomAverageMonthlyReturnPct,
    positiveAfterCosts: metrics.validationAverageMonthlyEquityReturnPct > 0,
    diversified: metrics.concentrationPct < 20,
    decisionActions: true,
    orderIntent: trades.every(row => row.orderIntent),
    historicalSectorPointInTime: false
  };
  metrics.highChecks = {
    annualized: metrics.validationAnnualizedReturnPct > 30,
    monthly: metrics.validationAverageMonthlyEquityReturnPct > 2,
    profitFactor: metrics.validationProfitFactor > 1.3,
    drawdown: metrics.validationMaximumDrawdownPct > -20
  };
  metrics.passedMinimum = Object.values(metrics.minimumChecks).every(Boolean);
  metrics.passedHighProfit = metrics.passedMinimum && Object.values(metrics.highChecks).every(Boolean);
  return metrics;
}

function registryInput(family, range, metrics) {
  return {
    strategyId: family.id,
    dataSources: ['daily_ohlcv', 'institutional_point_in_time_t_plus_1', 'sector_static_current_classification_v1'],
    setupRules: family.definitions.map(row => row.name),
    triggerRules: ['T 日收盤確認，T+1 開盤成交'],
    invalidationRules: ['ATR 1.5 倍停損', '投組風控降曝險'],
    exitRules: ['2R 停利', '最長持有 10 個交易日'],
    riskRules: ['單筆風險 0.5%', '狀態曝險上限', 'T+2'],
    blockedWhen: ['成交值過低', 'ATR 過高', '跳空過大'],
    parameters: { definitions: family.definitions.map(row => row.id), dataset: `${range.start}_${range.end}` },
    trainPeriod: { months: 36 }, validationPeriod: { months: 12, stepMonths: 12 },
    costModel: { buyFeePct: 0.1425, sellFeePct: 0.1425, sellTaxPct: 0.3, slippagePct: 0.15 },
    executionModel: { entry: 'next_open_market', settlement: 'T+2', simulator: 'shared' },
    metrics, resultStatus: metrics ? (metrics.passedMinimum ? 'passed' : 'failed') : 'inconclusive',
    failureReason: metrics?.passedMinimum ? null : 'Validation 未通過完整門檻，且歷史產業分類不是 point-in-time。',
    passedMinimum: metrics?.passedMinimum === true, passedHighProfit: metrics?.passedHighProfit === true,
    allowRetest: false, notes: '新增產業／族群資料後的獨立策略家族。'
  };
}

const [sectorPayload, sectorValidation, institutionalPayload, institutionalValidation] = await Promise.all([
  readJson(SECTOR_DATA), readJson(SECTOR_VALIDATION), readJson(INSTITUTIONAL_DATA), readJson(INSTITUTIONAL_VALIDATION)
]);
if (sectorValidation.status !== 'VALID' || institutionalValidation.status !== 'VALID') {
  console.log('產業或法人資料驗證未通過，安全停止回測。');
  process.exit(0);
}
const institutionalRows = safeInstitutionalRows(institutionalPayload);
const dates = [...new Set(institutionalRows.map(row => row.effectiveDate))].sort();
if (dates.length < 1_000) {
  console.log('法人歷史資料仍不足，尚無法完成真實 walk-forward 驗證');
  process.exit(0);
}
const context = await loadResearchContext();
const range = { start: dates[0], end: [dates.at(-1), context.endDate].sort()[0] };
const folds = foldWindows(range.start, range.end, 36, 12);
const { rows, rowsByDate } = buildResearchRows(context, institutionalRows, sectorPayload.records, range.start, range.end);
const results = [];
for (const family of FAMILIES) {
  const preInput = registryInput(family, range, null);
  const identity = buildExperimentIdentity(preInput);
  const precheck = shouldSkipExperiment(await loadRegistry(), identity, preInput);
  if (precheck.skip) {
    results.push({ id: family.id, name: family.name, skipped: true, skipReason: precheck.reason });
    continue;
  }
  const validationFolds = [];
  for (const fold of folds) {
    let best;
    for (const definition of family.definitions) {
      const train = simulateSignalMap(context, signalMap(rows, family, definition, fold.trainStart, fold.trainEnd), {
        startDate: fold.trainStart, endDate: fold.trainEnd, strategyId: `${family.id}:${definition.id}`, holdingDays: 10
      });
      const score = trainingScore(train.summary);
      if (!best || score > best.score) best = { definition, score, summary: train.summary };
    }
    const selected = signalMap(rows, family, best.definition, fold.validationStart, fold.validationEnd);
    const validation = simulateSignalMap(context, selected, {
      startDate: fold.validationStart, endDate: fold.validationEnd, strategyId: `${family.id}:${best.definition.id}`, holdingDays: 10
    });
    const random = simulateSignalMap(context, fairRandomMap(selected, rowsByDate, family, fold.validationStart, fold.validationEnd), {
      startDate: fold.validationStart, endDate: fold.validationEnd, strategyId: `${family.id}:fair_random`, holdingDays: 10
    });
    validationFolds.push({ ...fold, selectedDefinition: best.definition.id, trainSummary: best.summary, validation, random, marketReturns: marketMonthly(context, fold.validationStart, fold.validationEnd) });
  }
  const metrics = combineFolds(validationFolds);
  await appendExperiment(registryInput(family, range, metrics));
  results.push({
    id: family.id, name: family.name, skipped: false, registry: identity,
    testedDefinitions: family.definitions.map(row => ({ id: row.id, name: row.name })),
    folds: validationFolds.map(row => ({
      trainStart: row.trainStart, trainEnd: row.trainEnd, validationStart: row.validationStart, validationEnd: row.validationEnd,
      selectedDefinition: row.selectedDefinition, trainSummary: row.trainSummary, validationSummary: row.validation.summary, randomSummary: row.random.summary
    })),
    metrics
  });
  console.log(`${family.name}：交易 ${metrics.validationTrades}，月均 ${metrics.validationAverageMonthlyEquityReturnPct}%，PF ${metrics.validationProfitFactor}。`);
}
const completed = results.filter(row => !row.skipped);
const best = [...completed].sort((a, b) => b.metrics.validationAverageMonthlyEquityReturnPct - a.metrics.validationAverageMonthlyEquityReturnPct)[0] || null;
const minimumPassed = completed.filter(row => row.metrics.passedMinimum);
const highPassed = completed.filter(row => row.metrics.passedHighProfit);
const report = {
  generatedAt: new Date().toISOString(), branch: 'institutional-data-fetcher-v1',
  data: {
    sectorClassificationMode: sectorPayload.classificationMode, sectorPointInTimeSafe: false,
    sectorRecords: sectorPayload.records.length, institutionalPointInTimeSafeRecords: institutionalRows.length,
    researchRows: rows.length, dateRange: range, survivorshipBiasWarning: true
  },
  walkForward: { trainMonths: 36, validationMonths: 12, stepMonths: 12, folds: folds.length },
  familyCount: FAMILIES.length, strategyCount: FAMILIES.reduce((sum, row) => sum + row.definitions.length, 0), families: results,
  qualification: { minimumPassed: minimumPassed.map(row => row.id), highProfitPassed: highPassed.map(row => row.id) },
  bestStrategy: best ? { id: best.id, name: best.name, metrics: best.metrics } : null,
  readiness: { paperTradingAllowed: false, liveTradingAllowed: false, realBrokerAllowed: false, reason: minimumPassed.length ? '歷史產業分類不是 point-in-time，僅能保留研究候選。' : '沒有策略通過 validation。' },
  conclusion: minimumPassed.length ? '績效條件可能達標，但歷史產業分類限制尚未解除，不可進紙上交易。' : '沒有策略通過最低候選標準，不可進紙上交易、不可實盤、不可接真實券商下單。'
};
await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const table = completed.map(row => `| ${row.name} | ${row.metrics.validationTrades} | ${row.metrics.validationAverageMonthlyEquityReturnPct}% | ${row.metrics.validationAnnualizedReturnPct}% | ${row.metrics.validationProfitFactor ?? '-'} | ${row.metrics.validationMaximumDrawdownPct}% | ${row.metrics.validationWinRatePct}% | ${row.metrics.passedMinimum ? '通過' : '未通過'} |`).join('\n');
await fs.writeFile(REPORT, `# 產業／族群強度＋法人同步 Alpha 候選賽\n\n${report.conclusion}\n\n> 限制：產業資料是現行靜態分類，不是歷史 point-in-time 分類，存在分類變更與倖存者偏差。\n\n| 策略家族 | 交易數 | 月均總資產報酬 | 年化報酬 | PF | 最大回撤 | 勝率 | 結果 |\n|---|---:|---:|---:|---:|---:|---:|---|\n${table}\n\n共測 ${report.familyCount} 個新家族、${report.strategyCount} 組規則；舊法人-only 策略未重測。\n`, 'utf8');
await fs.writeFile(READINESS, `# 自動交易落地判斷\n\n更新時間：${report.generatedAt}\n\n## 結論\n\n- 紙上交易：不允許。\n- 實盤交易：不允許。\n- 真實券商下單：不允許。\n- 原因：${report.readiness.reason}\n\n## 下一個資料優先順序\n\n1. 融資融券：可補足法人訊號缺少的籌碼擁擠、散戶追價與券資壓力，優先於月營收。\n2. 月營收：適合建立較慢的基本面成長濾網，作為第二順位。\n3. 歷史產業分類：解除本次靜態分類的時間點偏差。\n`, 'utf8');
console.log(report.conclusion);
