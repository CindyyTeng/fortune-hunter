import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadResearchContext, round, simulateSignalMap } from './research-core.mjs';
import { buildExperimentIdentity, loadRegistry, shouldSkipExperiment } from './strategy-experiment-registry.mjs';

const REVENUE_SIGNALS = new URL('../../data/research/stock-unexpected-revenue-signals-v1.json.gz', import.meta.url);
const EARNINGS_SIGNALS = new URL('../../data/research/stock-unexpected-earnings-signals-v1.json.gz', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-dual-fundamental-confirmation-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_DUAL_FUNDAMENTAL_CONFIRMATION_V1.md', import.meta.url);
const START_DATE = '2020-09-01';
const END_DATE = '2026-06-09';
const CAPITAL = 1_000_000;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const pct = (value, base) => base ? (value / base - 1) * 100 : 0;

function historyLookup(context) {
  const map = new Map();
  for (const { stock, history } of context.ohlcv.stocks) map.set(stock.symbol, { history, dates: new Map(history.map((row, index) => [row.date, index])) });
  return map;
}

function buildDualSignals(context, revenue, earnings, key) {
  const stockHistory = historyLookup(context);
  const events = [];
  for (const [source, report] of [['revenue', revenue], ['earnings', earnings]]) {
    for (const row of report[key] || []) {
      for (const candidate of row.candidates || []) events.push({ date: row.date, source, candidate });
    }
  }
  events.sort((left, right) => left.date.localeCompare(right.date));
  const latest = new Map();
  const map = new Map();
  for (const event of events) {
    const symbolState = latest.get(event.candidate.symbol) || {};
    symbolState[event.source] = event;
    latest.set(event.candidate.symbol, symbolState);
    const revenueEvent = symbolState.revenue;
    const earningsEvent = symbolState.earnings;
    if (!revenueEvent || !earningsEvent) continue;
    const ageDays = Math.abs((Date.parse(revenueEvent.date) - Date.parse(earningsEvent.date)) / 86_400_000);
    if (ageDays > 90 || event.date < START_DATE || event.date > END_DATE) continue;
    const source = stockHistory.get(event.candidate.symbol);
    const index = source?.dates.get(event.date);
    if (!source || index === undefined || index + 1 >= source.history.length) continue;
    const candidate = {
      ...event.candidate,
      signalDate: event.date,
      entryDate: source.history[index + 1].date,
      score: revenueEvent.candidate.score + earningsEvent.candidate.score,
      positionPct: 15,
      accountRiskPct: 0.75,
      stopDistancePct: 8,
      maxHoldingDays: 30,
      trailingStopRule: { triggerPct: 10, lockPct: 3, givebackPct: 6 },
      futureBars: source.history.slice(index + 1, index + 32).map(row => ({ date: row.date, open: row.open, high: row.high, low: row.low, close: row.close, price: row.close })),
      setup: `90 天內意外營收與意外盈餘雙重確認；營收 ${revenueEvent.candidate.setup}；盈餘 ${earningsEvent.candidate.setup}`,
      trigger: '第二個 OOS 基本面訊號收盤後成立，下一交易日開盤成交',
      invalidation: '收盤跌破 8% 風險距離，下一交易日開盤退出',
      exitPlan: '最多持有 30 日，獲利達 10% 後啟動移動停利',
      reason: key.startsWith('random') ? '同來源公平隨機訊號的雙重確認' : '營收與盈餘兩個獨立 OOS alpha 同時確認',
      orderIntent: { action: 'BUY', orderType: 'MARKETABLE_LIMIT', timeInForce: 'DAY', earliestDate: source.history[index + 1].date }
    };
    const rows = map.get(event.date) || [];
    if (!rows.some(row => row.symbol === candidate.symbol)) rows.push(candidate);
    map.set(event.date, rows.sort((left, right) => right.score - left.score).slice(0, 5));
  }
  return map;
}

function run(context, map, suffix = '') {
  return simulateSignalMap(context, map, {
    strategyId: `stock_dual_fundamental_confirmation_v1${suffix}`,
    startDate: START_DATE,
    endDate: END_DATE,
    initialCapital: CAPITAL,
    maxOpenPositions: 5,
    accountRiskPct: 0.75,
    riskRules: {
      maxAccountRiskPct: 0.75,
      maxSinglePositionPct: 15,
      exposureLimits: { BULL_TREND: 75, THEME_MOMENTUM: 75, BULL_PULLBACK: 60, RANGE_BOUND: 40, HIGH_VOLATILITY: 0, BEAR_DEFENSE: 0 },
      drawdownBlockPct: 8,
      drawdownBlockDays: 20,
      monthlyLossBlockPct: 5,
      dailyLossBlockPct: 2,
      losingStreakCount: 4,
      losingStreakBlockDays: 10
    }
  });
}

function summarize(result) {
  const trades = result.trades;
  const gains = trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(trades.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
  const symbols = new Map();
  for (const trade of trades) symbols.set(trade.symbol, (symbols.get(trade.symbol) || 0) + 1);
  return {
    months: result.summary.monthly.length,
    averageMonthlyReturnPct: result.summary.averageMonthlyEquityReturnPct,
    annualizedReturnPct: result.summary.annualizedReturnPct,
    maximumDrawdownPct: result.summary.maximumDrawdownPct,
    trades: trades.length,
    winRatePct: result.summary.winRatePct,
    profitFactor: losses ? round(gains / losses) : null,
    concentrationPct: round(Math.max(0, ...symbols.values()) / Math.max(1, trades.length) * 100),
    averageExposurePct: round(mean(result.equityCurve.map(row => row.exposurePct || 0)))
  };
}

function benchmark(series) {
  const rows = series.filter(row => row.date >= START_DATE && row.date <= END_DATE);
  const ends = new Map(rows.map(row => [row.date.slice(0, 7), row.close]));
  let prior = [...series].reverse().find(row => row.date < START_DATE)?.close || rows[0]?.close;
  const returns = [];
  for (const close of ends.values()) {
    returns.push(pct(close, prior));
    prior = close;
  }
  return { averageMonthlyReturnPct: round(mean(returns)) };
}

async function main() {
  const identityInput = {
    strategyId: 'stock_dual_fundamental_confirmation_v1',
    dataSources: ['point-in-time 月營收', 'point-in-time EPS', '個股 OHLCV', '市場狀態'],
    setupRules: ['90 天內同股同時有意外營收與意外盈餘 OOS 訊號'],
    triggerRules: ['第二個訊號 T 日收盤確認，T+1 開盤成交'],
    invalidationRules: ['收盤跌破 8%，T+1 開盤退出'],
    exitRules: ['30 日與移動停利'],
    riskRules: { accountRiskPct: 0.75, maximumPositionPct: 15, tPlusTwo: true },
    blockedWhen: ['空頭或高波動市場'],
    parameters: { confirmationWindowDays: 90, topN: 5 },
    trainPeriod: '來源訊號各自 rolling 54 months',
    validationPeriod: '來源訊號各自 rolling 18 months OOS',
    costModel: '共用成交模擬器：手續費、交易稅、滑價',
    executionModel: 'T+1 開盤、跳空不利成交、T+2'
  };
  const identity = buildExperimentIdentity(identityInput);
  const decision = shouldSkipExperiment(await loadRegistry(), identity, { ...identityInput, newDataSources: ['營收與盈餘雙重確認'], coreRulesChanged: true });
  if (decision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...decision, ...identity }, null, 2));
    return;
  }
  const [context, revenue, earnings, etf] = await Promise.all([
    loadResearchContext(),
    fs.readFile(REVENUE_SIGNALS).then(buffer => JSON.parse(gunzipSync(buffer))),
    fs.readFile(EARNINGS_SIGNALS).then(buffer => JSON.parse(gunzipSync(buffer))),
    fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)
  ]);
  const signals = buildDualSignals(context, revenue, earnings, 'validationSignals');
  const randomSignals = buildDualSignals(context, revenue, earnings, 'randomValidationSignals');
  const metrics = summarize(run(context, signals));
  const fairRandom = summarize(run(context, randomSignals, '_random'));
  const benchmark0050 = benchmark(etf.series['0050.TW'] || []);
  const targetMet = metrics.averageMonthlyReturnPct >= 5 && metrics.maximumDrawdownPct >= -20 && metrics.trades >= 300
    && metrics.profitFactor > 1.15 && metrics.averageMonthlyReturnPct > fairRandom.averageMonthlyReturnPct
    && metrics.averageMonthlyReturnPct > benchmark0050.averageMonthlyReturnPct;
  const output = {
    generatedAt: new Date().toISOString(),
    experimentHash: identity.experimentHash,
    strategyFamilyId: identity.strategyFamilyId,
    universe: '純台股個股；ETF 交易占比 0%，0050 僅作比較',
    validationPeriod: `${START_DATE}–${END_DATE}`,
    signalDates: signals.size,
    metrics,
    fairRandom,
    benchmark0050,
    targetMonthlyReturnPct: 5,
    gapToTargetPct: round(5 - metrics.averageMonthlyReturnPct),
    targetMet,
    paperTradingReady: false,
    liveTradingReady: false,
    survivorshipBiasWarning: true,
    conclusion: targetMet ? '達到研究候選門檻，但仍須先以全新期間紙上交易驗證。' : `找不到月均 5% 的可實盤純個股雙基本面確認策略；目前 ${metrics.averageMonthlyReturnPct}%。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 純個股雙基本面確認研究\n\n- 驗證區間：${output.validationPeriod}\n- 訊號日期：${output.signalDates}\n- 月均總資產報酬：${metrics.averageMonthlyReturnPct}%（距 5%：${output.gapToTargetPct}%）\n- 年化報酬：${metrics.annualizedReturnPct}%\n- 最大回撤：${metrics.maximumDrawdownPct}%\n- 交易：${metrics.trades} 筆；勝率：${metrics.winRatePct}%；PF：${metrics.profitFactor}\n- 公平隨機月均：${fairRandom.averageMonthlyReturnPct}%；0050 月均：${benchmark0050.averageMonthlyReturnPct}%\n- 結論：${output.conclusion}\n\n只合併兩個已各自完成 rolling OOS 的 point-in-time 訊號；第二個訊號收盤後成立，下一交易日才成交。已計入費稅、滑價、跳空與 T+2。\n`, 'utf8');
  console.log(JSON.stringify({ signalDates: signals.size, metrics, fairRandom, benchmark0050, targetMet, conclusion: output.conclusion }, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
