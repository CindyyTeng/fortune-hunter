import fs from 'node:fs/promises';
import { buildMarketRegimes } from '../lib/market-regime.mjs';
import { foldWindows, mean, round, simulateSignalMap } from './research-core.mjs';

const BACKTEST = new URL('../../data/tw-backtest-12y.json', import.meta.url);
const MARKET = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const SECTORS = new URL('../../data/sector/sector-classification.json', import.meta.url);
const OUTPUT = new URL('../../data/research/residual-industry-momentum-v1.json', import.meta.url);
const REPORT = new URL('../../docs/RESIDUAL_INDUSTRY_MOMENTUM_V1.md', import.meta.url);
const BASELINE = Object.freeze({ monthly: 2.68, drawdown: -16.07, trades: 208 });
const RANDOM_SEEDS = 20;

const definitions = [
  {
    id: 'market_residual',
    name: '大盤中性殘差動能',
    pointInTimeSafe: true,
    filter: row => row.residualMarket20 >= 5
      && row.avg20TradeValue >= 100_000_000
      && row.ma20Rising
      && row.atr14Pct >= 1
      && row.atr14Pct <= 4
      && row.distanceToMa20Pct <= 10,
    score: row => row.residualMarket20 / Math.max(1, row.atr14Pct)
      + row.nearYearHigh * 3
  },
  {
    id: 'market_residual_pullback',
    name: '大盤中性動能回檔',
    pointInTimeSafe: true,
    filter: row => row.momentum126_21 >= 8
      && row.return5Pct >= -4
      && row.return5Pct <= 1
      && row.residualMarket20 >= 3
      && row.distanceToMa20Pct >= -3
      && row.distanceToMa20Pct <= 4
      && row.ma20Rising
      && row.avg20TradeValue >= 80_000_000,
    score: row => row.momentum126_21 * 0.2
      + row.residualMarket20
      - Math.abs(row.distanceToMa20Pct)
  },
  {
    id: 'sector_residual',
    name: '產業中性殘差動能',
    pointInTimeSafe: false,
    filter: row => row.residualSector20 >= 3
      && row.sectorMomentum20 - row.marketMom20 >= 2
      && row.avg20TradeValue >= 80_000_000
      && row.ma20Rising
      && row.atr14Pct <= 4.5,
    score: row => row.residualSector20 / Math.max(1, row.atr14Pct)
      + row.sectorMomentum20 - row.marketMom20
  },
  {
    id: 'dual_residual_breakout',
    name: '雙殘差量價突破',
    pointInTimeSafe: false,
    filter: row => row.donchian20Breakout
      && row.residualMarket20 >= 4
      && row.residualSector20 >= 1
      && row.volumeRatio1To20 >= 1.2
      && row.avg20TradeValue >= 100_000_000
      && !row.highVolumeDistribution
      && row.atr14Pct <= 5,
    score: row => row.residualMarket20
      + row.residualSector20
      + Math.min(3, row.volumeRatio1To20)
  },
  {
    id: 'low_vol_dual_residual',
    name: '低波動雙殘差動能',
    pointInTimeSafe: false,
    filter: row => row.residualMarket20 >= 4
      && row.residualSector20 >= 1
      && row.atr14Pct <= 2.5
      && row.avg20TradeValue >= 150_000_000
      && row.ma20Rising,
    score: row => (row.residualMarket20 + row.residualSector20)
      / Math.max(0.8, row.atr14Pct)
  },
  {
    id: 'liquid_low_vol_quality',
    name: '高流動低波動品質',
    pointInTimeSafe: true,
    filter: row => row.signalScore >= 70
      && row.avg20TradeValue >= 150_000_000
      && row.atr14Pct >= 1
      && row.atr14Pct <= 4
      && row.ma20Rising
      && !row.highVolumeDistribution,
    score: row => row.signalScore
      + Math.log10(row.avg20TradeValue) * 5
      - row.atr14Pct * 10
      + row.nearYearHigh * 10
  },
  {
    id: 'intraday_strength_quality',
    name: '盤中強度品質',
    pointInTimeSafe: true,
    filter: row => row.signalScore >= 70
      && row.intradayMomentum20Pct >= 3
      && row.overnightMomentum20Pct <= 6
      && row.avg20TradeValue >= 100_000_000
      && row.volumeRatio1To20 >= 0.7
      && row.volumeRatio1To20 <= 3,
    score: row => row.signalScore
      + row.intradayMinusOvernight20Pct * 2
      + row.nearYearHigh * 10
  },
  {
    id: 'breakout_quality',
    name: '量價突破品質',
    pointInTimeSafe: true,
    filter: row => row.signalScore >= 70
      && row.donchian20Breakout
      && row.directionalTrendUp
      && row.volumeRatio1To20 >= 1
      && row.avg20TradeValue >= 100_000_000
      && !row.highVolumeDistribution,
    score: row => row.signalScore
      + Math.min(4, row.volumeRatio1To20) * 5
      + row.nearYearHigh * 20
  },
  {
    id: 'broad_signal_quality',
    name: '廣度訊號品質',
    pointInTimeSafe: true,
    filter: row => row.signalScore >= 65
      && row.avg20TradeValue >= 80_000_000
      && row.atr14Pct <= 5,
    score: row => row.signalScore
      + (row.ma20Rising ? 10 : 0)
      - (row.highVolumeDistribution ? 20 : 0)
  },
  {
    id: 'broad_risk_adjusted',
    name: '廣度風險調整動能',
    pointInTimeSafe: true,
    filter: row => row.signalScore >= 65
      && row.avg20TradeValue >= 80_000_000
      && row.atr14Pct >= 1
      && row.atr14Pct <= 5,
    score: row => row.signalScore
      + row.return20Pct / Math.max(1, row.atr14Pct) * 10
      + row.nearYearHigh * 20
  },
  {
    id: 'broad_liquidity',
    name: '廣度流動性優先',
    pointInTimeSafe: true,
    filter: row => row.signalScore >= 65
      && row.avg20TradeValue >= 80_000_000
      && row.atr14Pct <= 5,
    score: row => Math.log10(row.avg20TradeValue) * 20
      + row.signalScore
      - row.atr14Pct * 5
  },
  {
    id: 'broad_low_chase',
    name: '廣度低追價品質',
    pointInTimeSafe: true,
    filter: row => row.signalScore >= 65
      && row.avg20TradeValue >= 80_000_000
      && row.atr14Pct <= 5
      && row.chasePct <= 3
      && !row.highVolumeDistribution,
    score: row => row.signalScore
      - Math.abs(row.chasePct) * 8
      + row.nearYearHigh * 15
      + Math.min(10, row.intradayMinusOvernight20Pct)
  },
  {
    id: 'broad_moderate_unextended',
    name: '廣度中高分未延伸',
    pointInTimeSafe: true,
    filter: row => row.signalScore >= 65
      && row.signalScore <= 85
      && row.avg20TradeValue >= 80_000_000
      && row.atr14Pct <= 5
      && row.distanceToMa20Pct >= -2
      && row.distanceToMa20Pct <= 8
      && row.chasePct <= 3
      && !row.highVolumeDistribution,
    score: row => row.signalScore
      - Math.abs(row.distanceToMa20Pct) * 3
      - Math.abs(row.chasePct) * 8
      + Math.log10(row.avg20TradeValue) * 5
  },
  {
    id: 'broad_support_reclaim',
    name: '廣度支撐轉強',
    pointInTimeSafe: true,
    filter: row => row.signalScore >= 65
      && row.avg20TradeValue >= 80_000_000
      && row.atr14Pct <= 5
      && (row.supportBounce || row.falseBreakdownReclaim || row.crossAboveMa20)
      && row.distanceToMa20Pct <= 6
      && !row.highVolumeDistribution,
    score: row => row.signalScore
      + (row.falseBreakdownReclaim ? 20 : 0)
      + (row.supportBounce ? 10 : 0)
      - Math.abs(row.distanceToMa20Pct) * 2
  },
  {
    id: 'broad_consensus',
    name: '廣度多排名共識',
    pointInTimeSafe: true,
    filter: () => false,
    score: () => 0
  },
  {
    id: 'broad_anti_crowding',
    name: '廣度反擁擠分散',
    pointInTimeSafe: true,
    filter: () => false,
    score: () => 0
  }
];

