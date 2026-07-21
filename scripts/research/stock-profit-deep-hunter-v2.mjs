import fs from 'node:fs/promises';
import {
  foldWindows,
  iterateObservations,
  loadResearchContext,
  round,
  simulateSignalMap
} from './research-core.mjs';
import { appendExperiment } from './strategy-experiment-registry.mjs';

const OUTPUT = new URL('../../data/research/stock-profit-deep-hunter-v2.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_PROFIT_DEEP_HUNTER_V2.md', import.meta.url);
const READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);
const TARGET_MONTHLY = 5;

const families = [
  {
    id: 'orderly_strength_continuation',
    name: '強勢整理續攻',
    filter: row => ['BULL_TREND', 'THEME_MOMENTUM', 'BULL_PULLBACK'].includes(row.factors.regime)
      && row.factors.marketAboveMa60
      && row.factors.marketReturn20 >= 0
      && row.factors.marketVolatilityPercentile <= 0.85
      && row.factors.return60 >= 12
      && row.factors.return60 <= 70
      && row.factors.return20 >= 3
      && row.factors.return20 <= 28
      && row.factors.return5 >= -4
      && row.factors.return5 <= 8
      && row.factors.relativeMarket20 >= 4
      && row.factors.relativeTheme20 >= -1
      && row.factors.distanceMa20 >= -3
      && row.factors.distanceMa20 <= 7
      && row.factors.ma20AboveMa60
      && row.factors.ma20Slope > 0
      && row.factors.atrPct >= 1.2
      && row.factors.atrPct <= 5.5
      && row.factors.transactionValuePercentile >= 0.68
      && row.factors.rangePosition20 >= 0.55
      && row.factors.rangePosition20 <= 0.96
      && Math.abs(row.factors.gapPct) <= 3
      && !row.factors.longUpperWick,
    score: row => row.factors.relativeMarket20 * 2
      + row.factors.return60 * 0.45
      + row.factors.transactionValuePercentile * 12
      - Math.abs(row.factors.distanceMa20) * 1.6
      - row.factors.atrPct * 1.2
  },
  {
    id: 'burst_continuation_guarded',
    name: '爆量長紅後續強控風險',
    filter: row => ['BULL_TREND', 'THEME_MOMENTUM'].includes(row.factors.regime)
      && row.factors.marketAboveMa60
      && row.factors.marketReturn20 >= 1
      && row.factors.return5 >= 4
      && row.factors.return5 <= 18
      && row.factors.return20 >= 8
      && row.factors.return20 <= 35
      && row.factors.relativeMarket20 >= 5
      && row.factors.volumeRatio20 >= 1.4
      && row.factors.volumeRatio20 <= 4.5
      && row.day.close > row.day.open
      && row.day.close > row.prior.high
      && row.factors.transactionValuePercentile >= 0.7
      && row.factors.atrPct >= 1.6
      && row.factors.atrPct <= 6.5
      && row.factors.rangePosition20 <= 0.97
      && row.factors.gapPct <= 3
      && !row.factors.longUpperWick,
    score: row => row.factors.return5 * 1.2
      + row.factors.relativeMarket20 * 1.8
      + Math.min(4.5, row.factors.volumeRatio20) * 6
      - row.factors.atrPct
  },
  {
    id: 'low_vol_relative_leader',
    name: '低波相對強勢領漲',
    filter: row => ['BULL_TREND', 'THEME_MOMENTUM'].includes(row.factors.regime)
      && row.factors.marketAboveMa60
      && row.factors.marketReturn20 >= 0
      && row.factors.relativeMarket20 >= 4
      && row.factors.return60 >= 8
      && row.factors.return60 <= 45
      && row.factors.atrPct <= 3.6
      && row.factors.transactionValuePercentile >= 0.75
      && row.factors.rangePosition20 >= 0.55
      && row.factors.rangePosition20 <= 0.93
      && row.factors.distanceMa20 >= -2.5
      && row.factors.distanceMa20 <= 6
      && row.factors.ma20AboveMa60
      && row.factors.ma60Slope >= -0.2
      && Math.abs(row.factors.gapPct) <= 2.5,
    score: row => row.factors.relativeMarket20 * 2.4
      + row.factors.return60 * 0.45
      + row.factors.transactionValuePercentile * 14
      - row.factors.atrPct * 3
      - Math.abs(row.factors.distanceMa20)
  }
];
const configs = [];
for (const family of families) {
  for (const topCount of [2, 3, 5]) {
    for (const holdingDays of [5, 7, 10]) {
      for (const stopMult of [1, 1.5]) {
        for (const rewardRisk of [1.2, 1.8, 2.4]) {
          for (const positionPct of topCount === 2 ? [18, 24, 30] : topCount === 3 ? [12, 16, 20] : [8, 10, 12]) {
            configs.push({
              id: `${family.id}_top${topCount}_hold${holdingDays}_stop${stopMult}_rr${rewardRisk}_pct${positionPct}`,
              name: `${family.name} Top${topCount} 持有${holdingDays}日`,
              family,
              topCount,
              holdingDays,
              stopMult,
              rewardRisk,
              positionPct
            });
          }
        }
      }
    }
  }
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

function stopDistance(row, config) {
  return Math.max(2.5, Math.min(12, row.factors.atrPct * config.stopMult));
}

function buildMaps(context) {
  const maps = new Map(configs.map(config => [config.id, new Map()]));
  iterateObservations(context, observation => {
    if (observation.factors.transactionValue < 40_000_000) return;
    if (Math.abs(observation.factors.gapPct) > 4) return;
    if (observation.day.close < 15) return;
    for (const config of configs) {
      if (!config.family.filter(observation)) continue;
      const score = config.family.score(observation);
      addTop(maps.get(config.id), observation.date, {
        signalDate: observation.date,
        entryDate: observation.nextDate,
        symbol: observation.symbol,
        name: observation.name,
        market: observation.market,
        regime: observation.factors.regime,
        atrPct: observation.factors.atrPct,
        score,
        futureBars: observation.futureBars,
        stopDistancePct: stopDistance(observation, config),
        rewardRisk: config.rewardRisk,
        maxHoldingDays: config.holdingDays,
        positionPct: config.positionPct,
        accountRiskPct: config.positionPct >= 24 ? 1.4 : config.positionPct >= 16 ? 1 : 0.75,
        trailingStopRule: { type: 'percent', valuePct: Math.max(4, observation.factors.atrPct * 1.2) },
        setup: [config.family.name, `分數 ${round(score, 2)}`],
        trigger: ['訊號日收盤確認，隔日開盤進場'],
        invalidation: ['停損、停利、移動停利、持有天數、帳戶風控'],
        exitPlan: [`最多持有 ${config.holdingDays} 日，停利 ${config.rewardRisk}R`],
        reason: config.name
      }, config.topCount);
    }
  });
  return maps;
}

function riskRules(config) {
  return {
    maxAccountRiskPct: config.positionPct >= 24 ? 1.4 : config.positionPct >= 16 ? 1 : 0.75,
    maxSinglePositionPct: Math.min(34, config.positionPct + 4),
    exposureLimits: {
      BULL_TREND: 90,
      THEME_MOMENTUM: 90,
      BULL_PULLBACK: 65,
      RANGE_BOUND: 20,
      HIGH_VOLATILITY: 0,
      BEAR_DEFENSE: 0
    },
    drawdownBlockPct: 9,
    drawdownBlockDays: 15,
    monthlyLossBlockPct: 6,
    dailyLossBlockPct: 2.5,
    dailyLossBlockDays: 1,
    losingStreakCount: 5,
    losingStreakBlockDays: 10
  };
}

function scoreSummary(summary) {
  if (!summary || summary.trades < 60) return -Infinity;
  const pf = Number.isFinite(summary.profitFactor) ? Math.min(3, summary.profitFactor) : 3;
  return summary.averageMonthlyEquityReturnPct * 16
    + pf * 5
    + Math.min(300, summary.trades) * 0.02
    + summary.maximumDrawdownPct * 0.8
    - summary.concentrationPct * 0.04
    - summary.negativeMonths * 0.12;
}

function aggregate(results) {
  const months = results.flatMap(row => row.summary.monthly);
  const trades = results.flatMap(row => row.trades);
  const gains = trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(trades.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
  return {
    validationTrades: trades.length,
    validationAverageMonthlyEquityReturnPct: round(months.reduce((sum, row) => sum + row.equityReturnPct, 0) / Math.max(1, months.length)),
    validationMaximumDrawdownPct: round(Math.min(0, ...results.map(row => row.summary.maximumDrawdownPct))),
    validationProfitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    validationWinRatePct: round(trades.filter(row => row.realizedPnl > 0).length / Math.max(1, trades.length) * 100),
    validationNegativeMonths: months.filter(row => row.equityReturnPct < 0).length,
    concentrationPct: round(Math.max(0, ...Object.values(Object.groupBy
      ? Object.groupBy(trades, trade => trade.symbol)
      : trades.reduce((groups, trade) => {
        (groups[trade.symbol] ||= []).push(trade);
        return groups;
      }, {})).map(rows => rows.length)) / Math.max(1, trades.length) * 100),
    folds: results.length
  };
}

async function main() {
  const context = await loadResearchContext();
  const maps = buildMaps(context);
  const windows = foldWindows(context.startDate, context.endDate, 48, 12);
  const selections = [];
  const validations = [];
  for (const fold of windows) {
    let selected = null;
    let selectedTrain = null;
    for (const config of configs) {
      const train = simulateSignalMap(context, maps.get(config.id), {
        startDate: fold.trainStart,
        endDate: fold.trainEnd,
        maxOpenPositions: config.topCount,
        strategyId: config.id,
        riskRules: riskRules(config)
      });
      if (scoreSummary(train.summary) > scoreSummary(selectedTrain?.summary)) {
        selected = config;
        selectedTrain = train;
      }
    }
    if (!selected) continue;
    const validation = simulateSignalMap(context, maps.get(selected.id), {
      startDate: fold.validationStart,
      endDate: fold.validationEnd,
      maxOpenPositions: selected.topCount,
      strategyId: selected.id,
      riskRules: riskRules(selected)
    });
    selections.push({
      ...fold,
      configId: selected.id,
      configName: selected.name,
      trainMonthlyPct: selectedTrain.summary.averageMonthlyEquityReturnPct,
      trainDrawdownPct: selectedTrain.summary.maximumDrawdownPct,
      trainTrades: selectedTrain.summary.trades,
      validationMonthlyPct: validation.summary.averageMonthlyEquityReturnPct,
      validationDrawdownPct: validation.summary.maximumDrawdownPct,
      validationTrades: validation.summary.trades
    });
    validations.push(validation);
    console.log(`${fold.validationStart} ${selected.name}，月均 ${validation.summary.averageMonthlyEquityReturnPct}% / 回撤 ${validation.summary.maximumDrawdownPct}% / 交易 ${validation.summary.trades}`);
  }
  const metrics = aggregate(validations);
  metrics.targetGapPct = round(TARGET_MONTHLY - metrics.validationAverageMonthlyEquityReturnPct);
  const passed = metrics.validationAverageMonthlyEquityReturnPct >= TARGET_MONTHLY
    && metrics.validationMaximumDrawdownPct > -20
    && metrics.validationTrades >= 300
    && metrics.validationProfitFactor > 1.15;
  const result = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    strategyId: 'stock_profit_deep_hunter_v2',
    objective: '個股為主，針對 v1 回撤過深問題，測試順風市場下的續攻與低波領漲策略',
    dataSources: ['個股 OHLCV', '市場狀態', '族群相對強弱', '成交值分位'],
    methodology: '48 個月訓練、12 個月驗證，每次前進 12 個月；T 日收盤訊號、T+1 開盤成交、T+2；提高市場順風與低回撤要求。',
    configurationsTested: configs.length,
    folds: windows.length,
    selections,
    metrics,
    readiness: {
      monthlyFivePctPassed: metrics.validationAverageMonthlyEquityReturnPct >= TARGET_MONTHLY,
      drawdownAcceptable: metrics.validationMaximumDrawdownPct > -20,
      tradesEnough: metrics.validationTrades >= 300,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      reason: passed
        ? '達成本次研究門檻，但仍需全新期間 paper trading，不可直接實盤。'
        : '尚未達成月均 5%、回撤、交易數與 PF 門檻，不可 paper trading 或實盤。'
    }
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, [
    '# 個股深度獲利獵人 v2',
    '',
    `- Validation 月均：${metrics.validationAverageMonthlyEquityReturnPct}%`,
    `- 距離月均 5%：${metrics.targetGapPct} 個百分點`,
    `- 最大回撤：${metrics.validationMaximumDrawdownPct}%`,
    `- Profit Factor：${metrics.validationProfitFactor}`,
    `- 交易數：${metrics.validationTrades}`,
    `- 勝率：${metrics.validationWinRatePct}%`,
    `- 是否通過：${passed ? '是' : '否'}`,
    '',
    '本腳本只測個股，不使用 ETF 作為主要標的。v2 重點是修正 v1 在錯誤環境追強造成回撤過深的問題。',
    '未通過前不得 paper trading、不得接真實券商 API。',
    ''
  ].join('\n'), 'utf8');
  await fs.writeFile(READINESS, [
    '# 自動交易落地狀態',
    '',
    `個股深度獲利獵人 v2：月均 ${metrics.validationAverageMonthlyEquityReturnPct}%、最大回撤 ${metrics.validationMaximumDrawdownPct}%、交易 ${metrics.validationTrades} 筆。`,
    passed ? '可進入全新期間 paper trading；仍不可直接實盤。' : '未通過 validation，不可 paper trading、不可實盤、不可接真實券商 API。',
    ''
  ].join('\n'), 'utf8');
  await appendExperiment({
    strategyId: 'stock_profit_deep_hunter_v2',
    dataSources: result.dataSources,
    setupRules: families.map(row => row.name),
    triggerRules: ['T 日收盤確認，T+1 開盤成交'],
    invalidationRules: ['停損、停利、移動停利、持有天數、帳戶風控'],
    exitRules: ['固定短持有期', 'R 倍停利', 'ATR 停損', '移動停利'],
    riskRules: ['T+2', '費稅滑價', '單檔/總曝險/連虧/月損熔斷'],
    blockedWhen: ['空頭防守禁止新倉', '帳戶風控熔斷'],
    parameters: { configs: configs.length, trainMonths: 48, validationMonths: 12 },
    trainPeriod: { months: 48 },
    validationPeriod: { months: 12, stepMonths: 12 },
    costModel: 'fees-tax-slippage',
    executionModel: 'shared next_open_market',
    metrics,
    resultStatus: passed ? 'inconclusive' : 'failed',
    passedMinimum: passed,
    passedHighProfit: passed && metrics.validationAverageMonthlyEquityReturnPct >= TARGET_MONTHLY,
    allowRetest: false,
    notes: result.readiness.reason
  });
  console.log(`個股深挖 v2：月均 ${metrics.validationAverageMonthlyEquityReturnPct}% / 回撤 ${metrics.validationMaximumDrawdownPct}% / 交易 ${metrics.validationTrades} 筆`);
}

await main();

