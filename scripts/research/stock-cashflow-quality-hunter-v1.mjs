import fs from 'node:fs/promises';
import {
  deterministicScore,
  foldWindows,
  loadResearchContext,
  mean,
  round,
  simulateSignalMap
} from './research-core.mjs';
import {
  appendExperiment,
  buildExperimentIdentity,
  loadRegistry,
  shouldSkipExperiment
} from './strategy-experiment-registry.mjs';

const CASHFLOW = new URL('../../data/cashflow-quality/cashflow-quality.json', import.meta.url);
const VALIDATION = new URL('../../data/research/cashflow-quality-validation.json', import.meta.url);
const REVENUE = new URL('../../data/revenue/monthly-revenue.json', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-cashflow-quality-hunter-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_CASHFLOW_QUALITY_HUNTER_V1.md', import.meta.url);
const STRATEGY_ID = 'stock_cashflow_quality_hunter_v1';
const INITIAL_CAPITAL = 1_000_000;
const TARGET_MONTHLY_RETURN_PCT = 5;

const readJson = (url, fallback = null) => fs.readFile(url, 'utf8').then(JSON.parse).catch(error => {
  if (error.code === 'ENOENT') return fallback;
  throw error;
});

const setups = [
  {
    id: 'cash_conversion',
    name: '高現金轉換品質',
    test: row => row.cashflow.operatingCashFlow > 0
      && row.cashflow.netIncome > 0
      && row.cashflow.cashConversion >= 1
      && row.cashflow.accrualRatio <= 0
      && row.cashflow.debtRatioChangeYoY <= 3
  },
  {
    id: 'cashflow_acceleration',
    name: '營業現金流加速',
    test: row => row.cashflow.operatingCashFlow > 0
      && row.cashflow.operatingCashFlowYoY >= 30
      && row.cashflow.netIncome > 0
      && row.cashflow.accrualRatio <= 2
  },
  {
    id: 'low_accrual',
    name: '低應計穩健成長',
    test: row => row.cashflow.operatingCashFlow > 0
      && row.cashflow.accrualRatio <= -1
      && row.cashflow.debtRatio < 70
      && row.cashflow.assetGrowthYoY >= -10
      && row.cashflow.assetGrowthYoY <= 30
  },
  {
    id: 'cashflow_turnaround',
    name: '現金流由負轉正',
    test: row => row.cashflow.operatingCashFlowTurnPositive
      && row.cashflow.netIncome > 0
      && row.cashflow.debtRatioChangeYoY <= 2
  },
  {
    id: 'cashflow_revenue_confirm',
    name: '現金流與營收同步',
    test: row => row.cashflow.operatingCashFlow > 0
      && row.cashflow.cashConversion >= 0.8
      && row.revenue?.YoY >= 20
      && (row.revenue?.revenueHigh12 || row.revenue?.yoyAcceleration)
  },
  {
    id: 'quality_momentum',
    name: '現金品質與相對強勢',
    test: row => row.cashflow.operatingCashFlow > 0
      && row.cashflow.accrualRatio <= 1
      && row.cashflow.debtRatioChangeYoY <= 0
      && row.return20Pct >= 5
      && row.relativeMarket20Pct >= 2
  }
];

const triggers = ['event_open', 'positive_reaction', 'breakout_10d', 'ma20_restrengthen'];

function configurations() {
  return setups.flatMap(setup => [20, 40].flatMap(holdingDays => [5, 10].flatMap(topN => [8, 12].flatMap(stopDistancePct => triggers.flatMap(trigger => ['all', 'risk_on'].map(marketMode => ({
    setup, holdingDays, topN, stopDistancePct, trigger, marketMode
  })))))));
}

function movingAverage(history, index, days) {
  return mean(history.slice(index - days + 1, index + 1).map(row => row.close));
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

function latestBefore(rows, date) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle].effectiveDate <= date) low = middle + 1;
    else high = middle;
  }
  return rows[low - 1] || null;
}

