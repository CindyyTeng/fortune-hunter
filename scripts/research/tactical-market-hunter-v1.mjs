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
const OUTPUT = new URL('../../data/research/tactical-market-hunter-v1.json', import.meta.url);
const REPORT = new URL('../../docs/TACTICAL_MARKET_HUNTER_V1.md', import.meta.url);
const READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);

const readJson = url => fs.readFile(url, 'utf8').then(JSON.parse);

function bars(rows, startIndex, count = 25) {
  return rows.slice(startIndex + 1, startIndex + 1 + count).map(row => ({
    date: row.date,
    open: row.open,
    high: Math.max(row.open, row.close),
    low: Math.min(row.open, row.close),
    close: row.close,
    price: row.close
  }));
}

function pct(value, base) {
  return Number.isFinite(value) && Number.isFinite(base) && base ? (value / base - 1) * 100 : null;
}

function enrichMarket(marketPayload) {
  const benchmark = marketPayload.benchmark || [];
  const inverseByDate = new Map((marketPayload.inverse || []).map(row => [row.date, row]));
  const regimes = buildMarketRegimes(benchmark);
  return regimes.map((row, index) => {
    const prior20 = regimes[index - 20];
    const prior60 = regimes[index - 60];
    return {
      ...row,
      benchmarkBar: benchmark[index],
      inverseBar: inverseByDate.get(row.date),
      index,
      mom60: prior60 ? pct(row.close, prior60.close) : null,
      inverseMom20: prior20 && inverseByDate.get(prior20.date) && inverseByDate.get(row.date)
        ? pct(inverseByDate.get(row.date).close, inverseByDate.get(prior20.date).close)
        : null
    };
  }).filter(row => row.ma200 && row.benchmarkBar);
}

