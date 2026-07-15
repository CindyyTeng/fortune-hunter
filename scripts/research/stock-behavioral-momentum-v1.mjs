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

const OUTPUT = new URL('../../data/research/stock-behavioral-momentum-v1.json', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const STRATEGY_ID = 'stock_behavioral_momentum_v1';
const INITIAL_CAPITAL = 1_000_000;

const mean = values => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : 0;

function weekEnds(rows) {
  const result = new Map();
  for (const row of rows) {
    const date = new Date(`${row.date}T00:00:00Z`);
    const weekStart = new Date(date);
    weekStart.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    result.set(weekStart.toISOString().slice(0, 10), row.date);
  }
  return new Set(result.values());
}

function movingAverage(history, index, days) {
  let total = 0;
  for (let cursor = index - days + 1; cursor <= index; cursor += 1) {
    total += history[cursor].close;
  }
  return total / days;
}

function buildWeeklyRows(context) {
  const signalDates = weekEnds(context.marketHistory);
  const rowsByDate = new Map();
  for (const { stock, history } of context.ohlcv.stocks) {
    if (!/^\d{4}$/.test(stock.symbol) || Number(stock.symbol) < 1000) continue;
    for (let index = 60; index + 20 < history.length; index += 1) {
      const day = history[index];
      if (!signalDates.has(day.date)) continue;
      const priorReturns = history.slice(index - 59, index + 1).map((row, offset) => (
        offset ? row.close / history[index - 60 + offset].close - 1 : 0
      ));
      if (priorReturns.some(value => Math.abs(value) > 0.15)) continue;
      const averageTradeValue20 = mean(history.slice(index - 19, index + 1)
        .map(row => row.close * row.volume));
      if (averageTradeValue20 < 30_000_000) continue;
      const factors = {};
      for (const lookback of [20, 60]) {
        const start = index - lookback + 1;
        let signedVolume = 0;
        let eligibleVolume = 0;
        let positiveDays = 0;
        let eligibleDays = 0;
        for (let cursor = start; cursor <= index; cursor += 1) {
          const returnPct = (history[cursor].close / history[cursor - 1].close - 1) * 100;
          if (Math.abs(returnPct) >= 8.5) continue;
          eligibleVolume += history[cursor].volume;
          signedVolume += Math.sign(returnPct) * history[cursor].volume;
          positiveDays += returnPct > 0 ? 1 : 0;
          eligibleDays += 1;
        }
        factors[lookback] = {
          signedVolumeRatio: eligibleVolume ? signedVolume / eligibleVolume : 0,
          positiveRatio: positiveDays / Math.max(1, eligibleDays),
          returnPct: (day.close / history[start - 1].close - 1) * 100
        };
      }
      const nextDay = history[index + 1];
      const row = {
        signalDate: day.date,
        entryDate: nextDay.date,
        symbol: stock.symbol,
        name: stock.name,
        market: stock.market,
        factors,
        close: day.close,
        ma20: movingAverage(history, index, 20),
        ma60: movingAverage(history, index, 60),
        entryGapPct: (nextDay.open / day.close - 1) * 100,
        averageTradeValue20,
        futureBars: history.slice(index + 1, index + 21).map(bar => ({
          date: bar.date,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          price: bar.close
        }))
      };
      const rows = rowsByDate.get(day.date) || [];
      rows.push(row);
      rowsByDate.set(day.date, rows);
    }
  }
  return rowsByDate;
}

function configurations() {
  const rows = [];
  for (const lookback of [20, 60]) {
    for (const topN of [5, 10]) {
      for (const minimumPositiveRatio of [0.5, 0.55]) {
        for (const stopDistancePct of [5, 7]) {
              rows.push({
                lookback,
                topN,
                minimumSignedVolumeRatio: 0.05,
                minimumPositiveRatio,
                stopDistancePct,
                exitMode: 'fixed_20',
                maxEntryGapPct: 4,
                minimumEntryGapPct: -5
              });
        }
      }
    }
  }
  return rows;
}

function signalMap(rowsByDate, config, random = false) {
  const map = new Map();
  for (const [date, rows] of rowsByDate) {
    const candidates = rows.filter(row => {
      const factor = row.factors[config.lookback];
      const commonEligibility = row.close > row.ma60
        && row.entryGapPct <= config.maxEntryGapPct
        && row.entryGapPct >= config.minimumEntryGapPct;
      if (!commonEligibility) return false;
      if (random) return true;
      return factor.signedVolumeRatio >= config.minimumSignedVolumeRatio
        && factor.positiveRatio >= config.minimumPositiveRatio;
    }).map(row => {
      const factor = row.factors[config.lookback];
      const score = random
        ? deterministicScore(`${date}|${row.symbol}|持續過度反應公平隨機`)
        : factor.signedVolumeRatio * 100
          + factor.positiveRatio * 20
          + factor.returnPct * 0.1;
      return {
        ...row,
        score,
        stopDistancePct: config.stopDistancePct,
        rewardRisk: 0,
        maxHoldingDays: 20,
        positionPct: Math.min(9, 80 / config.topN),
        accountRiskPct: 0.5,
        trailingStopRule: config.exitMode === 'trailing_20'
          ? { triggerPct: 8, givebackPct: 5, lockPct: 1 }
          : null,
        setup: `${config.lookback} 日排除漲跌停後的帶方向成交量排名`,
        trigger: '每週最後交易日確認後，下一交易日開盤且跳空介於 -5% 至 4%',
        invalidation: `進場價下方 ${config.stopDistancePct}%`,
        exitPlan: config.exitMode === 'trailing_20'
          ? '最多持有 20 日，獲利 8% 後啟動移動停利'
          : '固定最多持有 20 日',
        reason: '台股投資人持續過度反應形成的中期延續',
        orderIntent: {
          action: 'BUY',
          orderType: 'MARKET',
          timeInForce: 'DAY',
          earliestDate: row.entryDate
        }
      };
    }).sort((left, right) => right.score - left.score)
      .slice(0, config.topN);
    if (candidates.length) map.set(date, candidates);
  }
  return map;
}

function runConfig(context, rowsByDate, config, startDate, endDate, random = false) {
  return simulateSignalMap(context, signalMap(rowsByDate, config, random), {
    strategyId: random ? `${STRATEGY_ID}_random` : STRATEGY_ID,
    startDate,
    endDate,
    initialCapital: INITIAL_CAPITAL,
    maxOpenPositions: config.topN,
    holdingDays: 20,
    accountRiskPct: 0.5,
    riskRules: {
      maxAccountRiskPct: 0.5,
      maxSinglePositionPct: 10,
      drawdownBlockPct: 8,
      drawdownBlockDays: 20,
      monthlyLossBlockPct: 5,
      dailyLossBlockPct: 2,
      losingStreakCount: 5,
      losingStreakBlockDays: 10
    }
  });
}

function aggregateRuns(runs) {
  const monthly = runs.flatMap(run => run.summary.monthly);
  const trades = runs.flatMap(run => run.trades);
  let equity = INITIAL_CAPITAL;
  let peak = equity;
  let maximumDrawdownPct = 0;
  for (const row of runs.flatMap(run => run.equityCurve)) {
    equity *= 1 + row.dailyReturnPct / 100;
    peak = Math.max(peak, equity);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, (equity / peak - 1) * 100);
  }
  const gains = trades.filter(row => row.realizedPnl > 0)
    .reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(trades.filter(row => row.realizedPnl <= 0)
    .reduce((sum, row) => sum + row.realizedPnl, 0));
  const symbolCounts = Map.groupBy
    ? Map.groupBy(trades, row => row.symbol)
    : trades.reduce((map, row) => map.set(row.symbol, (map.get(row.symbol) || 0) + 1), new Map());
  const maximumSymbolTrades = Map.groupBy
    ? Math.max(0, ...[...symbolCounts.values()].map(rows => rows.length))
    : Math.max(0, ...symbolCounts.values());
  const profits = trades.filter(row => row.realizedPnl > 0)
    .map(row => row.realizedPnl).sort((a, b) => b - a);
  return {
    months: monthly.length,
    averageMonthlyReturnPct: round(mean(monthly.map(row => row.equityReturnPct))),
    annualizedReturnPct: round((equity / INITIAL_CAPITAL) ** (12 / Math.max(1, monthly.length)) * 100 - 100),
    maximumDrawdownPct: round(maximumDrawdownPct),
    trades: trades.length,
    winRatePct: round(trades.filter(row => row.realizedPnl > 0).length / Math.max(1, trades.length) * 100),
    profitFactor: losses ? round(gains / losses) : null,
    concentrationPct: round(maximumSymbolTrades / Math.max(1, trades.length) * 100),
    topFiveProfitContributionPct: round(profits.slice(0, 5).reduce((sum, value) => sum + value, 0)
      / Math.max(1, gains) * 100),
    negativeMonths: monthly.filter(row => row.equityReturnPct < 0).length
  };
}

