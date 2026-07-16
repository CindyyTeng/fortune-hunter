import fs from 'node:fs/promises';
import {
  deterministicScore,
  foldWindows,
  hasHistoricalPriceAnomaly,
  loadResearchContext,
  round,
  simulateSignalMap
} from './research-core.mjs';
import { buildExperimentIdentity, loadRegistry, shouldSkipExperiment } from './strategy-experiment-registry.mjs';

const EPS_INPUT = new URL('../../data/quality/eps-history-2015.json', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-earnings-quality-momentum-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_EARNINGS_QUALITY_MOMENTUM_V1.md', import.meta.url);
const STRATEGY_ID = 'stock_earnings_quality_momentum_v1';
const CAPITAL = 1_000_000;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const pct = (value, base) => base ? (value / base - 1) * 100 : 0;
const compact = summary => {
  const { monthly, ...metrics } = summary;
  return metrics;
};

function standardDeviation(values) {
  const average = mean(values);
  return Math.sqrt(mean(values.map(value => (value - average) ** 2)));
}

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
  const modes = [
    ['balanced', { yield: 0.3, growth: 0.2, latest: 0.1, momentum: 0.25, stability: 0.15 }],
    ['value_momentum', { yield: 0.4, growth: 0.1, latest: 0.05, momentum: 0.35, stability: 0.1 }],
    ['growth_momentum', { yield: 0.1, growth: 0.3, latest: 0.2, momentum: 0.3, stability: 0.1 }],
    ['quality_value', { yield: 0.35, growth: 0.1, latest: 0.05, momentum: 0.1, stability: 0.4 }],
    ['quality_momentum', { yield: 0.15, growth: 0.1, latest: 0.1, momentum: 0.35, stability: 0.3 }]
  ];
  const rows = [];
  for (const [scoreMode, weights] of modes) {
    for (const marketMode of ['risk_on', 'non_crash']) {
      for (const topN of [5, 10]) {
        for (const holdingDays of [20, 60]) rows.push({ scoreMode, weights, marketMode, topN, holdingDays });
      }
    }
  }
  return rows;
}

function recordGroups(records) {
  const groups = new Map();
  for (const row of records.filter(item => item.isPointInTimeSafe && item.effectiveDate && Number.isFinite(item.EPS))) {
    const list = groups.get(row.symbol) || [];
    list.push(row);
    groups.set(row.symbol, list);
  }
  for (const list of groups.values()) list.sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate));
  return groups;
}

function rawRows(context, epsRecords) {
  const groups = recordGroups(epsRecords);
  const dateOrder = new Map(context.marketHistory.map((row, index) => [row.date, index]));
  const rows = [];
  for (const { stock, history } of context.ohlcv.stocks) {
    if (!/^\d{4}$/.test(stock.symbol) || Number(stock.symbol) < 1000) continue;
    const records = groups.get(stock.symbol);
    if (!records?.length) continue;
    const returns = history.map((day, index) => index ? day.close / history[index - 1].close - 1 : 0);
    let cursor = -1;
    for (let index = 130; index + 61 < history.length; index += 1) {
      const day = history[index];
      while (cursor + 1 < records.length && records[cursor + 1].effectiveDate <= day.date) cursor += 1;
      const order = dateOrder.get(day.date);
      if (order === undefined || order % 20 !== 0 || cursor < 7) continue;
      if (hasHistoricalPriceAnomaly(returns, index)) continue;
      const recent = records.slice(cursor - 3, cursor + 1);
      const prior = records.slice(cursor - 7, cursor - 3);
      const ttmEps = recent.reduce((sum, row) => sum + row.EPS, 0);
      const priorTtm = prior.reduce((sum, row) => sum + row.EPS, 0);
      if (ttmEps <= 0 || priorTtm <= 0) continue;
      const averageTradeValue20 = mean(history.slice(index - 19, index + 1).map(row => row.close * row.volume));
      if (day.close < 10 || averageTradeValue20 < 30_000_000) continue;
      const market = context.marketByDate.get(day.date);
      if (!market) continue;
      const earningsYield = ttmEps / day.close * 100;
      const ttmGrowth = pct(ttmEps, priorTtm);
      const latestGrowth = prior[3].EPS > 0 ? pct(recent[3].EPS, prior[3].EPS) : -100;
      const earningsStability = Math.max(0, 1 - standardDeviation(recent.map(row => row.EPS)) / Math.max(0.01, Math.abs(mean(recent.map(row => row.EPS)))));
      const momentum60 = pct(day.close, history[index - 60].close);
      const momentum120 = pct(day.close, history[index - 120].close);
      const trueRanges = history.slice(index - 13, index + 1).map((row, offset) => {
        const previous = history[index - 14 + offset];
        return Math.max(row.high - row.low, Math.abs(row.high - previous.close), Math.abs(row.low - previous.close));
      });
      if (earningsYield <= 0 || earningsYield > 25 || ttmGrowth < -50 || ttmGrowth > 300) continue;
      rows.push({
        stock,
        history,
        index,
        date: day.date,
        entryDate: history[index + 1].date,
        day,
        market,
        earningsYield,
        ttmGrowth,
        latestGrowth: Math.max(-100, Math.min(300, latestGrowth)),
        earningsStability,
        positiveQuarterRatio: recent.filter(row => row.EPS > 0).length / 4,
        momentum60,
        momentum120,
        atrPct: mean(trueRanges) / day.close * 100,
        latestQuarter: recent[3].quarter
      });
    }
  }
  return rows;
}

