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
const AUTO_READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);
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
    if (!sectorMetric || !flow) return;
    const index = marketIndex.get(observation.date);
    const market60 = index >= 60 ? (context.marketHistory[index].close / context.marketHistory[index - 60].close - 1) * 100 : 0;
    const marginIncreasePriceWeak = margin
      ? margin.marginChange > 0 && observation.day.close <= observation.prior.close
      : false;
    rows.push({
      observation, sector: sectorMetric, flow,
      margin: margin ? { ...margin, marginIncreasePriceWeak } : null,
      marginDataMissing: !margin,
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
      row.baseScore = rank(rel20, factors.relativeMarket20) * 20
        + rank(rel60, row.relative60) * 15
        + row.sector.rank * 20
        + (row.sector.top20 ? 8 : 0)
        + (sync ? 10 : 0)
        + rank(institution, row.flow.foreignNetBuy + row.flow.trustNetBuy) * 8
        + Math.min(2, factors.volumeRatio20 || 0) * 4
        + (factors.breakout20 ? 6 : 0)
        + (factors.distanceMa20 >= -2 && factors.distanceMa20 <= 2 && factors.ma20Slope > 0 ? 5 : 0)
        - Math.max(0, factors.atrPct - 4) * 3;
    }
  }
  return { rows, byDate, byDateSymbol };
}

const paths = [
  { id: 'core', name: 'Core Profit Hunter', marketCoverage: 'ALL', useMargin: false, requireTpexMargin: false },
  { id: 'tpex_margin', name: 'TPEx-only Margin Profit Hunter', marketCoverage: 'TPEX_ONLY', useMargin: true, requireTpexMargin: true },
  { id: 'hybrid', name: 'Hybrid Profit Hunter', marketCoverage: 'ALL_WITH_OPTIONAL_MARGIN', useMargin: true, requireTpexMargin: false }
];

