import fs from 'node:fs/promises';
import {
  foldWindows,
  iterateObservations,
  loadResearchContext,
  round,
  simulateSignalMap
} from './research-core.mjs';
import {
  appendExperiment,
  buildExperimentIdentity,
  loadRegistry,
  shouldSkipExperiment
} from './strategy-experiment-registry.mjs';

const OUTPUT = new URL('../../data/research/burst-continuation-hunter-v1.json', import.meta.url);
const REPORT = new URL('../../docs/BURST_CONTINUATION_HUNTER_V1.md', import.meta.url);
const AUTO_READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);

const PRIOR_BEST_MONTHLY = 0.648;
const TARGET_MONTHLY = 10;
const DATA_SOURCES = ['OHLCV', 'market-regime', 'trade-value', 'relative-strength'];

const familyFilters = [
  {
    id: 'volume_breakout',
    name: '放量突破續強',
    filter: row => row.factors.breakout20
      && row.factors.volumeRatio20 >= 1.5
      && row.factors.relativeMarket20 >= 4
      && row.factors.return20 >= 3
      && row.factors.return20 <= 45
      && row.factors.transactionValuePercentile >= 0.75
      && row.factors.atrPct >= 1.5
      && row.factors.atrPct <= 7
      && row.factors.gapPct <= 5
      && !row.factors.longUpperWick
      && row.factors.marketAboveMa60
      && !['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.factors.regime),
    score: row => row.factors.relativeMarket20 * 2
      + Math.min(3, row.factors.volumeRatio20) * 8
      + row.factors.transactionValuePercentile * 12
      + row.factors.return20
  },
  {
    id: 'tight_base_restrength',
    name: '強勢整理再轉強',
    filter: row => row.factors.return60 >= 18
      && row.factors.return20 >= 0
      && row.factors.return5 >= -6
      && row.factors.return5 <= 4
      && row.factors.distanceMa20 >= -3
      && row.factors.distanceMa20 <= 6
      && row.factors.ma20Slope > 0
      && row.factors.ma60Slope >= -1
      && row.day.close > row.prior.high
      && row.factors.transactionValuePercentile >= 0.65
      && row.factors.atrPct <= 6
      && row.factors.marketAboveMa60,
    score: row => row.factors.return60
      + row.factors.relativeMarket20 * 1.5
      - Math.abs(row.factors.return5) * 1.5
      + row.factors.transactionValuePercentile * 10
  },
  {
    id: 'low_vol_relative_strength',
    name: '低波動相對強勢',
    filter: row => row.factors.relativeMarket20 >= 3
      && row.factors.relativeMarket20 <= 25
      && row.factors.atrPct <= 3.5
      && row.factors.transactionValuePercentile >= 0.75
      && row.factors.ma20AboveMa60
      && row.factors.ma20Slope > 0
      && row.factors.ma60Slope > -0.5
      && row.factors.rangePosition20 >= 0.55
      && row.factors.marketAboveMa60,
    score: row => row.factors.relativeMarket20 * 2
      + row.factors.transactionValuePercentile * 12
      - row.factors.atrPct * 2
  },
  {
    id: 'trend_pullback_resume',
    name: '趨勢拉回恢復',
    filter: row => row.factors.return60 >= 12
      && row.factors.relativeMarket20 >= 1
      && row.factors.return5 >= -8
      && row.factors.return5 <= 1
      && row.factors.distanceMa20 >= -4
      && row.factors.distanceMa20 <= 3
      && row.day.close > row.day.open
      && row.day.close > row.ma20
      && row.factors.transactionValuePercentile >= 0.6
      && row.factors.atrPct <= 6
      && !['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.factors.regime),
    score: row => row.factors.return60
      + row.factors.relativeMarket20 * 2
      - Math.abs(row.factors.distanceMa20) * 2
      + row.factors.transactionValuePercentile * 8
  },
  {
    id: 'bull_thrust_breakout',
    name: '強多攻擊盤突破',
    filter: row => ['BULL_TREND', 'THEME_MOMENTUM'].includes(row.factors.regime)
      && row.factors.marketReturn20 >= 3
      && row.factors.marketVolatilityPercentile <= 0.75
      && row.factors.breakout20
      && row.factors.volumeRatio20 >= 1.8
      && row.factors.relativeMarket20 >= 6
      && row.factors.return20 >= 8
      && row.factors.return20 <= 55
      && row.factors.return5 >= -3
      && row.factors.transactionValuePercentile >= 0.8
      && row.factors.atrPct >= 1.5
      && row.factors.atrPct <= 6
      && row.factors.distanceMa20 <= 12
      && row.factors.gapPct <= 4
      && !row.factors.longUpperWick,
    score: row => row.factors.relativeMarket20 * 2.5
      + row.factors.marketReturn20 * 2
      + Math.min(3, row.factors.volumeRatio20) * 8
      + row.factors.transactionValuePercentile * 15
      - row.factors.atrPct
  },
  {
    id: 'bull_low_vol_leader',
    name: '強多低波領漲股',
    filter: row => ['BULL_TREND', 'THEME_MOMENTUM'].includes(row.factors.regime)
      && row.factors.marketReturn20 >= 2
      && row.factors.marketVolatilityPercentile <= 0.7
      && row.factors.relativeMarket20 >= 5
      && row.factors.return60 >= 12
      && row.factors.return20 >= 2
      && row.factors.atrPct <= 3.8
      && row.factors.transactionValuePercentile >= 0.8
      && row.factors.ma20AboveMa60
      && row.factors.ma20Slope > 0
      && row.factors.rangePosition20 >= 0.65
      && row.factors.gapPct <= 3,
    score: row => row.factors.relativeMarket20 * 2
      + row.factors.return60 * 0.6
      + row.factors.transactionValuePercentile * 15
      - row.factors.atrPct * 2
  }
];

const configs = [];
for (const family of familyFilters) {
  for (const topCount of [3, 5, 8]) {
    for (const holdingDays of [3, 5, 7, 10]) {
      for (const stopMode of ['atr_1_2', 'atr_1_8', 'fixed_5']) {
        configs.push({
          id: `${family.id}_top${topCount}_hold${holdingDays}_${stopMode}`,
          name: `${family.name} Top ${topCount} 持有 ${holdingDays} 日 ${stopMode}`,
          family,
          topCount,
          holdingDays,
          stopMode
        });
      }
    }
  }
}

function addTop(map, date, row, limit) {
  const rows = map.get(date) || [];
  if (rows.length < limit) {
    rows.push(row);
  } else {
    let worst = 0;
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index].score < rows[worst].score) worst = index;
    }
    if (row.score <= rows[worst].score) return;
    rows[worst] = row;
  }
  map.set(date, rows);
}