function triggerVariants(history, eventIndex, marketByDate) {
  const output = {};
  const add = (id, index) => {
    if (index + 1 >= history.length) return;
    output[id] = {
      signalDate: history[index].date,
      entryDate: history[index + 1].date,
      historyIndex: index,
      close: history[index].close,
      regime: marketByDate.get(history[index].date)?.regime
    };
  };
  add('event_open', eventIndex);
  for (let index = eventIndex; index <= Math.min(eventIndex + 10, history.length - 2); index += 1) {
    const day = history[index];
    const prior = history[index - 1];
    const ma20 = movingAverage(history, index, 20);
    const priorHigh20 = Math.max(...history.slice(index - 20, index).map(row => row.high));
    const averageVolume20 = mean(history.slice(index - 19, index + 1).map(row => row.volume));
    if (!output.positive_reaction && day.close > day.open && day.close > prior.high && day.close > ma20) {
      add('positive_reaction', index);
    }
    if (!output.breakout_10d && day.close > priorHigh20 && day.volume >= averageVolume20 * 1.1) {
      add('breakout_10d', index);
    }
    if (!output.ma20_restrengthen && day.low <= ma20 * 1.02 && day.close >= ma20
      && day.close > day.open && day.close > prior.close) {
      add('ma20_restrengthen', index);
    }
  }
  return output;
}

function buildEvents(context, cashflowRows, revenueRows) {
  const stocks = new Map(context.ohlcv.stocks
    .filter(row => /^\d{4}$/.test(row.stock.symbol || ''))
    .map(row => [row.stock.symbol, row]));
  const revenueBySymbol = new Map();
  for (const row of revenueRows.filter(value => value.isPointInTimeSafe && value.effectiveDate)) {
    const list = revenueBySymbol.get(row.symbol) || [];
    list.push(row);
    revenueBySymbol.set(row.symbol, list);
  }
  for (const list of revenueBySymbol.values()) list.sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate));
  const marketRows = context.marketHistory;
  const marketIndex = new Map(marketRows.map((row, index) => [row.date, index]));
  const events = new Map();
  for (const cashflow of cashflowRows) {
    if (!cashflow.isPointInTimeSafe || !cashflow.effectiveDate) continue;
    const stockRow = stocks.get(cashflow.symbol);
    if (!stockRow) continue;
    const { stock, history } = stockRow;
    const eventIndex = firstIndexOnOrAfter(history, cashflow.effectiveDate);
    if (eventIndex < 120 || eventIndex + 42 >= history.length) continue;
    const day = history[eventIndex];
    const previous120 = history.slice(eventIndex - 119, eventIndex + 1);
    if (previous120.some((row, index) => index && Math.abs(row.close / previous120[index - 1].close - 1) > 0.15)) continue;
    const averageTradeValue20 = mean(history.slice(eventIndex - 19, eventIndex + 1).map(row => row.close * row.volume));
    if (day.close < 5 || averageTradeValue20 < 30_000_000) continue;
    const marketCursor = marketIndex.get(day.date);
    if (marketCursor < 20) continue;
    const return20Pct = (day.close / history[eventIndex - 20].close - 1) * 100;
    const marketReturn20Pct = (marketRows[marketCursor].close / marketRows[marketCursor - 20].close - 1) * 100;
    const relativeMarket20Pct = return20Pct - marketReturn20Pct;
    const revenue = latestBefore(revenueBySymbol.get(cashflow.symbol) || [], day.date);
    const row = {
      symbol: stock.symbol,
      name: stock.name,
      market: stock.market,
      cashflow,
      revenue,
      history,
      eventIndex,
      averageTradeValue20,
      return20Pct,
      relativeMarket20Pct,
      variants: triggerVariants(history, eventIndex, context.marketByDate)
    };
    row.score = Math.min(50, Math.max(-20, cashflow.operatingCashFlowYoY || 0)) * 0.2
      - Math.min(10, Math.max(-10, cashflow.accrualRatio || 0)) * 1.5
      - Math.max(0, cashflow.debtRatioChangeYoY || 0) * 0.8
      + Math.min(20, Math.max(-10, relativeMarket20Pct))
      + Math.min(15, Math.max(-10, revenue?.YoY || 0)) * 0.25
      + (cashflow.operatingCashFlowTurnPositive ? 8 : 0);
    if (!setups.some(setup => setup.test(row))) continue;
    const list = events.get(cashflow.effectiveDate) || [];
    list.push(row);
    events.set(cashflow.effectiveDate, list);
  }
  return { events, stocks };
}