function preparePathData(data, path) {
  const byDate = new Map();
  const byDateSymbol = new Map();
  const rows = [];
  for (const [date, source] of data.byDate) {
    const list = source
      .filter(row => !path.requireTpexMargin || row.margin?.market === 'TPEX')
      .map(row => {
        let marginScore = 0;
        if (path.useMargin && row.margin) {
          if (row.margin.marginOverheated) marginScore -= 20;
          if (row.margin.marginIncreasePriceWeak) marginScore -= 10;
          if (row.margin.shortCoverPressure && row.sector.top20) marginScore += 4;
        }
        return {
          ...row,
          score: row.baseScore + marginScore,
          positionPct: path.useMargin && row.margin?.shortMarginRatio >= 30 ? 4.5 : 9,
          marginDataMissing: !row.margin
        };
      })
      .sort((left, right) => right.score - left.score);
    list.forEach((row, index) => {
      row.dailyRank = index + 1;
      byDateSymbol.set(`${date}|${row.observation.symbol}`, row);
      rows.push(row);
    });
    if (list.length) byDate.set(date, list);
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
  && !['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.observation.factors.regime)
  && Math.abs(row.observation.factors.gapPct) <= 5;

function candidate(row, config, byDateSymbol) {
  const observation = row.observation;
  const support = Math.min(observation.day.low, observation.ma20, observation.priorHigh20 || observation.day.low);
  const stopDistancePct = Math.min(8, Math.max(2, (observation.nextOpen / Math.min(observation.nextOpen * 0.98, support) - 1) * 100));
  const bars = observation.futureBars.map(value => ({ ...value }));
  for (let index = 0; index + 1 < bars.length; index += 1) {
    const futureRow = byDateSymbol.get(`${bars[index].date}|${observation.symbol}`);
    const marginWeakExit = config.path.useMargin
      && futureRow?.margin?.marginChange > 0
      && futureRow.observation.day.close < futureRow.observation.ma20;
    if (futureRow && (config.exit.forced(futureRow, row) || marginWeakExit)) {
      bars[index + 1].forcedExit = {
        price: bars[index + 1].open,
        reason: marginWeakExit ? '融資增加且跌破 MA20' : config.exit.name,
        type: marginWeakExit ? 'margin_rise_weak_exit' : config.exit.id
      };
      break;
    }
  }
  const setup = ['多因子排名', `分數 ${round(row.score, 2)}`, `${row.sector.name} 強度 ${round(row.sector.rank * 100, 1)}%`];
  const trigger = [config.entry.name, 'T 日收盤確認，T+1 執行'];
  const invalidation = [config.exit.name, '融資過熱或融資增加但價格轉弱時不進場'];
  const decision = {
    date: observation.nextDate, symbol: observation.symbol, action: 'BUY', strategyId: `${config.path.id}:${config.id}`,
    setup, trigger, invalidation,
    entryPlan: { referencePrice: observation.nextOpen, maximumAcceptablePrice: observation.nextOpen * 1.005, orderType: 'MARKETABLE_LIMIT', timeInForce: 'ROD', session: 'REGULAR' },
    riskPlan: { stopPrice: observation.nextOpen * (1 - stopDistancePct / 100), targetPrice: observation.nextOpen * (1 + stopDistancePct * config.exit.rewardRisk / 100), riskRewardRatio: config.exit.rewardRisk, positionBudget: row.positionPct / 100 * 1_000_000, riskBudget: 5_000 },
    reason: `${config.name} 條件成立`,
    warnings: [
      '產業分類為現行靜態分類；僅供 validation',
      ...(row.marginDataMissing ? ['融資融券資料缺少，本筆以 unknown 處理'] : [])
    ]
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
    actionsAndIntents: metrics.buyOrderIntents === trades.length && metrics.sellDecisions === trades.length
  };
  metrics.dataWarnings = ['產業分類為現行靜態分類，不宣稱完全 point-in-time 全市場驗證。'];
  metrics.passed = Object.values(metrics.checks).every(Boolean);
  metrics.nearTenPercent = metrics.validationAverageMonthlyEquityReturnPct >= 8;
  return metrics;
}

function registryInput(path, range, metrics = null) {
  return {
    strategyId: `profit_hunter_v1_${path.id}`,
    dataSources: [
      'daily_ohlcv',
      'institutional_point_in_time_t_plus_1',
      'sector_static_current_classification_v1',
      ...(path.useMargin ? ['margin_point_in_time_t_plus_1_optional'] : [])
    ],
    setupRules: ['多因子每日排名，測試 Top 3／5／10／20'],
    triggerRules: entryModes.map(row => row.name), invalidationRules: ['融資過熱', '融資增加但價格轉弱', 'ATR 過高', '空頭或高波動大盤'],
    exitRules: exitModes.map(row => row.name), riskRules: ['單筆風險 0.5%', '集中持股', '券資比高時部位減半', 'T+2'],
    blockedWhen: ['融資過熱', '成交值低於三千萬元', 'ATR 高於 8%', '大盤防守狀態'],
    parameters: { path: path.id, marketCoverage: path.marketCoverage, configurations: configurations.map(row => row.id), dataset: `${range.start}_${range.end}` },
    trainPeriod: { months: 36 }, validationPeriod: { months: 12, stepMonths: 12 },
    costModel: { buyFeePct: 0.1425, sellFeePct: 0.1425, sellTaxPct: 0.3, slippagePct: 0.15 },
    executionModel: { entry: 'next_open_market', settlement: 'T+2', simulator: 'shared' },
    metrics, resultStatus: metrics ? (metrics.passed ? 'passed' : 'failed') : 'inconclusive',
    failureReason: metrics?.passed ? null : 'Validation 未達完整門檻。',
    passedMinimum: metrics?.passed === true, passedHighProfit: metrics?.nearTenPercent === true && metrics?.passed === true,
    allowRetest: false, coreRulesChanged: true, notes: `Profit Hunter v1 ${path.name}。`
  };
}

async function runPath(path, sourceData, context, range, folds) {
  const input = registryInput(path, range);
  const identity = buildExperimentIdentity(input);
  const precheck = shouldSkipExperiment(await loadRegistry(), identity, input);
  if (precheck.skip) return { id: path.id, name: path.name, skipped: true, reason: precheck.reason };

  const data = preparePathData(sourceData, path);
  if (!data.rows.length) return { id: path.id, name: path.name, skipped: false, status: 'NO_ELIGIBLE_ROWS', configurationsEvaluated: 0 };
  const foldResults = [];
  for (const fold of folds) {
    let best;
    for (const baseConfig of configurations) {
      const config = { ...baseConfig, path };
      const result = simulateSignalMap(context, signalMap(data, config, fold.trainStart, fold.trainEnd), {
        startDate: fold.trainStart, endDate: fold.trainEnd, strategyId: `${path.id}:${config.id}`,
        holdingDays: 10, maxOpenPositions: Math.min(config.topCount, 6)
      });
      const score = objective(result.summary);
      if (!best || score > best.score) best = { config, score, summary: result.summary };
    }
    const selected = signalMap(data, best.config, fold.validationStart, fold.validationEnd);
    const validation = simulateSignalMap(context, selected, {
      startDate: fold.validationStart, endDate: fold.validationEnd, strategyId: `${path.id}:${best.config.id}`,
      holdingDays: 10, maxOpenPositions: Math.min(best.config.topCount, 6)
    });
    const random = simulateSignalMap(context, randomMap(data, selected, best.config, fold.validationStart, fold.validationEnd), {
      startDate: fold.validationStart, endDate: fold.validationEnd, strategyId: `${path.id}:${best.config.id}:fair_random`,
      holdingDays: 10, maxOpenPositions: Math.min(best.config.topCount, 6)
    });
    foldResults.push({
      ...fold, selectedConfig: best.config, trainSummary: best.summary, validation, random,
      marketReturns: marketMonthly(context, fold.validationStart, fold.validationEnd)
    });
    console.log(`${path.name} ${fold.validationStart}：${best.config.name}，交易 ${validation.summary.trades}。`);
  }
  const metrics = combine(foldResults);
  const missingMarginRows = data.rows.filter(row => row.marginDataMissing).length;
  metrics.marginDataMissingPct = round(missingMarginRows / data.rows.length * 100);
  await appendExperiment(registryInput(path, range, metrics));
  return {
    id: path.id, name: path.name, marketCoverage: path.marketCoverage, skipped: false, status: 'COMPLETED',
    experiment: identity, configurationsEvaluated: configurations.length, researchRows: data.rows.length,
    selectedStrategies: [...new Set(foldResults.map(row => row.selectedConfig.name))], metrics,
    folds: foldResults.map(row => ({
      trainStart: row.trainStart, trainEnd: row.trainEnd,
      validationStart: row.validationStart, validationEnd: row.validationEnd,
      selectedConfig: row.selectedConfig.name,
      trainSummary: row.trainSummary, validationSummary: row.validation.summary, randomSummary: row.random.summary
    }))
  };
}

const [institutional, margin, marginValidation, sectors] = await Promise.all([
  readJson(INSTITUTIONAL), readJson(MARGIN), readJson(MARGIN_VALIDATION), readJson(SECTORS)
]);
const dates = [...new Set((institutional.records || []).filter(row => row.isPointInTimeSafe && row.effectiveDate > row.date).map(row => row.effectiveDate))].sort();
const context = await loadResearchContext();
const range = { start: dates[0], end: [dates.at(-1), context.endDate].sort()[0] };
const folds = foldWindows(range.start, range.end, 36, 12);
const sourceData = buildRows(context, institutional.records || [], margin.records || [], sectors.records || [], range.start, range.end);
const pathResults = [];
for (const path of paths) pathResults.push(await runPath(path, sourceData, context, range, folds));

const completed = pathResults.filter(row => row.status === 'COMPLETED');
const best = [...completed].sort((left, right) => right.metrics.validationAverageMonthlyEquityReturnPct - left.metrics.validationAverageMonthlyEquityReturnPct)[0] || null;
const passed = completed.filter(row => row.metrics.passed);
const effectiveBacktestConfigurations = completed.reduce((sum, row) => sum + row.configurationsEvaluated, 0);
const report = {
  generatedAt: new Date().toISOString(), branch: 'institutional-data-fetcher-v1', status: completed.length ? 'COMPLETED' : 'NO_VALID_BACKTEST',
  data: {
    institutionalDates: dates.length, marginStatus: marginValidation.status,
    marginRecords: margin.records.length, twseMarginDates: marginValidation.twseDates,
    tpexMarginDates: marginValidation.tpexDates, sectorPointInTimeSafe: false
  },
  search: {
    paths: paths.map(path => ({ id: path.id, name: path.name, marketCoverage: path.marketCoverage })),
    configurationsPerPath: configurations.length, effectiveBacktestConfigurations,
    topCounts, entryModes: entryModes.map(row => row.name), exitModes: exitModes.map(row => row.name)
  },
  walkForward: { trainMonths: 36, validationMonths: 12, stepMonths: 12, folds: folds.length },
  pathResults,
  bestStrategy: best ? {
    path: best.name, marketCoverage: best.marketCoverage,
    selectedStrategies: best.selectedStrategies, metrics: best.metrics
  } : null,
  readiness: {
    paperTradingAllowed: passed.length > 0,
    paperTradingCandidates: passed.map(row => row.name),
    liveTradingAllowed: false, realBrokerAllowed: false
  },
  conclusion: best
    ? (passed.length
      ? `${best.name} 通過最低 validation 門檻，但只能進紙上交易，不可實盤。`
      : `沒有策略通過完整門檻；目前最接近的是 ${best.name}，月均 ${best.metrics.validationAverageMonthlyEquityReturnPct}%，距離 10% 尚差 ${best.metrics.targetGapPct} 個百分點。`)
    : '沒有任何有效回測；原因是程式或資料仍無法產生候選。'
};
await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const rows = completed.map(row => `| ${row.name} | ${row.marketCoverage} | ${row.metrics.validationTrades} | ${row.metrics.validationAverageMonthlyEquityReturnPct}% | ${row.metrics.validationAnnualizedReturnPct}% | ${row.metrics.validationProfitFactor} | ${row.metrics.validationMaximumDrawdownPct}% | ${row.metrics.passed ? '通過' : '未通過'} |`).join('\n');
await fs.writeFile(REPORT, `# Profit Hunter v1\n\n${report.conclusion}\n\n| 路徑 | 市場 | 交易數 | 月均報酬 | 年化 | PF | 最大回撤 | 結果 |\n|---|---|---:|---:|---:|---:|---:|---|\n${rows}\n\n- 有效搜尋組合：${effectiveBacktestConfigurations}\n- 融資缺值在 Core／Hybrid 以 unknown 處理，不再全域停止。\n- TPEx-only 不可宣稱全台股適用；即使通過也只能紙上交易。\n- 實盤：不可。\n`, 'utf8');
await fs.writeFile(AUTO_READINESS, `# 自動交易落地判斷\n\n更新時間：${report.generatedAt}\n\n- Profit Hunter 有效回測組合：${effectiveBacktestConfigurations}\n- 紙上交易：${passed.length ? `僅允許候選 ${passed.map(row => row.name).join('、')}` : '不可'}\n- 實盤：不可\n- 真實券商下單：不可\n- 原因：${report.conclusion}\n\n下一步優先補 point-in-time 月營收與歷史產業分類，再建立「基本面成長加速＋價格確認」核心邏輯。\n`, 'utf8');
console.log(report.conclusion);