function stopDistance(row, mode) {
  if (mode === 'atr_1_2') return Math.max(2.5, Math.min(8, row.factors.atrPct * 1.2));
  if (mode === 'atr_1_8') return Math.max(3, Math.min(10, row.factors.atrPct * 1.8));
  return 5;
}

function buildMaps(context) {
  const maps = new Map(configs.map(config => [config.id, new Map()]));
  iterateObservations(context, observation => {
    if (observation.factors.transactionValue < 30_000_000) return;
    if (Math.abs(observation.factors.gapPct) > 7) return;
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
        stopDistancePct: stopDistance(observation, config.stopMode),
        rewardRisk: 2,
        maxHoldingDays: config.holdingDays,
        positionPct: config.topCount <= 3 ? 16 : 11,
        setup: [config.family.name, `分數 ${round(score, 2)}`],
        trigger: ['訊號日收盤後確認，隔日開盤用共用成交模擬器進場'],
        invalidation: ['停損、停利、持有天數或風控觸發'],
        exitPlan: [`最多持有 ${config.holdingDays} 日，搭配 2R 停利與停損`],
        reason: config.name
      }, config.topCount);
    }
  });
  return maps;
}

function riskRules() {
  return {
    maxAccountRiskPct: 0.6,
    maxSinglePositionPct: 18,
    exposureLimits: {
      BULL_TREND: 80,
      THEME_MOMENTUM: 80,
      BULL_PULLBACK: 65,
      RANGE_BOUND: 35,
      HIGH_VOLATILITY: 0,
      BEAR_DEFENSE: 0
    },
    drawdownBlockPct: 8,
    monthlyLossBlockPct: 5,
    dailyLossBlockPct: 2
  };
}

function scoreSummary(summary) {
  if (!summary || summary.trades < 50) return -Infinity;
  return summary.averageMonthlyEquityReturnPct * 5
    + (summary.profitFactor || 0)
    - Math.abs(Math.min(0, summary.maximumDrawdownPct)) * 0.2
    - summary.concentrationPct * 0.03;
}