function benchmarkStats(series, startDate, endDate) {
  const rows = series.filter(row => row.date >= startDate && row.date <= endDate);
  const monthEnd = new Map();
  for (const row of rows) monthEnd.set(row.date.slice(0, 7), row.close);
  let prior = [...series].reverse().find(row => row.date < startDate)?.close ?? rows[0]?.close;
  const monthly = [];
  for (const close of monthEnd.values()) {
    monthly.push((close / prior - 1) * 100);
    prior = close;
  }
  let peak = rows[0]?.close || 1;
  let maximumDrawdownPct = 0;
  for (const row of rows) {
    peak = Math.max(peak, row.close);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, (row.close / peak - 1) * 100);
  }
  const growth = rows.length ? rows.at(-1).close / rows[0].close : 1;
  return {
    averageMonthlyReturnPct: round(mean(monthly)),
    annualizedReturnPct: round(growth ** (12 / Math.max(1, monthly.length)) * 100 - 100),
    maximumDrawdownPct: round(maximumDrawdownPct)
  };
}

async function main() {
  const identityInput = {
    strategyId: STRATEGY_ID,
    dataSources: ['OHLCV 日線開高低收量', '大盤市場狀態'],
    setupRules: ['20／60 日帶方向成交量', '排除漲跌停日', '成交值與 MA60 過濾'],
    triggerRules: ['每週排名後下一交易日開盤'],
    invalidationRules: ['固定 5%／7%停損', '市場曝險與帳戶熔斷'],
    exitRules: ['20 日持有', '可選移動停利'],
    riskRules: { accountRiskPct: 0.5, maxPositionPct: 9, tPlusTwo: true },
    blockedWhen: ['空頭防守', '高波動曝險限制', '跳空超過範圍'],
    parameters: { testedConfigurations: 16 },
    trainPeriod: 'rolling 54 months',
    validationPeriod: 'rolling 18 months',
    costModel: '手續費、交易稅、買賣滑價、最低手續費',
    executionModel: '次月第一交易日開盤；停損跳空使用較差開盤價'
  };
  const identity = buildExperimentIdentity(identityInput);
  const registry = await loadRegistry();
  const registryDecision = shouldSkipExperiment(registry, identity, { ...identityInput, coreRulesChanged: true });
  if (registryDecision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...registryDecision, ...identity }, null, 2));
    return;
  }
  const existing = await fs.readFile(OUTPUT, 'utf8').then(JSON.parse).catch(() => null);
  if (existing?.experimentHash === identity.experimentHash && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, reason: '相同實驗輸出已存在', ...identity }, null, 2));
    return;
  }

  const context = await loadResearchContext();
  const rowsByDate = buildWeeklyRows(context);
  const configs = configurations();
  const folds = foldWindows(context.startDate, context.endDate, 54, 18);
  const validationRuns = [];
  const randomRuns = [];
  const foldReports = [];
  for (const fold of folds) {
    const trained = configs.map(config => ({
      config,
      result: runConfig(context, rowsByDate, config, fold.trainStart, fold.trainEnd)
    })).filter(row => row.result.summary.trades >= 150
      && row.result.summary.maximumDrawdownPct >= -25)
      .sort((left, right) => (
        right.result.summary.averageMonthlyEquityReturnPct
        - left.result.summary.averageMonthlyEquityReturnPct
        || right.result.summary.maximumDrawdownPct - left.result.summary.maximumDrawdownPct
      ))[0];
    if (!trained) {
      foldReports.push({ ...fold, status: '訓練樣本不足' });
      continue;
    }
    const validation = runConfig(
      context,
      rowsByDate,
      trained.config,
      fold.validationStart,
      fold.validationEnd
    );
    const random = runConfig(
      context,
      rowsByDate,
      trained.config,
      fold.validationStart,
      fold.validationEnd,
      true
    );
    validationRuns.push(validation);
    randomRuns.push(random);
    foldReports.push({
      ...fold,
      status: '完成',
      selectedConfig: trained.config,
      train: trained.result.summary,
      validation: validation.summary,
      random: random.summary
    });
  }

  const metrics = aggregateRuns(validationRuns);
  const randomMetrics = aggregateRuns(randomRuns);
  const etfHistory = JSON.parse(await fs.readFile(ETF_HISTORY, 'utf8'));
  const validationStart = folds.find(row => foldReports.some(report => (
    report.validationStart === row.validationStart && report.status === '完成'
  )))?.validationStart;
  const validationEnd = [...foldReports].reverse().find(row => row.status === '完成')?.validationEnd;
  const benchmark0050 = benchmarkStats(
    etfHistory.series['0050.TW'] || [],
    validationStart,
    validationEnd
  );
  const passed = metrics.averageMonthlyReturnPct >= 5
    && metrics.maximumDrawdownPct >= -20
    && metrics.trades >= 300
    && metrics.profitFactor > 1.15
    && metrics.averageMonthlyReturnPct > benchmark0050.averageMonthlyReturnPct
    && metrics.averageMonthlyReturnPct > randomMetrics.averageMonthlyReturnPct;
  const output = {
    generatedAt: new Date().toISOString(),
    ...identity,
    strategyId: STRATEGY_ID,
    universe: '台股四位數普通股，排除 ETF；0050 僅作比較',
    academicBasis: '排除漲跌停日後，以帶方向成交量衡量持續過度反應與中期延續',
    testedConfigurations: configs.length,
    validationPeriod: `${validationStart}～${validationEnd}`,
    trainingMonthsPerFold: 54,
    validationMonthsPerFold: 18,
    folds: foldReports,
    metrics,
    benchmark0050,
    fairRandom: randomMetrics,
    survivorshipBiasWarning: true,
    targetMonthlyReturnPct: 5,
    targetMet: passed,
    paperTradingReady: false,
    liveTradingReady: false,
    registryCheck: registryDecision,
    conclusion: passed
      ? '達到歷史研究門檻，但仍須先完成前瞻紙上交易。'
      : `尚未達到月均 5% 與全部風險門檻；目前月均 ${metrics.averageMonthlyReturnPct}%。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    output: OUTPUT.pathname,
    experimentHash: identity.experimentHash,
    testedConfigurations: configs.length,
    validationPeriod: output.validationPeriod,
    folds: foldReports.length,
    metrics,
    benchmark0050,
    fairRandom: randomMetrics,
    targetMet: passed,
    conclusion: output.conclusion
  }, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
