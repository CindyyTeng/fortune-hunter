import fs from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
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

const REVENUE = new URL('../../data/revenue/monthly-revenue.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-unexpected-revenue-v1.json', import.meta.url);
const SIGNAL_OUTPUT = new URL('../../data/research/stock-unexpected-revenue-signals-v1.json.gz', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const STRATEGY_ID = 'stock_unexpected_revenue_v1';
const INITIAL_CAPITAL = 1_000_000;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const compactCandidates = candidates => candidates.map(({ futureBars, ...candidate }) => candidate);

function standardDeviation(values) {
  const average = mean(values);
  return Math.sqrt(mean(values.map(value => (value - average) ** 2)));
}

function firstIndexOnOrAfter(history, date) {
  let low = 0;
  let high = history.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (history[middle].date < date) low = middle + 1;
    else high = middle;
  }
  return low < history.length ? low : -1;
}

function triggerVariants(history, index, marketByDate) {
  const create = historyIndex => ({
    signalDate: history[historyIndex].date,
    entryDate: history[historyIndex + 1].date,
    close: history[historyIndex].close,
    regime: marketByDate.get(history[historyIndex].date)?.regime,
    historyIndex
  });
  const averageClose = historyIndex => mean(history.slice(historyIndex - 19, historyIndex + 1).map(row => row.close));
  const day = history[index];
  const previous = history[index - 1];
  const variants = { event_open: create(index) };
  if (day.close > previous.close && day.close > averageClose(index)) {
    variants.positive_reaction = create(index);
  }
  for (let cursor = index; cursor <= Math.min(index + 2, history.length - 2); cursor += 1) {
    const priorHigh = Math.max(...history.slice(cursor - 5, cursor).map(row => row.high));
    if (history[cursor].close > priorHigh && history[cursor].close > averageClose(cursor)) {
      variants.breakout_3d = create(cursor);
      break;
    }
  }
  return variants;
}

function percentileRanks(rows, valueKey, outputKey) {
  const sorted = [...rows].sort((left, right) => left[valueKey] - right[valueKey]);
  sorted.forEach((row, index) => { row[outputKey] = (index + 1) / sorted.length; });
}

function addUnexpectedRevenue(records) {
  const output = [];
  const groups = new Map();
  for (const row of records) {
    const list = groups.get(row.symbol) || [];
    list.push({ ...row });
    groups.set(row.symbol, list);
  }
  for (const list of groups.values()) {
    list.sort((left, right) => left.revenueMonth.localeCompare(right.revenueMonth));
    const byMonth = new Map(list.map(row => [row.revenueMonth, row]));
    const deltas = [];
    for (const row of list) {
      const priorYearMonth = `${Number(row.revenueMonth.slice(0, 4)) - 1}${row.revenueMonth.slice(4)}`;
      const priorYear = byMonth.get(priorYearMonth);
      if (!priorYear?.monthlyRevenue) continue;
      const delta = row.monthlyRevenue - priorYear.monthlyRevenue;
      const history = deltas.slice(-24);
      if (history.length >= 18) {
        const sigma = standardDeviation(history);
        if (sigma > 0) output.push({ ...row, revenueDelta: delta, msurge: (delta - mean(history)) / sigma });
      }
      deltas.push(delta);
    }
  }
  return output;
}

function configurations() {
  const rows = [];
  for (const ranking of ['global', 'industry_neutral']) {
    for (const minimumPercentile of [0.8, 0.9]) {
      for (const holdingDays of [20, 40]) {
        for (const maximumPreRunPct of [10, 20]) {
          for (const triggerMode of ['event_open', 'positive_reaction', 'breakout_3d']) {
            for (const marketMode of ['all', 'risk_on']) {
              rows.push({
                ranking,
                minimumPercentile,
                topN: 10,
                holdingDays,
                maximumPreRunPct,
                triggerMode,
                marketMode,
                stopDistancePct: 10
              });
            }
          }
        }
      }
    }
  }
  return rows;
}