function aggregateValidation(rows) {
  const trades = rows.reduce((sum, row) => sum + row.summary.trades, 0);
  const months = rows.flatMap(row => row.summary.monthly);
  const weightedMonthly = months.length
    ? months.reduce((sum, row) => sum + row.equityReturnPct, 0) / months.length
    : 0;
  const equity = rows.reduce((value, row) => value * (row.summary.endingEquity / 1_000_000), 1_000_000);
  const gains = rows.reduce((sum, row) => sum + row.trades.filter(trade => trade.realizedPnl > 0).reduce((acc, trade) => acc + trade.realizedPnl, 0), 0);
  const losses = Math.abs(rows.reduce((sum, row) => sum + row.trades.filter(trade => trade.realizedPnl <= 0).reduce((acc, trade) => acc + trade.realizedPnl, 0), 0));
  const allTrades = rows.flatMap(row => row.trades);
  return {
    validationTrades: trades,
    validationAverageMonthlyEquityReturnPct: round(weightedMonthly),
    targetGapPct: round(TARGET_MONTHLY - weightedMonthly),
    priorBestGapPct: round(weightedMonthly - PRIOR_BEST_MONTHLY),
    validationAnnualizedReturnPct: round((equity / 1_000_000) ** (12 / Math.max(1, months.length)) * 100 - 100),
    validationProfitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    validationMaximumDrawdownPct: round(Math.min(0, ...rows.map(row => row.summary.maximumDrawdownPct))),
    validationWinRatePct: round(allTrades.filter(trade => trade.realizedPnl > 0).length / Math.max(1, allTrades.length) * 100),
    validationNegativeMonths: months.filter(row => row.equityReturnPct < 0).length,
    folds: rows.length
  };
}

async function writeReport(result) {
  const best = result.best;
  const lines = [
    '# Burst Continuation Hunter v1',
    '',
    '目標：停止微調舊失敗策略，改測短線爆發續強與趨勢拉回恢復規則，尋找是否能把 validation 月均報酬提高。',
    '',
    `- 目前最佳策略：${best?.name || '無'}`,
    `- Validation 月均報酬：${best?.metrics.validationAverageMonthlyEquityReturnPct ?? '無'}%`,
    `- 與先前最佳 0.648% 差距：${best?.metrics.priorBestGapPct ?? '無'} 個百分點`,
    `- 距離月均 10%：${best?.metrics.targetGapPct ?? '無'} 個百分點`,
    `- Profit Factor：${best?.metrics.validationProfitFactor ?? '無'}`,
    `- 最大回撤：${best?.metrics.validationMaximumDrawdownPct ?? '無'}%`,
    `- 交易次數：${best?.metrics.validationTrades ?? 0}`,
    '',
    best?.improved
      ? '結論：月均有比先前最佳提高，但仍需確認是否通過完整候選標準；未進 paper trading，也不可實盤。'
      : '結論：本輪沒有提高月均，不可 paper trading，也不可實盤。',
    ''
  ];
  await fs.writeFile(REPORT, `${lines.join('\n')}\n`, 'utf8');
  await fs.writeFile(AUTO_READINESS, [
    '# 自動交易落地狀態',
    '',
    '目前沒有任何策略通過可進 paper trading 或實盤的完整 validation 標準。',
    '',
    best?.improved
      ? `Burst Continuation Hunter v1 暫時把月均提高到 ${best.metrics.validationAverageMonthlyEquityReturnPct}%，但仍未接近月均 10%，不可直接接券商 API。`
      : 'Burst Continuation Hunter v1 沒有提高月均，不可接券商 API。',
    ''
  ].join('\n'), 'utf8');
}

