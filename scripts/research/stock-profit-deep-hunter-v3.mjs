import fs from 'node:fs/promises';
import {
  foldWindows,
  iterateObservations,
  loadResearchContext,
  round,
  simulateSignalMap
} from './research-core.mjs';
import { appendExperiment } from './strategy-experiment-registry.mjs';

const OUTPUT = new URL('../../data/research/stock-profit-deep-hunter-v3.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_PROFIT_DEEP_HUNTER_V3.md', import.meta.url);
const READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);
const TARGET_MONTHLY = 5;

const families = [
  {
    id: 'liquid_breakout_leader',
    name: '高流動強勢突破',
    filter: row => ['BULL_TREND', 'THEME_MOMENTUM'].includes(row.factors.regime)
      && row.factors.marketAboveMa60
      && row.factors.marketReturn20 >= -1
      && row.factors.breakout20
      && row.factors.relativeMarket20 >= 3
      && row.factors.return20 >= 4
      && row.factors.return20 <= 35
      && row.factors.volumeRatio20 >= 1.2
      && row.factors.transactionValuePercentile >= 0.7
      && row.factors.atrPct >= 1.2
      && row.factors.atrPct <= 7
      && row.factors.gapPct <= 4
      && !row.factors.longUpperWick,
    score: row => row.factors.relativeMarket20 * 2
      + row.factors.return20 * 0.8
      + row.factors.transactionValuePercentile * 12
      + Math.min(4, row.factors.volumeRatio20) * 4
      - row.factors.atrPct
  },
  {
    id: 'pullback_turning_strong',
    name: '強勢股拉回轉強',
    filter: row => ['BULL_TREND', 'THEME_MOMENTUM', 'BULL_PULLBACK'].includes(row.factors.regime)
      && row.factors.marketAboveMa60
      && row.factors.return60 >= 10
      && row.factors.return20 >= 0
      && row.factors.return5 >= -7
      && row.factors.return5 <= 3
      && row.factors.relativeMarket20 >= 2
      && row.factors.distanceMa20 >= -4
      && row.factors.distanceMa20 <= 5
      && row.factors.ma20AboveMa60
      && row.day.close > row.day.open
      && row.day.close >= row.prior.close
      && row.factors.transactionValuePercentile >= 0.55
      && row.factors.atrPct <= 6
      && Math.abs(row.factors.gapPct) <= 3,
    score: row => row.factors.return60 * 0.5
      + row.factors.relativeMarket20 * 2
      - Math.abs(row.factors.distanceMa20) * 1.5
      - row.factors.atrPct
  },
  {
    id: 'burst_continuation_guarded',
    name: '爆量長紅後續強控風險',
    filter: row => ['BULL_TREND', 'THEME_MOMENTUM'].includes(row.factors.regime)
      && row.factors.marketAboveMa60
      && row.factors.return5 >= 4
      && row.factors.return5 <= 20
      && row.factors.return20 >= 6
      && row.factors.return20 <= 38
      && row.factors.relativeMarket20 >= 4
      && row.factors.volumeRatio20 >= 1.4
      && row.factors.volumeRatio20 <= 5
      && row.day.close > row.day.open
      && row.day.close > row.prior.high
      && row.factors.transactionValuePercentile >= 0.62
      && row.factors.atrPct <= 7
      && row.factors.gapPct <= 4
      && !row.factors.longUpperWick,
    score: row => row.factors.return5 * 1.2
      + row.factors.relativeMarket20 * 1.7
      + Math.min(5, row.factors.volumeRatio20) * 5
      - row.factors.atrPct
  },
  {
    id: 'low_vol_relative_leader',
    name: '低波相對強勢領漲',
    filter: row => ['BULL_TREND', 'THEME_MOMENTUM'].includes(row.factors.regime)
      && row.factors.marketAboveMa60
      && row.factors.relativeMarket20 >= 3
      && row.factors.return60 >= 8
      && row.factors.return60 <= 45
      && row.factors.atrPct <= 4
      && row.factors.transactionValuePercentile >= 0.65
      && row.factors.rangePosition20 >= 0.5
      && row.factors.distanceMa20 >= -3
      && row.factors.distanceMa20 <= 7
      && row.factors.ma20AboveMa60
      && Math.abs(row.factors.gapPct) <= 3,
    score: row => row.factors.relativeMarket20 * 2.2
      + row.factors.return60 * 0.4
      + row.factors.transactionValuePercentile * 12
      - row.factors.atrPct * 2.5
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

function mergeSelectedMaps(selectedConfigs, maps) {
  const merged = new Map();
  for (const config of selectedConfigs) {
    for (const [date, rows] of maps.get(config.id)) {
      const bucket = merged.get(date) || [];
      for (const row of rows) {
        const copy = { ...row, strategyId: config.id, reason: config.name };
        const existing = bucket.findIndex(item => item.symbol === row.symbol);
        if (existing >= 0) {
          if (copy.score > bucket[existing].score) bucket[existing] = copy;
        } else {
          bucket.push(copy);
        }
      }
      bucket.sort((a, b) => b.score - a.score);
      merged.set(date, bucket.slice(0, 5));
    }
  }
  return merged;
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
    const trainRows = [];
    for (const config of configs) {
      const train = simulateSignalMap(context, maps.get(config.id), {
        startDate: fold.trainStart,
        endDate: fold.trainEnd,
        maxOpenPositions: config.topCount,
        strategyId: config.id,
        riskRules: riskRules(config)
      });
      trainRows.push({ config, train, score: scoreSummary(train.summary) });
    }
    const selectedRows = trainRows
      .filter(row => Number.isFinite(row.score))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    if (!selectedRows.length) continue;
    const selectedConfigs = selectedRows.map(row => row.config);
    const mergedMap = mergeSelectedMaps(selectedConfigs, maps);
    const selectedTrain = simulateSignalMap(context, mergedMap, {
      startDate: fold.trainStart,
      endDate: fold.trainEnd,
      maxOpenPositions: 5,
      strategyId: 'stock_profit_deep_hunter_v3_ensemble',
      riskRules: riskRules(selectedConfigs[0])
    });
    const validation = simulateSignalMap(context, mergedMap, {
      startDate: fold.validationStart,
      endDate: fold.validationEnd,
      maxOpenPositions: 5,
      strategyId: 'stock_profit_deep_hunter_v3_ensemble',
      riskRules: riskRules(selectedConfigs[0])
    });
    selections.push({
      ...fold,
      configId: selectedConfigs.map(row => row.id).join(' / '),
      configName: selectedConfigs.map(row => row.name).join(' / '),
      trainMonthlyPct: selectedTrain.summary.averageMonthlyEquityReturnPct,
      trainDrawdownPct: selectedTrain.summary.maximumDrawdownPct,
      trainTrades: selectedTrain.summary.trades,
      validationMonthlyPct: validation.summary.averageMonthlyEquityReturnPct,
      validationDrawdownPct: validation.summary.maximumDrawdownPct,
      validationTrades: validation.summary.trades
    });
    validations.push(validation);
    console.log(`${fold.validationStart} ensemble，月均 ${validation.summary.averageMonthlyEquityReturnPct}% / 回撤 ${validation.summary.maximumDrawdownPct}% / 交易 ${validation.summary.trades}`);
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
    strategyId: 'stock_profit_deep_hunter_v3',
    objective: '個股為主，測試多策略 ensemble，避免單一配置在驗證期失效',
    dataSources: ['個股 OHLCV', '市場狀態', '族群相對強弱', '成交值分位'],
    methodology: '48 個月訓練、12 個月驗證，每次前進 12 個月；每折選訓練期前 3 名配置合併訊號；T 日收盤訊號、T+1 開盤成交、T+2。',
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
    '# 個股深度獲利獵人 v3',
    '',
    `- Validation 月均：${metrics.validationAverageMonthlyEquityReturnPct}%`,
    `- 距離月均 5%：${metrics.targetGapPct} 個百分點`,
    `- 最大回撤：${metrics.validationMaximumDrawdownPct}%`,
    `- Profit Factor：${metrics.validationProfitFactor}`,
    `- 交易數：${metrics.validationTrades}`,
    `- 勝率：${metrics.validationWinRatePct}%`,
    `- 是否通過：${passed ? '是' : '否'}`,
    '',
    '本腳本只測個股，不使用 ETF 作為主要標的。v3 重點是用多策略 ensemble 增加交易數並降低單一策略失效。',
    '未通過前不得 paper trading、不得接真實券商 API。',
    ''
  ].join('\n'), 'utf8');
  await fs.writeFile(READINESS, [
    '# 自動交易落地狀態',
    '',
    `個股深度獲利獵人 v3：月均 ${metrics.validationAverageMonthlyEquityReturnPct}%、最大回撤 ${metrics.validationMaximumDrawdownPct}%、交易 ${metrics.validationTrades} 筆。`,
    passed ? '可進入全新期間 paper trading；仍不可直接實盤。' : '未通過 validation，不可 paper trading、不可實盤、不可接真實券商 API。',
    ''
  ].join('\n'), 'utf8');
  await appendExperiment({
    strategyId: 'stock_profit_deep_hunter_v3',
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
  console.log(`個股深挖 v3：月均 ${metrics.validationAverageMonthlyEquityReturnPct}% / 回撤 ${metrics.validationMaximumDrawdownPct}% / 交易 ${metrics.validationTrades} 筆`);
}

await main();