function assignPercentiles(rows) {
  const byDate = new Map();
  for (const row of rows) {
    const list = byDate.get(row.date) || [];
    list.push(row);
    byDate.set(row.date, list);
  }
  for (const list of byDate.values()) {
    for (const key of ['earningsYield', 'ttmGrowth', 'latestGrowth', 'earningsStability', 'momentum60', 'momentum120']) {
      [...list].sort((left, right) => left[key] - right[key]).forEach((row, index) => {
        row[`${key}Rank`] = (index + 1) / list.length;
      });
    }
  }
  return byDate;
}

function allowed(row, config) {
  const marketAllowed = config.marketMode === 'risk_on'
    ? row.market.close > row.market.ma60 && ['BULL_TREND', 'THEME_MOMENTUM', 'BULL_PULLBACK'].includes(row.market.regime)
    : !['HIGH_VOLATILITY', 'BEAR_DEFENSE'].includes(row.market.regime);
  return marketAllowed
    && row.positiveQuarterRatio >= 0.75
    && row.atrPct >= 1
    && row.atrPct <= 7
    && row.momentum60 > -10
    && row.momentum120 > -15;
}

function alphaScore(row, config) {
  const momentumRank = (row.momentum60Rank + row.momentum120Rank) / 2;
  return row.earningsYieldRank * config.weights.yield
    + row.ttmGrowthRank * config.weights.growth
    + row.latestGrowthRank * config.weights.latest
    + momentumRank * config.weights.momentum
    + row.earningsStabilityRank * config.weights.stability;
}

function buildMap(byDate, config, random = false) {
  const map = new Map();
  for (const [date, rows] of byDate) {
    const eligible = rows.filter(row => allowed(row, config));
    const selected = [...eligible].sort((left, right) => random
      ? deterministicScore(`${date}|${left.stock.symbol}|quality`) - deterministicScore(`${date}|${right.stock.symbol}|quality`)
      : alphaScore(right, config) - alphaScore(left, config)).slice(0, config.topN);
    if (!selected.length) continue;
    map.set(date, selected.map(row => ({
      signalDate: date,
      entryDate: row.entryDate,
      symbol: row.stock.symbol,
      name: row.stock.name,
      market: row.stock.market,
      regime: row.market.regime,
      score: random ? deterministicScore(`${date}|${row.stock.symbol}|fair`) : alphaScore(row, config),
      entryMode: 'next_open_market',
      close: row.day.close,
      entryGapRange: { minimumPct: -5, maximumPct: 4 },
      stopDistancePct: 10,
      stopLossMode: 'close',
      rewardRisk: 0,
      maxHoldingDays: config.holdingDays,
      trailingStopRule: config.holdingDays === 60 ? { triggerPct: 15, lockPct: 3, givebackPct: 8 } : null,
      positionPct: config.topN === 5 ? 15 : 8,
      accountRiskPct: 0.75,
      futureBars: row.history.slice(row.index + 1, row.index + config.holdingDays + 2).map(bar => ({
        date: bar.date, open: bar.open, high: bar.high, low: bar.low, close: bar.close, price: bar.close
      })),
      setup: `${config.scoreMode}：TTM 殖利率 ${round(row.earningsYield)}%、成長 ${round(row.ttmGrowth)}%、60 日動能 ${round(row.momentum60)}%`,
      trigger: `財報 ${row.latestQuarter} 已於 effectiveDate 生效，月度排名後隔日開盤進場`,
      invalidation: '收盤跌破進場價 10%，次日開盤退出',
      exitPlan: `最多持有 ${config.holdingDays} 日${config.holdingDays === 60 ? '，搭配移動停利' : ''}`,
      reason: random ? '同日品質可交易池公平隨機' : 'TTM 盈餘殖利率、EPS 成長品質與價格強度橫斷面排名',
      orderIntent: { action: 'BUY', orderType: 'MARKET', timeInForce: 'DAY', earliestDate: row.entryDate }
    })));
  }
  return map;
}

