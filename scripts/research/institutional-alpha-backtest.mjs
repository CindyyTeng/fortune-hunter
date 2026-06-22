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

const DATA = new URL('../../data/institutional/institutional-trades.json', import.meta.url);
const VALIDATION = new URL('../../data/institutional/validation-report.json', import.meta.url);
const OUTPUT = new URL('../../data/research/institutional-alpha-backtest.json', import.meta.url);
const DOCUMENT = new URL('../../docs/INSTITUTIONAL_ALPHA_BACKTEST.md', import.meta.url);
const STRATEGY_ID = 'trust_accumulation_pullback';
const WINDOWS = Object.freeze([3, 5, 10]);
const MINIMUM_DATA = Object.freeze({ pointInTimeRecords: 50_000, distinctDates: 1_000, distinctSymbols: 100 });

async function readJson(url, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(url, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function safeRecords(payload) {
  const fileLevelConservative = payload?.pointInTimePolicy?.conservativePointInTimeAssumption === true;
  return (payload?.records || []).filter(row =>
    row.isPointInTimeSafe === true
    && (row.pointInTimeMode === 'conservative_assumption' || fileLevelConservative)
    && /^\d{4}-\d{2}-\d{2}$/.test(row.effectiveDate)
    && row.effectiveDate > row.date
    && !Number.isNaN(Date.parse(row.publishedAt))
    && Date.parse(row.publishedAt) < Date.parse(`${row.effectiveDate}T09:00:00+08:00`)
  );
}

function assessData(payload, validation) {
  const records = safeRecords(payload);
  const dates = [...new Set(records.map(row => row.date))].sort();
  const symbols = new Set(records.map(row => row.symbol));
  const missing = [];
  if (records.length < MINIMUM_DATA.pointInTimeRecords) missing.push(`point-in-time 安全紀錄至少 ${MINIMUM_DATA.pointInTimeRecords} 筆`);
  if (dates.length < MINIMUM_DATA.distinctDates) missing.push(`至少 ${MINIMUM_DATA.distinctDates} 個交易日`);
  if (symbols.size < MINIMUM_DATA.distinctSymbols) missing.push(`至少 ${MINIMUM_DATA.distinctSymbols} 檔股票`);
  if (validation?.status !== 'VALID') missing.push('法人資料驗證必須通過');
  return {
    safeRecords: records,
    records: records.length,
    distinctDates: dates.length,
    distinctSymbols: symbols.size,
    dateRange: dates.length ? { start: dates[0], end: dates.at(-1) } : null,
    readyForWalkForward: missing.length === 0,
    missing
  };
}

function percentile(sorted, value) {
  if (!sorted.length) return 0;
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return low / sorted.length;
}

function buildFlowFeatures(records, marketDates) {
  const dateIndex = new Map(marketDates.map((date, index) => [date, index]));
  const flows = new Map();
  for (const row of records) {
    if (!dateIndex.has(row.effectiveDate)) continue;
    const key = `${row.effectiveDate}|${row.symbol}`;
    const current = flows.get(key) || {
      effectiveDate: row.effectiveDate,
      symbol: row.symbol,
      trustNetBuy: 0,
      foreignNetBuy: 0
    };
    current.trustNetBuy += Number(row.trustNetBuy) || 0;
    current.foreignNetBuy += Number(row.foreignNetBuy) || 0;
    flows.set(key, current);
  }

  const features = [];
  const byDate = new Map();
  for (const flow of flows.values()) {
    const index = dateIndex.get(flow.effectiveDate);
    const feature = { ...flow };
    for (const days of WINDOWS) {
      let cumulative = 0;
      let positiveDays = 0;
      let streak = 0;
      for (let offset = 0; offset < days; offset += 1) {
        const date = marketDates[index - offset];
        const value = Number(flows.get(`${date}|${flow.symbol}`)?.trustNetBuy) || 0;
        cumulative += value;
        positiveDays += value > 0 ? 1 : 0;
        if (offset === streak && value > 0) streak += 1;
      }
      feature[`trustCumulative${days}`] = cumulative;
      feature[`trustPositiveDays${days}`] = positiveDays;
      feature[`trustStreak${days}`] = streak;
    }
    features.push(feature);
    const rows = byDate.get(feature.effectiveDate) || [];
    rows.push(feature);
    byDate.set(feature.effectiveDate, rows);
  }
  for (const rows of byDate.values()) {
    for (const days of WINDOWS) {
      const sorted = rows.map(row => row[`trustCumulative${days}`]).filter(value => value > 0).sort((a, b) => a - b);
      for (const row of rows) row[`trustPercentile${days}`] = percentile(sorted, row[`trustCumulative${days}`]);
    }
  }
  return new Map(features.map(row => [`${row.effectiveDate}|${row.symbol}`, row]));
}

function buildObservations(context, flowByKey, startDate, endDate) {
  const rows = [];
  iterateObservations(context, observation => {
    const flow = flowByKey.get(`${observation.date}|${observation.symbol}`);
    if (!flow) return;
    rows.push({ observation, flow });
  }, { startDate, endDate });
  return rows;
}

function parameterGrid() {
  const rows = [];
  for (const trustDays of WINDOWS)
    for (const trustMode of ['consecutive', 'cumulative'])
      for (const trustPercentile of [0.5, 0.7, 0.9])
        for (const foreignMode of ['synchronized_buy', 'not_large_sell'])
          for (const supportMode of ['ma20', 'prior_high'])
            for (const stopMode of ['pullback_low', 'ma20', 'atr_1_5'])
              for (const exitMode of ['reward_1_5', 'reward_2', 'trailing'])
                rows.push({ trustDays, trustMode, trustPercentile, foreignMode, supportMode, stopMode, exitMode });
  return rows;
}

function addCandidate(map, date, candidate, limit = 6) {
  const rows = map.get(date) || [];
  rows.push(candidate);
  rows.sort((left, right) => right.score - left.score);
  if (rows.length > limit) rows.length = limit;
  map.set(date, rows);
}

function candidateFor(row, parameters) {
  const { observation, flow } = row;
  const { factors, day } = observation;
  const days = parameters.trustDays;
  const cumulative = flow[`trustCumulative${days}`];
  const percentileRank = flow[`trustPercentile${days}`];
  const trustPass = parameters.trustMode === 'consecutive'
    ? flow[`trustStreak${days}`] >= days
    : cumulative > 0 && flow[`trustPositiveDays${days}`] >= Math.ceil(days * 0.6);
  const foreignPass = parameters.foreignMode === 'synchronized_buy'
    ? flow.foreignNetBuy > 0
    : flow.foreignNetBuy >= -Math.max(Math.abs(cumulative) * 2, 1_000_000);
  const trendPass = factors.distanceMa60 > 0
    && (factors.ma20Slope > 0 || factors.ma60Slope > 0)
    && factors.relativeMarket20 > 0;
  const supportPass = parameters.supportMode === 'ma20'
    ? factors.distanceMa20 >= -3 && factors.distanceMa20 <= 3
    : day.close >= observation.priorHigh20 * 0.96 && day.close <= observation.priorHigh20 * 1.01;
  const blocked = Math.abs(factors.gapPct) > 3
    || factors.distanceMa20 > 6
    || factors.transactionValue < 20_000_000
    || factors.atrPct > 5
    || factors.longUpperWick
    || day.close <= day.open;
  if (!trustPass || percentileRank < parameters.trustPercentile || !foreignPass || !trendPass || !supportPass || blocked) return null;

  const entryPrice = observation.nextOpen;
  const stopReference = {
    pullback_low: day.low,
    ma20: observation.ma20 * 0.99,
    atr_1_5: entryPrice * (1 - factors.atrPct * 1.5 / 100)
  }[parameters.stopMode];
  if (!Number.isFinite(stopReference) || stopReference >= entryPrice) return null;
  const stopDistancePct = Math.min(8, Math.max(2, (entryPrice - stopReference) / entryPrice * 100));
  const rewardRisk = parameters.exitMode === 'reward_1_5' ? 1.5 : parameters.exitMode === 'reward_2' ? 2 : null;
  const stopPrice = entryPrice * (1 - stopDistancePct / 100);
  const intentTarget = entryPrice * (1 + stopDistancePct * (rewardRisk || 2) / 100);
  const setup = [`投信 ${parameters.trustMode === 'consecutive' ? '連買' : '累計買超'} ${days} 日條件成立`, '股價在 MA60 上且趨勢向上', '相對大盤強'];
  const trigger = [parameters.supportMode === 'ma20' ? '回測 MA20 後收紅' : '回測前高支撐後收紅'];
  const invalidation = ['跌破回測支撐', '跌破 MA20', '投信轉賣且股價轉弱'];
  const decision = {
    date: observation.nextDate,
    symbol: observation.symbol,
    action: 'BUY',
    strategyId: STRATEGY_ID,
    setup,
    trigger,
    invalidation,
    entryPlan: {
      referencePrice: entryPrice,
      maximumAcceptablePrice: entryPrice * 1.005,
      orderType: 'MARKETABLE_LIMIT',
      timeInForce: 'ROD',
      session: 'REGULAR'
    },
    riskPlan: {
      stopPrice,
      targetPrice: intentTarget,
      riskRewardRatio: rewardRisk || 2,
      positionBudget: 90_000,
      riskBudget: 5_000
    },
    reason: '投信連買強勢股回檔 Setup 與 Trigger 成立',
    warnings: ['法人資料採 T 日公布、T+1 才可使用的保守假設']
  };
  return {
    signalDate: observation.date,
    entryDate: observation.nextDate,
    symbol: observation.symbol,
    name: observation.name,
    market: observation.market,
    regime: factors.regime,
    atrPct: factors.atrPct,
    score: percentileRank * 100 + factors.relativeMarket20 + factors.transactionValuePercentile * 10,
    futureBars: observation.futureBars,
    stopDistancePct,
    rewardRisk,
    maxHoldingDays: parameters.exitMode === 'trailing' ? 15 : 10,
    trailingStopRule: parameters.exitMode === 'trailing' ? { triggerPct: 4, givebackPct: 3, lockPct: 1 } : null,
    setup,
    trigger,
    invalidation,
    exitPlan: parameters.exitMode,
    reason: decision.reason,
    orderIntent: decisionToOrderIntent(decision, { account: { equity: 1_000_000, availableCash: 1_000_000 } })
  };
}

function signalMap(rows, parameters, startDate, endDate) {
  const map = new Map();
  for (const row of rows) {
    const date = row.observation.date;
    if (date < startDate || date > endDate) continue;
    const candidate = candidateFor(row, parameters);
    if (candidate) addCandidate(map, date, candidate);
  }
  return map;
}

function randomSignalMap(rows, startDate, endDate) {
  const map = new Map();
  for (const row of rows) {
    const { observation } = row;
    if (observation.date < startDate || observation.date > endDate) continue;
    if (observation.factors.transactionValue < 20_000_000 || observation.factors.atrPct > 5) continue;
    addCandidate(map, observation.date, {
      signalDate: observation.date,
      entryDate: observation.nextDate,
      symbol: observation.symbol,
      name: observation.name,
      market: observation.market,
      regime: observation.factors.regime,
      atrPct: observation.factors.atrPct,
      score: deterministicScore(`${observation.date}|${observation.symbol}`),
      futureBars: observation.futureBars,
      stopDistancePct: Math.min(8, Math.max(2, observation.factors.atrPct * 1.5)),
      rewardRisk: 2,
      maxHoldingDays: 10,
      setup: ['同資料可用範圍內公平隨機抽樣'],
      trigger: ['次日開盤'],
      invalidation: ['ATR 停損'],
      exitPlan: 'reward_2',
      reason: '公平隨機基準'
    });
  }
  return map;
}

function marketMonthlyReturns(context, startDate, endDate) {
  const rows = context.marketHistory.filter(row => row.date <= endDate);
  const monthEnds = new Map();
  let priorClose = null;
  for (const row of rows) {
    if (row.date < startDate) priorClose = row.close;
    else monthEnds.set(row.date.slice(0, 7), row.close);
  }
  const returns = [];
  for (const close of monthEnds.values()) {
    if (priorClose) returns.push((close / priorClose - 1) * 100);
    priorClose = close;
  }
  return returns;
}

function trainingScore(summary) {
  const profitFactor = Number.isFinite(summary.profitFactor) ? Math.min(summary.profitFactor, 3) : 0;
  const lowTradePenalty = summary.trades < 30 ? (30 - summary.trades) * 0.08 : 0;
  return summary.averageMonthlyReturnPct + profitFactor * 0.25 + summary.maximumDrawdownPct * 0.04 - lowTradePenalty;
}

function combineValidation(folds) {
  const trades = folds.flatMap(fold => fold.validation.trades);
  const monthly = folds.flatMap(fold => fold.validation.summary.monthly);
  const marketMonths = folds.flatMap(fold => fold.marketMonthlyReturns);
  const randomMonths = folds.flatMap(fold => fold.random.summary.monthly.map(row => row.equityReturnPct));
  const gains = trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(trades.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
  const compounded = monthly.reduce((value, row) => value * (1 + row.equityReturnPct / 100), 1);
  const annualizedReturnPct = monthly.length ? (compounded ** (12 / monthly.length) - 1) * 100 : 0;
  const symbolCounts = new Map();
  for (const trade of trades) symbolCounts.set(trade.symbol, (symbolCounts.get(trade.symbol) || 0) + 1);
  const concentrationPct = trades.length ? Math.max(...symbolCounts.values()) / trades.length * 100 : 100;
  const combined = {
    validationTrades: trades.length,
    validationAverageMonthlyEquityReturnPct: round(mean(monthly.map(row => row.equityReturnPct)) || 0),
    validationAverageAnnualizedReturnPct: round(annualizedReturnPct),
    validationProfitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    validationMaximumDrawdownPct: round(Math.min(0, ...folds.map(fold => fold.validation.summary.maximumDrawdownPct))),
    validationWinRatePct: round(trades.filter(row => row.realizedPnl > 0).length / Math.max(1, trades.length) * 100),
    marketAverageMonthlyReturnPct: round(mean(marketMonths) || 0),
    randomAverageMonthlyEquityReturnPct: round(mean(randomMonths) || 0),
    concentrationPct: round(concentrationPct),
    validationMonths: monthly.length
  };
  const minimumChecks = {
    beatsMarket: combined.validationAverageMonthlyEquityReturnPct > combined.marketAverageMonthlyReturnPct,
    profitFactor: combined.validationProfitFactor > 1.15,
    drawdown: combined.validationMaximumDrawdownPct > -20,
    tradeCount: combined.validationTrades > 300,
    beatsRandom: combined.validationAverageMonthlyEquityReturnPct > combined.randomAverageMonthlyEquityReturnPct,
    diversified: combined.concentrationPct < 20,
    afterCostsPositive: combined.validationAverageMonthlyEquityReturnPct > 0
  };
  const highChecks = {
    annualizedReturn: combined.validationAverageAnnualizedReturnPct > 30,
    averageMonthly: combined.validationAverageMonthlyEquityReturnPct > 2,
    profitFactor: combined.validationProfitFactor > 1.3,
    drawdown: combined.validationMaximumDrawdownPct > -20
  };
  return {
    ...combined,
    minimumChecks,
    highChecks,
    passedMinimum: Object.values(minimumChecks).every(Boolean),
    passedHighProfit: Object.values(highChecks).every(Boolean),
    trades: trades.map(trade => ({
      symbol: trade.symbol,
      name: trade.name,
      signalDate: trade.signalDate,
      entryDate: trade.entryDate,
      exitDate: trade.exitDate,
      tradeReturnPct: trade.tradeReturnPct,
      setup: trade.setup,
      trigger: trade.trigger,
      invalidation: trade.invalidation,
      exitReason: trade.exitReason,
      orderIntent: trade.orderIntent
    }))
  };
}

function registryInput(assessment, gridCount, walkForward) {
  const combined = walkForward?.combined;
  return {
    strategyId: STRATEGY_ID,
    dataSources: ['daily_ohlcv', 'market_regime', 'institutional_trust', 'institutional_foreign', 'institutional_point_in_time_policy'],
    setupRules: ['投信連買或累計買超', '外資同步買超或未大賣', 'MA60 上方且均線向上', '相對大盤強'],
    triggerRules: ['回測 MA20 或前高支撐後收紅', '次日開盤進場'],
    invalidationRules: ['回測低點停損', 'MA20 停損', 'ATR 1.5 倍停損'],
    exitRules: ['1.5R', '2R', '移動停利', '最長持有 10 或 15 日'],
    riskRules: ['真實手續費', '交易稅', '滑價', 'T+2', '單筆帳戶風險上限 0.5%'],
    blockedWhen: ['跳空過大', '離 MA20 過遠', '成交值太低', 'ATR 過高', '長上影線'],
    parameters: {
      gridCount,
      datasetVersion: `${assessment.dateRange.start}_${assessment.dateRange.end}_${assessment.records}`,
      pointInTimePolicy: 'conservative_assumption_t_plus_1'
    },
    trainPeriod: { months: 36 },
    validationPeriod: { months: 12, stepMonths: 12 },
    costModel: { buyFeePct: 0.1425, sellFeePct: 0.1425, sellTaxPct: 0.3, slippagePct: 0.15 },
    executionModel: { entry: 'next_open_market', exit: 'shared execution-simulator', settlement: 'T+2' },
    metrics: combined || { records: assessment.records, distinctDates: assessment.distinctDates },
    resultStatus: combined?.passedMinimum ? 'passed' : walkForward ? 'failed' : 'data_missing',
    failureReason: combined?.passedMinimum ? null : walkForward ? 'Validation 未通過最低候選標準' : assessment.missing.join('；'),
    overfitFlag: false,
    passedMinimum: combined?.passedMinimum === true,
    passedHighProfit: combined?.passedHighProfit === true,
    allowRetest: !walkForward,
    notes: walkForward ? '已完成真實 rolling walk-forward。' : '資料不足，未執行 walk-forward。'
  };
}

function markdown(report) {
  const combined = report.walkForward?.combined;
  const value = (item, suffix = '') => item == null ? '未產生' : `${item}${suffix}`;
  return `# 投信連買強勢股回檔策略驗證

產生時間：${report.generatedAt}

## 結論

**${report.conclusion}**

## 資料狀態

- point-in-time 安全筆數：${report.dataAssessment.records}
- 交易日數：${report.dataAssessment.distinctDates}
- 股票檔數：${report.dataAssessment.distinctSymbols}
- 是否足夠 walk-forward：${report.dataAssessment.readyForWalkForward ? '是' : '否'}
- 倖存者偏差警告：有，OHLCV 股票池來自現有研究候選歷史

## Walk-forward

- 訓練：36 個月
- 驗證：12 個月
- 每次前進：12 個月
- 測試參數組合：${report.parameterGridCount}
- Fold 數：${report.walkForward?.folds.length || 0}
- Validation 交易次數：${value(combined?.validationTrades)}
- 月均總資產報酬：${value(combined?.validationAverageMonthlyEquityReturnPct, '%')}
- 年化報酬：${value(combined?.validationAverageAnnualizedReturnPct, '%')}
- Profit Factor：${value(combined?.validationProfitFactor)}
- 最大回撤：${value(combined?.validationMaximumDrawdownPct, '%')}
- 勝率：${value(combined?.validationWinRatePct, '%')}
- 大盤同期月均：${value(combined?.marketAverageMonthlyReturnPct, '%')}
- 公平隨機月均：${value(combined?.randomAverageMonthlyEquityReturnPct, '%')}
- 通過最低候選標準：${combined?.passedMinimum ? '是' : '否'}
- 通過高報酬候選標準：${combined?.passedHighProfit ? '是' : '否'}

## 風險警告

- 法人資料採 conservative point-in-time assumption，不是逐筆 fully verified publishedAt。
- T 日法人資料只允許 T+1 交易日使用；本回測使用 T+1 收盤確認、下一交易日開盤進場，較規則更保守。
- 注意股、處置股、除權息、減資、分割資料尚未完整介接。
`;
}

const [payload, validation] = await Promise.all([readJson(DATA), readJson(VALIDATION)]);
const assessment = assessData(payload, validation);
const grid = parameterGrid();
const preliminaryInput = registryInput(assessment, grid.length, null);
const identity = buildExperimentIdentity(preliminaryInput);
const registry = await loadRegistry();
const precheck = shouldSkipExperiment(registry, identity, preliminaryInput);

let walkForward = null;
if (assessment.readyForWalkForward && !precheck.skip) {
  const context = await loadResearchContext();
  const marketDates = context.marketHistory.map(row => row.date);
  const overlapStart = assessment.dateRange.start;
  const overlapEnd = [assessment.dateRange.end, context.endDate].sort().at(0);
  const flowByKey = buildFlowFeatures(assessment.safeRecords, marketDates);
  const observations = buildObservations(context, flowByKey, overlapStart, overlapEnd);
  const folds = [];
  for (const window of foldWindows(overlapStart, overlapEnd, 36, 12)) {
    let best = null;
    for (const parameters of grid) {
      const map = signalMap(observations, parameters, window.trainStart, window.trainEnd);
      const result = simulateSignalMap(context, map, {
        startDate: window.trainStart,
        endDate: window.trainEnd,
        strategyId: STRATEGY_ID,
        holdingDays: 10
      });
      const score = trainingScore(result.summary);
      if (!best || score > best.score) best = { parameters, score, summary: result.summary };
    }
    const validationMap = signalMap(observations, best.parameters, window.validationStart, window.validationEnd);
    const validationResult = simulateSignalMap(context, validationMap, {
      startDate: window.validationStart,
      endDate: window.validationEnd,
      strategyId: STRATEGY_ID,
      holdingDays: 10
    });
    const randomResult = simulateSignalMap(
      context,
      randomSignalMap(observations, window.validationStart, window.validationEnd),
      {
        startDate: window.validationStart,
        endDate: window.validationEnd,
        strategyId: 'fair_random_institutional_universe',
        holdingDays: 10
      }
    );
    folds.push({
      ...window,
      bestParameters: best.parameters,
      trainSummary: best.summary,
      validation: validationResult,
      random: randomResult,
      marketMonthlyReturns: marketMonthlyReturns(context, window.validationStart, window.validationEnd)
    });
  }
  const combined = combineValidation(folds);
  const compactFolds = folds.map(fold => ({
    trainStart: fold.trainStart,
    trainEnd: fold.trainEnd,
    validationStart: fold.validationStart,
    validationEnd: fold.validationEnd,
    bestParameters: fold.bestParameters,
    trainSummary: fold.trainSummary,
    validationSummary: fold.validation.summary,
    randomSummary: fold.random.summary,
    marketMonthlyReturns: fold.marketMonthlyReturns
  }));
  walkForward = {
    overlapDateRange: { start: overlapStart, end: overlapEnd },
    observationCount: observations.length,
    folds: compactFolds,
    combined
  };
}

const combined = walkForward?.combined;
const conclusion = !assessment.readyForWalkForward
  ? '法人歷史資料不足，尚無法完成真實 walk-forward 驗證'
  : precheck.skip
    ? `策略 registry 已跳過重複實驗：${precheck.reason}`
    : combined?.passedHighProfit
      ? '策略通過高報酬候選標準'
      : combined?.passedMinimum
        ? '策略通過最低候選標準，但未通過高報酬候選標準'
        : '沒有策略通過最低候選標準，也沒有策略通過高報酬候選標準';

const report = {
  branch: 'institutional-data-fetcher-v1',
  generatedAt: new Date().toISOString(),
  strategyId: STRATEGY_ID,
  strategyName: '投信連買強勢股回檔策略',
  sourceStatus: payload?.sourceStatus || '資料來源待確認',
  survivorshipBiasWarning: true,
  parameterGridCount: grid.length,
  walkForwardConfiguration: { trainMonths: 36, validationMonths: 12, stepMonths: 12, trainOnlyParameterSelection: true },
  dataAssessment: { ...assessment, safeRecords: undefined },
  registry: { experimentHash: identity.experimentHash, strategyFamilyId: identity.strategyFamilyId, precheck },
  walkForward,
  qualification: {
    researchMinimumCandidatePassed: combined?.passedMinimum === true,
    researchHighProfitCandidatePassed: combined?.passedHighProfit === true,
    executableCandidatePassed: combined?.passedMinimum === true
  },
  conclusion
};

const registryResult = await appendExperiment(registryInput(assessment, grid.length, walkForward));
report.registry.appended = registryResult.appended;
report.registry.skip = registryResult.skip;

await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await fs.writeFile(DOCUMENT, markdown(report), 'utf8');

console.log(`法人安全紀錄：${assessment.records} 筆；交易日：${assessment.distinctDates}；股票：${assessment.distinctSymbols}。`);
console.log(`參數組合：${grid.length}；registry appended=${registryResult.appended}。`);
if (combined) {
  console.log(`Validation：交易 ${combined.validationTrades} 筆，月均 ${combined.validationAverageMonthlyEquityReturnPct}%，年化 ${combined.validationAverageAnnualizedReturnPct}%，PF=${combined.validationProfitFactor}，MDD=${combined.validationMaximumDrawdownPct}%。`);
}
console.log(conclusion);
