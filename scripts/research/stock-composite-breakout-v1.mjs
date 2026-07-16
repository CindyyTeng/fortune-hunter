import fs from 'node:fs/promises';
import { deterministicScore, foldWindows, loadResearchContext, round, simulateSignalMap } from './research-core.mjs';
import { buildExperimentIdentity, loadRegistry, shouldSkipExperiment } from './strategy-experiment-registry.mjs';

const INPUT = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-composite-breakout-v1.json', import.meta.url);
const INITIAL_CAPITAL = 1_000_000;
const STRATEGY_ID = 'stock_composite_breakout_v1';
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const compactSummary = summary => {
  const { monthly, ...metrics } = summary;
  return metrics;
};
function shiftMonth(date, months) {
  const value = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + months);
  return value.toISOString().slice(0, 7);
}
function dayBeforeMonth(month) {
  const value = new Date(`${month}-01T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function configurations() {
  const rows = [];
  for (const minScore of [65, 75, 85]) {
    for (const minNearYearHigh of [0.85, 0.95]) {
      for (const rankMode of ['score', 'volume_rsi', 'risk_adjusted']) {
        for (const topN of [5, 8]) {
          for (const holdingDays of [10, 20, 40, 60]) {
            for (const stopDistancePct of [5, 7]) {
              rows.push({ minScore, minNearYearHigh, rankMode, topN, holdingDays, stopDistancePct });
            }
          }
        }
      }
    }
  }
  return rows;
}

function eligible(row, config, context) {
  const regime = context.marketByDate.get(row.signalDate)?.regime;
  return /^\d{4}$/.test(String(row.symbol || ''))
    && Number(row.symbol) >= 1000
    && row.signalScore >= config.minScore
    && (row.avg20TradeValue || 0) >= 30_000_000
    && (row.nearYearHigh || 0) >= config.minNearYearHigh
    && (row.atr14Pct || 0) >= 1.5
    && (row.atr14Pct || 0) <= 6
    && (row.rsi14 || 0) >= 50
    && (row.rsi14 || 0) <= 76
    && row.ma20Rising
    && !row.highVolumeDistribution
    && ['BULL_TREND', 'THEME_MOMENTUM', 'BULL_PULLBACK'].includes(regime)
    && row.historyIndex + config.holdingDays + 1 < row.history.length;
}

function score(row, mode) {
  if (mode === 'volume_rsi') {
    return row.signalScore
      + Math.min(12, Math.log10(Math.max(1, row.avg20TradeValue)) * 1.5)
      + Math.max(0, 72 - Math.abs((row.rsi14 || 60) - 62)) * 0.15
      + Math.min(5, row.volumeRatio1To20 || 0);
  }
  if (mode === 'risk_adjusted') {
    return (row.return20Pct || 0) / Math.max(1.5, row.atr14Pct || 1.5) * 5
      + (row.nearYearHigh || 0) * 20
      + row.signalScore * 0.5;
  }
  return row.signalScore + (row.return20Pct || 0) * 0.2 + (row.themeMovePct || 0);
}

function candidate(row, config, random = false) {
  const regime = row.regime;
  return {
    signalDate: row.signalDate,
    entryDate: row.entryDate,
    symbol: row.symbol,
    name: row.name,
    market: row.market,
    regime,
    score: random ? deterministicScore(`${row.signalDate}|${row.symbol}|綜合突破公平隨機`) : score(row, config.rankMode),
    entryMode: 'resistance_breakout',
    triggerPrice: row.triggerPrice,
    maxEntryOverTriggerPct: 4,
    futureBars: row.history.slice(row.historyIndex + 1, row.historyIndex + config.holdingDays + 2).map(bar => ({
      date: bar.date,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      price: bar.close
    })),
    stopDistancePct: config.stopDistancePct,
    stopLossMode: 'close',
    rewardRisk: 0,
    maxHoldingDays: config.holdingDays,
    trailingStopRule: config.holdingDays >= 20 ? { triggerPct: 10, lockPct: 2, givebackPct: 6 } : null,
    positionPct: Math.min(10, 80 / config.topN),
    accountRiskPct: 0.5,
    setup: random ? '同日同數量綜合候選公平隨機' : `${config.rankMode} 綜合技術與量價排名`,
    trigger: `突破壓力 ${round(row.triggerPrice)} 才進場，跳空採開盤較差價`,
    invalidation: `收盤跌破 ${config.stopDistancePct}% 風險距離後隔日退出`,
    exitPlan: `最多持有 ${config.holdingDays} 個交易日`,
    reason: random ? '公平隨機比較' : `訊號 ${row.signalScore} 分、近年高 ${round((row.nearYearHigh || 0) * 100)}%`,
    orderIntent: { action: 'BUY', orderType: 'STOP_LIMIT', triggerPrice: row.triggerPrice, timeInForce: 'DAY', earliestDate: row.entryDate }
  };
}

function buildSignalMap(rows, config, context, random = false) {
  const byDate = new Map();
  for (const row of rows) {
    if (!eligible(row, config, context)) continue;
    const list = byDate.get(row.signalDate) || [];
    list.push({ ...row, regime: context.marketByDate.get(row.signalDate)?.regime });
    byDate.set(row.signalDate, list);
  }
  const map = new Map();
  for (const [date, candidates] of byDate) {
    const count = Math.min(config.topN, candidates.length);
    const selected = random
      ? candidates.sort((left, right) => deterministicScore(`${date}|${left.symbol}`) - deterministicScore(`${date}|${right.symbol}`)).slice(0, count)
      : candidates.sort((left, right) => score(right, config.rankMode) - score(left, config.rankMode)).slice(0, count);
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
  const identityInput = {
    strategyId: STRATEGY_ID,
    dataSources: ['個股 OHLCV', '既有綜合技術與量價候選', '市場狀態'],
    setupRules: ['訊號分數、近年高、量價品質與風險調整排名'],
    triggerRules: ['隔日壓力突破才成交，跳空採較差開盤價'],
    invalidationRules: ['收盤停損後隔日開盤退出'],
    exitRules: ['10／20／40／60 日與移動停利'],
    riskRules: { accountRiskPct: 0.5, maxPositionPct: 10, tPlusTwo: true },
    blockedWhen: ['弱勢／高波動市場', '追價超過觸發價 4%', '成交值不足'],
    parameters: { trainMonths: 54, validationMonths: 18, configs: configurations() },
    trainPeriod: 'rolling 54 months',
    validationPeriod: 'rolling 18 months',
    costModel: '共用成交模擬器：手續費、交易稅、滑價',
    executionModel: '壓力突破、跳空不利成交、T+2'
  };
  const identity = buildExperimentIdentity(identityInput);
  const decision = shouldSkipExperiment(await loadRegistry(), identity, {
    ...identityInput,
    newDataSources: ['共用真實突破成交'],
    coreRulesChanged: true
  });
  if (decision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...decision, ...identity }, null, 2));
    return;
  }
  const [payload, context, etfHistory] = await Promise.all([
    fs.readFile(INPUT, 'utf8').then(JSON.parse),
    loadResearchContext(),
    fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)
  ]);
  const histories = new Map(context.ohlcv.stocks.map(({ stock, history }) => [
    stock.symbol,
    { history, byDate: new Map(history.map((bar, index) => [bar.date, index])) }
  ]));
  const rows = (payload.candidateTrades || []).filter(row => /^\d{4}$/.test(String(row.symbol || '')))
    .map(row => {
      const source = histories.get(row.symbol);
      const historyIndex = source?.byDate.get(row.signalDate);
      return source && historyIndex !== undefined ? { ...row, history: source.history, historyIndex } : null;
    }).filter(Boolean);
  const configs = configurations();
  const validations = [];
  const randoms = [];
  const folds = [];
  for (const fold of foldWindows(context.startDate, context.endDate, 54, 18)) {
    const trainRows = configs.map(config => {
      const result = run(context, buildSignalMap(rows, config, context), config, fold.trainStart, fold.trainEnd);
      return { config, result, quality: quality(result) };
    });
    const shortlist = trainRows.filter(row => row.result.trades.length >= 80
      && row.result.summary.maximumDrawdownPct >= -25
      && (row.quality.profitFactor || 0) > 1)
      .sort((left, right) => (
        right.result.summary.averageMonthlyEquityReturnPct + right.result.summary.maximumDrawdownPct * 0.03
        - left.result.summary.averageMonthlyEquityReturnPct - left.result.summary.maximumDrawdownPct * 0.03
      )).slice(0, 20);
    const trained = shortlist.map(row => {
      const segments = [0, 18, 36].map(offset => run(
        context,
        buildSignalMap(rows, row.config, context),
        row.config,
        `${shiftMonth(fold.trainStart, offset)}-01`,
        dayBeforeMonth(shiftMonth(fold.trainStart, offset + 18))
      ));
      const returns = segments.map(segment => segment.summary.averageMonthlyEquityReturnPct).sort((a, b) => a - b);
      return {
        ...row,
        segments,
        stabilityScore: row.result.summary.averageMonthlyEquityReturnPct * 0.35
          + returns[1] * 0.7
          + returns[0] * 0.9
          + row.result.summary.maximumDrawdownPct * 0.16
      };
    }).filter(row => row.segments.every(segment => segment.trades.length >= 15))
      .sort((left, right) => right.stabilityScore - left.stabilityScore)[0];
    if (!trained) {
      const best = [...trainRows].sort((left, right) => right.result.summary.averageMonthlyEquityReturnPct - left.result.summary.averageMonthlyEquityReturnPct)[0];
      folds.push({
        ...fold,
        status: '訓練證據不足，持有現金',
        diagnostic: {
          config: best.config,
          monthly: best.result.summary.averageMonthlyEquityReturnPct,
          maximumDrawdownPct: best.result.summary.maximumDrawdownPct,
          trades: best.result.trades.length,
          profitFactor: round(best.quality.profitFactor)
        }
      });
      continue;
    }
    const validation = run(context, buildSignalMap(rows, trained.config, context), trained.config, fold.validationStart, fold.validationEnd);
    const random = run(context, buildSignalMap(rows, trained.config, context, true), trained.config, fold.validationStart, fold.validationEnd, '_random');
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
    sourceCandidates: rows.length,
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
    conclusion: targetMet
      ? '達到研究候選門檻，但仍只能先進行紙上交易。'
      : `共用成交模擬後仍找不到月均 5% 的可實盤純個股綜合突破策略；目前 ${metrics.averageMonthlyReturnPct}%。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    sourceCandidates: output.sourceCandidates,
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
