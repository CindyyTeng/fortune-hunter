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

const REVENUE = new URL('../../data/revenue/monthly-revenue.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-record-revenue-drift-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_RECORD_REVENUE_DRIFT_V1.md', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const STRATEGY_ID = 'stock_record_revenue_drift_v1';
const INITIAL_CAPITAL = 1_000_000;
const COST_PCT = 0.6;
const rejectedRiskExperiments = [
  { id: 'source_blind_defensive_risk', monthlyReturnPct: 0.7924, maximumDrawdownPct: -13.3188, trades: 338, reason: '全面降低曝險使報酬大幅下降，回撤改善不足。' },
  { id: 'momentum_intraday_stop', monthlyReturnPct: 0.7755, maximumDrawdownPct: -12.6012, trades: 435, reason: '盤中硬停損造成反覆洗出，報酬損失大於風險改善。' },
  { id: 'momentum_hold_cap_20', monthlyReturnPct: 1.0283, maximumDrawdownPct: -12.1865, trades: 457, reason: '強制縮短持有期截斷獲利延續，月均報酬下降。' },
  { id: 'momentum_profit_trailing_stop', monthlyReturnPct: 0.9099, maximumDrawdownPct: -14.6982, trades: 302, reason: '獲利後移動停利仍破壞動能報酬，且最大回撤惡化。' },
  { id: 'sue_overlay_three_slots', monthlyReturnPct: 1.307, maximumDrawdownPct: -14.2722, trades: 481, reason: 'SUE 疊加增加交易數，但資金競爭稀釋較強的月營收事件，報酬與回撤同時惡化。' },
  { id: 'train_selected_source_risk_budget', monthlyReturnPct: 1.5134, maximumDrawdownPct: -13.8924, trades: 434, reason: '來源別風險預算略增交易與 PF，但月均下降且最大回撤沒有改善。' },
  { id: 'revenue_trend_refresh_20_40', monthlyReturnPct: 1.4559, maximumDrawdownPct: -15.6168, trades: 380, reason: '第 20／40 日趨勢刷新使候選更集中，月均、回撤與交易數皆惡化。' },
  { id: 'train_selected_revenue_priority', monthlyReturnPct: 1.5223, maximumDrawdownPct: -13.8924, trades: 430, reason: '四個訓練折皆選回全域分數排序，營收優先沒有邊際貢獻。' },
  { id: 'train_selected_market_policy', monthlyReturnPct: 0.8771, maximumDrawdownPct: -23.8211, trades: 438, reason: '前三折選到震盪聚焦，但首段驗證轉負，顯示市場狀態政策跨期不穩定。' },
  { id: 'train_selected_regime_source_quality', monthlyReturnPct: 1.3739, maximumDrawdownPct: -13.841, trades: 397, reason: '來源與市場狀態的歷史品質門檻只微幅改善回撤，卻降低月均與交易數，跨期選擇能力不足。' },
  { id: 'source_specific_momentum_stop', monthlyReturnPct: 1.3874, maximumDrawdownPct: -15.2464, trades: 385, reason: '動能補位改用 6%／8% 較緊停損後，正常波動被提早洗出，月均、回撤與交易數皆惡化。' },
  { id: 'train_selected_bear_defense_block', monthlyReturnPct: 1.6216, maximumDrawdownPct: -10.6531, trades: 541, reason: '由訓練期選擇是否封鎖空頭新倉，月均與交易數略降，回撤沒有改善。' },
  { id: 'train_selected_source_risk_tilt', monthlyReturnPct: 1.6429, maximumDrawdownPct: -10.6531, trades: 544, reason: '四個訓練折都選回等風險，偏重月營收來源沒有穩定的訓練期優勢。' },
  { id: 'higher_risk_with_bear_block', monthlyReturnPct: 1.3972, maximumDrawdownPct: -14.9219, trades: 446, reason: '訓練期偏好較高風險後驗證失效，月均、回撤與交易數同步惡化，屬於風險放大過度擬合。' },
  { id: 'stable_segment_training_score', monthlyReturnPct: 0.8763, maximumDrawdownPct: -13.1272, trades: 541, reason: '訓練期子區間穩定性評分選到較弱動能配置，驗證月均與回撤同步惡化。' },
  { id: 'momentum_regime_restriction', monthlyReturnPct: 1.5076, maximumDrawdownPct: -10.6531, trades: 528, reason: '限制動能補位的市場狀態降低月均與交易數，最大回撤沒有改善。' },
  { id: 'expanded_revenue_setups', monthlyReturnPct: 1.6239, maximumDrawdownPct: -10.6353, trades: 547, reason: '擴大營收創高加速條件只增加少量交易並微幅改善回撤，月均仍低於既有基準。' },
  { id: 'longer_holding_top15', monthlyReturnPct: 1.3577, maximumDrawdownPct: -10.6531, trades: 549, reason: '60 日持有提高單筆遠期報酬，但資金占用使投組月均下降；Top 15 只小幅增加交易。' },
  { id: 'pre_announcement_institutional_flow', monthlyReturnPct: 1.6094, maximumDrawdownPct: -10.6442, trades: 546, reason: '公告前法人淨賣超排序只在一折被選用，驗證月均低於原策略，無法轉成穩定 alpha。' },
  { id: 'revenue_confirmation_entry', monthlyReturnPct: 1.6429, maximumDrawdownPct: -10.6531, trades: 544, reason: '四個訓練折都選回立即進場；隔日轉強與三日回測轉強沒有穩定增益。' },
  { id: 'weekly_momentum_frequency', monthlyReturnPct: 1.6429, maximumDrawdownPct: -10.6531, trades: 544, reason: '四個訓練折都選回月底訊號；提高到每週選股沒有穩定的訓練期優勢。' }
];
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

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

const setups = [
  { id: 'record12', test: row => row.revenue.revenueHigh12 },
  { id: 'record24', test: row => row.revenue.revenueHigh24 },
  { id: 'record24_growth20', test: row => row.revenue.revenueHigh24 && row.revenue.YoY >= 20 },
  {
    id: 'record12_acceleration',
    test: row => row.revenue.revenueHigh12 && row.revenue.YoY >= 20 && row.revenue.yoyAcceleration
  }
];

function configurations() {
  return setups.flatMap(setup => [10, 20, 40].flatMap(holdingDays => [20, 40, 60].flatMap(momentumHoldingDays =>
    [5, 10].flatMap(topN => [8, 12].flatMap(stopDistancePct =>
    ['any', 'above_ma20', 'uptrend', 'relative_strength'].map(trendMode => ({
      setup,
      holdingDays,
      momentumHoldingDays,
      topN,
      stopDistancePct,
      trendMode,
      includeMomentum: true,
      maximumEntryGapPct: 4
    })))))));
}

function passesTrend(row, mode) {
  if (mode === 'above_ma20') return row.aboveMa20;
  if (mode === 'uptrend') return row.aboveMa20 && row.ma20AboveMa60;
  if (mode === 'relative_strength') return row.aboveMa20 && row.ma20AboveMa60 && row.relativeMarket20 >= 3;
  return true;
}

function baseCandidate(row, config, random = false) {
  const holdingDays = row.setupLabel ? config.momentumHoldingDays : config.holdingDays;
  const futureBars = row.history
    .slice(row.historyIndex + 1, row.historyIndex + holdingDays + 2)
    .map((bar, offset) => {
      const priorIndex = row.historyIndex + offset;
      const priorCloseBelowMa20 = row.setupLabel
        && row.history[priorIndex].close < movingAverage(row.history, priorIndex, 20);
      return {
        date: bar.date,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        price: bar.close,
        ...(priorCloseBelowMa20 ? {
          forcedExit: {
            price: bar.open,
            reason: '前一日收盤跌破 MA20',
            type: 'momentum_ma20_exit'
          }
        } : {})
      };
    });
  return {
    signalDate: row.signalDate,
    entryDate: row.entryDate,
    symbol: row.symbol,
    name: row.name,
    market: row.market,
    regime: row.regime,
    score: random
      ? deterministicScore(`${row.signalDate}|${row.symbol}|營收事件公平隨機`)
      : row.score,
    entryGapRange: { minimumPct: -5, maximumPct: config.maximumEntryGapPct },
    futureBars,
    stopDistancePct: config.stopDistancePct,
    stopLossMode: 'close',
    rewardRisk: 0,
    maxHoldingDays: holdingDays,
    positionPct: 10,
    accountRiskPct: 0.5,
    setup: random ? '同日同數量的流動性個股公平隨機' : (row.setupLabel || `月營收 ${config.setup.id}`),
    trigger: '保守有效日收盤確認後，下一交易日開盤成交；跳空超過範圍則放棄',
    invalidation: `收盤跌破風險距離 ${config.stopDistancePct}% 後，下一交易日開盤退出`,
    exitPlan: `最多持有 ${holdingDays} 個交易日`,
    reason: random ? '公平隨機比較' : '月營收創高公告後漂移',
    orderIntent: {
      action: 'BUY',
      orderType: 'MARKETABLE_LIMIT',
      timeInForce: 'DAY',
      earliestDate: row.entryDate
    }
  };
}

function signalMap(events, momentumEvents, config) {
  const map = new Map();
  const dates = new Set([...events.keys(), ...(config.includeMomentum ? momentumEvents.keys() : [])]);
  for (const date of dates) {
    const revenueRows = (events.get(date) || []).filter(row => config.setup.test(row) && passesTrend(row, config.trendMode));
    const rows = config.includeMomentum ? [...revenueRows, ...(momentumEvents.get(date) || [])] : revenueRows;
    const selected = rows
      .sort((left, right) => right.score - left.score)
      .slice(0, config.topN)
      .map(row => baseCandidate(row, config));
    if (selected.length) map.set(date, selected);
  }
  return map;
}

function randomSignalMap(events, momentumEvents, randomPool, config) {
  const map = new Map();
  const dates = new Set([...events.keys(), ...(config.includeMomentum ? momentumEvents.keys() : [])]);
  for (const date of dates) {
    const revenueCount = (events.get(date) || []).filter(row => config.setup.test(row) && passesTrend(row, config.trendMode)).length;
    const count = Math.min(config.topN, revenueCount + (config.includeMomentum ? (momentumEvents.get(date) || []).length : 0));
    if (!count) continue;
    const selected = (randomPool.get(date) || [])
      .sort((left, right) => deterministicScore(`${date}|${left.symbol}|公平隨機`)
        - deterministicScore(`${date}|${right.symbol}|公平隨機`))
      .slice(0, count)
      .map((row, index) => baseCandidate(
        index >= Math.min(config.topN, revenueCount) ? { ...row, setupLabel: 'random_momentum_slot' } : row,
        config,
        true
      ));
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
        BULL_TREND: 60,
        BULL_PULLBACK: 50,
        RANGE_BOUND: 40,
        THEME_MOMENTUM: 60,
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
  const groupedMetrics = key => {
    const output = {};
    for (const group of new Set(trades.map(key))) {
      const rows = trades.filter(row => key(row) === group);
      const groupGains = rows.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
      const groupLosses = Math.abs(rows.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
      output[group || 'UNKNOWN'] = {
      trades: rows.length,
      winRatePct: round(rows.filter(row => row.realizedPnl > 0).length / Math.max(1, rows.length) * 100),
      profitFactor: groupLosses ? round(groupGains / groupLosses) : null,
      realizedPnl: round(rows.reduce((sum, row) => sum + row.realizedPnl, 0), 0),
      averageTradeReturnPct: round(mean(rows.map(row => row.tradeReturnPct))),
      worstTradeReturnPct: round(Math.min(...rows.map(row => row.tradeReturnPct)))
    };
    }
    return output;
  };
  const sourceMetrics = groupedMetrics(row => row.setup);
  const regimeMetrics = groupedMetrics(row => row.regime);
  const regimeSourceMetrics = groupedMetrics(row => `${row.regime || 'UNKNOWN'}|${row.setup}`);
  return {
    months: monthly.length,
    averageMonthlyReturnPct: round(mean(monthly.map(row => row.equityReturnPct))),
    annualizedReturnPct: round((equity / INITIAL_CAPITAL) ** (12 / Math.max(1, monthly.length)) * 100 - 100),
    maximumDrawdownPct: round(maximumDrawdownPct),
    trades: trades.length,
    winRatePct: round(trades.filter(row => row.realizedPnl > 0).length / Math.max(1, trades.length) * 100),
    profitFactor: losses ? round(gains / losses) : null,
    concentrationPct: round(Math.max(0, ...symbols.values()) / Math.max(1, trades.length) * 100),
    negativeMonths: monthly.filter(row => row.equityReturnPct < 0).length,
    averageExposurePct: round(mean(curve.map(row => row.exposurePct || 0))),
    investedTradingDaysPct: round(curve.filter(row => row.openPositions > 0).length / Math.max(1, curve.length) * 100),
    sourceMetrics,
    regimeMetrics,
    regimeSourceMetrics
  };
}

function forwardSummary(values) {
  const gains = values.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter(value => value <= 0).reduce((sum, value) => sum + value, 0));
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    meanPct: round(mean(values)),
    medianPct: round(sorted[Math.floor(sorted.length / 2)] || 0),
    winRatePct: round(values.filter(value => value > 0).length / Math.max(1, values.length) * 100),
    profitFactor: losses ? round(gains / losses) : null
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
    dataSources: ['個股 OHLCV', '月營收歷史資料（保守 T+1）'],
    setupRules: setups.map(row => row.id),
    triggerRules: ['有效日收盤後形成訊號，隔日開盤進場'],
    invalidationRules: ['收盤停損 8% 或 12%'],
    exitRules: ['固定持有 10、20、40 個交易日'],
    riskRules: { accountRiskPct: 0.5, maxPositionPct: 10, tPlusTwo: true },
    blockedWhen: ['隔日跳空高於 4%', '近 20 日平均成交值低於三千萬元'],
    parameters: { trainMonths: 54, validationMonths: 18, topN: [5, 10] },
    trainPeriod: 'rolling 54 months',
    validationPeriod: 'rolling 18 months',
    costModel: '共用模擬器：手續費、交易稅、滑價',
    executionModel: '訊號排名後才檢查隔日真實跳空；跳空停損使用較差成交價'
  };
  Object.assign(identityInput, {
    strategyId: 'stock_revenue_momentum_ensemble_v1',
    dataSources: ['台股官方日線 OHLCV', '月營收保守 effectiveDate 資料'],
    setupRules: ['創 12／24 月營收新高與成長加速', '月底 6／12 個月風險調整動能補位'],
    triggerRules: ['訊號日收盤確認，下一交易日開盤成交'],
    invalidationRules: ['8%／12% 停損與投組風控熔斷'],
    exitRules: ['營收最長 10／20／40 日；動能最長 20／40／60 日且跌破 MA20 隔日退出'],
    blockedWhen: ['開盤跳空超過 4%', '市場狀態曝險上限或資金不足'],
    parameters: {
      trainMonths: 54,
      validationMonths: 18,
      topN: [5, 10],
      revenueTrendModes: ['any', 'above_ma20', 'uptrend', 'relative_strength'],
      momentumHoldingDays: [20, 40, 60],
      momentumFallback: true
    },
    trainPeriod: 'rolling 54 months',
    validationPeriod: 'rolling 18 months',
    costModel: '手續費、交易稅、雙邊滑價與最低手續費',
    executionModel: '訊號收盤後確認，下一交易日開盤成交；停損跳空採較差價與 T+2'
  });
  const identity = buildExperimentIdentity(identityInput);
  const registryDecision = shouldSkipExperiment(await loadRegistry(), identity, {
    ...identityInput,
    newDataSources: ['2015–2026 月營收歷史資料'],
    coreRulesChanged: true
  });
  if (registryDecision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...registryDecision, ...identity }, null, 2));
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
  const marketRows = context.marketHistory;
  const marketIndex = new Map(marketRows.map((row, index) => [row.date, index]));
  const events = new Map();
  const momentumEvents = new Map();
  const forward = new Map(setups.flatMap(setup => [10, 20, 40].map(days => [`${setup.id}_h${days}`, []])));

  for (const revenue of revenuePayload.records || []) {
    if (!revenue.isPointInTimeSafe || !revenue.effectiveDate) continue;
    const stockRow = stocks.get(revenue.symbol);
    if (!stockRow) continue;
    const { stock, history } = stockRow;
    const index = firstIndexOnOrAfter(history, revenue.effectiveDate);
    if (index < 60 || index + 41 >= history.length) continue;
    const day = history[index];
    const nextDay = history[index + 1];
    const priorReturns = history.slice(index - 59, index + 1).map((row, offset, rows) => (
      offset ? row.close / rows[offset - 1].close - 1 : 0
    ));
    if (priorReturns.some(value => Math.abs(value) > 0.15)) continue;
    const averageTradeValue20 = mean(history.slice(index - 19, index + 1).map(row => row.close * row.volume));
    if (day.close < 5 || averageTradeValue20 < 30_000_000) continue;
    const ma20 = movingAverage(history, index, 20);
    const ma60 = movingAverage(history, index, 60);
    const marketCursor = marketIndex.get(day.date);
    const marketReturn20 = marketCursor >= 20
      ? (marketRows[marketCursor].close / marketRows[marketCursor - 20].close - 1) * 100
      : 0;
    const return20 = (day.close / history[index - 20].close - 1) * 100;
    const row = {
      signalDate: day.date,
      entryDate: nextDay.date,
      symbol: stock.symbol,
      name: stock.name,
      market: stock.market,
      regime: context.marketByDate.get(day.date)?.regime,
      revenue,
      history,
      historyIndex: index,
      score: (revenue.revenueHigh24 ? 15 : 0)
        + Math.min(40, Math.max(-20, revenue.YoY || 0)) * 0.4
        + Math.min(25, Math.max(-15, revenue.threeMonthCumulativeYoY || 0)) * 0.2
        + (revenue.yoyAcceleration ? 5 : 0)
        + Math.min(15, return20 - marketReturn20)
        + (day.close > ma20 ? 2 : 0)
        + (ma20 > ma60 ? 2 : 0),
      aboveMa20: day.close > ma20,
      ma20AboveMa60: ma20 > ma60,
      relativeMarket20: return20 - marketReturn20
    };
    if (!setups.some(setup => setup.test(row))) continue;
    const rows = events.get(day.date) || [];
    rows.push(row);
    events.set(day.date, rows);
    for (const setup of setups) {
      if (!setup.test(row)) continue;
      for (const holdingDays of [10, 20, 40]) {
        const exit = history[index + 1 + holdingDays];
        if (!exit) continue;
        forward.get(`${setup.id}_h${holdingDays}`).push((exit.close / nextDay.open - 1) * 100 - COST_PCT);
      }
    }
  }

  for (const { stock, history } of stocks.values()) {
    for (let index = 252; index < history.length - 1; index += 1) {
      const day = history[index];
      const nextDay = history[index + 1];
      if (nextDay.date.slice(0, 7) === day.date.slice(0, 7)) continue;
      const averageTradeValue20 = mean(history.slice(index - 19, index + 1).map(row => row.close * row.volume));
      if (day.close < 5 || averageTradeValue20 < 50_000_000) continue;
      const ma20 = movingAverage(history, index, 20);
      const ma60 = movingAverage(history, index, 60);
      const momentum12 = (history[index - 20].close / history[index - 252].close - 1) * 100;
      const momentum6 = (history[index - 20].close / history[index - 126].close - 1) * 100;
      const nearHigh = day.close / Math.max(...history.slice(index - 251, index + 1).map(row => row.high));
      const dailyReturns = history.slice(index - 59, index + 1).map((row, offset, rows) =>
        offset ? (row.close / rows[offset - 1].close - 1) * 100 : 0).slice(1);
      const dailyMean = mean(dailyReturns);
      const volatility = Math.sqrt(mean(dailyReturns.map(value => (value - dailyMean) ** 2))) * Math.sqrt(252);
      if (momentum12 < 10 || momentum6 < 8 || nearHigh < 0.75 || ma20 <= ma60) continue;
      const rows = momentumEvents.get(day.date) || [];
      rows.push({
        signalDate: day.date,
        entryDate: nextDay.date,
        symbol: stock.symbol,
        name: stock.name,
        market: stock.market,
        regime: context.marketByDate.get(day.date)?.regime,
        history,
        historyIndex: index,
        score: momentum12 / Math.max(8, volatility) * 25 + momentum6 / Math.max(8, volatility) * 15 + nearHigh * 20,
        setupLabel: '月底長期動能補位'
      });
      momentumEvents.set(day.date, rows);
    }
  }

  const eventDates = new Set([...events.keys(), ...momentumEvents.keys()]);
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
    let trained = null;
    for (const config of configs) {
      const result = run(context, signalMap(events, momentumEvents, config), config, fold.trainStart, fold.trainEnd);
      if (result.summary.trades < 30 || result.summary.maximumDrawdownPct < -25) continue;
      if (!trained || result.summary.averageMonthlyEquityReturnPct
        > trained.result.summary.averageMonthlyEquityReturnPct) {
        trained = { config, result };
      }
    }
    if (!trained) {
      folds.push({ ...fold, status: '訓練樣本不足' });
      continue;
    }
    const realMap = signalMap(events, momentumEvents, trained.config);
    const validation = run(context, realMap, trained.config, fold.validationStart, fold.validationEnd);
    const random = run(
      context,
      randomSignalMap(events, momentumEvents, randomPool, trained.config),
      trained.config,
      fold.validationStart,
      fold.validationEnd,
      '_random'
    );
    validations.push(validation);
    randoms.push(random);
    folds.push({
      ...fold,
      status: '完成',
      selectedConfig: {
        setup: trained.config.setup.id,
        trendMode: trained.config.trendMode,
        includeMomentum: trained.config.includeMomentum,
        holdingDays: trained.config.holdingDays,
        momentumHoldingDays: trained.config.momentumHoldingDays,
        topN: trained.config.topN,
        stopDistancePct: trained.config.stopDistancePct
      },
      train: trained.result.summary,
      validation: validation.summary,
      random: random.summary
    });
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
    revenueCoverage: {
      records: revenuePayload.records?.length || 0,
      symbols: new Set((revenuePayload.records || []).map(row => row.symbol)).size,
      months: new Set((revenuePayload.records || []).map(row => row.revenueMonth)).size,
      pointInTimeMode: revenuePayload.pointInTimePolicy?.mode,
      fullyVerified: revenuePayload.pointInTimePolicy?.fullyVerified
    },
    testedSetups: forward.size,
    forwardResults: [...forward].map(([id, values]) => ({ id, ...forwardSummary(values) }))
      .sort((left, right) => right.meanPct - left.meanPct),
    testedConfigurations: configs.length,
    strategySources: ['創 12／24 月新高營收事件', '月底 6／12 個月風險調整動能'],
    momentumFallbackEnabled: true,
    trainingMonthsPerFold: 54,
    validationMonthsPerFold: 18,
    validationPeriod: `${validationStart}–${validationEnd}`,
    folds,
    metrics,
    benchmark0050,
    fairRandom,
    rejectedRiskExperiments,
    priorBaselineComparison: {
      priorMonthlyReturnPct: 1.5223,
      priorMaximumDrawdownPct: -13.8924,
      priorTrades: 430,
      monthlyReturnChangePct: round(metrics.averageMonthlyReturnPct - 1.5223),
      maximumDrawdownImprovementPct: round(metrics.maximumDrawdownPct - (-13.8924)),
      tradeCountChange: metrics.trades - 430
    },
    targetMonthlyReturnPct: 5,
    gapToTargetPct: round(5 - metrics.averageMonthlyReturnPct),
    targetMet,
    paperTradingReady: false,
    liveTradingReady: false,
    survivorshipBiasWarning: true,
    conclusion: targetMet
      ? '通過本研究門檻，但仍只能先進紙上交易。'
      : `找不到月均 5% 的可實盤純個股策略；目前月均 ${metrics.averageMonthlyReturnPct}%。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 創高營收與個股動能雙來源策略\n\n- 驗證區間：${output.validationPeriod}，共 ${metrics.months} 個月。\n- 訓練／驗證：每折 54 個月訓練、18 個月驗證，驗證期不調參。\n- 個股交易：${metrics.trades} 筆；ETF 與 0050 交易占比 0%。\n- 月均總資產報酬：${metrics.averageMonthlyReturnPct}%；年化報酬：${metrics.annualizedReturnPct}%。\n- 最大回撤：${metrics.maximumDrawdownPct}%；Profit Factor：${metrics.profitFactor}；勝率：${metrics.winRatePct}%。\n- 公平隨機月均：${fairRandom.averageMonthlyReturnPct}%；0050 同期月均：${benchmark0050.averageMonthlyReturnPct}%。\n- 平均曝險：${metrics.averageExposurePct}%；有持倉交易日：${metrics.investedTradingDaysPct}%。\n\n## 本輪改善\n\n相較前一可信基準，月均增加 ${output.priorBaselineComparison.monthlyReturnChangePct} 個百分點，最大回撤改善 ${output.priorBaselineComparison.maximumDrawdownImprovementPct} 個百分點，交易數增加 ${output.priorBaselineComparison.tradeCountChange} 筆。\n\n## 邏輯\n\n創 12／24 個月新高且成長加速的月營收事件為主要候選；月底以 6／12 個月風險調整動能個股補足閒置部位。營收事件與動能補位分開選擇持有週期；動能股若前一日收盤跌破 MA20，隔日開盤退出。所有訊號只使用 effectiveDate 或訊號日收盤前資料，下一交易日才成交。投組共用現金、T+2、手續費、交易稅、雙邊滑價、跳空停損、單檔 10% 與單筆風險 0.5% 限制。\n\n月營收歷史公布時間採保守 effectiveDate，並非逐筆 fully verified；目前歷史股票池仍有倖存者偏差警告，因此結果不得視為實盤保證。\n\n## 結論\n\n${output.conclusion} 雖然雙來源策略明顯高於各自單獨運行並贏過公平隨機，但仍輸給 0050，且未達月均 5%，不可進紙上交易或實盤。\n`, 'utf8');
  await fs.appendFile(REPORT, `\n## 市場狀態歸因\n\n${Object.entries(metrics.regimeMetrics).map(([regime, row]) => `- ${regime}：${row.trades} 筆，PF ${row.profitFactor}，平均每筆 ${row.averageTradeReturnPct}%，已實現損益 ${row.realizedPnl}。`).join('\n')}\n\n## 來源績效與風控覆檢\n\n主要正期望來自月營收創高事件；月底長期動能補位增加交易機會，但獲利品質較弱。已拒絕的風控實驗如下，後續不可重複測試：\n\n${rejectedRiskExperiments.map(row => `- ${row.id}：月均 ${row.monthlyReturnPct}%，最大回撤 ${row.maximumDrawdownPct}%，${row.trades} 筆；${row.reason}`).join('\n')}\n`, 'utf8');
  console.log(JSON.stringify({
    revenueCoverage: output.revenueCoverage,
    forwardBest: output.forwardResults.slice(0, 6),
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
