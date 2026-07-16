import fs from 'node:fs/promises';
import {
  deterministicScore,
  foldWindows,
  loadResearchContext,
  round,
  simulateSignalMap
} from './research-core.mjs';
import {
  buildExperimentIdentity,
  loadRegistry,
  shouldSkipExperiment
} from './strategy-experiment-registry.mjs';

const OUTPUT = new URL('../../data/research/stock-cross-sectional-momentum-v1.json', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const INITIAL_CAPITAL = 1_000_000;
const STRATEGY_ID = 'stock_cross_sectional_momentum_v1';
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const compactSummary = summary => {
  const { monthly, ...metrics } = summary;
  return metrics;
};

function deviation(values) {
  const average = mean(values);
  return Math.sqrt(mean(values.map(value => (value - average) ** 2)));
}

function configurations() {
  const rows = [];
  for (const scoreMode of ['medium_term', 'risk_adjusted', 'trend_quality', 'trend_pullback', 'bull_reversal']) {
    for (const regimeMode of ['trend_only', 'trend_pullback']) {
      for (const rebalanceDays of [5, 10]) {
        for (const holdingDays of [10, 20, 40]) {
          for (const topN of [5, 10]) {
            for (const exitMode of ['protective', 'wide_fixed', 'trend_trailing']) {
              rows.push({ scoreMode, regimeMode, rebalanceDays, holdingDays, topN, exitMode });
            }
          }
        }
      }
    }
  }
  return rows;
}

function buildObservations(context) {
  const marketIndex = new Map(context.marketHistory.map((row, index) => [row.date, index]));
  const marketClose = context.marketHistory.map(row => row.close);
  const byDate = new Map();
  for (const { stock, history } of context.ohlcv.stocks) {
    if (!/^\d{4}$/.test(stock.symbol) || Number(stock.symbol) < 1000) continue;
    const theme = stock.themes?.[0] || '未分類';
    for (let index = 252; index + 41 < history.length; index += 1) {
      const day = history[index];
      const dateIndex = marketIndex.get(day.date);
      if (dateIndex === undefined || dateIndex % 5 !== 0 || dateIndex < 252) continue;
      const prior20 = history.slice(index - 19, index + 1);
      const averageTradeValue20 = mean(prior20.map(row => row.close * row.volume));
      const averageVolume20 = mean(prior20.map(row => row.volume));
      if (day.close < 10 || averageTradeValue20 < 30_000_000) continue;
      const trueRanges = history.slice(index - 13, index + 1).map((row, offset) => {
        const previous = history[index - 14 + offset].close;
        return Math.max(row.high - row.low, Math.abs(row.high - previous), Math.abs(row.low - previous));
      });
      const atrPct = mean(trueRanges) / day.close * 100;
      if (atrPct < 1 || atrPct > 7) continue;
      const dailyReturns = history.slice(index - 60, index + 1).slice(1).map((row, offset) => (
        row.close / history[index - 60 + offset].close - 1
      ));
      const momentum252Skip20 = (history[index - 20].close / history[index - 252].close - 1) * 100;
      const momentum126Skip20 = (history[index - 20].close / history[index - 126].close - 1) * 100;
      const momentum63Skip5 = (history[index - 5].close / history[index - 63].close - 1) * 100;
      const marketMomentum126Skip20 = (marketClose[dateIndex - 20] / marketClose[dateIndex - 126] - 1) * 100;
      const high252 = Math.max(...history.slice(index - 251, index + 1).map(row => row.high));
      const row = {
        signalDate: day.date,
        entryDate: history[index + 1].date,
        symbol: stock.symbol,
        name: stock.name,
        market: stock.market,
        regime: context.marketByDate.get(day.date)?.regime,
        close: day.close,
        history,
        historyIndex: index,
        dateIndex,
        averageTradeValue20,
        atrPct,
        volatility60Pct: deviation(dailyReturns) * Math.sqrt(252) * 100,
        momentum252Skip20,
        momentum126Skip20,
        momentum63Skip5,
        return5Pct: (day.close / history[index - 5].close - 1) * 100,
        return20Pct: (day.close / history[index - 20].close - 1) * 100,
        relativeMarket126: momentum126Skip20 - marketMomentum126Skip20,
        themeMomentum20: context.themeReturns.get(`${day.date}|${theme}`)?.average || 0,
        nearYearHigh: day.close / high252,
        ma60: mean(history.slice(index - 59, index + 1).map(row => row.close)),
        volumeRatio20: day.volume / Math.max(1, averageVolume20)
      };
      const rows = byDate.get(day.date) || [];
      rows.push(row);
      byDate.set(day.date, rows);
    }
  }
  return byDate;
}

function allowedRegime(regime, mode) {
  const allowed = mode === 'trend_only'
    ? ['BULL_TREND', 'THEME_MOMENTUM']
    : ['BULL_TREND', 'THEME_MOMENTUM', 'BULL_PULLBACK'];
  return allowed.includes(regime);
}

function score(row, mode) {
  if (mode === 'trend_pullback') {
    return row.relativeMarket126 + row.momentum252Skip20 * 0.4
      - Math.abs(row.return5Pct) * 0.3 + row.nearYearHigh * 5;
  }
  if (mode === 'bull_reversal') {
    return -row.return5Pct + row.relativeMarket126 * 0.5 - row.atrPct;
  }
  if (mode === 'risk_adjusted') {
    return (row.relativeMarket126 + row.momentum252Skip20 * 0.5) / Math.max(8, row.volatility60Pct) * 100;
  }
  if (mode === 'trend_quality') {
    return row.relativeMarket126
      + row.momentum63Skip5 * 0.6
      + Math.max(0, row.themeMomentum20) * 0.8
      + row.nearYearHigh * 10
      - row.atrPct * 1.5;
  }
  return row.relativeMarket126 + row.momentum252Skip20 * 0.6 + row.momentum63Skip5 * 0.4;
}

function eligible(row, config) {
  const base = row.dateIndex % config.rebalanceDays === 0
    && allowedRegime(row.regime, config.regimeMode);
  if (!base) return false;
  if (config.scoreMode === 'trend_pullback') {
    return row.momentum252Skip20 > 0
      && row.relativeMarket126 > 0
      && row.return5Pct >= -8
      && row.return5Pct <= 0
      && row.close > row.ma60
      && row.volumeRatio20 <= 1.2;
  }
  if (config.scoreMode === 'bull_reversal') {
    return row.close > row.ma60
      && row.return20Pct > -5
      && row.return5Pct >= -12
      && row.return5Pct <= -3
      && row.relativeMarket126 > -5;
  }
  return row.momentum252Skip20 > 0
    && row.relativeMarket126 > 0
    && row.momentum63Skip5 > -8
    && row.nearYearHigh >= 0.7;
}

function candidate(row, config, random = false) {
  const stopDistancePct = config.exitMode === 'wide_fixed'
    ? 12
    : config.exitMode === 'trend_trailing'
      ? Math.min(10, Math.max(6, row.atrPct * 2))
      : Math.min(8, Math.max(4, row.atrPct * 1.5));
  const trailingStopRule = config.exitMode === 'wide_fixed'
    ? null
    : config.exitMode === 'trend_trailing'
      ? { triggerPct: 15, lockPct: 3, givebackPct: 8 }
      : { triggerPct: 10, lockPct: 2, givebackPct: 6 };
  return {
    signalDate: row.signalDate,
    entryDate: row.entryDate,
    symbol: row.symbol,
    name: row.name,
    market: row.market,
    regime: row.regime,
    close: row.close,
    score: random ? deterministicScore(`${row.signalDate}|${row.symbol}|截面動能公平隨機`) : score(row, config.scoreMode),
    entryGapRange: { minimumPct: -4, maximumPct: 3 },
    futureBars: row.history.slice(row.historyIndex + 1, row.historyIndex + config.holdingDays + 2).map(bar => ({
      date: bar.date,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      price: bar.close
    })),
    stopDistancePct,
    stopLossMode: 'close',
    rewardRisk: 0,
    maxHoldingDays: config.holdingDays,
    trailingStopRule,
    positionPct: Math.min(10, 80 / config.topN),
    accountRiskPct: 0.5,
    setup: random ? '同日同數量高流動個股公平隨機' : `${config.scoreMode} 純個股截面排名`,
    trigger: `每 ${config.rebalanceDays} 個交易日收盤排名，隔日開盤進場`,
    invalidation: `收盤跌破 ${round(stopDistancePct)}% 風險距離，隔日開盤退出`,
    exitPlan: `最多持有 ${config.holdingDays} 個交易日，並使用移動停利`,
    reason: random ? '公平隨機比較' : `相對大盤 ${round(row.relativeMarket126)}%，接近年高 ${round(row.nearYearHigh * 100)}%`,
    orderIntent: { action: 'BUY', orderType: 'MARKETABLE_LIMIT', timeInForce: 'DAY', earliestDate: row.entryDate }
  };
}

function signalMap(observations, config, random = false) {
  const map = new Map();
  for (const [date, rows] of observations) {
    const ranked = rows.filter(row => eligible(row, config)).sort((left, right) => score(right, config.scoreMode) - score(left, config.scoreMode));
    if (!ranked.length) continue;
    const selected = random
      ? rows.filter(row => row.dateIndex % config.rebalanceDays === 0 && allowedRegime(row.regime, config.regimeMode))
        .sort((left, right) => deterministicScore(`${date}|${left.symbol}`) - deterministicScore(`${date}|${right.symbol}`))
        .slice(0, Math.min(config.topN, ranked.length))
      : ranked.slice(0, config.topN);
    if (selected.length) map.set(date, selected.map(row => candidate(row, config, random)));
  }
  return map;
}

function run(context, map, config, startDate, endDate, suffix = '') {
  return simulateSignalMap(context, map, {
    strategyId: `${STRATEGY_ID}${suffix}`,
    startDate,
    endDate,
    initialCapital: INITIAL_CAPITAL,
    maxOpenPositions: config.topN,
    holdingDays: config.holdingDays,
    accountRiskPct: 0.5,
    riskRules: {
      maxAccountRiskPct: 0.5,
      maxSinglePositionPct: 10,
      exposureLimits: {
        BULL_TREND: 80,
        THEME_MOMENTUM: 80,
        BULL_PULLBACK: 60,
        RANGE_BOUND: 0,
        HIGH_VOLATILITY: 0,
        BEAR_DEFENSE: 0
      },
      drawdownBlockPct: 8,
      drawdownBlockDays: 20,
      monthlyLossBlockPct: 5,
      dailyLossBlockPct: 2,
      losingStreakCount: 3,
      losingStreakBlockDays: 10
    }
  });
}

function quality(result) {
  const gains = result.trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(result.trades.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
  return { profitFactor: losses ? gains / losses : null };
}

function summarizeRuns(runs) {
  const monthly = runs.flatMap(run => run.summary.monthly);
  const trades = runs.flatMap(run => run.trades);
  const curve = runs.flatMap(run => run.equityCurve);
  let equity = INITIAL_CAPITAL;
  let peak = equity;
  let maximumDrawdownPct = 0;
  for (const row of curve) {
    equity *= 1 + row.dailyReturnPct / 100;
    peak = Math.max(peak, equity);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, (equity / peak - 1) * 100);
  }
  const gains = trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(trades.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
  const symbols = new Map();
  for (const trade of trades) symbols.set(trade.symbol, (symbols.get(trade.symbol) || 0) + 1);
  return {
    months: monthly.length,
    averageMonthlyReturnPct: round(mean(monthly.map(row => row.equityReturnPct))),
    annualizedReturnPct: round(((equity / INITIAL_CAPITAL) ** (12 / Math.max(1, monthly.length)) - 1) * 100),
    maximumDrawdownPct: round(maximumDrawdownPct),
    trades: trades.length,
    winRatePct: round(trades.filter(row => row.realizedPnl > 0).length / Math.max(1, trades.length) * 100),
    profitFactor: losses ? round(gains / losses) : null,
    concentrationPct: round(Math.max(0, ...symbols.values()) / Math.max(1, trades.length) * 100),
    averageExposurePct: round(mean(curve.map(row => row.exposurePct || 0)))
  };
}

function benchmark(series, startDate, endDate) {
  const rows = series.filter(row => row.date >= startDate && row.date <= endDate);
  const monthEnds = new Map(rows.map(row => [row.date.slice(0, 7), row.close]));
  let prior = [...series].reverse().find(row => row.date < startDate)?.close ?? rows[0]?.close;
  const returns = [];
  for (const close of monthEnds.values()) {
    returns.push((close / prior - 1) * 100);
    prior = close;
  }
  return { averageMonthlyReturnPct: round(mean(returns)) };
}

async function main() {
  const configs = configurations();
  const identityInput = {
    strategyId: STRATEGY_ID,
    dataSources: ['全個股 OHLCV', '市場狀態', '靜態產業分類'],
    setupRules: ['12-1 與 6-1 截面動能', '相對大盤與族群強度', '流動性與波動排除'],
    triggerRules: ['固定交易日收盤排名，隔日開盤成交'],
    invalidationRules: ['收盤停損後隔日開盤退出'],
    exitRules: ['20／40 日持有與移動停利'],
    riskRules: { accountRiskPct: 0.5, maxPositionPct: 10, tPlusTwo: true },
    blockedWhen: ['弱勢／高波動市場', '成交值不足', '隔日跳空超過 3%'],
    parameters: { trainMonths: 54, validationMonths: 18, configs },
    trainPeriod: 'rolling 54 months',
    validationPeriod: 'rolling 18 months',
    costModel: '共用成交模擬器：手續費、交易稅、滑價',
    executionModel: 'T 日收盤排名，T+1 開盤成交，跳空停損採較差價格'
  };
  const identity = buildExperimentIdentity(identityInput);
  const decision = shouldSkipExperiment(await loadRegistry(), identity, {
    ...identityInput,
    newDataSources: ['不依賴舊 BUY_SIGNAL 的全個股截面排名'],
    coreRulesChanged: true
  });
  if (decision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...decision, ...identity }, null, 2));
    return;
  }

  const [context, etfHistory] = await Promise.all([
    loadResearchContext(),
    fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)
  ]);
  const observations = buildObservations(context);
  const maps = new Map(configs.map(config => [JSON.stringify(config), signalMap(observations, config)]));
  const validations = [];
  const randoms = [];
  const folds = [];
  for (const fold of foldWindows(context.startDate, context.endDate, 54, 18)) {
    const trainRows = configs.map(config => {
      const result = run(context, maps.get(JSON.stringify(config)), config, fold.trainStart, fold.trainEnd);
      return { config, result, quality: quality(result) };
    });
    const trained = trainRows.filter(row => row.result.trades.length >= 100
      && row.result.summary.maximumDrawdownPct >= -25
      && (row.quality.profitFactor || 0) > 1)
      .sort((left, right) => (
        right.result.summary.averageMonthlyEquityReturnPct + right.result.summary.maximumDrawdownPct * 0.03
        - left.result.summary.averageMonthlyEquityReturnPct - left.result.summary.maximumDrawdownPct * 0.03
      ))[0];
    if (!trained) {
      const bestDiagnostic = [...trainRows].sort((left, right) => (
        right.result.summary.averageMonthlyEquityReturnPct - left.result.summary.averageMonthlyEquityReturnPct
      ))[0];
      folds.push({
        ...fold,
        status: '訓練證據不足，持有現金',
        diagnostic: {
          bestConfig: bestDiagnostic.config,
          bestAverageMonthlyReturnPct: bestDiagnostic.result.summary.averageMonthlyEquityReturnPct,
          bestMaximumDrawdownPct: bestDiagnostic.result.summary.maximumDrawdownPct,
          bestTrades: bestDiagnostic.result.trades.length,
          bestProfitFactor: round(bestDiagnostic.quality.profitFactor)
        }
      });
      continue;
    }
    const validation = run(context, maps.get(JSON.stringify(trained.config)), trained.config, fold.validationStart, fold.validationEnd);
    const random = run(context, signalMap(observations, trained.config, true), trained.config, fold.validationStart, fold.validationEnd, '_random');
    validations.push(validation);
    randoms.push(random);
    folds.push({
      ...fold,
      status: '已驗證',
      selectedConfig: trained.config,
      train: compactSummary(trained.result.summary),
      validation: compactSummary(validation.summary),
      validationProfitFactor: round(quality(validation).profitFactor)
    });
  }
  const metrics = summarizeRuns(validations);
  const fairRandom = summarizeRuns(randoms);
  const validationStart = folds.find(row => row.status === '已驗證')?.validationStart;
  const validationEnd = folds.filter(row => row.status === '已驗證').at(-1)?.validationEnd;
  const benchmark0050 = benchmark(etfHistory.series['0050.TW'] || [], validationStart, validationEnd);
  const targetMet = metrics.averageMonthlyReturnPct >= 5
    && metrics.maximumDrawdownPct >= -20
    && metrics.trades >= 300
    && metrics.profitFactor > 1.15
    && metrics.averageMonthlyReturnPct > fairRandom.averageMonthlyReturnPct
    && metrics.averageMonthlyReturnPct > benchmark0050.averageMonthlyReturnPct;
  const output = {
    generatedAt: new Date().toISOString(),
    strategyId: STRATEGY_ID,
    universe: '純台股普通股；ETF／0050 交易占比 0%，0050 僅作比較',
    methodology: '全個股 OHLCV 截面排名；54 個月訓練、18 個月固定驗證；真實費稅、滑價與 T+2。',
    observations: [...observations.values()].reduce((sum, rows) => sum + rows.length, 0),
    configurationsTested: configs.length,
    validationPeriod: `${validationStart}–${validationEnd}`,
    folds,
    metrics,
    benchmark0050,
    fairRandom,
    targetMonthlyReturnPct: 5,
    gapToTargetPct: round(5 - metrics.averageMonthlyReturnPct),
    targetMet,
    paperTradingReady: false,
    liveTradingReady: false,
    survivorshipBiasWarning: true,
    conclusion: targetMet
      ? '達到研究候選門檻，但仍只能先進行紙上交易。'
      : `找不到月均 5% 的可實盤純個股截面動能策略；目前 ${metrics.averageMonthlyReturnPct}%。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    observations: output.observations,
    configurationsTested: output.configurationsTested,
    validationPeriod: output.validationPeriod,
    metrics,
    benchmark0050,
    fairRandom,
    targetMet,
    conclusion: output.conclusion
  }, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
