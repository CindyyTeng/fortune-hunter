import fs from 'node:fs/promises';
import { decisionToOrderIntent } from '../lib/order-intent-generator.mjs';
import { buildMarketRegimes } from '../lib/market-regime.mjs';
import {
  foldWindows,
  iterateObservations,
  loadResearchContext,
  mean,
  round,
  simulateSignalMap
} from './research-core.mjs';
import { appendExperiment } from './strategy-experiment-registry.mjs';

const MARKET = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const OUTPUT = new URL('../../data/research/live-ready-hunter-v1.json', import.meta.url);
const REPORT = new URL('../../docs/LIVE_READY_HUNTER_V1.md', import.meta.url);
const READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);

const PRIOR_BEST_MONTHLY = 2.3954;
const TARGET_MONTHLY = 10;
const START_DATE = '2022-03-01';
const readJson = url => fs.readFile(url, 'utf8').then(JSON.parse);
const pct = (value, base) => Number.isFinite(value) && Number.isFinite(base) && base ? (value / base - 1) * 100 : null;

const stockFamilies = [
  {
    id: 'liquid_momentum',
    name: '高成交值強勢續攻',
    filter: row => row.factors.marketAboveMa60
      && row.factors.relativeMarket20 >= 5
      && row.factors.return20 >= 5
      && row.factors.return20 <= 45
      && row.factors.volumeRatio20 >= 1.2
      && row.factors.transactionValuePercentile >= 0.8
      && row.factors.atrPct <= 6
      && row.factors.gapPct <= 5
      && !row.factors.longUpperWick,
    score: row => row.factors.relativeMarket20 * 2
      + row.factors.transactionValuePercentile * 16
      + Math.min(3, row.factors.volumeRatio20) * 6
      - row.factors.atrPct
  },
  {
    id: 'leader_pullback',
    name: '領漲股拉回再轉強',
    filter: row => row.factors.marketAboveMa60
      && row.factors.return60 >= 15
      && row.factors.relativeMarket20 >= 2
      && row.factors.return5 >= -7
      && row.factors.return5 <= 2
      && row.factors.distanceMa20 >= -4
      && row.factors.distanceMa20 <= 4
      && row.day.close > row.day.open
      && row.day.close >= row.ma20
      && row.factors.transactionValuePercentile >= 0.65
      && row.factors.atrPct <= 6,
    score: row => row.factors.return60
      + row.factors.relativeMarket20 * 2
      - Math.abs(row.factors.distanceMa20) * 2
      + row.factors.transactionValuePercentile * 10
  },
  {
    id: 'low_vol_leader',
    name: '低波動相對強勢股',
    filter: row => row.factors.marketAboveMa60
      && row.factors.relativeMarket20 >= 4
      && row.factors.atrPct <= 3.8
      && row.factors.transactionValuePercentile >= 0.75
      && row.factors.ma20AboveMa60
      && row.factors.ma20Slope > 0
      && row.factors.rangePosition20 >= 0.55,
    score: row => row.factors.relativeMarket20 * 2
      + row.factors.transactionValuePercentile * 14
      - row.factors.atrPct * 2
  }
];

const baseModes = [
  { id: 'no_base', name: '不放 0050 底倉', positionPct: 0 },
  { id: 'trend_0050_50', name: '0050 趨勢底倉 50%', positionPct: 50 },
  { id: 'trend_0050_70', name: '0050 趨勢底倉 70%', positionPct: 70 }
];

const configs = [];
for (const base of baseModes) {
  for (const family of stockFamilies) {
    for (const topCount of [3, 5]) {
      for (const holdingDays of [3, 5, 7]) {
        for (const stockPct of [6, 8]) {
          configs.push({
            id: `${base.id}_${family.id}_top${topCount}_hold${holdingDays}_pct${stockPct}`,
            name: `${base.name} + ${family.name} Top ${topCount} 持有 ${holdingDays} 日`,
            base,
            family,
            topCount,
            holdingDays,
            stockPct
          });
        }
      }
    }
  }
}

function enrichMarket(payload) {
  const regimes = buildMarketRegimes(payload.benchmark || []);
  return regimes.map((row, index) => ({
    ...row,
    index,
    benchmarkBar: payload.benchmark[index],
    mom60: index >= 60 ? pct(row.close, regimes[index - 60].close) : null
  })).filter(row => row.date >= START_DATE && row.ma200 && row.benchmarkBar);
}

function addTop(map, date, row, limit) {
  const rows = map.get(date) || [];
  if (rows.length < limit) rows.push(row);
  else {
    let worst = 0;
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index].score < rows[worst].score) worst = index;
    }
    if (row.score <= rows[worst].score) return;
    rows[worst] = row;
  }
  map.set(date, rows);
}