async function main() {
  const context = await loadResearchContext();
  const windows = foldWindows(context.startDate, context.endDate, 36, 12);
  const identity = buildExperimentIdentity({
    strategyId: 'burst_continuation_hunter_v1',
    dataSources: DATA_SOURCES,
    setupRules: ['短線放量突破', '強勢整理再轉強', '低波動相對強勢', '趨勢拉回恢復'],
    triggerRules: ['訊號日收盤確認，隔日開盤進場'],
    invalidationRules: ['共用停損、停利、曝險風控'],
    exitRules: ['3/5/7/10 日持有、2R 停利、停損'],
    riskRules: riskRules(),
    blockedWhen: ['空頭防守', '高波動風險盤', '跳空過大', '成交值不足'],
    parameters: { configurations: configs.map(config => config.id) },
    trainPeriod: windows[0] ? { start: windows[0].trainStart, end: windows.at(-1).trainEnd } : null,
    validationPeriod: windows[0] ? { start: windows[0].validationStart, end: windows.at(-1).validationEnd } : null,
    costModel: '手續費、交易稅、滑價使用共用成交與投組模擬器',
    executionModel: 'next_open_market'
  });
  const registry = await loadRegistry();
  const skip = shouldSkipExperiment(registry, identity, {
    dataSources: DATA_SOURCES,
    coreRulesChanged: true
  });

  const maps = buildMaps(context);
  const validationRows = [];
  const foldSelections = [];
  if (!skip.skip) {
    for (const fold of windows) {
      let bestConfig = null;
      let bestTrain = null;
      for (const config of configs) {
        const train = simulateSignalMap(context, maps.get(config.id), {
          startDate: fold.trainStart,
          endDate: fold.trainEnd,
          maxOpenPositions: config.topCount,
          strategyId: config.id,
          riskRules: riskRules()
        });
        if (scoreSummary(train.summary) > scoreSummary(bestTrain?.summary)) {
          bestConfig = config;
          bestTrain = train;
        }
      }
      const validation = simulateSignalMap(context, maps.get(bestConfig.id), {
        startDate: fold.validationStart,
        endDate: fold.validationEnd,
        maxOpenPositions: bestConfig.topCount,
        strategyId: bestConfig.id,
        riskRules: riskRules()
      });
      foldSelections.push({
        ...fold,
        selectedConfig: bestConfig.id,
        selectedName: bestConfig.name,
        trainMonthly: bestTrain.summary.averageMonthlyEquityReturnPct,
        validationMonthly: validation.summary.averageMonthlyEquityReturnPct,
        validationTrades: validation.summary.trades
      });
      validationRows.push(validation);
      console.log(`${fold.validationStart}：${bestConfig.name}，validation 月均 ${validation.summary.averageMonthlyEquityReturnPct}%`);
    }
  }

  const metrics = skip.skip ? null : aggregateValidation(validationRows);
  const improved = metrics ? metrics.validationAverageMonthlyEquityReturnPct > PRIOR_BEST_MONTHLY : false;
  const best = metrics ? {
    id: 'burst_continuation_hunter_v1',
    name: '短線爆發續強 walk-forward 組合',
    metrics,
    improved,
    passMinimum: metrics.validationTrades > 300
      && metrics.validationAverageMonthlyEquityReturnPct > PRIOR_BEST_MONTHLY
      && metrics.validationProfitFactor > 1.15
      && metrics.validationMaximumDrawdownPct > -20
  } : null;
  const result = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    status: skip.skip ? 'SKIPPED' : 'COMPLETED',
    skip,
    priorBestMonthlyPct: PRIOR_BEST_MONTHLY,
    targetMonthlyPct: TARGET_MONTHLY,
    configurationsTested: configs.length,
    folds: windows.length,
    foldSelections,
    best
  };
  await fs.mkdir(new URL('../../data/research/', import.meta.url), { recursive: true });
  await fs.writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await writeReport(result);

  if (!skip.skip) {
    await appendExperiment({
      strategyId: 'burst_continuation_hunter_v1',
      dataSources: DATA_SOURCES,
      parameters: { configurationsTested: configs.length },
      trainPeriod: windows[0] ? { start: windows[0].trainStart, end: windows.at(-1).trainEnd } : null,
      validationPeriod: windows[0] ? { start: windows[0].validationStart, end: windows.at(-1).validationEnd } : null,
      costModel: 'fees-tax-slippage',
      executionModel: 'shared-simulator-next-open',
      metrics,
      resultStatus: best.passMinimum ? 'passed' : improved ? 'inconclusive' : 'failed',
      coreRulesChanged: true,
      passedMinimum: best.passMinimum,
      passedHighProfit: false,
      allowRetest: false,
      notes: improved
        ? '月均有提高，但尚未達高報酬或實盤標準。'
        : '本輪未提高月均。'
    });
  }
  console.log(improved
    ? `月均有提高：${metrics.validationAverageMonthlyEquityReturnPct}% > ${PRIOR_BEST_MONTHLY}%。`
    : `沒有提高月均：${metrics?.validationAverageMonthlyEquityReturnPct ?? '無'}% <= ${PRIOR_BEST_MONTHLY}%。`);
}

await main();
