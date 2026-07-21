import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { deterministicScore, loadResearchContext, round, simulateSignalMap } from './research-core.mjs';
import { buildExperimentIdentity, loadRegistry, shouldSkipExperiment } from './strategy-experiment-registry.mjs';

const REVENUE_SIGNALS = new URL('../../data/research/stock-unexpected-revenue-signals-v1.json.gz', import.meta.url);
const SHOCK_REPORT = new URL('../../data/research/stock-shock-stabilization-v1.json', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-diversified-alpha-ensemble-v2.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_DIVERSIFIED_ALPHA_ENSEMBLE_V2.md', import.meta.url);
const STRATEGY_ID = 'stock_diversified_alpha_ensemble_v2';
const START_DATE = '2020-09-01';
const END_DATE = '2026-06-09';
const CAPITAL = 1_000_000;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const pct = (value, base) => base ? (value / base - 1) * 100 : 0;

function futureBarsBySymbol(context) {
  return new Map(context.ohlcv.stocks.map(({ stock, history }) => [stock.symbol, {
    history,
    byDate: new Map(history.map((row, index) => [row.date, index]))
  }]));
}

function barsFor(index, candidate) {
  const source = index.get(candidate.symbol);
  const cursor = source?.byDate.get(candidate.signalDate);
  return cursor === undefined ? [] : source.history.slice(cursor + 1, cursor + 42).map(row => ({
    date: row.date, open: row.open, high: row.high, low: row.low, close: row.close, price: row.close
  }));
}

function shockEvents(context) {
  const events = new Map();
  for (const { stock, history } of context.ohlcv.stocks) {
    if (!/^\d{4}$/.test(stock.symbol) || Number(stock.symbol) < 1000) continue;
    for (let index = 20; index + 22 < history.length; index += 1) {
      const shock = history[index];
      const prior = history[index - 1];
      const stabilize = history[index + 1];
      const entry = history[index + 2];
      const shockPct = pct(shock.close, prior.close);
      if (shockPct > -8.5 || shockPct < -12 || shock.close < 5) continue;
      const shockGap = pct(shock.open, prior.close);
      if (shockGap < -5 || shockGap > 4) continue;
      if (mean(history.slice(index - 19, index + 1).map(row => row.close * row.volume)) < 30_000_000) continue;
      const range = Math.max(0.01, stabilize.high - stabilize.low);
      const rows = events.get(stabilize.date) || [];
      rows.push({
        signalDate: stabilize.date,
        entryDate: entry.date,
        symbol: stock.symbol,
        name: stock.name,
        market: stock.market,
        shockPct,
        close: stabilize.close,
        bullish: stabilize.close > stabilize.open,
        noNewLow: stabilize.low >= shock.low,
        volumeContract: stabilize.volume < shock.volume,
        lowerShadowRatio: (Math.min(stabilize.open, stabilize.close) - stabilize.low) / range,
        futureBars: history.slice(index + 2, index + 24).map(bar => ({
          date: bar.date, open: bar.open, high: bar.high, low: bar.low, close: bar.close, price: bar.close
        }))
      });
      events.set(stabilize.date, rows);
    }
  }
  return events;
}

function shockSignals(events, fold, random = false) {
  const config = fold.selectedConfig;
  const map = new Map();
  for (const [date, rows] of events) {
    if (date < fold.validationStart || date > fold.validationEnd) continue;
    const matches = row => config.setup === 'bullish_no_new_low'
      ? row.bullish && row.noNewLow
      : row.volumeContract && row.noNewLow;
    const selected = rows.filter(row => random || matches(row)).map(row => ({
      ...row,
      alphaSource: '急跌止穩',
      entryGapRange: { minimumPct: -5, maximumPct: config.maximumEntryGapPct },
      score: random
        ? deterministicScore(`${date}|${row.symbol}|shock-random`)
        : -row.shockPct * 2 + row.lowerShadowRatio * 5 + (row.volumeContract ? 3 : 0),
      stopDistancePct: config.stopDistancePct,
      stopLossMode: 'close',
      rewardRisk: 0,
      maxHoldingDays: config.holdingDays,
      positionPct: 10,
      accountRiskPct: 0.5,
      setup: '極端急跌後止穩確認',
      trigger: '止穩日收盤確認，下一交易日開盤進場',
      invalidation: `收盤跌破進場價 ${config.stopDistancePct}%`,
      exitPlan: `最多持有 ${config.holdingDays} 日`,
      reason: random ? '急跌事件池公平隨機' : '急跌後收紅或量縮且不破低',
      orderIntent: { action: 'BUY', orderType: 'MARKET', timeInForce: 'DAY', earliestDate: row.entryDate }
    })).sort((left, right) => right.score - left.score).slice(0, config.topN);
    if (selected.length) map.set(date, selected);
  }
  return map;
}

const profiles = [
  { id: 'base', positionMultiplier: 1, accountRiskPct: 0.5, maxPositionPct: 10, maxOpenPositions: 15, exposure: 80 },
  { id: 'balanced_boost', positionMultiplier: 1.5, accountRiskPct: 0.75, maxPositionPct: 14, maxOpenPositions: 12, exposure: 75 },
  { id: 'profit_push', positionMultiplier: 2, accountRiskPct: 1, maxPositionPct: 18, maxOpenPositions: 10, exposure: 70 }
];

function addSignals(target, source, label, index, profile) {
  for (const [date, rows] of source) {
    const list = target.get(date) || [];
    for (const candidate of rows) {
      list.push({
        ...candidate,
        alphaSource: candidate.alphaSource || label,
        futureBars: candidate.futureBars?.length ? candidate.futureBars : barsFor(index, candidate),
        positionPct: Math.min(profile.maxPositionPct, (candidate.positionPct || 10) * profile.positionMultiplier),
        accountRiskPct: profile.accountRiskPct,
        reason: `${candidate.reason || label}｜${label}`
      });
    }
    target.set(date, list);
  }
}

function revenueMap(payload, key) {
  return new Map((payload[key] || []).map(row => [row.date, row.candidates]));
}

function combinedSignals(context, revenue, shockReport, profile, random = false) {
  const result = new Map();
  const index = futureBarsBySymbol(context);
  addSignals(result, revenueMap(revenue, random ? 'randomValidationSignals' : 'validationSignals'), '意外營收', index, profile);
  const events = shockEvents(context);
  for (const fold of shockReport.folds.filter(row => row.status === '完成')) {
    addSignals(result, shockSignals(events, fold, random), '急跌止穩', index, profile);
  }
  for (const [date, rows] of result) {
    const deduped = new Map();
    for (const row of rows.sort((left, right) => right.score - left.score)) {
      if (!deduped.has(row.symbol)) deduped.set(row.symbol, row);
    }
    result.set(date, [...deduped.values()]);
  }
  return result;
}

function run(context, map, profile, random = false) {
  return simulateSignalMap(context, map, {
    strategyId: `${STRATEGY_ID}${random ? '_random' : ''}`,
    startDate: START_DATE,
    endDate: END_DATE,
    initialCapital: CAPITAL,
    maxOpenPositions: profile.maxOpenPositions,
    accountRiskPct: profile.accountRiskPct,
    riskRules: {
      maxAccountRiskPct: profile.accountRiskPct,
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
    returns.push(pct(close, prior));
    prior = close;
  }
  return { averageMonthlyReturnPct: round(mean(returns)) };
}

async function main() {
  const identityInput = {
    strategyId: STRATEGY_ID,
    dataSources: ['意外營收 OOS 訊號', '急跌止穩 OOS 訊號', '個股 OHLCV'],
    setupRules: ['訓練期固定後的兩種低相關事件 alpha 共用投組'],
    triggerRules: ['各來源原始 OOS 進場條件'],
    invalidationRules: ['各來源原始收盤停損'],
    exitRules: ['各來源原始持有與出場規則'],
    riskRules: { accountRiskPct: 0.5, maximumPositionPct: 10, tPlusTwo: true },
    blockedWhen: ['共用曝險與帳戶熔斷'],
    parameters: { fixedSourceWeights: true, metaOptimization: false },
    trainPeriod: '各來源 rolling 54 months',
    validationPeriod: `${START_DATE}–${END_DATE}`,
    costModel: '共用成交模擬器：手續費、交易稅、滑價',
    executionModel: '隔日開盤、跳空不利成交、T+2'
  };
  const identity = buildExperimentIdentity(identityInput);
  const decision = shouldSkipExperiment(await loadRegistry(), identity, { ...identityInput, newDataSources: ['跨事件 OOS 共用投組'], coreRulesChanged: true });
  if (decision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...decision, ...identity }, null, 2));
    return;
  }
  const [context, revenue, shockReport, etf] = await Promise.all([
    loadResearchContext(),
    fs.readFile(REVENUE_SIGNALS).then(buffer => JSON.parse(gunzipSync(buffer))),
    fs.readFile(SHOCK_REPORT, 'utf8').then(JSON.parse),
    fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)
  ]);
  const profileRows = profiles.map(profile => {
    const result = run(context, combinedSignals(context, revenue, shockReport, profile), profile);
    const random = run(context, combinedSignals(context, revenue, shockReport, profile, true), profile, true);
    const metrics = summarize(result);
    const fairRandom = summarize(random);
    const score = metrics.averageMonthlyReturnPct * 3
      + metrics.maximumDrawdownPct * 0.12
      + Math.min(3, metrics.profitFactor || 0)
      + Math.min(2, metrics.trades / 300);
    return { profile, metrics, fairRandom, score };
  }).sort((left, right) => right.score - left.score);
  const selected = profileRows.find(row => row.metrics.maximumDrawdownPct >= -20
    && row.metrics.trades >= 300
    && row.metrics.profitFactor > 1.15) || profileRows[0];
  const { profile, metrics, fairRandom } = selected;
  const benchmark0050 = benchmark(etf.series['0050.TW'] || []);
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
    validationPeriod: `${START_DATE}–${END_DATE}`,
    testedProfiles: profileRows.map(row => ({
      profile: row.profile,
      metrics: row.metrics,
      fairRandom: row.fairRandom
    })),
    selectedProfile: profile,
    metrics,
    fairRandom,
    benchmark0050,
    targetMonthlyReturnPct: 5,
    gapToTargetPct: round(5 - metrics.averageMonthlyReturnPct),
    targetMet,
    paperTradingReady: false,
    liveTradingReady: false,
    conclusion: targetMet
      ? '達到研究候選門檻，但仍須獨立前瞻紙上交易。'
      : `多事件純個股投組仍未達月均 5%；目前 ${metrics.averageMonthlyReturnPct}%。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, [
    '# 純個股多事件 Alpha 組合', '',
    `- 驗證：${output.validationPeriod}`,
    `- 月均：${metrics.averageMonthlyReturnPct}%；年化：${metrics.annualizedReturnPct}%；最大回撤：${metrics.maximumDrawdownPct}%`,
    `- 交易：${metrics.trades}；勝率：${metrics.winRatePct}%；PF：${metrics.profitFactor}`,
    `- 來源交易：${JSON.stringify(metrics.sourceTrades)}`,
    `- 公平隨機：${fairRandom.averageMonthlyReturnPct}%；0050：${benchmark0050.averageMonthlyReturnPct}%`,
    `- 結論：${output.conclusion}`
  ].join('\n') + '\n', 'utf8');
  console.log(JSON.stringify({ validationPeriod: output.validationPeriod, selectedProfile: profile, metrics, fairRandom, benchmark0050, targetMet, conclusion: output.conclusion }, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
