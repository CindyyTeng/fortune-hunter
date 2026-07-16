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

const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-defensive-momentum-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_DEFENSIVE_MOMENTUM_V1.md', import.meta.url);
const STRATEGY_ID = 'stock_defensive_momentum_v1';
const CAPITAL = 1_000_000;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const pct = (value, base) => base ? (value / base - 1) * 100 : 0;
const compact = summary => {
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

function average(history, start, end, key) {
  return mean(history.slice(Math.max(0, start), end + 1).map(row => row[key]).filter(Number.isFinite));
}

function standardDeviation(values) {
  const averageValue = mean(values);
  return Math.sqrt(mean(values.map(value => (value - averageValue) ** 2)));
}

function maxDrawdown(history, start, end) {
  let peak = 0;
  let drawdown = 0;
  for (const row of history.slice(start, end + 1)) {
    peak = Math.max(peak, row.close);
    drawdown = Math.min(drawdown, pct(row.close, peak));
  }
  return drawdown;
}

function configurations() {
  const rows = [];
  for (const factorMode of ['low_vol_only', 'low_max_only', 'low_vol_momentum', 'low_max_strength', 'stable_relative_strength']) {
    for (const marketMode of ['bull_only', 'non_bear']) {
      for (const topN of [5, 10]) {
        for (const holdingDays of [20, 40, 60]) {
          for (const stopDistancePct of [6, 9]) rows.push({ factorMode, marketMode, topN, holdingDays, stopDistancePct });
        }
      }
    }
  }
  return rows;
}

function monthEndDates(context) {
  const rows = new Map();
  for (const date of context.marketByDate.keys()) rows.set(date.slice(0, 7), date);
  return new Set(rows.values());
}

function observations(context) {
  const signalDates = monthEndDates(context);
  const byDate = new Map();
  for (const { stock, history } of context.ohlcv.stocks) {
    if (!/^\d{4}$/.test(String(stock.symbol)) || Number(stock.symbol) < 1000) continue;
    const returns = history.map((row, index) => index ? row.close / history[index - 1].close - 1 : 0);
    for (let index = 130; index + 42 < history.length; index += 1) {
      const day = history[index];
      if (!signalDates.has(day.date) || hasHistoricalPriceAnomaly(returns, index)) continue;
      const market = context.marketByDate.get(day.date);
      if (!market) continue;
      const averageTradeValue20 = average(history, index - 19, index, 'close') * average(history, index - 19, index, 'volume');
      if (averageTradeValue20 < 50_000_000) continue;
      const dailyReturns60 = returns.slice(index - 59, index + 1).map(value => value * 100);
      const maxDailyReturn20 = Math.max(...dailyReturns60.slice(-20));
      const minDailyReturn20 = Math.min(...dailyReturns60.slice(-20));
      const volatility60 = standardDeviation(dailyReturns60) * Math.sqrt(252);
      const momentum60 = pct(day.close, history[index - 60].close);
      const momentum120 = pct(day.close, history[index - 120].close);
      const relative20 = pct(day.close, history[index - 20].close) - (market.mom20 || 0);
      const ma20 = average(history, index - 19, index, 'close');
      const ma60 = average(history, index - 59, index, 'close');
      const drawdown60 = maxDrawdown(history, index - 59, index);
      const row = {
        stock, history, index, date: day.date, entryDate: history[index + 1].date, day, market,
        averageTradeValue20, volatility60, maxDailyReturn20, minDailyReturn20, momentum60, momentum120,
        relative20, ma20, ma60, drawdown60
      };
      const rows = byDate.get(day.date) || [];
      rows.push(row);
      byDate.set(day.date, rows);
    }
  }
  return byDate;
}

function percentileRanks(rows, selector, ascending = true) {
  const sorted = [...rows].sort((left, right) => selector(left) - selector(right));
  const ranks = new Map();
  sorted.forEach((row, index) => ranks.set(row.stock.symbol, (ascending ? index : sorted.length - 1 - index) / Math.max(1, sorted.length - 1)));
  return ranks;
}

function rankedRows(rows, config, random) {
  const eligible = rows.filter(row => {
    const pureDefensive = ['low_vol_only', 'low_max_only'].includes(config.factorMode);
    if (pureDefensive) {
      if (row.day.close < row.ma60 * 0.9 || row.momentum120 < -10) return false;
    } else if (!(row.day.close > row.ma60 && row.ma20 >= row.ma60 * 0.98)) return false;
    if (row.maxDailyReturn20 > 9 || row.minDailyReturn20 < -12 || row.volatility60 > 85) return false;
    if (config.marketMode === 'bull_only' && !['BULL_TREND', 'THEME_MOMENTUM', 'BULL_PULLBACK'].includes(row.market.regime)) return false;
    return config.marketMode !== 'non_bear' || !['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.market.regime);
  });
  const lowVol = percentileRanks(eligible, row => row.volatility60, false);
  const lowMax = percentileRanks(eligible, row => row.maxDailyReturn20, false);
  const lowDrawdown = percentileRanks(eligible, row => row.drawdown60, true);
  const momentum60 = percentileRanks(eligible, row => row.momentum60);
  const momentum120 = percentileRanks(eligible, row => row.momentum120);
  const relative20 = percentileRanks(eligible, row => row.relative20);
  return eligible.map(row => {
    let score;
    if (config.factorMode === 'low_vol_only') score = lowVol.get(row.stock.symbol) * 70 + lowDrawdown.get(row.stock.symbol) * 30;
    else if (config.factorMode === 'low_max_only') score = lowMax.get(row.stock.symbol) * 70 + lowVol.get(row.stock.symbol) * 30;
    else if (config.factorMode === 'low_vol_momentum') score = lowVol.get(row.stock.symbol) * 40 + momentum120.get(row.stock.symbol) * 35 + relative20.get(row.stock.symbol) * 25;
    else if (config.factorMode === 'low_max_strength') score = lowMax.get(row.stock.symbol) * 40 + momentum60.get(row.stock.symbol) * 35 + lowDrawdown.get(row.stock.symbol) * 25;
    else score = relative20.get(row.stock.symbol) * 40 + momentum120.get(row.stock.symbol) * 35 + lowVol.get(row.stock.symbol) * 25;
    return { row, score: random ? deterministicScore(`${row.date}|${row.stock.symbol}|defensive`) : score };
  }).sort((left, right) => right.score - left.score);
}

function buildMap(rowsByDate, config, random = false) {
  const map = new Map();
  for (const [date, rows] of rowsByDate) {
    const selected = rankedRows(rows, config, random).slice(0, config.topN);
    map.set(date, selected.map(({ row, score }) => ({
      signalDate: row.date,
      entryDate: row.entryDate,
      symbol: row.stock.symbol,
      name: row.stock.name,
      market: row.stock.market,
      regime: row.market.regime,
      score,
      entryMode: 'next_open_market',
      entryGapRange: { minimumPct: -4, maximumPct: 3 },
      stopDistancePct: config.stopDistancePct,
      stopLossMode: 'close',
      rewardRisk: 0,
      maxHoldingDays: config.holdingDays,
      trailingStopRule: { triggerPct: 10, lockPct: 2, givebackPct: 6 },
      positionPct: config.topN === 5 ? 15 : 8,
      accountRiskPct: 0.75,
      futureBars: row.history.slice(row.index + 1, row.index + config.holdingDays + 2).map(bar => ({
        date: bar.date, open: bar.open, high: bar.high, low: bar.low, close: bar.close, price: bar.close
      })),
      setup: `${config.factorMode}：低極端報酬／低波動與中期相對強度的月度橫斷面排名`,
      trigger: '月末收盤排名完成，下一交易日開盤且跳空介於 -4% 至 3% 才成交',
      invalidation: `收盤跌破進場價 ${config.stopDistancePct}%，下一交易日開盤退出`,
      exitPlan: `最多持有 ${config.holdingDays} 日，獲利達 10% 後採移動停利`,
      reason: random ? '同日同候選池公平隨機' : '避開樂透型極端報酬，選擇風險較低且相對強勢個股',
      orderIntent: { action: 'BUY', orderType: 'MARKETABLE_LIMIT', timeInForce: 'DAY', earliestDate: row.entryDate }
    })));
  }
  return map;
}

function run(context, rows, config, startDate, endDate, random = false) {
  return simulateSignalMap(context, buildMap(rows, config, random), {
    strategyId: `${STRATEGY_ID}${random ? '_random' : ''}`,
    startDate,
    endDate,
    initialCapital: CAPITAL,
    maxOpenPositions: config.topN,
    accountRiskPct: 0.75,
    riskRules: {
      maxAccountRiskPct: 0.75,
      maxSinglePositionPct: 15,
      exposureLimits: { BULL_TREND: 80, THEME_MOMENTUM: 80, BULL_PULLBACK: 65, RANGE_BOUND: 45, HIGH_VOLATILITY: 0, BEAR_DEFENSE: 0 },
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
    dataSources: ['個股 OHLCV', '市場狀態', '成交值', '橫斷面低波動與 MAX 因子'],
    setupRules: ['避開近月極端正報酬與高波動個股', '從低風險股票選擇中期相對強勢者'],
    triggerRules: ['月末 T 日收盤排名，T+1 開盤成交', '跳空超過範圍放棄'],
    invalidationRules: ['收盤跌破 6% 或 9%，T+1 開盤退出'],
    exitRules: ['20／40 日與移動停利'],
    riskRules: { accountRiskPct: 0.75, maximumPositionPct: 15, tPlusTwo: true },
    blockedWhen: ['空頭或高波動市場', '成交值不足', '價格異常'],
    parameters: { trainMonths: 48, validationMonths: 12, configs },
    trainPeriod: 'rolling 48 months',
    validationPeriod: 'rolling 12 months',
    costModel: '共用成交模擬器：手續費、交易稅、滑價',
    executionModel: 'T+1 開盤、跳空不利成交、T+2'
  };
  const identity = buildExperimentIdentity(identityInput);
  const decision = shouldSkipExperiment(await loadRegistry(), identity, { ...identityInput, newDataSources: ['低波動與 MAX 橫斷面因子'], coreRulesChanged: true });
  if (decision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...decision, ...identity }, null, 2));
    return;
  }
  const [context, etf] = await Promise.all([loadResearchContext(), fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)]);
  const rows = observations(context);
  const validations = [];
  const randoms = [];
  const folds = [];
  for (const fold of foldWindows(context.startDate, context.endDate, 48, 12)) {
    const trained = [];
    for (const config of configs) {
      const result = run(context, rows, config, fold.trainStart, fold.trainEnd);
      if (result.trades.length < 60 || result.summary.profitFactor < 1 || result.summary.maximumDrawdownPct < -20) continue;
      const segments = [0, 12, 24, 36].map(offset => run(context, rows, config, `${shiftMonth(fold.trainStart, offset)}-01`, dayBeforeMonth(shiftMonth(fold.trainStart, offset + 12))));
      if (segments.some(row => row.trades.length < 10)) continue;
      const returns = segments.map(row => row.summary.averageMonthlyEquityReturnPct).sort((a, b) => a - b);
      trained.push({ config, result, score: result.summary.averageMonthlyEquityReturnPct * 0.5 + returns[1] + returns[0] + result.summary.maximumDrawdownPct * 0.12 });
    }
    const selected = trained.sort((left, right) => right.score - left.score)[0];
    if (!selected) {
      folds.push({ ...fold, status: '訓練證據不足，持有現金' });
      continue;
    }
    const validation = run(context, rows, selected.config, fold.validationStart, fold.validationEnd);
    const random = run(context, rows, selected.config, fold.validationStart, fold.validationEnd, true);
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
  const targetMet = metrics.averageMonthlyReturnPct >= 5 && metrics.maximumDrawdownPct >= -20 && metrics.trades >= 300
    && metrics.profitFactor > 1.15 && metrics.averageMonthlyReturnPct > fairRandom.averageMonthlyReturnPct
    && metrics.averageMonthlyReturnPct > benchmark0050.averageMonthlyReturnPct;
  const output = {
    generatedAt: new Date().toISOString(),
    experimentHash: identity.experimentHash,
    strategyFamilyId: identity.strategyFamilyId,
    universe: '純台股四碼普通股；ETF 交易占比 0%，0050 僅作比較',
    monthlyObservationDates: rows.size,
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
    survivorshipBiasWarning: true,
    conclusion: targetMet ? '達到研究候選門檻，但仍須先以全新期間紙上交易驗證。' : `找不到月均 5% 的可實盤純個股防守動能策略；目前 ${metrics.averageMonthlyReturnPct}%。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 純個股低風險防守動能研究\n\n- 驗證區間：${output.validationPeriod}\n- 月度觀察日期：${output.monthlyObservationDates}；設定：${output.configurationsTested} 組\n- 月均總資產報酬：${metrics.averageMonthlyReturnPct}%（距 5%：${output.gapToTargetPct}%）\n- 年化報酬：${metrics.annualizedReturnPct}%\n- 最大回撤：${metrics.maximumDrawdownPct}%\n- 交易：${metrics.trades} 筆；勝率：${metrics.winRatePct}%；PF：${metrics.profitFactor}\n- 公平隨機月均：${fairRandom.averageMonthlyReturnPct}%；0050 月均：${benchmark0050.averageMonthlyReturnPct}%\n- 結論：${output.conclusion}\n\n訊號只使用月末收盤前可知資料，下一交易日才成交；已計入費稅、滑價、跳空與 T+2。策略排除高 MAX 與高波動樂透型股票，再選擇相對強勢個股。\n`, 'utf8');
  console.log(JSON.stringify({ validationPeriod: output.validationPeriod, monthlyObservationDates: rows.size, metrics, fairRandom, benchmark0050, targetMet, conclusion: output.conclusion }, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
