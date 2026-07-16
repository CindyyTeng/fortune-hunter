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

const EPS = new URL('../../data/quality/eps-history-2015.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-unexpected-earnings-v1.json', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const STRATEGY_ID = 'stock_unexpected_earnings_v1';
const INITIAL_CAPITAL = 1_000_000;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

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

function percentileRanks(rows, valueKey, outputKey) {
  const sorted = [...rows].sort((left, right) => left[valueKey] - right[valueKey]);
  sorted.forEach((row, index) => { row[outputKey] = (index + 1) / sorted.length; });
}

function addSue(records) {
  const output = [];
  const groups = new Map();
  for (const row of records) groups.set(row.symbol, [...(groups.get(row.symbol) || []), row]);
  for (const list of groups.values()) {
    list.sort((left, right) => left.quarter.localeCompare(right.quarter));
    const byQuarter = new Map(list.map(row => [row.quarter, row]));
    const surprises = [];
    for (const row of list) {
      const priorYear = byQuarter.get(`${Number(row.quarter.slice(0, 4)) - 1}${row.quarter.slice(4)}`);
      if (!Number.isFinite(priorYear?.EPS)) continue;
      const surprise = row.EPS - priorYear.EPS;
      const history = surprises.slice(-8);
      if (history.length >= 6) {
        const sigma = standardDeviation(history);
        if (sigma > 0) output.push({ ...row, seasonalEpsChange: surprise, sue: (surprise - mean(history)) / sigma });
      }
      surprises.push(surprise);
    }
  }
  return output;
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
  const variants = { event_open: create(index) };
  if (history[index].close > history[index - 1].close && history[index].close > averageClose(index)) {
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

function configurations() {
  const rows = [];
  for (const ranking of ['global', 'industry_neutral']) {
    for (const minimumPercentile of [0.8, 0.9]) {
      for (const topN of [10, 20]) {
        for (const holdingDays of [20, 40, 60]) {
          for (const triggerMode of ['event_open', 'positive_reaction', 'breakout_3d']) {
            for (const marketMode of ['all', 'risk_on']) {
              for (const refreshMode of ['event_once', 'monthly_refresh']) {
                rows.push({ ranking, minimumPercentile, topN, holdingDays, triggerMode, marketMode, refreshMode });
              }
            }
          }
        }
      }
    }
  }
  for (const ranking of ['global', 'industry_neutral']) {
    for (const minimumPercentile of [0.6, 0.7]) {
      for (const topN of [20, 30]) {
        for (const holdingDays of [10, 20]) {
          for (const triggerMode of ['event_open', 'positive_reaction']) {
            for (const marketMode of ['all', 'risk_on']) {
              rows.push({ ranking, minimumPercentile, topN, holdingDays, triggerMode, marketMode, refreshMode: 'event_once' });
            }
          }
        }
      }
    }
  }
  for (const ranking of ['global', 'industry_neutral']) {
    for (const topN of [30, 40]) {
      for (const holdingDays of [10, 20]) {
        for (const triggerMode of ['event_open', 'positive_reaction']) {
          for (const marketMode of ['all', 'risk_on']) {
            rows.push({ ranking, minimumPercentile: 0.5, topN, holdingDays, triggerMode, marketMode, refreshMode: 'event_once' });
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
    && row.sue > 0
    && (config.refreshMode === 'monthly_refresh' || row.refreshAge === 0)
    && rank >= config.minimumPercentile
    && row.preRun20Pct >= -15
    && row.preRun20Pct <= 20
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
    score: random ? deterministicScore(`${row.signalDate}|${row.symbol}|random-sue`) : row.score,
    close: row.close,
    entryGapRange: { minimumPct: -5, maximumPct: 4 },
    futureBars: row.history.slice(row.historyIndex + 1, row.historyIndex + config.holdingDays + 2).map(bar => ({
      date: bar.date,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      price: bar.close
    })),
    stopDistancePct: 10,
    stopLossMode: 'close',
    rewardRisk: 0,
    maxHoldingDays: config.holdingDays,
    trailingStopRule: config.holdingDays >= 40 ? { triggerPct: 10, lockPct: 2, givebackPct: 6 } : null,
    positionPct: Math.min(10, 80 / config.topN),
    accountRiskPct: 0.5,
    setup: random ? '同日公平隨機個股' : `標準化意外盈餘 SUE ${round(row.sue, 2)}`,
    trigger: `${config.triggerMode} 訊號收盤確認，隔日開盤成交`,
    invalidation: '收盤跌破進場價 10% 或投組風控觸發',
    exitPlan: `最長持有 ${config.holdingDays} 個交易日`,
    reason: random ? '公平隨機基準' : `${config.ranking} SUE 橫斷面排名`,
    orderIntent: { action: 'BUY', orderType: 'MARKETABLE_LIMIT', timeInForce: 'DAY', earliestDate: row.entryDate }
  };
}

function signalMap(events, config) {
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
  const map = new Map();
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
    const selected = (randomPool.get(date) || [])
      .sort((left, right) => deterministicScore(`${date}|${left.symbol}`) - deterministicScore(`${date}|${right.symbol}`))
      .slice(0, selectedRows.length)
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
        BULL_TREND: 75,
        BULL_PULLBACK: 65,
        RANGE_BOUND: 50,
        THEME_MOMENTUM: 75,
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
    dataSources: ['個股 OHLCV', '季度 EPS 保守 T+1', '市場狀態'],
    setupRules: ['SUE 橫斷面前 10%／20%', '全市場或產業中性排名'],
    triggerRules: ['公告可用日、正向反應或三日突破後隔日開盤'],
    invalidationRules: ['收盤停損 10%', '投組熔斷'],
    exitRules: ['20／40／60 日或移動停利'],
    riskRules: { accountRiskPct: 0.5, maxPositionPct: 10, tPlusTwo: true },
    blockedWhen: ['成交值不足', '跳空超過 4%', '高波動／空頭盤可選擇停買'],
    parameters: { trainMonths: 54, validationMonths: 18, configurations: configurations() },
    trainPeriod: 'rolling 54 months',
    validationPeriod: 'rolling 18 months',
    costModel: '台股手續費、交易稅與滑價',
    executionModel: '隔日開盤真實跳空成交與 T+2'
  };
  const identity = buildExperimentIdentity(identityInput);
  const decision = shouldSkipExperiment(await loadRegistry(), identity, {
    ...identityInput,
    newDataSources: ['2015 起季度 EPS 與 SUE'],
    coreRulesChanged: true
  });
  if (decision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...decision, ...identity }, null, 2));
    return;
  }

  const [context, epsPayload, etfHistory] = await Promise.all([
    loadResearchContext(),
    fs.readFile(EPS, 'utf8').then(JSON.parse),
    fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)
  ]);
  const stocks = new Map(context.ohlcv.stocks
    .filter(row => /^\d{4}$/.test(row.stock.symbol) && Number(row.stock.symbol) >= 1000)
    .map(row => [row.stock.symbol, row]));
  const unexpected = addSue((epsPayload.records || []).filter(row => row.isPointInTimeSafe));
  const events = new Map();
  for (const earnings of unexpected) {
    const stockRow = stocks.get(earnings.symbol);
    if (!stockRow) continue;
    const { stock, history } = stockRow;
    const eventIndex = firstIndexOnOrAfter(history, earnings.effectiveDate);
    if (eventIndex < 60 || eventIndex + 102 >= history.length) continue;
    for (const refreshAge of [0, 20, 40]) {
      const index = eventIndex + refreshAge;
      const day = history[index];
      const averageTradeValue20 = mean(history.slice(index - 19, index + 1).map(row => row.close * row.volume));
      const priorReturns = history.slice(index - 59, index + 1).map((row, offset, rows) => (
        offset ? row.close / rows[offset - 1].close - 1 : 0
      ));
      if (day.close < 5 || averageTradeValue20 < 30_000_000 || priorReturns.some(value => Math.abs(value) > 0.15)) continue;
      const row = {
        symbol: stock.symbol,
        name: stock.name,
        market: stock.market,
        industry: stock.themes?.[0] || '未分類',
        sue: earnings.sue,
        refreshAge,
        preRun20Pct: (day.close / history[index - 20].close - 1) * 100,
        averageTradeValue20,
        history,
        variants: triggerVariants(history, index, context.marketByDate)
      };
      const rows = events.get(day.date) || [];
      rows.push(row);
      events.set(day.date, rows);
    }
  }

  for (const rows of events.values()) {
    percentileRanks(rows, 'sue', 'globalPercentile');
    const industries = new Map();
    for (const row of rows) industries.set(row.industry, [...(industries.get(row.industry) || []), row]);
    for (const list of industries.values()) {
      if (list.length >= 4) percentileRanks(list, 'sue', 'industryPercentile');
      else for (const row of list) row.industryPercentile = row.globalPercentile;
    }
    for (const row of rows) row.score = row.sue * 10 + row.industryPercentile * 5;
  }

  const eventDates = new Set([...events.values()].flatMap(rows => rows.flatMap(row => (
    Object.values(row.variants).map(variant => variant.signalDate)
  ))));
  const randomPool = new Map();
  for (const { stock, history } of stocks.values()) {
    for (let index = 60; index + 62 < history.length; index += 1) {
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
  const folds = [];
  for (const fold of foldWindows(context.startDate, context.endDate, 54, 18)) {
    const trained = configs.map(config => ({ config, result: run(context, signalMap(events, config), config, fold.trainStart, fold.trainEnd) }))
      .filter(row => row.result.summary.trades >= 40 && row.result.summary.maximumDrawdownPct >= -25)
      .sort((left, right) => right.result.summary.averageMonthlyEquityReturnPct - left.result.summary.averageMonthlyEquityReturnPct)[0];
    if (!trained) {
      folds.push({ ...fold, status: '訓練樣本不足' });
      continue;
    }
    const validation = run(context, signalMap(events, trained.config), trained.config, fold.validationStart, fold.validationEnd);
    const random = run(context, randomSignalMap(events, randomPool, trained.config), trained.config, fold.validationStart, fold.validationEnd, '_random');
    validations.push(validation);
    randoms.push(random);
    folds.push({ ...fold, status: '已驗證', selectedConfig: trained.config, train: trained.result.summary, validation: validation.summary, random: random.summary });
  }

  const metrics = summarizeRuns(validations);
  const fairRandom = summarizeRuns(randoms);
  const completed = folds.filter(row => row.status === '已驗證');
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
    universe: '純個股，ETF 與 0050 交易占比 0%',
    formula: 'SUE = [(EPS_t - EPS_t-4) - mean(previous 8 seasonal EPS changes)] / standard deviation',
    dataCoverage: {
      records: epsPayload.records.length,
      symbols: new Set(epsPayload.records.map(row => row.symbol)).size,
      earliestQuarter: epsPayload.records[0]?.quarter,
      latestQuarter: epsPayload.records.at(-1)?.quarter,
      pointInTimeMode: 'conservative_assumption'
    },
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
    pointInTimeWarning: '逐筆歷史公布時間未 fully verified，採法定期限收盤後、下一交易日可用。',
    conclusion: targetMet
      ? '達到月均 5% 的純個股候選門檻，仍只能先紙上交易。'
      : `找不到月均 5% 的可實盤純個股策略；目前月均 ${metrics.averageMonthlyReturnPct}%。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    dataCoverage: output.dataCoverage,
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
