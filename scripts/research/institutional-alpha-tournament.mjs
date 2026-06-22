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

const DATA = new URL('../../data/institutional/institutional-trades.json', import.meta.url);
const VALIDATION = new URL('../../data/institutional/validation-report.json', import.meta.url);
const REGISTRY = new URL('../../data/research/strategy-experiment-registry.json', import.meta.url);
const OUTPUT = new URL('../../data/research/institutional-alpha-tournament.json', import.meta.url);
const REPORT = new URL('../../docs/INSTITUTIONAL_ALPHA_TOURNAMENT.md', import.meta.url);
const READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);
const HORIZONS = Object.freeze([1, 5, 10, 20]);

async function readJson(url, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(url, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function safeRows(payload) {
  const fileSafe = payload?.pointInTimePolicy?.conservativePointInTimeAssumption === true;
  return (payload?.records || []).filter(row =>
    row.isPointInTimeSafe === true
    && (row.pointInTimeMode === 'conservative_assumption' || fileSafe)
    && row.effectiveDate > row.date
  );
}

async function lockFailedStrategy() {
  const registry = await loadRegistry();
  let changed = false;
  for (const row of registry.experiments) {
    if (row.strategyId !== 'trust_accumulation_pullback' || row.resultStatus !== 'failed') continue;
    row.strategyDisposition = 'FAILED_DO_NOT_RETUNE';
    row.allowRetest = false;
    row.paperTradingAllowed = false;
    row.liveTradingAllowed = false;
    row.failureReason = 'Validation 僅 35 筆、Profit Factor 小於 1、策略虧損且輸給 0050／大盤；除非新增月營收、融資融券或產業族群資料，否則禁止重測。';
    changed = true;
  }
  if (changed) {
    registry.updatedAt = new Date().toISOString();
    await fs.writeFile(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  }
}

function percentile(sorted, value) {
  if (!sorted.length || !Number.isFinite(value)) return 0;
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return low / sorted.length;
}

function compactFlows(records, marketDates) {
  const dateIndex = new Map(marketDates.map((date, index) => [date, index]));
  const map = new Map();
  for (const row of records) {
    if (!dateIndex.has(row.effectiveDate)) continue;
    const key = `${row.effectiveDate}|${row.symbol}`;
    const value = map.get(key) || { trust: 0, foreign: 0, dealer: 0 };
    value.trust += Number(row.trustNetBuy) || 0;
    value.foreign += Number(row.foreignNetBuy) || 0;
    value.dealer += Number(row.dealerNetBuy) || 0;
    map.set(key, value);
  }
  return { map, dateIndex };
}

function buildRows(context, records, startDate, endDate) {
  const marketDates = context.marketHistory.map(row => row.date);
  const { map: flowMap, dateIndex } = compactFlows(records, marketDates);
  const rows = [];
  iterateObservations(context, observation => {
    const current = flowMap.get(`${observation.date}|${observation.symbol}`);
    if (!current) return;
    const index = dateIndex.get(observation.date);
    const prior = offset => flowMap.get(`${marketDates[index - offset]}|${observation.symbol}`) || { trust: 0, foreign: 0, dealer: 0 };
    const flow = { ...current };
    for (const days of [5, 10, 20]) {
      let trust = 0;
      let foreign = 0;
      let dealer = 0;
      for (let offset = 0; offset < days; offset += 1) {
        const value = prior(offset);
        trust += value.trust;
        foreign += value.foreign;
        dealer += value.dealer;
      }
      flow[`trust${days}`] = trust;
      flow[`foreign${days}`] = foreign;
      flow[`dealer${days}`] = dealer;
      flow[`total${days}`] = trust + foreign + dealer;
    }
    flow.trustPrevious = prior(1).trust;
    flow.foreignPrevious = prior(1).foreign;
    flow.totalPrevious = prior(1).trust + prior(1).foreign + prior(1).dealer;
    flow.priorTrustNegativeDays5 = Array.from({ length: 5 }, (_, offset) => prior(offset + 1).trust < 0).filter(Boolean).length;
    flow.trustStreak = 0;
    for (let offset = 0; offset < 20 && prior(offset).trust > 0; offset += 1) flow.trustStreak += 1;
    const priorTrustAbs = Array.from({ length: 20 }, (_, offset) => Math.abs(prior(offset + 1).trust));
    flow.trustSuddenRatio = Math.abs(current.trust) / Math.max(1, mean(priorTrustAbs) || 1);
    flow.trustVolumeRatio = current.trust / Math.max(1, observation.day.volume);
    flow.totalCurrent = current.trust + current.foreign + current.dealer;
    rows.push({ observation, flow });
  }, { startDate, endDate });

  const byDate = new Map();
  for (const row of rows) {
    const list = byDate.get(row.observation.date) || [];
    list.push(row);
    byDate.set(row.observation.date, list);
  }
  for (const list of byDate.values()) {
    for (const field of ['trust5', 'trust10', 'trust20', 'foreign', 'totalCurrent', 'trustVolumeRatio', 'trustSuddenRatio']) {
      const sorted = list.map(row => row.flow[field]).filter(Number.isFinite).sort((a, b) => a - b);
      for (const row of list) row.flow[`${field}Rank`] = percentile(sorted, row.flow[field]);
    }
  }
  return rows;
}

const trend = row => row.observation.factors.distanceMa60 > 0 && row.observation.factors.ma20Slope > 0;
const tradable = row => row.observation.factors.transactionValue >= 20_000_000 && row.observation.factors.atrPct <= 8;
const positiveInstitutions = flow => [flow.trust, flow.foreign, flow.dealer].filter(value => value > 0).length;

const FAMILIES = Object.freeze([
  ['trust_flow_intensity', '投信買超強度', [
    ['trust5_top', '投信 5 日累計買超高分位', row => row.flow.trust5 > 0 && row.flow.trust5Rank >= 0.8],
    ['trust10_top', '投信 10 日累計買超高分位', row => row.flow.trust10 > 0 && row.flow.trust10Rank >= 0.8],
    ['trust20_top', '投信 20 日累計買超高分位', row => row.flow.trust20 > 0 && row.flow.trust20Rank >= 0.8],
    ['trust_sudden', '投信買超突然放大', row => row.flow.trust > 0 && row.flow.trustSuddenRatio >= 2 && row.flow.trustVolumeRatio > 0]
  ]],
  ['foreign_trust_sync', '外資與投信同步', [
    ['sync_buy', '外資與投信同時買超', row => row.flow.trust > 0 && row.flow.foreign > 0],
    ['trust_foreign_not_sell', '投信買且外資不賣', row => row.flow.trust > 0 && row.flow.foreign >= 0],
    ['foreign_large_trust_buy', '外資大買且投信買超', row => row.flow.foreignRank >= 0.8 && row.flow.trust > 0],
    ['multi_institution_buy', '至少兩類法人同步買超', row => positiveInstitutions(row.flow) >= 2 && row.flow.totalCurrent > 0]
  ]],
  ['institutional_flow_reversal', '法人買超轉折', [
    ['trust_turn_positive', '投信由賣轉買', row => row.flow.trustPrevious < 0 && row.flow.trust > 0],
    ['foreign_turn_positive', '外資由賣轉買', row => row.flow.foreignPrevious < 0 && row.flow.foreign > 0],
    ['total_turn_positive', '三大法人合計由賣轉買', row => row.flow.totalPrevious < 0 && row.flow.totalCurrent > 0],
    ['trust_sell_streak_end', '投信連續賣超結束後轉正', row => row.flow.priorTrustNegativeDays5 >= 3 && row.flow.trust > 0]
  ]],
  ['institutional_relative_strength', '法人買超與強勢股', [
    ['flow_relative_strength', '法人買超且相對大盤強', row => row.flow.totalCurrent > 0 && row.observation.factors.relativeMarket20 >= 3 && trend(row)],
    ['trust_breakout', '投信買超後突破前高', row => row.flow.trust > 0 && row.observation.factors.breakout20 && trend(row)],
    ['trust_pullback_hold', '投信買超後回測 MA20 不破', row => row.flow.trust > 0 && row.observation.factors.distanceMa20 >= -2 && row.observation.factors.distanceMa20 <= 2 && row.observation.day.close > row.observation.day.open && trend(row)],
    ['total_top_strong', '法人高分位且個股強勢', row => row.flow.totalCurrentRank >= 0.8 && row.flow.totalCurrent > 0 && row.observation.factors.relativeMarket20 >= 5 && trend(row)]
  ]],
  ['institutional_risk_exclusion', '法人買超與風險排除', [
    ['market_above_ma60', '大盤 MA60 上方才買', row => row.flow.trust5 > 0 && row.observation.factors.marketAboveMa60],
    ['exclude_high_atr', '排除 ATR 過高', row => row.flow.trust5 > 0 && row.observation.factors.atrPct <= 3],
    ['exclude_gap_distance', '排除大跳空與乖離過大', row => row.flow.trust5 > 0 && Math.abs(row.observation.factors.gapPct) <= 2 && Math.abs(row.observation.factors.distanceMa20) <= 4],
    ['exclude_low_value_wick', '排除低成交值與長上影', row => row.flow.trust5 > 0 && row.observation.factors.transactionValue >= 50_000_000 && !row.observation.factors.longUpperWick]
  ]],
  ['institutional_contrarian_audit', '法人訊號反向檢查', [
    ['trust_extreme_chase', '投信極端買超追高', row => row.flow.trust5Rank >= 0.95 && row.flow.trust5 > 0 && row.observation.factors.distanceMa20 > 4],
    ['foreign_extreme_chase', '外資極端買超追高', row => row.flow.foreignRank >= 0.95 && row.flow.foreign > 0 && row.observation.factors.gapPct > 2],
    ['trust_streak_5', '投信連買第 5 日後', row => row.flow.trustStreak >= 5],
    ['trust_streak_10', '投信連買第 10 日後', row => row.flow.trustStreak >= 10]
  ]]
].map(([id, label, definitions]) => ({
  id,
  label,
  definitions: definitions.map(([definitionId, definitionLabel, filter]) => ({ id: definitionId, label: definitionLabel, filter }))
})));

function addCandidate(map, date, value, limit = 6) {
  const rows = map.get(date) || [];
  rows.push(value);
  rows.sort((left, right) => right.score - left.score);
  if (rows.length > limit) rows.length = limit;
  map.set(date, rows);
}

function candidate(row, family, definition) {
  if (!tradable(row) || !definition.filter(row)) return null;
  const { observation, flow } = row;
  const stopDistancePct = Math.min(8, Math.max(2, observation.factors.atrPct * 1.5));
  const stopPrice = observation.nextOpen * (1 - stopDistancePct / 100);
  const targetPrice = observation.nextOpen * (1 + stopDistancePct * 2 / 100);
  const setup = [family.label, definition.label, '法人資料已於前一交易日收盤後公布'];
  const trigger = ['訊號日收盤確認後，下一交易日開盤進場'];
  const invalidation = ['ATR 1.5 倍停損', '市場風控熔斷'];
  const decision = {
    date: observation.nextDate,
    symbol: observation.symbol,
    action: 'BUY',
    strategyId: `${family.id}:${definition.id}`,
    setup,
    trigger,
    invalidation,
    entryPlan: { referencePrice: observation.nextOpen, maximumAcceptablePrice: observation.nextOpen * 1.005, orderType: 'MARKETABLE_LIMIT', timeInForce: 'ROD', session: 'REGULAR' },
    riskPlan: { stopPrice, targetPrice, riskRewardRatio: 2, positionBudget: 90_000, riskBudget: 5_000 },
    reason: `${definition.label} Setup 成立`,
    warnings: ['僅供回測與下單意圖 dry-run']
  };
  return {
    signalDate: observation.date,
    entryDate: observation.nextDate,
    symbol: observation.symbol,
    name: observation.name,
    market: observation.market,
    regime: observation.factors.regime,
    atrPct: observation.factors.atrPct,
    score: (flow.trust5Rank || 0) * 30 + (flow.foreignRank || 0) * 20 + observation.factors.relativeMarket20,
    futureBars: observation.futureBars,
    stopDistancePct,
    rewardRisk: 2,
    maxHoldingDays: 10,
    setup,
    trigger,
    invalidation,
    exitPlan: '2R、ATR 停損或最長持有 10 日',
    reason: decision.reason,
    orderIntent: decisionToOrderIntent(decision, { account: { equity: 1_000_000, availableCash: 1_000_000 } })
  };
}

function signalMap(rows, family, definition, startDate, endDate) {
  const map = new Map();
  for (const row of rows) {
    if (row.observation.date < startDate || row.observation.date > endDate) continue;
    const value = candidate(row, family, definition);
    if (value) addCandidate(map, row.observation.date, value);
  }
  return map;
}

function randomMap(rows, startDate, endDate) {
  const map = new Map();
  for (const row of rows) {
    const { observation } = row;
    if (observation.date < startDate || observation.date > endDate || !tradable(row)) continue;
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
      setup: ['同法人資料可用範圍內公平隨機抽樣'],
      trigger: ['下一交易日開盤'],
      invalidation: ['ATR 停損'],
      reason: '公平隨機基準'
    });
  }
  return map;
}

function marketMonthly(context, startDate, endDate) {
  const monthEnds = new Map();
  let priorClose = null;
  for (const row of context.marketHistory.filter(row => row.date <= endDate)) {
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

function forwardSummary(rows, definition, ranges) {
  const values = Object.fromEntries(HORIZONS.map(horizon => [horizon, []]));
  for (const row of rows) {
    if (!ranges.some(range => row.observation.date >= range.validationStart && row.observation.date <= range.validationEnd)) continue;
    if (!tradable(row) || !definition.filter(row)) continue;
    for (const horizon of HORIZONS) {
      const exit = row.observation.futureBars[horizon - 1]?.close;
      if (Number.isFinite(exit)) values[horizon].push(netReturnPct(row.observation.nextOpen, exit));
    }
  }
  return Object.fromEntries(HORIZONS.map(horizon => {
    const returns = values[horizon];
    const sorted = [...returns].sort((a, b) => a - b);
    const gains = returns.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
    const losses = Math.abs(returns.filter(value => value <= 0).reduce((sum, value) => sum + value, 0));
    return [horizon, {
      samples: returns.length,
      averageNetReturnPct: round(mean(returns) || 0),
      medianNetReturnPct: round(sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0),
      winRatePct: round(returns.filter(value => value > 0).length / Math.max(1, returns.length) * 100),
      profitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0
    }];
  }));
}

function trainingScore(summary) {
  const pf = Number.isFinite(summary.profitFactor) ? Math.min(summary.profitFactor, 3) : 0;
  return summary.averageMonthlyReturnPct + pf * 0.25 + summary.maximumDrawdownPct * 0.04 - Math.max(0, 30 - summary.trades) * 0.08;
}

function combineFolds(folds) {
  const trades = folds.flatMap(fold => fold.validation.trades);
  const monthly = folds.flatMap(fold => fold.validation.summary.monthly.map(row => row.equityReturnPct));
  const randomMonthly = folds.flatMap(fold => fold.random.summary.monthly.map(row => row.equityReturnPct));
  const marketReturns = folds.flatMap(fold => fold.marketReturns);
  const gains = trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(trades.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
  const compounded = monthly.reduce((value, row) => value * (1 + row / 100), 1);
  const years = new Map();
  const symbols = new Map();
  for (const trade of trades) {
    const year = trade.exitDate.slice(0, 4);
    years.set(year, (years.get(year) || 0) + trade.realizedPnl);
    symbols.set(trade.symbol, (symbols.get(trade.symbol) || 0) + 1);
  }
  const result = {
    validationTrades: trades.length,
    validationAverageMonthlyEquityReturnPct: round(mean(monthly) || 0),
    validationAnnualizedReturnPct: round(monthly.length ? (compounded ** (12 / monthly.length) - 1) * 100 : 0),
    validationProfitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    validationMaximumDrawdownPct: round(Math.min(0, ...folds.map(fold => fold.validation.summary.maximumDrawdownPct))),
    validationWinRatePct: round(trades.filter(row => row.realizedPnl > 0).length / Math.max(1, trades.length) * 100),
    marketAverageMonthlyReturnPct: round(mean(marketReturns) || 0),
    randomAverageMonthlyReturnPct: round(mean(randomMonthly) || 0),
    concentrationPct: round(trades.length ? Math.max(...symbols.values()) / trades.length * 100 : 100),
    profitableYears: [...years.values()].filter(value => value > 0).length,
    validationYears: years.size
  };
  result.minimumChecks = {
    tradeCount: result.validationTrades > 300,
    beatsMarket: result.validationAverageMonthlyEquityReturnPct > result.marketAverageMonthlyReturnPct,
    profitFactor: result.validationProfitFactor > 1.15,
    drawdown: result.validationMaximumDrawdownPct > -20,
    beatsRandom: result.validationAverageMonthlyEquityReturnPct > result.randomAverageMonthlyReturnPct,
    positiveAfterCosts: result.validationAverageMonthlyEquityReturnPct > 0,
    diversified: result.concentrationPct < 20,
    crossYear: result.validationYears >= 2 && result.profitableYears >= 2,
    decisionActions: true,
    orderIntent: trades.every(row => row.orderIntent)
  };
  result.highChecks = {
    annualized: result.validationAnnualizedReturnPct > 30,
    monthly: result.validationAverageMonthlyEquityReturnPct > 2,
    profitFactor: result.validationProfitFactor > 1.3,
    drawdown: result.validationMaximumDrawdownPct > -20
  };
  result.passedMinimum = Object.values(result.minimumChecks).every(Boolean);
  result.passedHighProfit = Object.values(result.highChecks).every(Boolean);
  result.trades = trades.map(row => ({
    symbol: row.symbol,
    entryDate: row.entryDate,
    exitDate: row.exitDate,
    tradeReturnPct: row.tradeReturnPct,
    setup: row.setup,
    trigger: row.trigger,
    invalidation: row.invalidation,
    exitReason: row.exitReason,
    reason: row.reason,
    orderIntent: row.orderIntent ? {
      intentId: row.orderIntent.intentId,
      tradeDate: row.orderIntent.tradeDate,
      symbol: row.orderIntent.symbol,
      side: row.orderIntent.side,
      quantity: row.orderIntent.quantity,
      orderType: row.orderIntent.orderType,
      limitPrice: row.orderIntent.limitPrice,
      stopPrice: row.orderIntent.stopPrice,
      targetPrice: row.orderIntent.targetPrice,
      status: row.orderIntent.status,
      submitToRealBroker: row.orderIntent.submitToRealBroker
    } : null
  }));
  return result;
}

function registryInput(family, dateRange, metrics = null) {
  const registryMetrics = metrics ? Object.fromEntries(
    Object.entries(metrics).filter(([key]) => key !== 'trades')
  ) : null;
  return {
    strategyId: family.id,
    dataSources: ['daily_ohlcv', 'institutional_trust', 'institutional_foreign', 'institutional_dealer', 'point_in_time_t_plus_1'],
    setupRules: family.definitions.map(row => row.label),
    triggerRules: ['訊號日收盤確認，下一交易日開盤進場'],
    invalidationRules: ['ATR 1.5 倍停損', '市場風控熔斷'],
    exitRules: ['2R 停利', '最長持有 10 日'],
    riskRules: ['單筆帳戶風險 0.5%', '真實費稅滑價', 'T+2'],
    blockedWhen: ['共用市場風控', '成交值不足', 'ATR 過高'],
    parameters: { definitionCount: family.definitions.length, datasetVersion: `${dateRange.start}_${dateRange.end}` },
    trainPeriod: { months: 36 },
    validationPeriod: { months: 12, stepMonths: 12 },
    costModel: { buyFeePct: 0.1425, sellFeePct: 0.1425, sellTaxPct: 0.3, slippagePct: 0.15 },
    executionModel: { entry: 'next_open_market', settlement: 'T+2', simulator: 'shared' },
    metrics: registryMetrics,
    resultStatus: metrics?.passedMinimum ? 'passed' : metrics ? 'failed' : 'inconclusive',
    failureReason: metrics?.passedMinimum ? null : 'Validation 未通過最低候選標準',
    passedMinimum: metrics?.passedMinimum === true,
    passedHighProfit: metrics?.passedHighProfit === true,
    allowRetest: false,
    notes: 'Alpha Tournament 家族級 validation。'
  };
}

function compactFold(fold) {
  return {
    trainStart: fold.trainStart,
    trainEnd: fold.trainEnd,
    validationStart: fold.validationStart,
    validationEnd: fold.validationEnd,
    selectedDefinition: fold.selectedDefinition,
    trainSummary: fold.trainSummary,
    validationSummary: fold.validation.summary,
    randomSummary: fold.random.summary
  };
}

function tournamentMarkdown(report) {
  const rows = report.families.filter(family => !family.skipped).map(family => `| ${family.label} | ${family.forwardAlpha.hasAlpha ? '有' : '無'} | ${family.metrics.validationTrades} | ${family.metrics.validationAverageMonthlyEquityReturnPct}% | ${family.metrics.validationProfitFactor ?? '-'} | ${family.metrics.validationMaximumDrawdownPct}% | ${family.metrics.passedMinimum ? '通過' : '未通過'} |`).join('\n');
  return `# 法人 Alpha 候選賽

產生時間：${report.generatedAt}

## 結論

**${report.conclusion}**

- 策略家族：${report.familyCount}
- 策略組合：${report.strategyCount}
- Train / Validation：36 / 12 個月，每次前進 12 個月
- 舊投信連買回檔：FAILED_DO_NOT_RETUNE

| 策略家族 | Forward Alpha | Validation 交易 | 月均報酬 | Profit Factor | 最大回撤 | 最低標準 |
|---|---:|---:|---:|---:|---:|---:|
${rows}

## 資料限制

- processed dataset 以投信有活動的列為主，因此純外資／自營商訊號屬「投信活動條件下」的檢查，不可宣稱完整純外資 alpha。
- 法人資料採 T+1 保守 point-in-time policy。
- OHLCV 股票池仍有倖存者偏差警告。
`;
}

function readinessMarkdown(report) {
  const passed = report.families.filter(row => !row.skipped && row.metrics.passedMinimum);
  if (!passed.length) return `# 自動交易落地判斷

產生時間：${report.generatedAt}

## 決策

- 實盤：不允許。
- 真實券商下單接線：不允許。
- 策略 paper trading：不核准，因沒有策略通過 validation。
- 可保留：paper trading 基礎設施、BUY / SELL / HOLD / SKIP 決策介面、order intent dry-run。

## 下一批最值得補的資料

1. 產業／族群分類：驗證法人資金輪動是否只在特定族群有效。
2. 融資融券與券資比：排除籌碼過熱、追價與軋空失真。
3. 月營收與公布日期：加入可驗證的基本面催化劑。
4. 注意／處置股：排除成交限制與異常波動。
5. 除權息、減資、分割與其他公司行動：避免價格序列失真。

## 下一步

先補產業族群與融資融券 point-in-time 管線，再建立新 experimentHash。沒有新增資料前，不重測已失敗家族。
`;
  return `# 自動交易落地判斷

通過策略：${passed.map(row => row.label).join('、')}

- 只允許進入 paper trading，不可直接實盤。
- 實盤前仍需券商 API 認證、帳號環境、委託種類、漲跌停與錯單處理規格。
`;
}

await lockFailedStrategy();
const [payload, validation] = await Promise.all([readJson(DATA), readJson(VALIDATION)]);
const records = safeRows(payload);
const dates = [...new Set(records.map(row => row.date))].sort();
if (validation?.status !== 'VALID' || dates.length < 1_000) {
  console.log('法人歷史資料不足，尚無法完成 Alpha Tournament。');
  process.exit(0);
}

const context = await loadResearchContext();
const dateRange = { start: dates[0], end: [dates.at(-1), context.endDate].sort()[0] };
const folds = foldWindows(dateRange.start, dateRange.end, 36, 12);
const rows = buildRows(context, records, dateRange.start, dateRange.end);
const randomByFold = folds.map(fold => simulateSignalMap(context, randomMap(rows, fold.validationStart, fold.validationEnd), {
  startDate: fold.validationStart,
  endDate: fold.validationEnd,
  strategyId: 'fair_random_institutional_tournament',
  holdingDays: 10
}));

const familyResults = [];
for (const family of FAMILIES) {
  const input = registryInput(family, dateRange);
  const identity = buildExperimentIdentity(input);
  const registry = await loadRegistry();
  const precheck = shouldSkipExperiment(registry, identity, input);
  if (precheck.skip) {
    familyResults.push({ id: family.id, label: family.label, skipped: true, skipReason: precheck.reason });
    continue;
  }
  const definitionForward = family.definitions.map(definition => ({
    id: definition.id,
    label: definition.label,
    horizons: forwardSummary(rows, definition, folds)
  }));
  const hasAlpha = definitionForward.some(definition => [5, 10, 20].some(horizon => {
    const value = definition.horizons[horizon];
    return value.samples >= 100 && value.averageNetReturnPct > 0 && value.medianNetReturnPct > 0 && value.profitFactor > 1;
  }));
  const validationFolds = [];
  for (let index = 0; index < folds.length; index += 1) {
    const fold = folds[index];
    let best = null;
    for (const definition of family.definitions) {
      const result = simulateSignalMap(context, signalMap(rows, family, definition, fold.trainStart, fold.trainEnd), {
        startDate: fold.trainStart,
        endDate: fold.trainEnd,
        strategyId: `${family.id}:${definition.id}`,
        holdingDays: 10
      });
      const score = trainingScore(result.summary);
      if (!best || score > best.score) best = { definition, score, summary: result.summary };
    }
    const validationResult = simulateSignalMap(context, signalMap(rows, family, best.definition, fold.validationStart, fold.validationEnd), {
      startDate: fold.validationStart,
      endDate: fold.validationEnd,
      strategyId: `${family.id}:${best.definition.id}`,
      holdingDays: 10
    });
    validationFolds.push({
      ...fold,
      selectedDefinition: { id: best.definition.id, label: best.definition.label },
      trainSummary: best.summary,
      validation: validationResult,
      random: randomByFold[index],
      marketReturns: marketMonthly(context, fold.validationStart, fold.validationEnd)
    });
  }
  const metrics = combineFolds(validationFolds);
  await appendExperiment(registryInput(family, dateRange, metrics));
  familyResults.push({
    id: family.id,
    label: family.label,
    skipped: false,
    registry: identity,
    forwardAlpha: { hasAlpha, definitions: definitionForward },
    folds: validationFolds.map(compactFold),
    metrics
  });
  console.log(`${family.label}：交易 ${metrics.validationTrades}，月均 ${metrics.validationAverageMonthlyEquityReturnPct}%，PF=${metrics.validationProfitFactor}，通過=${metrics.passedMinimum}`);
}

const completed = familyResults.filter(row => !row.skipped);
const qualified = completed.filter(row => row.metrics.passedMinimum);
const highProfit = completed.filter(row => row.metrics.passedHighProfit);
const best = [...completed].sort((left, right) => right.metrics.validationAverageMonthlyEquityReturnPct - left.metrics.validationAverageMonthlyEquityReturnPct)[0] || null;
const report = {
  generatedAt: new Date().toISOString(),
  branch: 'institutional-data-fetcher-v1',
  familyCount: FAMILIES.length,
  strategyCount: FAMILIES.reduce((sum, family) => sum + family.definitions.length, 0),
  dataStatus: {
    pointInTimeSafeRecords: records.length,
    uniqueTradingDates: dates.length,
    dateRange,
    validationStatus: validation.status,
    foreignDealerCoverageWarning: 'processed dataset 以投信活動列為主，純外資／自營商結果屬條件式檢查。'
  },
  failedStrategyLock: 'FAILED_DO_NOT_RETUNE',
  walkForward: { trainMonths: 36, validationMonths: 12, stepMonths: 12, folds: folds.length },
  families: familyResults,
  qualification: {
    minimumPassedFamilies: qualified.map(row => row.id),
    highProfitPassedFamilies: highProfit.map(row => row.id)
  },
  bestFamily: best ? { id: best.id, label: best.label, metrics: { ...best.metrics, trades: undefined } } : null,
  autoTradingReadiness: {
    paperTradingInfrastructureAvailable: true,
    strategyApprovedForPaperTrading: qualified.length > 0,
    liveTradingAllowed: false,
    realBrokerOrderSubmissionAllowed: false,
    allowedMode: qualified.length ? 'PAPER_TRADING_ONLY' : 'ORDER_INTENT_DRY_RUN_ONLY'
  },
  conclusion: qualified.length
    ? '有策略通過最低候選標準，只能進入 paper trading，仍不可實盤。'
    : '沒有任何策略通過最低候選標準，也沒有策略可進入 paper trading 或實盤。'
};

await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, tournamentMarkdown(report), 'utf8');
await fs.writeFile(READINESS, readinessMarkdown(report), 'utf8');

console.log(`Alpha Tournament：${report.familyCount} 家族、${report.strategyCount} 組。`);
console.log(report.conclusion);