function stockCandidate(row, config) {
  const stopDistancePct = Math.max(3, Math.min(8, row.factors.atrPct * 1.5));
  const decision = {
    date: row.nextDate,
    symbol: row.symbol,
    action: 'BUY',
    strategyId: `live_ready_hunter_v1:${config.id}`,
    setup: [config.family.name, `分數 ${round(config.family.score(row), 2)}`],
    trigger: ['收盤確認，隔日開盤以共用成交模擬器進場'],
    invalidation: ['跌破停損、停利、持有期滿或大盤風控出場'],
    entryPlan: { referencePrice: row.nextOpen, maximumAcceptablePrice: row.nextOpen * 1.006, orderType: 'MARKETABLE_LIMIT', timeInForce: 'ROD', session: 'REGULAR' },
    riskPlan: { stopPrice: row.nextOpen * (1 - stopDistancePct / 100), targetPrice: row.nextOpen * (1 + stopDistancePct * 2 / 100), riskRewardRatio: 2, positionBudget: config.stockPct / 100 * 1_000_000, riskBudget: 6_000 },
    reason: config.name,
    warnings: ['研究用 order intent，未通過 paper trading 前不可實盤']
  };
  return {
    signalDate: row.date,
    entryDate: row.nextDate,
    symbol: row.symbol,
    name: row.name,
    market: row.market,
    regime: row.factors.regime,
    atrPct: row.factors.atrPct,
    score: config.family.score(row),
    futureBars: row.futureBars,
    stopDistancePct,
    rewardRisk: 2,
    maxHoldingDays: config.holdingDays,
    trailingStopRule: { triggerPct: 6, lockPct: 1.5, givebackPct: 4 },
    positionPct: config.stockPct,
    accountRiskPct: 0.6,
    reason: config.name,
    orderIntent: decisionToOrderIntent(decision, { account: { equity: 1_000_000, availableCash: 1_000_000 } })
  };
}