function eligible(row, config) {
  const rank = config.ranking === 'industry_neutral' ? row.industryPercentile : row.globalPercentile;
  return row.variant
    && rank >= config.minimumPercentile
    && row.msurge > 0
    && row.preRun20Pct <= config.maximumPreRunPct
    && row.preRun20Pct >= -15
    && row.averageTradeValue20 >= 30_000_000
    && (config.marketMode === 'all' || !['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.variant.regime));
}

function candidate(row, config, random = false) {
  return {
    signalDate: row.signalDate,
    entryDate: row.entryDate,
    symbol: row.symbol,
    name: row.name,
    market: row.market,
    regime: row.regime,
    close: row.close,
    score: random ? deterministicScore(`${row.signalDate}|${row.symbol}|未預期營收公平隨機`) : row.score,
    entryGapRange: { minimumPct: -5, maximumPct: 4 },
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
    trailingStopRule: config.holdingDays === 40 ? { triggerPct: 10, lockPct: 2, givebackPct: 6 } : null,
    positionPct: Math.min(10, 80 / config.topN),
    accountRiskPct: 0.5,
    setup: random ? '同日同數量流動性個股公平隨機' : `標準化未預期營收 ${round(row.msurge, 2)}`,
    trigger: '保守有效日收盤完成橫斷面排名，下一交易日開盤進場',
    invalidation: '收盤跌破 10% 風險距離後，下一交易日開盤退出',
    exitPlan: `最多持有 ${config.holdingDays} 個交易日`,
    reason: random ? '公平隨機比較' : `${config.ranking} 未預期營收前段`,
    orderIntent: { action: 'BUY', orderType: 'MARKETABLE_LIMIT', timeInForce: 'DAY', earliestDate: row.entryDate }
  };
}

function signalMap(events, config) {
  const map = new Map();
  const bySignalDate = new Map();
  for (const rows of events.values()) {
    for (const row of rows) {
      const variant = row.variants[config.triggerMode];
      if (!variant) continue;
      const list = bySignalDate.get(variant.signalDate) || [];
      list.push({ ...row, ...variant, variant });
      bySignalDate.set(variant.signalDate, list);
    }
  }
  for (const [date, rows] of bySignalDate) {
    const selected = rows.filter(row => eligible(row, config))
      .sort((left, right) => right.score - left.score)
      .slice(0, config.topN)
      .map(row => candidate(row, config));
    if (selected.length) map.set(date, selected);
  }
  return map;
}

function randomSignalMap(events, randomPool, config) {
  const map = new Map();
  for (const [date, selectedRows] of signalMap(events, config)) {
    const count = selectedRows.length;
    if (!count) continue;
    const selected = (randomPool.get(date) || [])
      .sort((left, right) => deterministicScore(`${date}|${left.symbol}`) - deterministicScore(`${date}|${right.symbol}`))
      .slice(0, count)
      .map(row => candidate(row, config, true));
    if (selected.length) map.set(date, selected);
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
        BULL_TREND: 70,
        BULL_PULLBACK: 60,
        RANGE_BOUND: 50,
        THEME_MOMENTUM: 70,
        HIGH_VOLATILITY: 20,
        BEAR_DEFENSE: 20
      },
      drawdownBlockPct: 8,
      drawdownBlockDays: 20,
      monthlyLossBlockPct: 5,
      dailyLossBlockPct: 2,
      losingStreakCount: 5,
      losingStreakBlockDays: 10
    }
  });
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
    annualizedReturnPct: round((equity / INITIAL_CAPITAL) ** (12 / Math.max(1, monthly.length)) * 100 - 100),
    maximumDrawdownPct: round(maximumDrawdownPct),
    trades: trades.length,
    winRatePct: round(trades.filter(row => row.realizedPnl > 0).length / Math.max(1, trades.length) * 100),
    profitFactor: losses ? round(gains / losses) : null,
    concentrationPct: round(Math.max(0, ...symbols.values()) / Math.max(1, trades.length) * 100),
    averageExposurePct: round(mean(curve.map(row => row.exposurePct || 0))),
    investedTradingDaysPct: round(curve.filter(row => row.openPositions > 0).length / Math.max(1, curve.length) * 100)
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
    dataSources: ['個股 OHLCV', '月營收歷史資料（保守 T+1）', '靜態產業分類'],
    setupRules: ['MSURGE 標準化未預期營收', '全市場或產業內前 20%／10%'],
    triggerRules: ['有效日收盤排名後，隔日開盤進場'],
    invalidationRules: ['收盤停損 10%'],
    exitRules: ['固定持有 20／40 個交易日'],
    riskRules: { accountRiskPct: 0.5, maxPositionPct: 10, tPlusTwo: true },
    blockedWhen: ['公告前 20 日漲幅過高', '成交值低於三千萬元', '隔日跳空超過 4%'],
    parameters: { trainMonths: 54, validationMonths: 18, configurations: configurations() },
    trainPeriod: 'rolling 54 months',
    validationPeriod: 'rolling 18 months',
    costModel: '共用成交模擬器：手續費、交易稅、滑價',
    executionModel: '訊號排名後才檢查隔日跳空，停損跳空採較差成交價'
  };
  const identity = buildExperimentIdentity(identityInput);
  const decision = shouldSkipExperiment(await loadRegistry(), identity, {
    ...identityInput,
    newDataSources: ['MSURGE 與產業中性橫斷面排名'],
    coreRulesChanged: true
  });
  if (decision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...decision, ...identity }, null, 2));
    return;
  }

  const [context, revenuePayload, etfHistory] = await Promise.all([
    loadResearchContext(),
    fs.readFile(REVENUE, 'utf8').then(JSON.parse),
    fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)
  ]);
  const stocks = new Map(context.ohlcv.stocks
    .filter(row => /^\d{4}$/.test(row.stock.symbol) && Number(row.stock.symbol) >= 1000)
    .map(row => [row.stock.symbol, row]));
  const unexpected = addUnexpectedRevenue((revenuePayload.records || []).filter(row => row.isPointInTimeSafe));
  const events = new Map();
  for (const revenue of unexpected) {
    const stockRow = stocks.get(revenue.symbol);
    if (!stockRow) continue;
    const { stock, history } = stockRow;
    const index = firstIndexOnOrAfter(history, revenue.effectiveDate);
    if (index < 60 || index + 41 >= history.length) continue;
    const day = history[index];
    const nextDay = history[index + 1];
    const averageTradeValue20 = mean(history.slice(index - 19, index + 1).map(row => row.close * row.volume));
    if (day.close < 5 || averageTradeValue20 < 30_000_000) continue;
    const priorReturns = history.slice(index - 59, index + 1).map((row, offset, rows) => (
      offset ? row.close / rows[offset - 1].close - 1 : 0
    ));
    if (priorReturns.some(value => Math.abs(value) > 0.15)) continue;
    const preRun20Pct = (day.close / history[index - 20].close - 1) * 100;
    const row = {
      signalDate: day.date,
      entryDate: nextDay.date,
      symbol: stock.symbol,
      name: stock.name,
      market: stock.market,
      industry: stock.themes?.[0] || '未分類',
      regime: context.marketByDate.get(day.date)?.regime,
      msurge: revenue.msurge,
      preRun20Pct,
      averageTradeValue20,
      history,
      historyIndex: index,
      variants: triggerVariants(history, index, context.marketByDate)
    };
    const rows = events.get(day.date) || [];
    rows.push(row);
    events.set(day.date, rows);
  }

  for (const rows of events.values()) {
    percentileRanks(rows, 'msurge', 'globalPercentile');
    const industries = new Map();
    for (const row of rows) {
      const list = industries.get(row.industry) || [];
      list.push(row);
      industries.set(row.industry, list);
    }
    for (const list of industries.values()) {
      if (list.length >= 4) percentileRanks(list, 'msurge', 'industryPercentile');
      else for (const row of list) row.industryPercentile = row.globalPercentile;
    }
    for (const row of rows) row.score = row.msurge * 10 + row.industryPercentile * 5 - Math.max(0, row.preRun20Pct - 5) * 0.2;
  }

  const eventDates = new Set([...events.values()].flatMap(rows => (
    rows.flatMap(row => Object.values(row.variants).map(variant => variant.signalDate))
  )));
  const randomPool = new Map();
  for (const { stock, history } of stocks.values()) {
    for (let index = 60; index + 41 < history.length; index += 1) {
      const day = history[index];
      if (!eventDates.has(day.date) || day.close < 5) continue;
      const averageTradeValue20 = mean(history.slice(index - 19, index + 1).map(row => row.close * row.volume));
      if (averageTradeValue20 < 30_000_000) continue;
      const rows = randomPool.get(day.date) || [];
      rows.push({
        signalDate: day.date,
        entryDate: history[index + 1].date,
        symbol: stock.symbol,
        name: stock.name,
        market: stock.market,
        regime: context.marketByDate.get(day.date)?.regime,
        close: day.close,
        history,
        historyIndex: index
      });
      randomPool.set(day.date, rows);
    }
  }

  const configs = configurations();
  const validations = [];
  const randoms = [];
  const validationSignals = [];
  const randomValidationSignals = [];
  const folds = [];
  for (const fold of foldWindows(context.startDate, context.endDate, 54, 18)) {
    const trained = configs.map(config => ({ config, result: run(context, signalMap(events, config), config, fold.trainStart, fold.trainEnd) }))
      .filter(row => row.result.summary.trades >= 40 && row.result.summary.maximumDrawdownPct >= -25)
      .sort((left, right) => right.result.summary.averageMonthlyEquityReturnPct - left.result.summary.averageMonthlyEquityReturnPct)[0];
    if (!trained) {
      folds.push({ ...fold, status: '訓練樣本不足' });
      continue;
    }
    const validationMap = signalMap(events, trained.config);
    const randomMap = randomSignalMap(events, randomPool, trained.config);
    const validation = run(context, validationMap, trained.config, fold.validationStart, fold.validationEnd);
    const random = run(context, randomMap, trained.config, fold.validationStart, fold.validationEnd, '_random');
    validationSignals.push(...[...validationMap].filter(([date]) => date >= fold.validationStart && date <= fold.validationEnd)
      .map(([date, candidates]) => ({ date, candidates: compactCandidates(candidates) })));
    randomValidationSignals.push(...[...randomMap].filter(([date]) => date >= fold.validationStart && date <= fold.validationEnd)
      .map(([date, candidates]) => ({ date, candidates: compactCandidates(candidates) })));
    validations.push(validation);
    randoms.push(random);
    folds.push({ ...fold, status: '完成', selectedConfig: trained.config, train: trained.result.summary, validation: validation.summary, random: random.summary });
  }

  const metrics = summarizeRuns(validations);
  const fairRandom = summarizeRuns(randoms);
  const completed = folds.filter(row => row.status === '完成');
  const validationStart = completed[0]?.validationStart;
  const validationEnd = completed.at(-1)?.validationEnd;
  const benchmark0050 = benchmark(etfHistory.series['0050.TW'] || [], validationStart, validationEnd);
  const targetMet = metrics.averageMonthlyReturnPct >= 5
    && metrics.maximumDrawdownPct >= -20
    && metrics.trades >= 300
    && metrics.profitFactor > 1.15
    && metrics.averageMonthlyReturnPct > benchmark0050.averageMonthlyReturnPct
    && metrics.averageMonthlyReturnPct > fairRandom.averageMonthlyReturnPct;
  const output = {
    generatedAt: new Date().toISOString(),
    ...identity,
    universe: '台股個股；ETF 與 0050 實際交易比重 0%',
    formula: 'MSURGE = [(Revenue_t - Revenue_t-12) - mean(previous 24 annual differences)] / standard deviation',
    observations: unexpected.length,
    eventDates: events.size,
    testedConfigurations: configs.length,
    trainingMonthsPerFold: 54,
    validationMonthsPerFold: 18,
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
      ? '通過研究門檻，但仍只能先進紙上交易。'
      : `找不到月均 5% 的可實盤純個股策略；目前月均 ${metrics.averageMonthlyReturnPct}%。`
  };
  await Promise.all([
    fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8'),
    fs.writeFile(SIGNAL_OUTPUT, gzipSync(JSON.stringify({ validationSignals, randomValidationSignals })))
  ]);
  console.log(JSON.stringify({
    observations: output.observations,
    eventDates: output.eventDates,
    testedConfigurations: output.testedConfigurations,
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
