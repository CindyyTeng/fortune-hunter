import fs from 'node:fs/promises';
import { loadResearchContext, mean, round, simulateSignalMap } from './research-core.mjs';

const OUTPUT = new URL('../../data/research/stock-short-swing-momentum-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_SHORT_SWING_MOMENTUM_V1.md', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const STRATEGY_ID = 'stock_short_swing_momentum_v1';
const START_DATE = '2020-09-01';
const END_DATE = '2026-06-09';
const CAPITAL = 1_000_000;

const profiles = [
  { id: 'quick_top8', top: 8, hold: 5, risk: 0.75, pos: 10, exposure: 65, rr: 1.5 },
  { id: 'quick_top12', top: 12, hold: 5, risk: 0.5, pos: 7, exposure: 70, rr: 1.5 },
  { id: 'swing_top8', top: 8, hold: 10, risk: 0.75, pos: 10, exposure: 70, rr: 2 },
  { id: 'swing_top12', top: 12, hold: 10, risk: 0.5, pos: 7, exposure: 75, rr: 2 }
];

function avg(rows, end, n, key) {
  if (end + 1 < n) return null;
  return mean(rows.slice(end + 1 - n, end + 1).map(row => row[key]));
}

function buildSignals(context, profile, random = false) {
  const map = new Map();
  for (const { stock, history } of context.ohlcv.stocks) {
    if (!/^\d{4}$/.test(stock.symbol)) continue;
    for (let i = 80; i + profile.hold + 2 < history.length; i += 1) {
      const day = history[i];
      const prior = history[i - 1];
      const ma20 = avg(history, i, 20, 'close');
      const ma60 = avg(history, i, 60, 'close');
      const vol20 = avg(history, i - 1, 20, 'volume');
      if (!ma20 || !ma60 || !vol20 || day.close < 10) continue;
      const ret5 = (day.close / history[i - 5].close - 1) * 100;
      const ret20 = (day.close / history[i - 20].close - 1) * 100;
      const gap = (day.open / prior.close - 1) * 100;
      const value20 = avg(history, i, 20, 'volume') * day.close;
      const volumeRatio = day.volume / vol20;
      const distanceMa20 = (day.close / ma20 - 1) * 100;
      const upperWick = (day.high - Math.max(day.open, day.close)) / Math.max(0.01, day.high - day.low);
      const market = context.marketByDate.get(day.date);
      if (['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(market?.regime)) continue;
      if (value20 < 120_000_000 || ma20 < ma60) continue;
      if (ret20 < 8 || ret5 < 0 || ret5 > 12) continue;
      if (volumeRatio < 0.8 || volumeRatio > 3.5) continue;
      if (distanceMa20 < -2 || distanceMa20 > 12 || gap > 5 || upperWick > 0.5) continue;
      const futureBars = history.slice(i + 1, i + profile.hold + 8).map(row => ({
        date: row.date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        price: row.close
      }));
      if (!futureBars.length) continue;
      const score = random
        ? ((Number(stock.symbol) * 1103515245 + i) >>> 0) / 100000
        : ret20 * 1.5 + ret5 + Math.min(3, volumeRatio) * 4 - Math.abs(distanceMa20) + (market?.mom20 || 0);
      const rows = map.get(day.date) || [];
      rows.push({
        signalDate: day.date,
        entryDate: futureBars[0].date,
        symbol: stock.symbol,
        name: stock.name,
        market: stock.market,
        close: day.close,
        score,
        futureBars,
        positionPct: profile.pos,
        accountRiskPct: profile.risk,
        maxHoldingDays: profile.hold,
        stopDistancePct: Math.max(4, Math.min(8, distanceMa20 + 3)),
        rewardRisk: profile.rr,
        stopLossMode: 'close',
        entryGapRange: { minimumPct: -4, maximumPct: 4 },
        setup: ['20 日動能強、5 日未過熱、流動性足'],
        trigger: ['訊號後隔日開盤可成交'],
        invalidation: ['收盤跌破停損或持有期結束'],
        exitPlan: `${profile.hold} 日內短線波段，搭配 ${profile.rr}R 停利`,
        reason: '短線強勢延續純個股策略',
        orderIntent: { action: 'BUY', orderType: 'MARKETABLE_LIMIT', timeInForce: 'DAY', earliestDate: futureBars[0].date }
      });
      map.set(day.date, rows);
    }
  }
  for (const [date, rows] of map) map.set(date, rows.sort((a, b) => b.score - a.score).slice(0, profile.top));
  return map;
}

function run(context, profile, random = false) {
  return simulateSignalMap(context, buildSignals(context, profile, random), {
    strategyId: `${STRATEGY_ID}${random ? '_random' : ''}`,
    startDate: START_DATE,
    endDate: END_DATE,
    initialCapital: CAPITAL,
    maxOpenPositions: profile.top,
    accountRiskPct: profile.risk,
    riskRules: {
      maxAccountRiskPct: profile.risk,
      maxSinglePositionPct: profile.pos,
      exposureLimits: { BULL_TREND: profile.exposure, THEME_MOMENTUM: profile.exposure, BULL_PULLBACK: 55, RANGE_BOUND: 35, HIGH_VOLATILITY: 0, BEAR_DEFENSE: 0 },
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
    averageExposurePct: round(mean(result.equityCurve.map(row => row.exposurePct || 0)))
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
  const [context, etf] = await Promise.all([
    loadResearchContext(),
    fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)
  ]);
  const rows = profiles.map(profile => {
    const metrics = summarize(run(context, profile));
    const fairRandom = summarize(run(context, profile, true));
    const score = metrics.averageMonthlyReturnPct * 3
      + metrics.maximumDrawdownPct * 0.1
      + Math.min(3, metrics.profitFactor || 0)
      + Math.min(2, metrics.trades / 400);
    return { profile, metrics, fairRandom, score };
  }).sort((a, b) => b.score - a.score);
  const selected = rows.find(row => row.metrics.trades >= 300
    && row.metrics.maximumDrawdownPct >= -20
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
  await fs.writeFile(REPORT, `# 短線強勢延續純個股策略 v1\n\n- 驗證期間：${output.validationPeriod}\n- 最佳 Profile：${selected.profile.id}\n- 交易筆數：${selected.metrics.trades}\n- 月均報酬：${selected.metrics.averageMonthlyReturnPct}%\n- 年化報酬：${selected.metrics.annualizedReturnPct}%\n- 最大回撤：${selected.metrics.maximumDrawdownPct}%\n- Profit Factor：${selected.metrics.profitFactor}\n- 勝率：${selected.metrics.winRatePct}%\n- 0050 同期月均：${benchmark0050.averageMonthlyReturnPct}%\n- 公平隨機月均：${selected.fairRandom.averageMonthlyReturnPct}%\n- 結論：${output.conclusion}\n\n策略邏輯：篩選流動性足、20 日動能強、5 日未過熱、站上 MA20/MA60 且非高波動/空頭盤的純個股，隔日開盤進場，5~10 日短線出場。\n`, 'utf8');
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