function run(context, byDate, config, startDate, endDate, random = false) {
  return simulateSignalMap(context, buildMap(byDate, config, random), {
    strategyId: `${STRATEGY_ID}${random ? '_random' : ''}`,
    startDate,
    endDate,
    initialCapital: CAPITAL,
    maxOpenPositions: config.topN,
    accountRiskPct: 0.75,
    riskRules: {
      maxAccountRiskPct: 0.75,
      maxSinglePositionPct: 15,
      exposureLimits: { BULL_TREND: 75, THEME_MOMENTUM: 75, BULL_PULLBACK: 60, RANGE_BOUND: 35, HIGH_VOLATILITY: 0, BEAR_DEFENSE: 0 },
      drawdownBlockPct: 8,
      drawdownBlockDays: 20,
      monthlyLossBlockPct: 5,
      dailyLossBlockPct: 2,
      losingStreakCount: 5,
      losingStreakBlockDays: 10
    }
  });
}

function aggregate(runs) {
  const monthly = runs.flatMap(row => row.summary.monthly);
  const trades = runs.flatMap(row => row.trades);
  const curve = runs.flatMap(row => row.equityCurve);
  let equity = CAPITAL;
  let peak = CAPITAL;
  let drawdown = 0;
  for (const row of curve) {
    equity *= 1 + (row.dailyReturnPct || 0) / 100;
    peak = Math.max(peak, equity);
    drawdown = Math.min(drawdown, pct(equity, peak));
  }
  const gains = trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(trades.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
  const symbols = new Map();
  for (const trade of trades) symbols.set(trade.symbol, (symbols.get(trade.symbol) || 0) + 1);
  return {
    months: monthly.length,
    averageMonthlyReturnPct: round(mean(monthly.map(row => row.equityReturnPct))),
    annualizedReturnPct: round(((equity / CAPITAL) ** (12 / Math.max(1, monthly.length)) - 1) * 100),
    maximumDrawdownPct: round(drawdown),
    trades: trades.length,
    winRatePct: round(trades.filter(row => row.realizedPnl > 0).length / Math.max(1, trades.length) * 100),
    profitFactor: losses ? round(gains / losses) : null,
    concentrationPct: round(Math.max(0, ...symbols.values()) / Math.max(1, trades.length) * 100),
    averageExposurePct: round(mean(curve.map(row => row.exposurePct || 0)))
  };
}

function benchmark(series, startDate, endDate) {
  const rows = series.filter(row => row.date >= startDate && row.date <= endDate);
  const ends = new Map(rows.map(row => [row.date.slice(0, 7), row.close]));
  let prior = [...series].reverse().find(row => row.date < startDate)?.close || rows[0]?.close;
  const returns = [];
  for (const close of ends.values()) {
    returns.push(pct(close, prior));
    prior = close;
  }
  return { averageMonthlyReturnPct: round(mean(returns)) };
}

async function main() {
  const configs = configurations();
  const identityInput = {
    strategyId: STRATEGY_ID,
    dataSources: ['2015 起季度 EPS point-in-time', '個股 OHLCV', '市場狀態'],
    setupRules: ['TTM 盈餘殖利率、EPS 成長、獲利穩定性與 60／120 日動能橫斷面排名'],
    triggerRules: ['每月收盤排名，隔日開盤成交；跳空超出 -5%～4% 放棄'],
    invalidationRules: ['收盤 10% 停損，次日開盤退出'],
    exitRules: ['20／60 日持有與移動停利'],
    riskRules: { accountRiskPct: 0.75, maximumPositionPct: 15, tPlusTwo: true },
    blockedWhen: ['空頭／高波動市場', '成交值不足', 'ATR 過高'],
    parameters: { trainMonths: 54, validationMonths: 18, configs },
    trainPeriod: 'rolling 54 months',
    validationPeriod: 'rolling 18 months',
    costModel: '共用成交模擬器：手續費、交易稅、滑價',
    executionModel: '隔日開盤、跳空過濾、收盤停損次日退出、T+2'
  };
  const identity = buildExperimentIdentity(identityInput);
  const decision = shouldSkipExperiment(await loadRegistry(), identity, { ...identityInput, newDataSources: ['TTM EPS 品質價值橫斷面'], coreRulesChanged: true });
  if (decision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...decision, ...identity }, null, 2));
    return;
  }
  const [context, epsPayload, etf] = await Promise.all([
    loadResearchContext(),
    fs.readFile(EPS_INPUT, 'utf8').then(JSON.parse),
    fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)
  ]);
  const rows = rawRows(context, epsPayload.records || []);
  const byDate = assignPercentiles(rows);
  const validations = [];
  const randoms = [];
  const folds = [];
  for (const fold of foldWindows(context.startDate, context.endDate, 54, 18)) {
    const trained = [];
    for (const config of configs) {
      const result = run(context, byDate, config, fold.trainStart, fold.trainEnd);
      if (result.trades.length < 80 || result.summary.profitFactor < 1 || result.summary.maximumDrawdownPct < -25) continue;
      const segments = [0, 18, 36].map(offset => run(context, byDate, config, `${shiftMonth(fold.trainStart, offset)}-01`, dayBeforeMonth(shiftMonth(fold.trainStart, offset + 18))));
      if (segments.some(segment => segment.trades.length < 15)) continue;
      const returns = segments.map(segment => segment.summary.averageMonthlyEquityReturnPct).sort((a, b) => a - b);
      trained.push({
        config,
        result,
        score: result.summary.averageMonthlyEquityReturnPct * 0.35 + returns[1] * 0.8 + returns[0] + result.summary.maximumDrawdownPct * 0.12
      });
    }
    const selected = trained.sort((left, right) => right.score - left.score)[0];
    if (!selected) {
      folds.push({ ...fold, status: '訓練證據不足，持有現金' });
      continue;
    }
    const validation = run(context, byDate, selected.config, fold.validationStart, fold.validationEnd);
    const random = run(context, byDate, selected.config, fold.validationStart, fold.validationEnd, true);
    validations.push(validation);
    randoms.push(random);
    folds.push({ ...fold, status: '已驗證', selectedConfig: selected.config, train: compact(selected.result.summary), validation: compact(validation.summary) });
    console.log(`${fold.validationStart}–${fold.validationEnd}：${validation.trades.length} 筆，月均 ${validation.summary.averageMonthlyEquityReturnPct}%`);
  }
  const metrics = aggregate(validations);
  const fairRandom = aggregate(randoms);
  const validationStart = folds.find(row => row.status === '已驗證')?.validationStart;
  const validationEnd = folds.filter(row => row.status === '已驗證').at(-1)?.validationEnd;
  const benchmark0050 = benchmark(etf.series['0050.TW'] || [], validationStart, validationEnd);
  const targetMet = metrics.averageMonthlyReturnPct >= 5
    && metrics.maximumDrawdownPct >= -20
    && metrics.trades >= 300
    && metrics.profitFactor > 1.15
    && metrics.averageMonthlyReturnPct > fairRandom.averageMonthlyReturnPct
    && metrics.averageMonthlyReturnPct > benchmark0050.averageMonthlyReturnPct;
  const output = {
    generatedAt: new Date().toISOString(),
    ...identity,
    universe: '純台股普通股；ETF／0050 交易占比 0%，0050 僅作比較',
    pointInTimeRecords: epsPayload.records?.length || 0,
    observations: rows.length,
    configurationsTested: configs.length,
    validationPeriod: `${validationStart || '無'}–${validationEnd || '無'}`,
    folds,
    metrics,
    fairRandom,
    benchmark0050,
    targetMonthlyReturnPct: 5,
    gapToTargetPct: round(5 - metrics.averageMonthlyReturnPct),
    targetMet,
    paperTradingReady: false,
    liveTradingReady: false,
    conclusion: targetMet
      ? '達到研究候選門檻，但仍須先紙上交易。'
      : `找不到月均 5% 的可實盤純個股 EPS 品質動能策略；目前 ${metrics.averageMonthlyReturnPct}%。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, [
    '# 純個股 EPS 品質價值動能研究', '',
    `- 驗證：${output.validationPeriod}`,
    `- 月均：${metrics.averageMonthlyReturnPct}%；年化：${metrics.annualizedReturnPct}%；最大回撤：${metrics.maximumDrawdownPct}%`,
    `- 交易：${metrics.trades}；勝率：${metrics.winRatePct}%；PF：${metrics.profitFactor}`,
    `- 公平隨機：${fairRandom.averageMonthlyReturnPct}%；0050：${benchmark0050.averageMonthlyReturnPct}%`,
    `- 結論：${output.conclusion}`, '',
    '每次排名只使用訊號日以前已生效的八季 EPS；0050 不進入交易池。'
  ].join('\n') + '\n', 'utf8');
  console.log(JSON.stringify({ validationPeriod: output.validationPeriod, observations: rows.length, metrics, fairRandom, benchmark0050, targetMet, conclusion: output.conclusion }, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
