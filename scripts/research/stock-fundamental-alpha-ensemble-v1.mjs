import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadResearchContext, round, simulateSignalMap } from './research-core.mjs';

const REVENUE = new URL('../../data/research/stock-unexpected-revenue-v1.json', import.meta.url);
const EARNINGS = new URL('../../data/research/stock-unexpected-earnings-v1.json', import.meta.url);
const REVENUE_SIGNALS = new URL('../../data/research/stock-unexpected-revenue-signals-v1.json.gz', import.meta.url);
const EARNINGS_SIGNALS = new URL('../../data/research/stock-unexpected-earnings-signals-v1.json.gz', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-fundamental-alpha-ensemble-v1.json', import.meta.url);
const INITIAL_CAPITAL = 1_000_000;
const START_DATE = '2020-09-01';
const END_DATE = '2026-06-09';
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function candidateWithSource(candidate, source) {
  return {
    ...candidate,
    alphaSource: source,
    positionPct: Math.min(6, candidate.positionPct || 6),
    accountRiskPct: 0.4,
    reason: `${source}｜${candidate.reason}`
  };
}

function buildFutureBars(context) {
  const rows = new Map();
  for (const { stock, history } of context.ohlcv.stocks) {
    const byDate = new Map(history.map((row, index) => [row.date, index]));
    rows.set(stock.symbol, { history, byDate });
  }
  return candidate => {
    const source = rows.get(candidate.symbol);
    const index = source?.byDate.get(candidate.signalDate);
    if (!source || index === undefined) return [];
    return source.history.slice(index + 1, index + 41).map(row => ({
      date: row.date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      price: row.close
    }));
  };
}

function mergeSignals(context, reports, key) {
  const map = new Map();
  const counts = {};
  const futureBars = buildFutureBars(context);
  for (const { source, report } of reports) {
    for (const row of report[key] || []) {
      if (row.date < START_DATE || row.date > END_DATE) continue;
      const list = map.get(row.date) || [];
      for (const candidate of row.candidates) {
        list.push(candidateWithSource({ ...candidate, futureBars: futureBars(candidate) }, source));
        counts[source] = (counts[source] || 0) + 1;
      }
      map.set(row.date, list);
    }
  }
  for (const [date, rows] of map) {
    const deduped = new Map();
    for (const row of rows.sort((left, right) => right.score - left.score)) {
      if (!deduped.has(row.symbol)) deduped.set(row.symbol, row);
    }
    map.set(date, [...deduped.values()]);
  }
  return { map, counts };
}

function run(context, map, suffix = '') {
  return simulateSignalMap(context, map, {
    strategyId: `stock_fundamental_alpha_ensemble_v1${suffix}`,
    startDate: START_DATE,
    endDate: END_DATE,
    initialCapital: INITIAL_CAPITAL,
    maxOpenPositions: 20,
    holdingDays: 40,
    accountRiskPct: 0.4,
    riskRules: {
      maxAccountRiskPct: 0.4,
      maxSinglePositionPct: 6,
      exposureLimits: {
        BULL_TREND: 80,
        BULL_PULLBACK: 65,
        RANGE_BOUND: 50,
        THEME_MOMENTUM: 80,
        HIGH_VOLATILITY: 20,
        BEAR_DEFENSE: 15
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
    averageExposurePct: round(mean(result.equityCurve.map(row => row.exposurePct || 0))),
    investedTradingDaysPct: round(result.equityCurve.filter(row => row.openPositions > 0).length / Math.max(1, result.equityCurve.length) * 100),
    monthly: result.summary.monthly
  };
}

async function main() {
  const [context, revenue, earnings, revenueSignals, earningsSignals] = await Promise.all([
    loadResearchContext(),
    fs.readFile(REVENUE, 'utf8').then(JSON.parse),
    fs.readFile(EARNINGS, 'utf8').then(JSON.parse),
    fs.readFile(REVENUE_SIGNALS).then(buffer => JSON.parse(gunzipSync(buffer))),
    fs.readFile(EARNINGS_SIGNALS).then(buffer => JSON.parse(gunzipSync(buffer)))
  ]);
  const reports = [
    { source: 'unexpected_revenue', report: revenueSignals },
    { source: 'unexpected_earnings', report: earningsSignals }
  ];
  const signals = mergeSignals(context, reports, 'validationSignals');
  const randomSignals = mergeSignals(context, reports, 'randomValidationSignals');
  const result = run(context, signals.map);
  const random = run(context, randomSignals.map, '_random');
  const metrics = summarize(result);
  const fairRandom = summarize(random);
  const benchmark0050 = { averageMonthlyReturnPct: revenue.benchmark0050.averageMonthlyReturnPct };
  const targetMet = metrics.averageMonthlyReturnPct >= 5
    && metrics.maximumDrawdownPct >= -20
    && metrics.trades >= 300
    && metrics.profitFactor > 1.15
    && metrics.averageMonthlyReturnPct > fairRandom.averageMonthlyReturnPct
    && metrics.averageMonthlyReturnPct > benchmark0050.averageMonthlyReturnPct;
  const output = {
    generatedAt: new Date().toISOString(),
    strategyId: 'stock_fundamental_alpha_ensemble_v1',
    universe: '純個股，ETF 與 0050 交易占比 0%',
    validationPeriod: `${START_DATE}–${END_DATE}`,
    methodology: {
      alphaSources: ['標準化意外營收 MSURGE', '標準化意外盈餘 SUE'],
      selection: '各來源均由 54 個月訓練選參數，固定套用下一段 18 個月驗證；本組合只合併 OOS 候選。',
      portfolio: '單一帳戶、同日同股去重、最多 20 檔、單檔 6%、單筆風險 0.4%。',
      execution: '共用真實成交模擬、費稅、滑價、跳空、T+2 與熔斷規則。'
    },
    sourceSignalCounts: signals.counts,
    metrics,
    benchmark0050,
    fairRandom: { ...fairRandom, monthly: undefined },
    targetMonthlyReturnPct: 5,
    gapToTargetPct: round(5 - metrics.averageMonthlyReturnPct),
    targetMet,
    paperTradingReady: false,
    liveTradingReady: false,
    survivorshipBiasWarning: true,
    conclusion: targetMet
      ? '達到月均 5% 候選門檻，仍只能先進行紙上交易。'
      : `多 alpha 組合仍未達月均 5%；目前 ${metrics.averageMonthlyReturnPct}%。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    validationPeriod: output.validationPeriod,
    sourceSignalCounts: output.sourceSignalCounts,
    metrics: { ...metrics, monthly: undefined },
    benchmark0050,
    fairRandom: output.fairRandom,
    targetMet,
    conclusion: output.conclusion
  }, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