const configs = [
  {
    id: 'bull_cash_defense',
    name: '多頭持有 0050／弱勢空手',
    side: row => ['BULL_TREND', 'THEME_MOMENTUM', 'BULL_PULLBACK'].includes(row.regime) && row.close > row.ma60 && row.mom20 > 0 ? 'benchmark' : null,
    exit: (row, original) => row.close < row.ma20 || ['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.regime),
    maxHoldingDays: 25,
    positionPct: 90
  },
  {
    id: 'bull_inverse_defense',
    name: '多頭 0050／空頭反向 ETF',
    side: row => {
      if (['BULL_TREND', 'THEME_MOMENTUM', 'BULL_PULLBACK'].includes(row.regime) && row.close > row.ma60 && row.mom20 > 0) return 'benchmark';
      if (['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.regime) && row.close < row.ma60 && row.mom20 < -3) return 'inverse';
      return null;
    },
    exit: (row, original) => original.side === 'benchmark'
      ? row.close < row.ma20 || ['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.regime)
      : row.close > row.ma20 || row.mom20 > 2,
    maxHoldingDays: 20,
    positionPct: 90
  },
  {
    id: 'momentum_only',
    name: '大盤 20/60 日動能順勢',
    side: row => {
      if (row.mom20 > 3 && row.mom60 > 5 && row.close > row.ma60) return 'benchmark';
      if (row.mom20 < -5 && row.close < row.ma60) return 'inverse';
      return null;
    },
    exit: (row, original) => original.side === 'benchmark' ? row.mom20 < 0 || row.close < row.ma20 : row.mom20 > 0 || row.close > row.ma20,
    maxHoldingDays: 15,
    positionPct: 90
  },
  {
    id: 'panic_rebound',
    name: '恐慌後反彈 0050 短打',
    side: row => row.regime !== 'BEAR_DEFENSE' && row.mom5 > 2 && row.mom20 < -6 && row.close > row.ma20 ? 'benchmark' : null,
    exit: row => row.mom5 < -1 || row.close < row.ma20,
    maxHoldingDays: 8,
    positionPct: 60
  }
];

function candidateFor(rows, inverseRows, row, config, side, rowByDate) {
  const source = side === 'inverse' ? inverseRows : rows.map(item => item.benchmarkBar);
  const sourceIndex = source.findIndex(item => item.date === row.date);
  const futureBars = bars(source, sourceIndex, 30);
  for (let index = 0; index + 1 < futureBars.length; index += 1) {
    const futureRegime = rowByDate.get(futureBars[index].date);
    if (futureRegime && config.exit(futureRegime, { ...row, side })) {
      futureBars[index + 1].forcedExit = {
        price: futureBars[index + 1].open,
        reason: config.name,
        type: 'market_tactical_exit'
      };
      break;
    }
  }
  const next = futureBars[0];
  if (!next) return null;
  const symbol = side === 'inverse' ? '00632R.TW' : '0050.TW';
  const name = side === 'inverse' ? '元大台灣50反1' : '元大台灣50';
  const stopDistancePct = side === 'inverse' ? 5 : 4;
  const setup = [config.name, side === 'inverse' ? '空頭防守用反向 ETF' : '多頭順勢用 0050'];
  const trigger = ['市場狀態與均線動能在 T 日收盤確認，T+1 開盤進場'];
  const invalidation = ['市場狀態反轉、跌破均線或動能反向'];
  const decision = {
    date: next.date,
    symbol,
    action: 'BUY',
    strategyId: `tactical_market_hunter_v1:${config.id}`,
    setup,
    trigger,
    invalidation,
    entryPlan: { referencePrice: next.open, maximumAcceptablePrice: next.open * 1.005, orderType: 'MARKETABLE_LIMIT', timeInForce: 'ROD', session: 'REGULAR' },
    riskPlan: { stopPrice: next.open * (1 - stopDistancePct / 100), targetPrice: null, riskRewardRatio: 2, positionBudget: 900_000, riskBudget: 5_000 },
    reason: config.name,
    warnings: ['ETF 策略仍需 validation，通過前不可紙上交易或實盤']
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
    trailingStopRule: side === 'inverse'
      ? { triggerPct: 5, lockPct: 1, givebackPct: 3 }
      : { triggerPct: 6, lockPct: 2, givebackPct: 4 },
    positionPct: config.positionPct,
    setup,
    trigger,
    invalidation,
    exitPlan: config.name,
    reason: decision.reason,
    orderIntent: decisionToOrderIntent(decision, { account: { equity: 1_000_000, availableCash: 1_000_000 } })
  };
}

function signalMap(rows, inverseRows, config, startDate, endDate) {
  const rowByDate = new Map(rows.map(row => [row.date, row]));
  const map = new Map();
  for (const row of rows) {
    if (row.date < startDate || row.date > endDate) continue;
    const side = config.side(row);
    if (!side) continue;
    const candidate = candidateFor(rows, inverseRows, row, config, side, rowByDate);
    if (candidate) map.set(row.date, [candidate]);
  }
  return map;
}

function marketMonthly(rows, startDate, endDate) {
  let prior;
  const closes = new Map();
  for (const row of rows.filter(row => row.date <= endDate)) {
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
  return summary.averageMonthlyEquityReturnPct * 8 + pf + summary.maximumDrawdownPct * 0.08 + Math.min(1, summary.trades / 120);
}

function combine(folds) {
  const trades = folds.flatMap(row => row.validation.trades);
  const monthly = folds.flatMap(row => row.validation.summary.monthly.map(value => value.equityReturnPct));
  const market = folds.flatMap(row => row.marketReturns);
  const gains = trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(trades.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
  const compounded = monthly.reduce((value, row) => value * (1 + row / 100), 1);
  const avg = mean(monthly) || 0;
  const metrics = {
    validationTrades: trades.length,
    validationAverageMonthlyEquityReturnPct: round(avg),
    targetGapPct: round(10 - avg),
    validationAnnualizedReturnPct: round(monthly.length ? (compounded ** (12 / monthly.length) - 1) * 100 : 0),
    validationProfitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    validationMaximumDrawdownPct: round(Math.min(0, ...folds.map(row => row.validation.summary.maximumDrawdownPct))),
    validationWinRatePct: round(trades.filter(row => row.realizedPnl > 0).length / Math.max(1, trades.length) * 100),
    marketAverageMonthlyReturnPct: round(mean(market) || 0),
    orderIntents: trades.filter(row => row.orderIntent).length,
    supportedActions: ['BUY', 'SELL', 'HOLD', 'SKIP']
  };
  metrics.checks = {
    tradeCount: metrics.validationTrades > 60,
    beatsMarket: metrics.validationAverageMonthlyEquityReturnPct > metrics.marketAverageMonthlyReturnPct,
    profitFactor: metrics.validationProfitFactor > 1.15,
    drawdown: metrics.validationMaximumDrawdownPct > -20,
    positiveAfterCosts: metrics.validationAverageMonthlyEquityReturnPct > 0,
    actionsAndIntents: metrics.orderIntents === trades.length
  };
  metrics.passed = Object.values(metrics.checks).every(Boolean);
  metrics.nearTenPercent = metrics.validationAverageMonthlyEquityReturnPct >= 8;
  return metrics;
}

function registryInput(range, metrics = null) {
  return {
    strategyId: 'tactical_market_hunter_v1',
    dataSources: ['0050_daily_ohlcv', '00632R_daily_ohlcv', 'market_regime'],
    setupRules: configs.map(row => row.name),
    triggerRules: ['市場狀態與均線動能收盤確認，隔日開盤執行'],
    invalidationRules: ['市場狀態反轉', '跌破均線', '動能反向'],
    exitRules: ['移動停利', '固定最長持有天數', '市場狀態出場'],
    riskRules: ['ETF 單檔最高 90%', 'T+2', '不使用槓桿，只使用 0050 / 00632R / 現金'],
    blockedWhen: ['訊號不明確時空手'],
    parameters: { configs: configs.map(row => row.id), range },
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
    notes: 'Tactical Market Hunter v1：0050 / 00632R / 現金市場切換。'
  };
}

async function main() {
  const payload = await readJson(MARKET);
  const rows = enrichMarket(payload);
  const inverseRows = payload.inverse || [];
  const range = { start: rows[0].date, end: rows.at(-1).date };
  const folds = foldWindows(range.start, range.end, 36, 12);
  const input = registryInput(range);
  const identity = buildExperimentIdentity(input);
  const precheck = shouldSkipExperiment(await loadRegistry(), identity, input);
  if (precheck.skip) {
    const registry = await loadRegistry();
    const previous = registry.experiments.find(row => row.experimentHash === identity.experimentHash);
    const report = { generatedAt: new Date().toISOString(), status: 'SKIPPED', reason: precheck.reason, bestStrategy: previous?.metrics ? { metrics: previous.metrics } : null };
    await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log('Tactical Market Hunter 已由 registry 跳過。');
    return;
  }
  const foldResults = [];
  for (const fold of folds) {
    let best;
    for (const config of configs) {
      const train = simulateSignalMap({ marketHistory: rows, marketByDate: new Map(rows.map(row => [row.date, row])) }, signalMap(rows, inverseRows, config, fold.trainStart, fold.trainEnd), {
        startDate: fold.trainStart,
        endDate: fold.trainEnd,
        strategyId: `tactical:${config.id}`,
        maxOpenPositions: 1,
        riskRules: { maxSinglePositionPct: 100, exposureLimits: { BULL_TREND: 100, THEME_MOMENTUM: 100, BULL_PULLBACK: 100, RANGE_BOUND: 100, HIGH_VOLATILITY: 100, BEAR_DEFENSE: 100 } }
      });
      const score = objective(train.summary);
      if (!best || score > best.score) best = { config, score, summary: train.summary };
    }
    const validation = simulateSignalMap({ marketHistory: rows, marketByDate: new Map(rows.map(row => [row.date, row])) }, signalMap(rows, inverseRows, best.config, fold.validationStart, fold.validationEnd), {
      startDate: fold.validationStart,
      endDate: fold.validationEnd,
      strategyId: `tactical:${best.config.id}`,
      maxOpenPositions: 1,
      riskRules: { maxSinglePositionPct: 100, exposureLimits: { BULL_TREND: 100, THEME_MOMENTUM: 100, BULL_PULLBACK: 100, RANGE_BOUND: 100, HIGH_VOLATILITY: 100, BEAR_DEFENSE: 100 } }
    });
    foldResults.push({ ...fold, selectedConfig: best.config, trainSummary: best.summary, validation, marketReturns: marketMonthly(rows, fold.validationStart, fold.validationEnd) });
    console.log(`${fold.validationStart}：${best.config.name}，交易 ${validation.summary.trades} 筆。`);
  }
  const metrics = combine(foldResults);
  await appendExperiment(registryInput(range, metrics));
  const report = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    status: 'COMPLETED',
    search: { configs: configs.map(row => row.name), folds: folds.length },
    bestStrategy: { selectedStrategies: [...new Set(foldResults.map(row => row.selectedConfig.name))], metrics },
    readiness: { paperTradingAllowed: metrics.passed, liveTradingAllowed: false, realBrokerAllowed: false },
    conclusion: metrics.passed
      ? 'Tactical Market Hunter v1 通過最低 validation，但仍只能進入紙上交易驗收，不可直接實盤。'
      : `沒有策略通過 validation；Tactical Market Hunter v1 月均 ${metrics.validationAverageMonthlyEquityReturnPct}%，距離 10% 還差 ${metrics.targetGapPct} 個百分點。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# Tactical Market Hunter v1\n\n${report.conclusion}\n\n| 交易數 | 月均報酬 | 年化 | PF | 最大回撤 | 勝率 | 大盤月均 |\n|---:|---:|---:|---:|---:|---:|---:|\n| ${metrics.validationTrades} | ${metrics.validationAverageMonthlyEquityReturnPct}% | ${metrics.validationAnnualizedReturnPct}% | ${metrics.validationProfitFactor} | ${metrics.validationMaximumDrawdownPct}% | ${metrics.validationWinRatePct}% | ${metrics.marketAverageMonthlyReturnPct}% |\n\n- 核心：0050 / 00632R / 現金市場狀態切換。\n- 不使用槓桿，只測 ETF 戰術切換是否能打敗大盤。\n- 通過 validation 前不可 paper trading、不可實盤。\n`, 'utf8');
  await fs.writeFile(READINESS, `# 自動交易落地判斷\n\n更新時間：${report.generatedAt}\n\n- Tactical Market Hunter：${report.conclusion}\n- 紙上交易：${metrics.passed ? '需人工驗收後才可 dry-run' : '不可'}\n- 實盤：不可\n- 真實券商 API：不可\n\n下一步：${metrics.passed ? '先做 ETF 紙上交易 dry-run 與成交驗收。' : '市場 ETF 切換仍未接近月均 10%；下一步應轉向分鐘線與事件驅動資料，不再只靠日線。'}\n`, 'utf8');
  console.log(report.conclusion);
}

await main();