function etfCandidate(row, marketRows, config, rowByDate) {
  if (!config.base.positionPct) return null;
  if (!(row.close > row.ma60 && row.mom20 > 0 && row.mom60 > 0)) return null;
  if (['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.regime)) return null;
  const sourceIndex = marketRows.findIndex(item => item.date === row.date);
  const futureBars = marketRows.slice(sourceIndex + 1, sourceIndex + 70).map(item => ({
    date: item.date,
    open: item.benchmarkBar.open,
    high: Math.max(item.benchmarkBar.open, item.benchmarkBar.close),
    low: Math.min(item.benchmarkBar.open, item.benchmarkBar.close),
    close: item.benchmarkBar.close,
    price: item.benchmarkBar.close
  }));
  if (!futureBars.length) return null;
  for (let index = 0; index + 1 < futureBars.length; index += 1) {
    const future = rowByDate.get(futureBars[index].date);
    if (future && (future.close < future.ma60 || future.mom20 < -2 || ['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(future.regime))) {
      futureBars[index + 1].forcedExit = { price: futureBars[index + 1].open, reason: '0050 趨勢轉弱出場', type: 'market_risk_exit' };
      break;
    }
  }
  const next = futureBars[0];
  const decision = {
    date: next.date,
    symbol: '0050.TW',
    action: 'BUY',
    strategyId: `live_ready_hunter_v1:${config.id}`,
    setup: [config.base.name],
    trigger: ['大盤位於 MA60 上方且動能為正'],
    invalidation: ['跌破 MA60、動能轉弱或高波動風險盤'],
    entryPlan: { referencePrice: next.open, maximumAcceptablePrice: next.open * 1.003, orderType: 'MARKETABLE_LIMIT', timeInForce: 'ROD', session: 'REGULAR' },
    riskPlan: { stopPrice: next.open * 0.75, targetPrice: null, riskRewardRatio: null, positionBudget: config.base.positionPct / 100 * 1_000_000, riskBudget: config.base.positionPct / 100 * 1_000_000 },
    reason: config.base.name,
    warnings: ['ETF 底倉仍需 paper trading 驗證，不能直接實盤']
  };
  return {
    signalDate: row.date,
    entryDate: next.date,
    symbol: '0050.TW',
    name: '元大台灣50',
    market: 'ETF',
    regime: row.regime,
    atrPct: row.vol20 || 2,
    score: 10_000 + (row.mom20 || 0),
    futureBars,
    stopDistancePct: 25,
    rewardRisk: null,
    maxHoldingDays: 60,
    positionPct: config.base.positionPct,
    accountRiskPct: config.base.positionPct,
    reason: config.base.name,
    orderIntent: decisionToOrderIntent(decision, { account: { equity: 1_000_000, availableCash: 1_000_000 } })
  };
}

function buildMaps(context, marketRows) {
  const maps = new Map(configs.map(config => [config.id, new Map()]));
  const marketByDate = new Map(marketRows.map(row => [row.date, row]));
  const marketRowByDate = new Map(marketRows.map(row => [row.date, row]));
  for (const config of configs) {
    for (const row of marketRows) {
      const candidate = etfCandidate(row, marketRows, config, marketRowByDate);
      if (candidate) addTop(maps.get(config.id), row.date, candidate, 1);
    }
  }
  iterateObservations(context, row => {
    if (row.date < START_DATE) return;
    const market = marketByDate.get(row.date);
    if (!market) return;
    if (row.factors.transactionValue < 30_000_000 || Math.abs(row.factors.gapPct) > 6) return;
    for (const config of configs) {
      if (!config.family.filter(row)) continue;
      addTop(maps.get(config.id), row.date, stockCandidate(row, config), config.topCount + (config.base.positionPct ? 1 : 0));
    }
  });
  return maps;
}

function riskRules() {
  return {
    maxAccountRiskPct: 80,
    maxSinglePositionPct: 80,
    exposureLimits: {
      BULL_TREND: 95,
      THEME_MOMENTUM: 95,
      BULL_PULLBACK: 75,
      RANGE_BOUND: 45,
      HIGH_VOLATILITY: 0,
      BEAR_DEFENSE: 0
    },
    drawdownBlockPct: 8,
    monthlyLossBlockPct: 5,
    dailyLossBlockPct: 2
  };
}

function trainScore(summary) {
  if (!summary || summary.trades < 20) return -Infinity;
  return summary.averageMonthlyEquityReturnPct * 10
    + Math.min(3, summary.profitFactor || 0)
    + summary.maximumDrawdownPct * 0.25
    - summary.negativeMonths * 0.1;
}

function combine(rows) {
  const trades = rows.flatMap(row => row.validation.trades);
  const months = rows.flatMap(row => row.validation.summary.monthly);
  const gains = trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(trades.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
  const monthly = months.map(row => row.equityReturnPct);
  const compounded = monthly.reduce((value, item) => value * (1 + item / 100), 1);
  const averageMonthly = mean(monthly) || 0;
  return {
    validationTrades: trades.length,
    validationAverageMonthlyEquityReturnPct: round(averageMonthly),
    improvementVsPreviousPct: round(averageMonthly - PRIOR_BEST_MONTHLY),
    targetGapPct: round(TARGET_MONTHLY - averageMonthly),
    validationAnnualizedReturnPct: round(monthly.length ? (compounded ** (12 / monthly.length) - 1) * 100 : 0),
    validationProfitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    validationMaximumDrawdownPct: round(Math.min(0, ...rows.map(row => row.validation.summary.maximumDrawdownPct))),
    validationWinRatePct: round(trades.filter(row => row.realizedPnl > 0).length / Math.max(1, trades.length) * 100),
    validationNegativeMonths: months.filter(row => row.equityReturnPct < 0).length,
    orderIntents: trades.filter(row => row.orderIntent).length
  };
}

async function main() {
  const [context, marketPayload] = await Promise.all([loadResearchContext(), readJson(MARKET)]);
  const marketRows = enrichMarket(marketPayload);
  const range = { start: marketRows[0].date, end: marketRows.at(-1).date };
  const folds = foldWindows(range.start, range.end, 36, 12);
  const maps = buildMaps(context, marketRows);
  const foldResults = [];
  for (const fold of folds) {
    let selected = null;
    for (const config of configs) {
      const train = simulateSignalMap(context, maps.get(config.id), {
        startDate: fold.trainStart,
        endDate: fold.trainEnd,
        maxOpenPositions: config.topCount + (config.base.positionPct ? 1 : 0),
        strategyId: config.id,
        riskRules: riskRules()
      });
      const score = trainScore(train.summary);
      if (!selected || score > selected.score) selected = { config, train, score };
    }
    const validation = simulateSignalMap(context, maps.get(selected.config.id), {
      startDate: fold.validationStart,
      endDate: fold.validationEnd,
      maxOpenPositions: selected.config.topCount + (selected.config.base.positionPct ? 1 : 0),
      strategyId: selected.config.id,
      riskRules: riskRules()
    });
    foldResults.push({ ...fold, selectedConfig: selected.config.id, selectedName: selected.config.name, train: selected.train, validation });
    console.log(`${fold.validationStart}：${selected.config.name}，validation 月均 ${validation.summary.averageMonthlyEquityReturnPct}%`);
  }
  const metrics = combine(foldResults);
  const improved = metrics.validationAverageMonthlyEquityReturnPct > PRIOR_BEST_MONTHLY;
  const passPaperGate = metrics.validationTrades >= 100
    && metrics.validationAverageMonthlyEquityReturnPct > PRIOR_BEST_MONTHLY
    && metrics.validationProfitFactor > 1.15
    && metrics.validationMaximumDrawdownPct > -20;
  const result = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    status: improved ? 'IMPROVED' : 'NO_IMPROVEMENT',
    priorBestMonthlyPct: PRIOR_BEST_MONTHLY,
    targetMonthlyPct: TARGET_MONTHLY,
    configsTested: configs.length,
    folds: foldResults.map(row => ({
      trainStart: row.trainStart,
      trainEnd: row.trainEnd,
      validationStart: row.validationStart,
      validationEnd: row.validationEnd,
      selectedConfig: row.selectedConfig,
      selectedName: row.selectedName,
      trainMonthly: row.train.summary.averageMonthlyEquityReturnPct,
      validationMonthly: row.validation.summary.averageMonthlyEquityReturnPct,
      validationTrades: row.validation.summary.trades
    })),
    metrics,
    readiness: {
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      brokerApiAllowed: false,
      paperGateWouldPassAfterHumanApproval: passPaperGate,
      reason: passPaperGate
        ? '雖通過研究門檻，但仍需先人工驗收與紙上交易，不可直接實盤。'
        : '未達可進紙上交易門檻，不可實盤。'
    }
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, [
    '# Live Ready Hunter v1',
    '',
    `結論：${improved ? '月均有提高' : '月均沒有提高'}，但目前仍不可實盤。`,
    '',
    `- Validation 月均報酬：${metrics.validationAverageMonthlyEquityReturnPct}%`,
    `- 距離月均 10%：${metrics.targetGapPct}%`,
    `- 年化：${metrics.validationAnnualizedReturnPct}%`,
    `- PF：${metrics.validationProfitFactor}`,
    `- 最大回撤：${metrics.validationMaximumDrawdownPct}%`,
    `- 交易數：${metrics.validationTrades}`,
    `- 紙上交易：不可自動啟用，需人工驗收`,
    `- 實盤：不可`,
    ''
  ].join('\n'), 'utf8');
  await fs.writeFile(READINESS, [
    '# 自動交易落地判斷',
    '',
    '目前沒有任何策略可直接實盤或接真實券商 API。',
    '',
    `Live Ready Hunter v1：月均 ${metrics.validationAverageMonthlyEquityReturnPct}%，最大回撤 ${metrics.validationMaximumDrawdownPct}%，交易 ${metrics.validationTrades} 筆。`,
    passPaperGate
      ? '研究門檻接近可進 paper trading，但仍需你人工確認後才可啟用。'
      : '尚未達可進 paper trading 的研究門檻。',
    ''
  ].join('\n'), 'utf8');
  await appendExperiment({
    strategyId: 'live_ready_hunter_v1',
    dataSources: ['OHLCV', '0050', 'market-regime', 'trade-value', 'relative-strength'],
    setupRules: ['0050 趨勢底倉', '強勢股短線疊加', '大盤風控降曝險'],
    triggerRules: ['收盤確認，隔日開盤'],
    invalidationRules: ['大盤轉弱', '停損', '停利', '持有期滿'],
    exitRules: ['MA60/市場風險出場', '2R/移動停利/持有期出場'],
    riskRules: riskRules(),
    blockedWhen: ['空頭防守', '高波動風險盤', '跳空過大', '成交值不足'],
    parameters: { version: 'v1', configsTested: configs.length, startDate: START_DATE },
    trainPeriod: { months: 36 },
    validationPeriod: { months: 12, stepMonths: 12 },
    costModel: 'fees-tax-slippage',
    executionModel: 'shared-simulator-next-open-T+2',
    metrics,
    resultStatus: passPaperGate ? 'inconclusive' : improved ? 'inconclusive' : 'failed',
    passedMinimum: false,
    passedHighProfit: false,
    allowRetest: false,
    notes: improved ? '月均提高但不可直接實盤。' : '未提高月均。'
  });
  console.log(`Live Ready Hunter：月均 ${metrics.validationAverageMonthlyEquityReturnPct}%，提高 ${metrics.improvementVsPreviousPct}%，實盤：不可。`);
}

await main();
