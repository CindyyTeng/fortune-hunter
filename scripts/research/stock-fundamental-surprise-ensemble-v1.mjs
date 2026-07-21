import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadResearchContext, mean, round, simulateSignalMap } from './research-core.mjs';

const REVENUE = new URL('../../data/research/stock-unexpected-revenue-signals-v1.json.gz', import.meta.url);
const EARNINGS = new URL('../../data/research/stock-unexpected-earnings-signals-v1.json.gz', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-fundamental-surprise-ensemble-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_FUNDAMENTAL_SURPRISE_ENSEMBLE_V1.md', import.meta.url);
const STRATEGY_ID = 'stock_fundamental_surprise_ensemble_v1';
const START_DATE = '2020-09-01';
const END_DATE = '2026-06-09';
const CAPITAL = 1_000_000;

const profiles = [
  { id: 'balanced', risk: 0.5, maxPositionPct: 10, maxOpenPositions: 18, positionMultiplier: 1, exposure: 75 },
  { id: 'earnings_boost', risk: 0.75, maxPositionPct: 14, maxOpenPositions: 15, positionMultiplier: 1.4, exposure: 75 },
  { id: 'profit_push', risk: 1, maxPositionPct: 18, maxOpenPositions: 12, positionMultiplier: 1.8, exposure: 70 }
];

function loadSignals(buffer) {
  return JSON.parse(gunzipSync(buffer));
}

function indexBars(context) {
  return new Map(context.ohlcv.stocks.map(({ stock, history }) => [stock.symbol, {
    history,
    byDate: new Map(history.map((row, index) => [row.date, index]))
  }]));
}

function barsFor(index, row) {
  if (row.futureBars?.length) return row.futureBars;
  const source = index.get(row.symbol);
  const cursor = source?.byDate.get(row.signalDate);
  if (cursor === undefined) return [];
  return source.history.slice(cursor + 1, cursor + 62).map(bar => ({
    date: bar.date,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    price: bar.close
  }));
}

function mergeSignals(context, revenue, earnings, profile, random = false) {
  const index = indexBars(context);
  const map = new Map();
  const add = (payload, key, source, weight) => {
    for (const row of payload[random ? 'randomValidationSignals' : 'validationSignals'] || []) {
      const date = row.date;
      const list = map.get(date) || [];
      for (const candidate of row.candidates || []) {
        const futureBars = barsFor(index, candidate);
        if (!futureBars.length) continue;
        list.push({
          ...candidate,
          alphaSource: source,
          score: (candidate.score || 0) * weight + (source === '意外盈餘' ? 15 : 0),
          futureBars,
          positionPct: Math.min(profile.maxPositionPct, (candidate.positionPct || 8) * profile.positionMultiplier * weight),
          accountRiskPct: profile.risk,
          maxHoldingDays: candidate.maxHoldingDays || (source === '意外盈餘' ? 40 : 20),
          rewardRisk: candidate.rewardRisk ?? 0,
          trailingStopRule: candidate.trailingStopRule || (source === '意外盈餘' ? { triggerPct: 10, lockPct: 2, givebackPct: 6 } : null),
          stopLossMode: 'close',
          entryGapRange: candidate.entryGapRange || { minimumPct: -5, maximumPct: 4 },
          setup: [`${source} OOS 訊號`],
          trigger: ['訊號確認後隔日開盤或原策略進場條件'],
          invalidation: ['收盤跌破停損或持有期結束'],
          exitPlan: '固定持有、停利或移動停利',
          reason: `${source} 基本面驚喜組合`,
          orderIntent: { action: 'BUY', orderType: 'MARKETABLE_LIMIT', timeInForce: 'DAY', earliestDate: candidate.entryDate }
        });
      }
      if (list.length) map.set(date, list);
    }
  };
  add(revenue, 'validationSignals', '意外營收', 1);
  add(earnings, 'validationSignals', '意外盈餘', 1.2);
  for (const [date, rows] of map) {
    const deduped = new Map();
    for (const row of rows.sort((a, b) => b.score - a.score)) {
      if (!deduped.has(row.symbol)) deduped.set(row.symbol, row);
    }
    map.set(date, [...deduped.values()].slice(0, profile.maxOpenPositions));
  }
  return map;
}

function run(context, map, profile, random = false) {
  return simulateSignalMap(context, map, {
    strategyId: `${STRATEGY_ID}${random ? '_random' : ''}`,
    startDate: START_DATE,
    endDate: END_DATE,
    initialCapital: CAPITAL,
    maxOpenPositions: profile.maxOpenPositions,
    accountRiskPct: profile.risk,
    riskRules: {
      maxAccountRiskPct: profile.risk,
      maxSinglePositionPct: profile.maxPositionPct,
      exposureLimits: { BULL_TREND: profile.exposure, THEME_MOMENTUM: profile.exposure, BULL_PULLBACK: 60, RANGE_BOUND: 40, HIGH_VOLATILITY: 15, BEAR_DEFENSE: 0 },
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
  const sources = {};
  const symbols = new Map();
  for (const trade of trades) {
    sources[trade.alphaSource] = (sources[trade.alphaSource] || 0) + 1;
    symbols.set(trade.symbol, (symbols.get(trade.symbol) || 0) + 1);
  }
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
    sourceTrades: sources
  };
}

function benchmark(series) {
  const rows = series.filter(row => row.date >= START_DATE && row.date <= END_DATE);
  const ends = new Map(rows.map(row => [row.date.slice(0, 7), row.close]));
  let prior = [...series].reverse().find(row => row.date < START_DATE)?.close || rows[0]?.close;
  const returns = [];
  for (const close of ends.values()) {
    returns.push((close / prior - 1) * 100);
    prior = close;
  }
  return { averageMonthlyReturnPct: round(mean(returns)) };
}

async function main() {
  const [context, revenue, earnings, etf] = await Promise.all([
    loadResearchContext(),
    fs.readFile(REVENUE).then(loadSignals),
    fs.readFile(EARNINGS).then(loadSignals),
    fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)
  ]);
  const rows = profiles.map(profile => {
    const result = run(context, mergeSignals(context, revenue, earnings, profile), profile);
    const random = run(context, mergeSignals(context, revenue, earnings, profile, true), profile, true);
    const metrics = summarize(result);
    const fairRandom = summarize(random);
    const score = metrics.averageMonthlyReturnPct * 3
      + metrics.maximumDrawdownPct * 0.12
      + Math.min(3, metrics.profitFactor || 0)
      + Math.min(2, metrics.trades / 300);
    return { profile, metrics, fairRandom, score };
  }).sort((a, b) => b.score - a.score);
  const selected = rows.find(row => row.metrics.maximumDrawdownPct >= -20
    && row.metrics.trades >= 300
    && row.metrics.profitFactor > 1.15) || rows[0];
  const benchmark0050 = benchmark(etf.series['0050.TW'] || []);
  const targetMet = selected.metrics.averageMonthlyReturnPct >= 5
    && selected.metrics.maximumDrawdownPct >= -20
    && selected.metrics.trades >= 300
    && selected.metrics.profitFactor > 1.15
    && selected.metrics.averageMonthlyReturnPct > benchmark0050.averageMonthlyReturnPct
    && selected.metrics.averageMonthlyReturnPct > selected.fairRandom.averageMonthlyReturnPct;
  const output = {
    generatedAt: new Date().toISOString(),
    strategyId: STRATEGY_ID,
    universe: '純個股，不以 ETF 或 0050 為主要交易標的。',
    validationPeriod: `${START_DATE}~${END_DATE}`,
    testedProfiles: rows,
    selectedProfile: selected.profile,
    metrics: selected.metrics,
    fairRandom: selected.fairRandom,
    benchmark0050,
    targetMonthlyReturnPct: 5,
    targetMet,
    paperTradingReady: false,
    liveTradingReady: false,
    conclusion: targetMet
      ? '達到月均 5% 門檻，但仍需紙上交易驗證後才可討論實盤。'
      : `未達月均 5% 可實盤門檻；validation 月均 ${selected.metrics.averageMonthlyReturnPct}%，不可 paper trading、不可實盤。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 基本面驚喜純個股組合 v1\n\n- 驗證期間：${output.validationPeriod}\n- 最佳 Profile：${selected.profile.id}\n- 交易筆數：${selected.metrics.trades}\n- 月均報酬：${selected.metrics.averageMonthlyReturnPct}%\n- 年化報酬：${selected.metrics.annualizedReturnPct}%\n- 最大回撤：${selected.metrics.maximumDrawdownPct}%\n- Profit Factor：${selected.metrics.profitFactor}\n- 勝率：${selected.metrics.winRatePct}%\n- 0050 同期月均：${benchmark0050.averageMonthlyReturnPct}%\n- 公平隨機月均：${selected.fairRandom.averageMonthlyReturnPct}%\n- 結論：${output.conclusion}\n\n策略邏輯：合併意外營收與意外盈餘 OOS 訊號，偏重盈餘驚喜，使用共用成交模擬器、費稅滑價、T+2 與風控規則。\n`, 'utf8');
  console.log(JSON.stringify({
    validationPeriod: output.validationPeriod,
    selectedProfile: selected.profile,
    metrics: selected.metrics,
    fairRandom: selected.fairRandom,
    benchmark0050,
    targetMet,
    conclusion: output.conclusion
  }, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