function candidate(row, variant, config, random = false) {
  return {
    signalDate: variant.signalDate,
    entryDate: variant.entryDate,
    symbol: row.symbol,
    name: row.name,
    market: row.market,
    regime: variant.regime,
    close: variant.close,
    score: random ? deterministicScore(`${variant.signalDate}|${row.symbol}|cashflow-random`) : row.score,
    entryGapRange: { minimumPct: -5, maximumPct: 4 },
    futureBars: row.history.slice(variant.historyIndex + 1, variant.historyIndex + config.holdingDays + 2).map(bar => ({
      date: bar.date, open: bar.open, high: bar.high, low: bar.low, close: bar.close, price: bar.close
    })),
    stopDistancePct: config.stopDistancePct,
    stopLossMode: 'close',
    rewardRisk: 0,
    maxHoldingDays: config.holdingDays,
    trailingStopRule: config.holdingDays === 40 ? { triggerPct: 10, lockPct: 2, givebackPct: 6 } : null,
    positionPct: Math.min(10, 70 / config.topN),
    accountRiskPct: 0.5,
    setup: random ? '相同日期與流動性限制的公平隨機個股' : config.setup.name,
    trigger: `${config.trigger} 訊號收盤確認後，下一交易日才允許成交`,
    invalidation: `收盤跌破 ${config.stopDistancePct}% 風險界線，下一交易日出場`,
    exitPlan: `最長 ${config.holdingDays} 交易日；40 日版本另有移動停利`,
    reason: random ? '公平隨機基準' : '現金流品質、財務穩健與價格確認同時成立',
    orderIntent: { action: 'BUY', orderType: 'MARKETABLE_LIMIT', timeInForce: 'DAY', earliestDate: variant.entryDate }
  };
}

