import fs from 'node:fs/promises';
import { decisionToOrderIntent } from '../lib/order-intent-generator.mjs';
import { buildMarketRegimes } from '../lib/market-regime.mjs';
import {
  foldWindows,
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

const MARKET = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const OUTPUT = new URL('../../data/research/return-improvement-hunter-v1.json', import.meta.url);
const REPORT = new URL('../../docs/RETURN_IMPROVEMENT_HUNTER_V1.md', import.meta.url);
const READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);
const PRIOR_BEST_MONTHLY = 0.648;

const readJson = url => fs.readFile(url, 'utf8').then(JSON.parse);
const pct = (value, base) => Number.isFinite(value) && Number.isFinite(base) && base ? (value / base - 1) * 100 : null;

function enrich(payload) {
  const benchmark = payload.benchmark || [];
  const inverseByDate = new Map((payload.inverse || []).map(row => [row.date, row]));
  const regimes = buildMarketRegimes(benchmark);
  return regimes.map((row, index) => ({
    ...row,
    index,
    benchmarkBar: benchmark[index],
    inverseBar: inverseByDate.get(row.date),
    mom60: index >= 60 ? pct(row.close, regimes[index - 60].close) : null
  })).filter(row => row.ma200 && row.benchmarkBar);
}

const configs = [
  {
    id: 'buy_hold_0050',
    name: '全期持有 0050',
    signal: row => row.close > row.ma60 ? 'benchmark' : null,
    maxHoldingDays: 280,
    positionPct: 90
  },
  {
    id: 'bull_hold_0050',
    name: '多頭持有 0050，弱勢空手',
    signal: row => row.close > row.ma60 && row.mom20 > 0 && ['BULL_TREND', 'THEME_MOMENTUM', 'BULL_PULLBACK'].includes(row.regime) ? 'benchmark' : null,
    exit: row => row.close < row.ma20 || ['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.regime),
    maxHoldingDays: 60,
    positionPct: 90
  },
  {
    id: 'strong_momentum_0050',
    name: '0050 強動能續抱',
    signal: row => row.close > row.ma20 && row.ma20 > row.ma60 && row.mom20 > 3 && row.mom60 > 6 ? 'benchmark' : null,
    exit: row => row.close < row.ma20 || row.mom20 < 0,
    maxHoldingDays: 45,
    positionPct: 90
  },
  {
    id: 'defensive_trend_0050',
    name: '0050 防守型趨勢續抱',
    signal: row => row.close > row.ma200 && row.ma20 > row.ma60 && row.mom20 > 0.5 && row.mom60 > 1 ? 'benchmark' : null,
    exit: row => row.close < row.ma60 || row.mom20 < -2 || ['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.regime),
    maxHoldingDays: 55,
    positionPct: 90
  },
  {
    id: 'theme_momentum_0050',
    name: '0050 強題材盤續抱',
    signal: row => ['BULL_TREND', 'THEME_MOMENTUM'].includes(row.regime) && row.close > row.ma20 && row.mom20 > 2 ? 'benchmark' : null,
    exit: row => row.close < row.ma20 || row.mom20 < -1 || ['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.regime),
    maxHoldingDays: 35,
    positionPct: 90
  },
  {
    id: 'cash_or_inverse',
    name: '0050 多頭／反向 ETF 空頭',
    signal: row => {
      if (row.close > row.ma60 && row.mom20 > 1 && ['BULL_TREND', 'THEME_MOMENTUM', 'BULL_PULLBACK'].includes(row.regime)) return 'benchmark';
      if (row.close < row.ma60 && row.mom20 < -4 && ['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.regime)) return 'inverse';
      return null;
    },
    exit: (row, original) => original.side === 'inverse' ? row.close > row.ma20 || row.mom20 > 0 : row.close < row.ma20 || row.mom20 < -2,
    maxHoldingDays: 35,
    positionPct: 90
  }
];

function sourceRows(rows, inverseRows, side) {
  return side === 'inverse' ? inverseRows : rows.map(row => row.benchmarkBar);
}

function candidateFor(rows, inverseRows, row, config, side, rowByDate) {
  const source = sourceRows(rows, inverseRows, side);
  const sourceIndex = source.findIndex(item => item.date === row.date);
  const futureBars = source.slice(sourceIndex + 1, sourceIndex + 1 + Math.max(20, config.maxHoldingDays + 5)).map(item => ({
    date: item.date,
    open: item.open,
    high: Math.max(item.open, item.close),
    low: Math.min(item.open, item.close),
    close: item.close,
    price: item.close
  }));
  if (!futureBars.length) return null;
  for (let index = 0; index + 1 < futureBars.length; index += 1) {
    const future = rowByDate.get(futureBars[index].date);
    if (future && config.exit?.(future, { ...row, side })) {
      futureBars[index + 1].forcedExit = { price: futureBars[index + 1].open, reason: config.name, type: 'rule_exit' };
      break;
    }
  }
  const symbol = side === 'inverse' ? '00632R.TW' : '0050.TW';
  const name = side === 'inverse' ? '元大台灣50反1' : '元大台灣50';
  const next = futureBars[0];
  const stopDistancePct = side === 'inverse' ? 6 : 5;
  const setup = [config.name, side === 'inverse' ? '空頭用反向 ETF' : '持有 0050'];
  const decision = {
    date: next.date,
    symbol,
    action: 'BUY',
    strategyId: `return_improvement_hunter_v1:${config.id}`,
    setup,
    trigger: ['收盤訊號確認，隔日開盤執行'],
    invalidation: ['市場條件反轉或持有期結束'],
    entryPlan: { referencePrice: next.open, maximumAcceptablePrice: next.open * 1.005, orderType: 'MARKETABLE_LIMIT', timeInForce: 'ROD', session: 'REGULAR' },
    riskPlan: { stopPrice: next.open * (1 - stopDistancePct / 100), targetPrice: null, riskRewardRatio: 2, positionBudget: 900_000, riskBudget: 5_000 },
    reason: config.name,
    warnings: ['此為提高月均的基準策略，不等於已找到個股 alpha']
  };
  return {
    signalDate: row.date,
    entryDate: next.date,
    symbol,
    name,
    market: 'ETF',
    regime: row.regime,
    atrPct: row.vol20 || 2,
    score: side === 'inverse' ? Math.abs(row.mom20 || 0) : (row.mom20 || 0) + (row.mom60 || 0) * 0.3,
    futureBars,
    stopDistancePct,
    rewardRisk: null,
    maxHoldingDays: config.maxHoldingDays,
    trailingStopRule: config.id === 'buy_hold_0050' ? null : { triggerPct: 8, lockPct: 2, givebackPct: 5 },
    positionPct: config.positionPct,
    accountRiskPct: side === 'inverse' ? 2 : 5,
    setup,
    trigger: decision.trigger,
    invalidation: decision.invalidation,
    exitPlan: config.name,
    reason: decision.reason,
    orderIntent: decisionToOrderIntent(decision, { account: { equity: 1_000_000, availableCash: 1_000_000 } })
  };
}

function signalMap(rows, inverseRows, config, startDate, endDate) {
  const map = new Map();
  const rowByDate = new Map(rows.map(row => [row.date, row]));
  const startIndex = rows.findIndex(row => row.date >= startDate);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.date < startDate || row.date > endDate) continue;
    const side = config.signal(row, index, rows, { startIndex });
    if (!side) continue;
    const candidate = candidateFor(rows, inverseRows, row, config, side, rowByDate);
    if (candidate) map.set(row.date, [candidate]);
  }
  return map;
}

function monthlyBenchmark(rows, startDate, endDate) {
  let prior;
  const byMonth = new Map();
  for (const row of rows.filter(row => row.date <= endDate)) {
    if (row.date < startDate) prior = row.close;
    else byMonth.set(row.date.slice(0, 7), row.close);
  }
  const returns = [];
  for (const close of byMonth.values()) {
    if (prior) returns.push((close / prior - 1) * 100);
    prior = close;
  }
  return returns;
}

function score(summary) {
  const pf = Number.isFinite(summary.profitFactor) ? Math.min(3, summary.profitFactor) : 0;
  return summary.averageMonthlyEquityReturnPct * 10
    + pf
    + summary.maximumDrawdownPct * 0.22
    - summary.negativeMonths * 0.18;
}

function combine(folds) {
  const trades = folds.flatMap(row => row.validation.trades);
  const monthly = folds.flatMap(row => row.validation.summary.monthly.map(item => item.equityReturnPct));
  const benchmark = folds.flatMap(row => row.benchmarkReturns);
  const gains = trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(trades.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
  const compounded = monthly.reduce((value, item) => value * (1 + item / 100), 1);
  const averageMonthly = mean(monthly) || 0;
  return {
    validationTrades: trades.length,
    validationAverageMonthlyEquityReturnPct: round(averageMonthly),
    priorBestMonthlyPct: PRIOR_BEST_MONTHLY,
    improvementPct: round(averageMonthly - PRIOR_BEST_MONTHLY),
    targetGapPct: round(10 - averageMonthly),
    validationAnnualizedReturnPct: round(monthly.length ? (compounded ** (12 / monthly.length) - 1) * 100 : 0),
    validationProfitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    validationMaximumDrawdownPct: round(Math.min(0, ...folds.map(row => row.validation.summary.maximumDrawdownPct))),
    validationWinRatePct: round(trades.filter(row => row.realizedPnl > 0).length / Math.max(1, trades.length) * 100),
    benchmarkAverageMonthlyReturnPct: round(mean(benchmark) || 0),
    orderIntents: trades.filter(row => row.orderIntent).length,
    improved: averageMonthly > PRIOR_BEST_MONTHLY,
    nearTenPercent: averageMonthly >= 8
  };
}

function registryInput(range, metrics = null) {
  return {
    strategyId: 'return_improvement_hunter_v1',
    dataSources: ['0050_daily_ohlcv', '00632R_daily_ohlcv', 'market_regime'],
    setupRules: configs.map(row => row.name),
    triggerRules: ['以 walk-forward train 選擇 ETF / 現金 / 反向 ETF 切換規則'],
    invalidationRules: ['市場條件反轉', '移動停利', '持有期結束'],
    exitRules: ['規則出場與期末出場'],
    riskRules: ['ETF 單檔 90%', 'T+2', '不用槓桿'],
    blockedWhen: ['沒有訊號時持有現金'],
    parameters: { range, priorBestMonthlyPct: PRIOR_BEST_MONTHLY, implementationVersion: 'aligned-validation-window-v4', configs: configs.map(row => row.id) },
    trainPeriod: { months: 36 },
    validationPeriod: { months: 12, stepMonths: 12 },
    costModel: { buyFeePct: 0.1425, sellFeePct: 0.1425, sellTaxPct: 0.3, slippagePct: 0.15 },
    executionModel: { entry: 'next_open_market', settlement: 'T+2', simulator: 'shared' },
    metrics,
    resultStatus: metrics ? (metrics.improved ? 'inconclusive' : 'failed') : 'inconclusive',
    failureReason: metrics?.improved ? null : '沒有高於前一最佳月均報酬。',
    passedMinimum: false,
    passedHighProfit: false,
    allowRetest: false,
    coreRulesChanged: true,
    notes: 'Return Improvement Hunter v1：先找能提高月均的 ETF 基準策略。'
  };
}

async function main() {
  const payload = await readJson(MARKET);
  const rows = enrich(payload).filter(row => row.date >= '2022-03-01');
  const inverseRows = payload.inverse || [];
  const range = { start: rows[0].date, end: rows.at(-1).date };
  const folds = foldWindows(range.start, range.end, 36, 12);
  const context = { marketHistory: rows, marketByDate: new Map(rows.map(row => [row.date, row])) };
  const input = registryInput(range);
  const identity = buildExperimentIdentity(input);
  const precheck = shouldSkipExperiment(await loadRegistry(), identity, input);
  if (precheck.skip) {
    const registry = await loadRegistry();
    const previous = registry.experiments.find(row => row.experimentHash === identity.experimentHash);
    await fs.writeFile(OUTPUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), status: 'SKIPPED', reason: precheck.reason, bestStrategy: previous?.metrics ? { metrics: previous.metrics } : null }, null, 2)}\n`, 'utf8');
    console.log('Return Improvement Hunter 已由 registry 跳過。');
    return;
  }
  const foldResults = [];
  for (const fold of folds) {
    let best;
    for (const config of configs) {
      const train = simulateSignalMap(context, signalMap(rows, inverseRows, config, fold.trainStart, fold.trainEnd), {
        startDate: fold.trainStart,
        endDate: fold.trainEnd,
        strategyId: `return-improvement:${config.id}`,
        maxOpenPositions: 1,
        riskRules: { maxAccountRiskPct: 5, maxSinglePositionPct: 100, exposureLimits: { BULL_TREND: 100, THEME_MOMENTUM: 100, BULL_PULLBACK: 100, RANGE_BOUND: 100, HIGH_VOLATILITY: 100, BEAR_DEFENSE: 100 } }
      });
      const value = score(train.summary);
      if (!best || value > best.score) best = { config, score: value, summary: train.summary };
    }
    const validation = simulateSignalMap(context, signalMap(rows, inverseRows, best.config, fold.validationStart, fold.validationEnd), {
      startDate: fold.validationStart,
      endDate: fold.validationEnd,
      strategyId: `return-improvement:${best.config.id}`,
      maxOpenPositions: 1,
      riskRules: { maxAccountRiskPct: 5, maxSinglePositionPct: 100, exposureLimits: { BULL_TREND: 100, THEME_MOMENTUM: 100, BULL_PULLBACK: 100, RANGE_BOUND: 100, HIGH_VOLATILITY: 100, BEAR_DEFENSE: 100 } }
    });
    foldResults.push({ ...fold, selectedConfig: best.config, trainSummary: best.summary, validation, benchmarkReturns: monthlyBenchmark(rows, fold.validationStart, fold.validationEnd) });
    console.log(`${fold.validationStart}：${best.config.name}，月均 ${validation.summary.averageMonthlyEquityReturnPct}%`);
  }
  const metrics = combine(foldResults);
  await appendExperiment(registryInput(range, metrics));
  const selectedStrategies = [...new Set(foldResults.map(row => row.selectedConfig.name))];
  const report = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    status: metrics.improved ? 'IMPROVED_MONTHLY_RETURN' : 'NO_IMPROVEMENT',
    bestStrategy: { selectedStrategies, metrics },
    readiness: { paperTradingAllowed: false, liveTradingAllowed: false, realBrokerAllowed: false },
    conclusion: metrics.improved
      ? `已找到月均提高：${metrics.validationAverageMonthlyEquityReturnPct}% > ${PRIOR_BEST_MONTHLY}%，但仍未接近 10%，不可實盤。`
      : `沒有提高月均：${metrics.validationAverageMonthlyEquityReturnPct}% <= ${PRIOR_BEST_MONTHLY}%。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# Return Improvement Hunter v1\n\n${report.conclusion}\n\n| 交易數 | 月均報酬 | 前最佳 | 改善幅度 | 年化 | PF | 最大回撤 | 勝率 | 0050 月均 |\n|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n| ${metrics.validationTrades} | ${metrics.validationAverageMonthlyEquityReturnPct}% | ${metrics.priorBestMonthlyPct}% | ${metrics.improvementPct}% | ${metrics.validationAnnualizedReturnPct}% | ${metrics.validationProfitFactor} | ${metrics.validationMaximumDrawdownPct}% | ${metrics.validationWinRatePct}% | ${metrics.benchmarkAverageMonthlyReturnPct}% |\n\n- 這輪目的只是先找「月均有提高」的方向，不宣稱已找到個股 alpha。\n- 若提高，代表大盤 ETF 基準策略優於目前個股策略；若要接近 10%，仍需更高頻或事件資料。\n`, 'utf8');
  await fs.writeFile(READINESS, `# 自動交易落地判斷\n\n更新時間：${report.generatedAt}\n\n- Return Improvement Hunter：${report.conclusion}\n- 紙上交易：不可\n- 實盤：不可\n- 真實券商 API：不可\n\n下一步：${metrics.improved ? '以此作為更高基準，接著只能測能打敗 ETF 基準的事件／分鐘線策略。' : '仍未提高月均，應停止日線 ETF/個股策略堆疊，補分鐘線或主力資料。'}\n`, 'utf8');
  console.log(report.conclusion);
}

await main();