const configurations = definitions.flatMap(definition => (
  definition.id.startsWith('broad_') ? [3, 5, 8] : [3, 5]
).flatMap(top =>
  [1, 1.5, 2].flatMap(accountRiskPct => [5].flatMap(holdingDays =>
    [0, 2].map(rewardRisk => ({
      id: `${definition.id}_top${top}_hold${holdingDays}_risk${accountRiskPct}_target${rewardRisk || 'trail'}`,
      definitionId: definition.id,
      name: `${definition.name} Top ${top}／持有 ${holdingDays} 日／風險 ${accountRiskPct}%／${rewardRisk ? `${rewardRisk}R 停利` : '移動停利'}`,
      top,
      holdingDays,
      accountRiskPct,
      rewardRisk,
      positionPct: top === 3 ? 30 : top === 5 ? 18 : 11
    }))
  ))));

function addCandidate(map, date, candidate, limit = 8) {
  const rows = map.get(date) || [];
  rows.push(candidate);
  rows.sort((left, right) => right.score - left.score);
  if (rows.length > limit) rows.length = limit;
  map.set(date, rows);
}

function deterministicScore(text) {
  let value = 2166136261;
  for (const character of text) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function tradeTiming(trade, entryMode) {
  if (entryMode !== 'close_confirm') {
    return {
      signalDate: trade.signalDate,
      entryDate: trade.entryDate,
      futureBars: trade.forwardPrices
    };
  }
  const entryBar = trade.forwardPrices?.[1];
  return entryBar ? {
    signalDate: trade.entryDate,
    entryDate: entryBar.date,
    futureBars: trade.forwardPrices.slice(1)
  } : null;
}

function buildMaps(trades, marketByDate, sectorBySymbol, entryMode) {
  const sectorRows = new Map();
  for (const trade of trades) {
    const timing = tradeTiming(trade, entryMode);
    if (!timing) continue;
    const sector = sectorBySymbol.get(trade.symbol) || trade.themes || '未分類';
    const key = `${timing.signalDate}|${sector}`;
    const row = sectorRows.get(key) || { sum: 0, count: 0 };
    row.sum += trade.return20Pct || 0;
    row.count += 1;
    sectorRows.set(key, row);
  }
  const maps = Object.fromEntries([
    ...definitions.map(row => [row.id, new Map()]),
    ...Array.from({ length: RANDOM_SEEDS }, (_, seed) => [`fairRandom${seed}`, new Map()])
  ]);
  for (const trade of trades) {
    const timing = tradeTiming(trade, entryMode);
    if (!timing) continue;
    const marketMom20 = marketByDate.get(timing.signalDate)?.mom20;
    if (!Number.isFinite(marketMom20) || !timing.futureBars.length) continue;
    const sector = sectorBySymbol.get(trade.symbol) || trade.themes || '未分類';
    const sectorRow = sectorRows.get(`${timing.signalDate}|${sector}`);
    const sectorMomentum20 = sectorRow?.count ? sectorRow.sum / sectorRow.count : marketMom20;
    const enriched = {
      ...trade,
      marketMom20,
      sector,
      sectorMomentum20,
      residualMarket20: (trade.return20Pct || 0) - marketMom20,
      residualSector20: (trade.return20Pct || 0) - sectorMomentum20
    };
    const stopDistancePct = Math.min(8, Math.max(
      3,
      (trade.entryPrice - trade.stopLoss) / trade.entryPrice * 100
    ));
    const candidate = score => ({
      signalDate: timing.signalDate,
      entryDate: timing.entryDate,
      entryPrice: timing.futureBars[0].open,
      symbol: trade.symbol,
      name: trade.name,
      market: trade.market,
      regime: marketByDate.get(timing.signalDate)?.regime,
      atrPct: trade.atr14Pct,
      score,
      stopDistancePct,
      futureBars: timing.futureBars.map(row => ({ ...row, close: row.price }))
    });
    if (trade.signalScore >= 65
      && trade.avg20TradeValue >= 80_000_000
      && trade.atr14Pct <= 5) {
      for (let seed = 0; seed < RANDOM_SEEDS; seed += 1) {
        addCandidate(
          maps[`fairRandom${seed}`],
          timing.signalDate,
          candidate(deterministicScore(`${seed}|${timing.signalDate}|${trade.symbol}`))
        );
      }
    }
    for (const definition of definitions) {
      if (!definition.filter(enriched)) continue;
      addCandidate(maps[definition.id], timing.signalDate, candidate(definition.score(enriched)));
    }
  }
  const consensusSources = [
    'broad_signal_quality',
    'broad_risk_adjusted',
    'broad_liquidity',
    'broad_low_chase'
  ];
  const dates = new Set(consensusSources.flatMap(id => [...maps[id].keys()]));
  for (const date of dates) {
    const candidates = new Map();
    for (const sourceId of consensusSources) {
      const rows = maps[sourceId].get(date) || [];
      rows.forEach((row, index) => {
        const current = candidates.get(row.symbol) || { candidate: row, points: 0, votes: 0 };
        current.points += rows.length - index;
        current.votes += 1;
        candidates.set(row.symbol, current);
      });
    }
    for (const row of candidates.values()) {
      addCandidate(maps.broad_consensus, date, {
        ...row.candidate,
        score: row.points + row.votes * 8
      });
      if (row.votes <= 3) {
        addCandidate(maps.broad_anti_crowding, date, {
          ...row.candidate,
          score: row.points - row.votes * 4
        });
      }
    }
  }
  return maps;
}

function configureSignals(source, config, startDate, endDate) {
  return new Map([...source]
    .filter(([date]) => date >= startDate && date <= endDate)
    .map(([date, candidates]) => [
    date,
    candidates.slice(0, config.top).map(candidate => ({
      ...candidate,
      positionPct: config.positionPct,
      accountRiskPct: config.accountRiskPct,
      maxHoldingDays: config.holdingDays,
      rewardRisk: config.rewardRisk,
      trailingStopRule: config.holdingDays === 10
        ? { triggerPct: 8, givebackPct: 5, lockPct: 2 }
        : null,
      setup: [config.name],
      trigger: ['訊號日收盤確認，下一交易日開盤成交'],
      invalidation: ['ATR 停損、風險熔斷或市場狀態轉弱'],
      exitPlan: `最長持有 ${config.holdingDays} 個交易日`
    }))
    ]));
}

function alignRandomSignals(strategyMap, randomMap) {
  return new Map([...strategyMap].map(([date, candidates]) => [
    date,
    (randomMap.get(date) || []).slice(0, candidates.length)
  ]).filter(([, candidates]) => candidates.length));
}

const riskRules = {
  maxAccountRiskPct: 2,
  maxSinglePositionPct: 34,
  exposureLimits: {
    BULL_TREND: 90,
    THEME_MOMENTUM: 90,
    BULL_PULLBACK: 70,
    RANGE_BOUND: 35,
    HIGH_VOLATILITY: 0,
    BEAR_DEFENSE: 0
  },
  drawdownBlockPct: 8,
  drawdownBlockDays: 20,
  monthlyLossBlockPct: 5,
  dailyLossBlockPct: 2,
  dailyLossBlockDays: 1,
  losingStreakCount: 5,
  losingStreakBlockDays: 10
};

function run(context, map, config, startDate, endDate) {
  return simulateSignalMap(context, configureSignals(map, config, startDate, endDate), {
    startDate,
    endDate,
    strategyId: `residual-industry:${config.id}`,
    maxOpenPositions: config.top,
    holdingDays: config.holdingDays,
    accountRiskPct: config.accountRiskPct,
    riskRules
  });
}

function trainingScore(summary) {
  if (summary.trades < 40 || summary.profitFactor < 1 || summary.maximumDrawdownPct < -20) return -Infinity;
  return summary.averageMonthlyEquityReturnPct * 5
    + Math.min(3, summary.profitFactor)
    + summary.maximumDrawdownPct * 0.12
    + Math.min(2, summary.trades / 100);
}

function combine(folds) {
  const trades = folds.flatMap(fold => fold.validation.trades);
  const monthly = folds.flatMap(fold => fold.validation.summary.monthly);
  let equity = 1_000_000;
  let peak = equity;
  let maximumDrawdownPct = 0;
  for (const fold of folds) {
    let prior = fold.validation.equityCurve[0]?.equity || 1_000_000;
    for (const row of fold.validation.equityCurve) {
      equity *= row.equity / prior;
      prior = row.equity;
      peak = Math.max(peak, equity);
      maximumDrawdownPct = Math.min(maximumDrawdownPct, (equity / peak - 1) * 100);
    }
  }
  const gains = trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(trades.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
  const compounded = monthly.reduce((value, row) => value * (1 + row.equityReturnPct / 100), 1);
  const metrics = {
    validationPeriod: `${folds[0].validationStart}～${folds.at(-1).validationEnd}`,
    validationMonths: monthly.length,
    trades: trades.length,
    averageMonthlyReturnPct: round(mean(monthly.map(row => row.equityReturnPct)) || 0),
    annualizedReturnPct: round((compounded ** (12 / Math.max(1, monthly.length)) - 1) * 100),
    profitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    maximumDrawdownPct: round(maximumDrawdownPct),
    winRatePct: round(trades.filter(row => row.realizedPnl > 0).length / Math.max(1, trades.length) * 100),
    maximumSymbolConcentrationPct: round(Math.max(0, ...Object.values(trades.reduce((rows, trade) => {
      rows[trade.symbol] = (rows[trade.symbol] || 0) + 1;
      return rows;
    }, {}))) / Math.max(1, trades.length) * 100)
  };
  metrics.improvesMonthly = metrics.averageMonthlyReturnPct > BASELINE.monthly;
  metrics.improvesDrawdown = metrics.maximumDrawdownPct > BASELINE.drawdown;
  metrics.improvesTrades = metrics.trades > BASELINE.trades;
  metrics.improvesAllThree = metrics.improvesMonthly && metrics.improvesDrawdown && metrics.improvesTrades;
  return metrics;
}

function benchmark(context, startDate, endDate) {
  const rows = context.marketHistory.filter(row => row.date >= startDate && row.date <= endDate);
  const monthEnd = new Map(rows.map(row => [row.date.slice(0, 7), row.close]));
  const closes = [...monthEnd.values()];
  return {
    months: Math.max(0, closes.length - 1),
    averageMonthlyReturnPct: round(mean(closes.slice(1).map((close, index) => (
      (close / closes[index] - 1) * 100
    ))) || 0)
  };
}

async function main() {
  const [backtest, market, sectors] = await Promise.all([
    fs.readFile(BACKTEST, 'utf8').then(JSON.parse),
    fs.readFile(MARKET, 'utf8').then(JSON.parse),
    fs.readFile(SECTORS, 'utf8').then(JSON.parse)
  ]);
  const regimes = buildMarketRegimes(market.benchmark || []);
  const marketByDate = new Map(regimes.map(row => [row.date, row]));
  const sectorBySymbol = new Map(sectors.records.map(row => [row.symbol, row.sectorName]));
  const maps = buildMaps(
    backtest.candidateTrades || [],
    marketByDate,
    sectorBySymbol,
    backtest.assumptions?.entryMode
  );
  console.log(`候選資料完成：${backtest.candidateTrades?.length || 0} 筆`);
  const context = {
    marketHistory: market.benchmark,
    marketByDate,
    startDate: regimes.find(row => row.ma200)?.date,
    endDate: regimes.at(-1).date
  };
  const folds = foldWindows(context.startDate, context.endDate, 54, 12)
    .filter(fold => Date.parse(fold.validationEnd) - Date.parse(fold.validationStart) >= 330 * 86_400_000);
  let activeConfigurations = process.env.POINT_IN_TIME_ONLY === '1'
    ? configurations.filter(config => definitions.find(row => (
      row.id === config.definitionId
    )).pointInTimeSafe)
    : configurations;
  if (process.env.STRATEGY_ONLY) {
    activeConfigurations = activeConfigurations.filter(config => (
      config.definitionId === process.env.STRATEGY_ONLY
    ));
  }
  console.log(`開始 ${folds.length} 段 walk-forward，每段測試 ${activeConfigurations.length} 組。`);
  const results = [];
  for (const fold of folds) {
    let selected;
    for (const config of activeConfigurations) {
      const train = run(context, maps[config.definitionId], config, fold.trainStart, fold.trainEnd);
      const score = trainingScore(train.summary);
      if (!selected || score > selected.score) selected = { config, score, train: train.summary };
    }
    const validation = run(context, maps[selected.config.definitionId], selected.config, fold.validationStart, fold.validationEnd);
    const randomValidations = Array.from({ length: RANDOM_SEEDS }, (_, seed) => run(
      context,
      alignRandomSignals(maps[selected.config.definitionId], maps[`fairRandom${seed}`]),
      selected.config,
      fold.validationStart,
      fold.validationEnd
    ));
    results.push({ ...fold, selectedConfig: selected.config, train: selected.train, validation, randomValidations });
    console.log(`${fold.validationStart}：${selected.config.name}，${validation.summary.trades} 筆`);
  }
  const metrics = combine(results);
  const randomRuns = Array.from({ length: RANDOM_SEEDS }, (_, seed) => combine(
    results.map(row => ({ ...row, validation: row.randomValidations[seed] }))
  ));
  const randomMonthly = randomRuns.map(row => row.averageMonthlyReturnPct).sort((a, b) => a - b);
  const randomMetrics = {
    seeds: RANDOM_SEEDS,
    minimumMonthlyReturnPct: randomMonthly[0],
    medianMonthlyReturnPct: round((randomMonthly[9] + randomMonthly[10]) / 2),
    averageMonthlyReturnPct: round(mean(randomMonthly)),
    maximumMonthlyReturnPct: randomMonthly.at(-1),
    runs: randomRuns
  };
  const marketResult = benchmark(context, results[0].validationStart, results.at(-1).validationEnd);
  const selectedDefinitions = new Set(results.map(row => row.selectedConfig.definitionId));
  const usesStaticSector = [...selectedDefinitions].some(id => !definitions.find(row => row.id === id).pointInTimeSafe);
  const holdoutStart = new Date(`${results.at(-1).validationEnd}T00:00:00Z`);
  holdoutStart.setUTCDate(holdoutStart.getUTCDate() + 1);
  const holdoutStartText = holdoutStart.toISOString().slice(0, 10);
  const holdoutTrainStart = new Date(`${holdoutStartText.slice(0, 7)}-01T00:00:00Z`);
  holdoutTrainStart.setUTCMonth(holdoutTrainStart.getUTCMonth() - 54);
  let holdoutSelection;
  for (const config of activeConfigurations) {
    const train = run(
      context,
      maps[config.definitionId],
      config,
      holdoutTrainStart.toISOString().slice(0, 10),
      results.at(-1).validationEnd
    );
    const score = trainingScore(train.summary);
    if (!holdoutSelection || score > holdoutSelection.score) {
      holdoutSelection = { config, score, train: train.summary };
    }
  }
  const holdout = holdoutStartText <= context.endDate
    ? run(context, maps[holdoutSelection.config.definitionId], holdoutSelection.config, holdoutStartText, context.endDate)
    : null;
  const output = {
    generatedAt: new Date().toISOString(),
    methodology: '54 個月訓練／12 個月驗證，每次前進 12 個月；驗證期固定規則。',
    configurationsTestedPerFold: activeConfigurations.length,
    pointInTimeOnly: process.env.POINT_IN_TIME_ONLY === '1',
    folds: results.map(row => ({
      trainPeriod: `${row.trainStart}～${row.trainEnd}`,
      validationPeriod: `${row.validationStart}～${row.validationEnd}`,
      selectedConfig: row.selectedConfig,
      trainMetrics: row.train,
      validationMetrics: row.validation.summary
    })),
    dataWarning: usesStaticSector
      ? '使用目前產業分類作歷史探索，存在倖存者偏差，不得批准紙上或實盤。'
      : '目前股票池仍有倖存者偏差；close_confirm 候選一律延至確認後下一交易日開盤成交。',
    baseline: BASELINE,
    benchmark0050: marketResult,
    fairRandom: randomMetrics,
    holdout: holdout ? {
      period: `${holdoutStartText}～${context.endDate}`,
      selectedConfig: holdoutSelection.config,
      trainMetrics: holdoutSelection.train,
      metrics: holdout.summary
    } : null,
    survivorshipBiasWarning: true,
    metrics,
    conclusion: metrics.improvesAllThree
      && !usesStaticSector
      && metrics.averageMonthlyReturnPct > randomMetrics.medianMonthlyReturnPct
      && (holdout?.summary.averageMonthlyEquityReturnPct || 0) > 0
      ? '找到同時改善三項指標、勝過公平隨機且額外 holdout 為正的歷史候選；仍有股票池倖存者偏差，須全新期間紙上交易。'
      : '找不到可批准且同時改善三項指標的候選策略，不可進入紙上交易或實盤。'
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 殘差與產業動能驗證\n\n${output.conclusion}\n\n- Validation：${metrics.validationPeriod}，${metrics.validationMonths} 個月\n- 交易：${metrics.trades} 筆\n- 月均：${metrics.averageMonthlyReturnPct}%\n- 年化：${metrics.annualizedReturnPct}%\n- Profit Factor：${metrics.profitFactor}\n- 最大回撤：${metrics.maximumDrawdownPct}%\n- 勝率：${metrics.winRatePct}%\n- 同期 0050 月均：${marketResult.averageMonthlyReturnPct}%\n- 資料警告：${output.dataWarning || '無'}\n`, 'utf8');
  console.log(JSON.stringify({
    metrics,
    benchmark0050: marketResult,
    fairRandom: randomMetrics,
    holdout: output.holdout,
    dataWarning: output.dataWarning,
    conclusion: output.conclusion
  }, null, 2));
}

await main();