function signalMap(events, config) {
  const grouped = new Map();
  for (const rows of events.values()) {
    for (const row of rows) {
      const variant = row.variants[config.trigger];
      if (!variant || !config.setup.test(row)) continue;
      if (config.marketMode === 'risk_on' && ['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(variant.regime)) continue;
      const list = grouped.get(variant.signalDate) || [];
      list.push({ row, variant });
      grouped.set(variant.signalDate, list);
    }
  }
  return new Map([...grouped].map(([date, rows]) => [date, rows
    .sort((left, right) => right.row.score - left.row.score)
    .slice(0, config.topN)
    .map(({ row, variant }) => candidate(row, variant, config))]));
}

function randomSignalMap(realMap, stocks, config) {
  const map = new Map();
  for (const [date, rows] of realMap) {
    const pool = [];
    for (const stockRow of stocks.values()) {
      const index = firstIndexOnOrAfter(stockRow.history, date);
      if (index < 120 || index + config.holdingDays + 2 >= stockRow.history.length) continue;
      const day = stockRow.history[index];
      const value20 = mean(stockRow.history.slice(index - 19, index + 1).map(row => row.close * row.volume));
      if (day.close < 5 || value20 < 30_000_000) continue;
      const variant = { signalDate: date, entryDate: stockRow.history[index + 1].date, historyIndex: index, close: day.close };
      pool.push({ row: { symbol: stockRow.stock.symbol, name: stockRow.stock.name, market: stockRow.stock.market, history: stockRow.history }, variant });
    }
    map.set(date, pool
      .sort((left, right) => deterministicScore(`${date}|${left.row.symbol}|random`) - deterministicScore(`${date}|${right.row.symbol}|random`))
      .slice(0, rows.length)
      .map(({ row, variant }) => candidate(row, variant, config, true)));
  }
  return map;
}

function run(context, map, config, startDate, endDate, suffix = '') {
  return simulateSignalMap(context, map, {
    strategyId: `${STRATEGY_ID}${suffix}`,
    startDate, endDate,
    initialCapital: INITIAL_CAPITAL,
    maxOpenPositions: config.topN,
    holdingDays: config.holdingDays,
    accountRiskPct: 0.5,
    riskRules: {
      maxAccountRiskPct: 0.5,
      maxSinglePositionPct: 10,
      exposureLimits: {
        BULL_TREND: 70, BULL_PULLBACK: 60, RANGE_BOUND: 40,
        THEME_MOMENTUM: 70, HIGH_VOLATILITY: 20, BEAR_DEFENSE: 10
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

function summarize(runs) {
  const monthly = runs.flatMap(row => row.summary.monthly);
  const trades = runs.flatMap(row => row.trades);
  const curve = runs.flatMap(row => row.equityCurve);
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
    averageMonthlyReturnPct: round(mean(monthly.map(row => row.equityReturnPct)) || 0),
    annualizedReturnPct: round((equity / INITIAL_CAPITAL) ** (12 / Math.max(1, monthly.length)) * 100 - 100),
    maximumDrawdownPct: round(maximumDrawdownPct),
    trades: trades.length,
    winRatePct: round(trades.filter(row => row.realizedPnl > 0).length / Math.max(1, trades.length) * 100),
    profitFactor: losses ? round(gains / losses) : null,
    concentrationPct: round(Math.max(0, ...symbols.values()) / Math.max(1, trades.length) * 100),
    negativeMonths: monthly.filter(row => row.equityReturnPct < 0).length
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
  return round(mean(returns) || 0);
}

async function writeMissing(validation, cashflowPayload) {
  const quarters = new Set((cashflowPayload.records || []).map(row => row.quarter));
  const report = {
    generatedAt: new Date().toISOString(),
    status: 'data_missing',
    validationStatus: validation?.status || 'MISSING',
    records: cashflowPayload.records?.length || 0,
    symbols: new Set((cashflowPayload.records || []).map(row => row.symbol)).size,
    quarters: quarters.size,
    requiredQuarters: 24,
    conclusion: '現金流歷史資料不足，尚無法執行可信的 54／18 個月 walk-forward；未產生績效。'
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 純個股現金流品質策略 v1\n\n${report.conclusion}\n\n- 目前：${report.symbols} 檔、${report.quarters} 季、${report.records} 筆。\n- 最低資料門檻：24 季。\n- 未通過前不可紙上交易、不可實盤。\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const [cashflowPayload, validation] = await Promise.all([
    readJson(CASHFLOW, { records: [] }),
    readJson(VALIDATION, null)
  ]);
  if (validation?.status !== 'VALID' || new Set((cashflowPayload.records || []).map(row => row.quarter)).size < 24) {
    await writeMissing(validation, cashflowPayload);
    return;
  }

  const identityInput = {
    strategyId: STRATEGY_ID,
    dataSources: ['純個股 OHLCV', 'MOPS 現金流量表', 'MOPS 資產負債表', 'MOPS 損益表', '月營收'],
    setupRules: setups.map(row => row.id),
    triggerRules: triggers,
    invalidationRules: ['收盤停損 8% 或 12%'],
    exitRules: ['20 或 40 交易日', '40 日版本移動停利'],
    riskRules: { accountRiskPct: 0.5, maxPositionPct: 10, tPlusTwo: true },
    blockedWhen: ['成交值不足', '跳空超過 4%', '高波動與空頭降低曝險'],
    parameters: { trainMonths: 54, validationMonths: 18, topN: [5, 10] },
    trainPeriod: 'rolling 54 months',
    validationPeriod: 'rolling 18 months',
    costModel: '真實手續費、交易稅與雙邊滑價',
    executionModel: '訊號收盤後下一交易日合理成交；T+2'
  };
  const identity = buildExperimentIdentity(identityInput);
  const registryDecision = shouldSkipExperiment(await loadRegistry(), identity, {
    ...identityInput,
    newDataSources: ['MOPS 現金流與資產負債歷史資料'],
    coreRulesChanged: true
  });
  if (registryDecision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...registryDecision, ...identity }, null, 2));
    return;
  }

  const [context, revenuePayload, etfHistory] = await Promise.all([
    loadResearchContext(),
    readJson(REVENUE, { records: [] }),
    readJson(ETF_HISTORY, { series: {} })
  ]);
  const { events, stocks } = buildEvents(context, cashflowPayload.records, revenuePayload.records || []);
  const configs = configurations();
  const validationRuns = [];
  const randomRuns = [];
  const folds = [];
  for (const fold of foldWindows(context.startDate, context.endDate, 54, 18)) {
    const trained = configs.map(config => ({
      config,
      result: run(context, signalMap(events, config), config, fold.trainStart, fold.trainEnd)
    })).filter(row => row.result.summary.trades >= 30 && row.result.summary.maximumDrawdownPct >= -25)
      .sort((left, right) => right.result.summary.averageMonthlyEquityReturnPct
        - left.result.summary.averageMonthlyEquityReturnPct)[0];
    if (!trained) {
      folds.push({ ...fold, status: '訓練樣本不足' });
      continue;
    }
    const realMap = signalMap(events, trained.config);
    const validationRun = run(context, realMap, trained.config, fold.validationStart, fold.validationEnd);
    const randomRun = run(context, randomSignalMap(realMap, stocks, trained.config), trained.config, fold.validationStart, fold.validationEnd, '_random');
    validationRuns.push(validationRun);
    randomRuns.push(randomRun);
    folds.push({
      ...fold,
      status: '完成',
      selected: {
        setup: trained.config.setup.id,
        trigger: trained.config.trigger,
        holdingDays: trained.config.holdingDays,
        topN: trained.config.topN,
        stopDistancePct: trained.config.stopDistancePct,
        marketMode: trained.config.marketMode
      },
      train: trained.result.summary,
      validation: validationRun.summary
    });
  }
  const metrics = summarize(validationRuns);
  const fairRandom = summarize(randomRuns);
  const completedFolds = folds.filter(row => row.status === '完成');
  const validationStart = completedFolds[0]?.validationStart;
  const validationEnd = completedFolds.at(-1)?.validationEnd;
  const benchmark0050 = benchmark(etfHistory.series?.['0050.TW'] || [], validationStart, validationEnd);
  const checks = {
    target5Pct: metrics.averageMonthlyReturnPct >= TARGET_MONTHLY_RETURN_PCT,
    trades: metrics.trades > 300,
    beats0050: metrics.averageMonthlyReturnPct > benchmark0050,
    beatsRandom: metrics.averageMonthlyReturnPct > fairRandom.averageMonthlyReturnPct,
    profitFactor: metrics.profitFactor > 1.15,
    drawdown: metrics.maximumDrawdownPct > -20,
    diversified: metrics.concentrationPct < 20
  };
  const passed = Object.values(checks).every(Boolean);
  const report = {
    generatedAt: new Date().toISOString(),
    ...identity,
    strategyFamilies: setups.map(row => ({ id: row.id, name: row.name })),
    testedConfigurations: configs.length,
    trainingMonthsPerFold: 54,
    validationMonthsPerFold: 18,
    validationPeriod: { start: validationStart, end: validationEnd },
    folds,
    metrics,
    benchmark0050: { averageMonthlyReturnPct: benchmark0050 },
    fairRandom,
    checks,
    targetMonthlyReturnPct: TARGET_MONTHLY_RETURN_PCT,
    gapToTargetPct: round(TARGET_MONTHLY_RETURN_PCT - metrics.averageMonthlyReturnPct),
    passed,
    paperTradingReady: passed,
    liveTradingReady: false,
    conclusion: passed
      ? '通過最低候選門檻，但仍只能進入紙上交易。'
      : '找不到達到可信月均 5% 且通過完整 validation 的純個股現金流品質策略。'
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 純個股現金流品質策略 v1\n\n${report.conclusion}\n\n| 驗證區間 | 交易數 | 月均 | 0050 月均 | PF | 最大回撤 | 勝率 |\n|---|---:|---:|---:|---:|---:|---:|\n| ${validationStart} 至 ${validationEnd} | ${metrics.trades} | ${metrics.averageMonthlyReturnPct}% | ${benchmark0050}% | ${metrics.profitFactor} | ${metrics.maximumDrawdownPct}% | ${metrics.winRatePct}% |\n\n- 測試 ${setups.length} 個新家族、${configs.length} 組設定。\n- 使用 MOPS 現金流、資產負債與損益資料，採保守法定期限後下一交易日。\n- 0050 僅作基準，交易標的是四碼台股個股。\n`, 'utf8');
  await appendExperiment({
    ...identity,
    strategyId: STRATEGY_ID,
    dataSources: identityInput.dataSources,
    parameters: identityInput.parameters,
    validationMetrics: metrics,
    status: passed ? 'passed' : 'failed',
    passed,
    failureReasons: Object.entries(checks).filter(([, value]) => !value).map(([key]) => key),
    recommendRetest: false,
    notes: report.conclusion
  });
  console.log(JSON.stringify({ metrics, benchmark0050, fairRandom, checks, conclusion: report.conclusion }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
