import fs from 'node:fs/promises';
import {
  FOLDS,
  aggregate,
  avg,
  benchmark0050,
  buildBreadth,
  buildMarketRisk,
  cashMetrics,
  loadData,
  round,
  simulate
} from './stock-official-market-walk-forward-v2.mjs';
import { buildExperimentIdentity, loadRegistry, shouldSkipExperiment } from './strategy-experiment-registry.mjs';

const REVENUE = new URL('../../data/revenue/monthly-revenue.json', import.meta.url);
const QUALITY = new URL('../../data/quality/financial-quality.json', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-fundamental-official-walk-forward-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_FUNDAMENTAL_OFFICIAL_WALK_FORWARD_V1.md', import.meta.url);

function dedupe(rows, key) {
  const map = new Map();
  for (const row of rows) {
    if (!row.isPointInTimeSafe || !row.effectiveDate) continue;
    const id = key(row);
    const prior = map.get(id);
    if (!prior || row.effectiveDate < prior.effectiveDate) map.set(id, row);
  }
  return [...map.values()];
}

function group(rows) {
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row.symbol) || [];
    list.push(row);
    map.set(row.symbol, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  return map;
}

function firstIndex(rows, date) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle].date < date) low = middle + 1;
    else high = middle;
  }
  return low;
}

function latestBefore(rows, date) {
  if (!rows?.length) return null;
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle].effectiveDate <= date) low = middle + 1;
    else high = middle;
  }
  return rows[low - 1] || null;
}

function marketFeatures(rows, index) {
  if (index < 130 || index + 1 >= rows.length) return null;
  const row = rows[index];
  const previous = rows[index - 1];
  const next = rows[index + 1];
  const ma20 = avg(rows.slice(index - 19, index + 1).map(item => item.close));
  const ma60 = avg(rows.slice(index - 59, index + 1).map(item => item.close));
  const ma20Prior = avg(rows.slice(index - 24, index - 4).map(item => item.close));
  const high20 = Math.max(...rows.slice(index - 20, index).map(item => item.high));
  const value20 = avg(rows.slice(index - 19, index + 1).map(item => item.tradeValue));
  return {
    symbol: row.symbol,
    name: row.name,
    market: row.market,
    signalDate: row.date,
    entryDate: next.date,
    entryOpen: next.open,
    tradeValue: row.tradeValue,
    volumeRatio20: row.tradeValue / Math.max(1, value20),
    atr20Pct: avg(rows.slice(index - 19, index + 1).map(item => (item.high - item.low) / item.close * 100)),
    mom5: (row.close / rows[index - 5].close - 1) * 100,
    mom20: (row.close / rows[index - 20].close - 1) * 100,
    mom60: (row.close / rows[index - 60].close - 1) * 100,
    ma20SlopePct: (ma20 / ma20Prior - 1) * 100,
    ma20,
    distanceToMa20Pct: (row.close / ma20 - 1) * 100,
    ma20AboveMa60: ma20 > ma60,
    breakout20: row.close > high20,
    pullback20: ma20 > ma60 && row.low <= ma20 * 1.025 && row.close >= ma20 && row.close > row.open,
    turnStrong: row.close > previous.high && row.close > row.open
  };
}

function addSetup(output, common, setup, score, event) {
  output.push({
    ...common,
    setup,
    score,
    eventEffectiveDate: event.effectiveDate,
    setupReason: setup === 'quality_repricing'
      ? '盈餘與毛利品質改善後價格轉強'
      : '營收成長獲利品質確認後價格轉強'
  });
}

function buildSetups(histories, revenueRows, qualityRows) {
  const revenues = group(dedupe(revenueRows, row => `${row.symbol}|${row.revenueMonth}`));
  const qualities = group(dedupe(qualityRows, row => `${row.symbol}|${row.quarter}`));
  const setups = [];
  for (const [symbol, rows] of histories) {
    const baseSymbol = rows[0]?.id || symbol.split('.')[0];
    const stockRevenue = revenues.get(baseSymbol) || [];
    const stockQuality = qualities.get(baseSymbol) || [];
    for (const event of stockRevenue) {
      const index = firstIndex(rows, event.effectiveDate);
      const common = marketFeatures(rows, index);
      const quality = latestBefore(stockQuality, common?.signalDate);
      if (!common || !quality || quality.EPS <= 0) continue;
      const epsGrowth = quality.epsYoY ?? -100;
      const grossChange = quality.grossMarginYoYChange ?? quality.grossMarginQoQChange ?? -99;
      const operatingChange = quality.operatingMarginYoYChange ?? quality.operatingMarginQoQChange ?? -99;
      const yoy = event.YoY ?? event.reportedYoY ?? -100;
      const qualityScore = Math.max(-20, epsGrowth) * 0.2 + Math.max(-5, grossChange) * 2 + Math.max(-5, operatingChange) * 2;
      const qualityConfirmed = epsGrowth >= 0 || grossChange + operatingChange > 0;
      if (yoy >= 10 && qualityConfirmed && common.breakout20 && common.volumeRatio20 >= 1) {
        addSetup(setups, common, 'fundamental_breakout', yoy * 0.25 + qualityScore + common.mom20 + common.volumeRatio20 * 5, event);
      }
      if (yoy >= 5 && event.yoyAcceleration && qualityConfirmed && common.pullback20 && common.mom60 > 3) {
        addSetup(setups, common, 'fundamental_pullback', yoy * 0.2 + qualityScore + common.mom60 * 0.5 - Math.abs(common.distanceToMa20Pct), event);
      }
    }
    for (const event of stockQuality) {
      const index = firstIndex(rows, event.effectiveDate);
      const common = marketFeatures(rows, index);
      const revenue = latestBefore(stockRevenue, common?.signalDate);
      if (!common || !revenue) continue;
      const epsGrowth = event.epsYoY ?? -100;
      const grossChange = event.grossMarginYoYChange ?? event.grossMarginQoQChange ?? -99;
      const operatingChange = event.operatingMarginYoYChange ?? event.operatingMarginQoQChange ?? -99;
      const yoy = revenue.YoY ?? revenue.reportedYoY ?? -100;
      if (event.EPS > 0 && epsGrowth >= 15 && grossChange + operatingChange > 0 && yoy >= 0
        && common.ma20AboveMa60 && common.turnStrong && common.distanceToMa20Pct <= 12) {
        addSetup(setups, common, 'quality_repricing', epsGrowth * 0.25 + grossChange * 2 + operatingChange * 2 + common.mom20, event);
      }
    }
    let revenueCursor = -1;
    let qualityCursor = -1;
    for (let index = 130; index < rows.length - 1; index += 1) {
      const date = rows[index].date;
      while (revenueCursor + 1 < stockRevenue.length && stockRevenue[revenueCursor + 1].effectiveDate <= date) revenueCursor += 1;
      while (qualityCursor + 1 < stockQuality.length && stockQuality[qualityCursor + 1].effectiveDate <= date) qualityCursor += 1;
      const revenue = stockRevenue[revenueCursor];
      const quality = stockQuality[qualityCursor];
      if (!revenue || !quality) continue;
      const revenueAge = (Date.parse(date) - Date.parse(revenue.effectiveDate)) / 86_400_000;
      const qualityAge = (Date.parse(date) - Date.parse(quality.effectiveDate)) / 86_400_000;
      if (revenueAge > 60 || qualityAge > 180 || quality.EPS <= 0) continue;
      const common = marketFeatures(rows, index);
      const yoy = revenue.YoY ?? revenue.reportedYoY ?? -100;
      const epsGrowth = quality.epsYoY ?? -100;
      const grossChange = quality.grossMarginYoYChange ?? quality.grossMarginQoQChange ?? -99;
      const operatingChange = quality.operatingMarginYoYChange ?? quality.operatingMarginQoQChange ?? -99;
      const qualityConfirmed = epsGrowth >= 0 || grossChange + operatingChange > 0;
      const trendConfirmed = common && yoy >= 10 && qualityConfirmed && common.ma20AboveMa60 && common.mom20 >= 3
        && common.mom60 >= 8 && common.distanceToMa20Pct >= -1 && common.distanceToMa20Pct <= 12;
      if (trendConfirmed && [2, 5].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) {
        const score = yoy * 0.2 + Math.max(-20, epsGrowth) * 0.15 + (grossChange + operatingChange) * 1.5
          + common.mom20 * 0.5 + common.mom60 * 0.4 - common.atr20Pct * 2 - common.distanceToMa20Pct * 0.5;
        addSetup(setups, common, 'fundamental_persistence', score, revenue);
      }
      if (trendConfirmed && common.turnStrong && common.volumeRatio20 >= 0.8) {
        const score = yoy * 0.2 + Math.max(-20, epsGrowth) * 0.15 + (grossChange + operatingChange) * 1.5
          + common.mom20 * 0.6 + common.mom60 * 0.35 + common.volumeRatio20 * 4 - common.atr20Pct * 2;
        addSetup(setups, common, 'fundamental_reacceleration', score, revenue);
      }
    }
  }
  const byDate = new Map();
  for (const setup of setups) {
    const list = byDate.get(setup.signalDate) || [];
    list.push(setup);
    byDate.set(setup.signalDate, list);
  }
  for (const rows of byDate.values()) {
    rows.sort((a, b) => b.score - a.score).forEach((row, index) => {
      row.strengthRankPct = rows.length === 1 ? 1 : 1 - index / (rows.length - 1);
      row.score += row.strengthRankPct * 15;
    });
  }
  return setups;
}

function configs() {
  const families = [
    { setup: 'fundamental_breakout', minValue: 30e6, minMom20: 0, minMom60: 0, maxAtr: 9, minVolumeRatio: 1, maxDistance: 18, minRank: 0.25 },
    { setup: 'fundamental_pullback', minValue: 30e6, minMom20: -10, minMom60: 3, maxAtr: 9, minVolumeRatio: 0.4, maxDistance: 6, minRank: 0.2 },
    { setup: 'quality_repricing', minValue: 30e6, minMom20: -5, minMom60: 0, maxAtr: 9, minVolumeRatio: 0.5, maxDistance: 12, minRank: 0.2 },
    { setup: 'fundamental_persistence', minValue: 50e6, minMom20: 3, minMom60: 8, maxAtr: 8, minVolumeRatio: 0.5, maxDistance: 12, minRank: 0.5 },
    { setup: 'fundamental_reacceleration', minValue: 50e6, minMom20: 3, minMom60: 8, maxAtr: 8, minVolumeRatio: 0.8, maxDistance: 12, minRank: 0.5 }
  ];
  const output = [];
  for (const family of families) {
    for (const top of [5, 10]) for (const holdDays of [10, 20, 40]) for (const stopLossPct of [5, 8]) {
      for (const takeProfitPct of [12, 20, 30]) for (const marketMode of ['strong', 'breadth']) {
        output.push({ ...family, id: `${family.setup}_top${top}_h${holdDays}_s${stopLossPct}_t${takeProfitPct}_${marketMode}`, top, holdDays, stopLossPct, takeProfitPct, marketMode, stopMode: 'intraday', positionPct: 10, accountRiskPct: 0.5 });
      }
    }
  }
  return output;
}

function score(metrics) {
  if (metrics.trades < 35 || metrics.profitFactor < 0.95 || metrics.maximumDrawdownPct < -20) return -Infinity;
  const middle = Math.floor(metrics.monthly.length / 2);
  const stability = Math.min(avg(metrics.monthly.slice(0, middle).map(row => row.returnPct)), avg(metrics.monthly.slice(middle).map(row => row.returnPct)));
  if (stability < -0.15) return -Infinity;
  return metrics.averageMonthlyReturnPct * 4 + stability * 2 + metrics.profitFactor + metrics.maximumDrawdownPct * 0.08 + Math.min(metrics.trades, 300) / 300;
}

const experiment = {
  strategyId: 'stock_fundamental_official_walk_forward_v1',
  dataSources: ['官方個股日線 OHLCV', '保守 T+1 月營收', '保守 T+1 財報品質'],
  setupRules: ['營收與 EPS 同步成長後突破或回測', 'EPS 與毛利、營益率同步改善後轉強'],
  triggerRules: ['effectiveDate 後價格確認，下一交易日開盤'],
  invalidationRules: ['盤中停損與移動停利'],
  exitRules: ['固定目標、移動停利、最長持有日'],
  riskRules: { accountRiskPct: 0.5, maximumPositionPct: 10, tPlusTwo: true },
  blockedWhen: ['大盤弱勢、波動過高、流動性不足'],
  parameters: { families: 5, configurationsPerFold: 360 },
  trainPeriod: '每段 72 個月',
  validationPeriod: '每段 24 個月，合併 2020-2025',
  costModel: '手續費、交易稅、雙邊滑價、最低手續費',
  executionModel: '訊號後下一交易日開盤、跳空停損採較差開盤價、T+2'
};
const identity = buildExperimentIdentity(experiment);
const duplicate = shouldSkipExperiment(await loadRegistry(), identity, { ...experiment, coreRulesChanged: true });
if (duplicate.skip && !process.argv.includes('--force')) {
  console.log(JSON.stringify({ skipped: true, ...duplicate, ...identity }, null, 2));
  process.exit(0);
}

const [{ histories, dailyBars, coverage }, revenuePayload, qualityPayload, etfPayload] = await Promise.all([
  loadData(),
  fs.readFile(REVENUE, 'utf8').then(JSON.parse),
  fs.readFile(QUALITY, 'utf8').then(JSON.parse),
  fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)
]);
const setups = buildSetups(histories, revenuePayload.records || [], qualityPayload.records || []);
const dates = [...dailyBars.keys()].sort();
const benchmarkSeries = etfPayload.series?.['0050.TW'] || [];
const marketRisk = buildMarketRisk(benchmarkSeries, buildBreadth(histories));
const allConfigs = configs();
const folds = [];
for (const fold of FOLDS) {
  let selected;
  for (const config of allConfigs) {
    const train = simulate(setups, dailyBars, dates, marketRisk, config, fold.train);
    const candidate = { config, train, score: score(train) };
    if (!selected || candidate.score > selected.score) selected = candidate;
  }
  const enabled = Number.isFinite(selected.score) && selected.train.averageMonthlyReturnPct > 0 && selected.train.profitFactor >= 1.05;
  folds.push({
    trainPeriod: fold.train,
    validationPeriod: fold.validation,
    strategyEnabled: enabled,
    selectedConfig: selected.config,
    trainMetrics: selected.train,
    validation: enabled ? simulate(setups, dailyBars, dates, marketRisk, selected.config, fold.validation) : cashMetrics(fold.validation, dates),
    candidateRandom: enabled ? simulate(setups, dailyBars, dates, marketRisk, selected.config, fold.validation, true) : cashMetrics(fold.validation, dates)
  });
}
const metrics = aggregate(folds.map(row => row.validation));
const candidateRandom = aggregate(folds.map(row => row.candidateRandom));
const benchmark = await benchmark0050(benchmarkSeries);
const passed = metrics.averageMonthlyReturnPct >= 5 && metrics.maximumDrawdownPct >= -20 && metrics.trades >= 300
  && metrics.profitFactor > 1.15 && metrics.averageMonthlyReturnPct > benchmark.averageMonthlyReturnPct
  && metrics.averageMonthlyReturnPct > candidateRandom.averageMonthlyReturnPct;
const output = {
  generatedAt: new Date().toISOString(),
  ...identity,
  registryChecked: true,
  universe: 'TWSE_TPEX_COMMON_STOCKS_ONLY',
  pointInTimePolicy: '月營收與財報只在 effectiveDate 後使用，訊號再延後至下一交易日成交',
  coverage,
  symbols: histories.size,
  fundamentalSetups: setups.length,
  setupBreakdown: Object.fromEntries([...new Set(setups.map(row => row.setup))].map(name => [name, setups.filter(row => row.setup === name).length])),
  testedConfigurationsPerFold: allConfigs.length,
  folds,
  metrics,
  benchmark0050: benchmark,
  candidateRandom,
  targetMonthlyReturnPct: 5,
  targetGapPct: round(5 - metrics.averageMonthlyReturnPct),
  passed,
  paperTradingReady: passed,
  liveTradingReady: false,
  conclusion: passed ? '通過研究門檻，仍須先紙上交易。' : `未達可信月均 5%；目前 ${metrics.averageMonthlyReturnPct}%，不可宣稱完成或可實盤。`
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 官方個股基本面確認長期驗證 v1\n\n- 驗證：2020-01-01 至 2025-12-31，共 ${metrics.validationMonths} 個月\n- 個股交易：${metrics.trades} 筆；ETF 交易占比 0%\n- 月均總資產報酬：${metrics.averageMonthlyReturnPct}%\n- 年化報酬：${metrics.annualizedReturnPct}%\n- 最大回撤：${metrics.maximumDrawdownPct}%\n- Profit Factor：${metrics.profitFactor}\n- 勝率：${metrics.winRatePct}%\n- 0050 月均：${benchmark.averageMonthlyReturnPct}%\n- 候選池隨機排序月均：${candidateRandom.averageMonthlyReturnPct}%\n- 結論：${output.conclusion}\n\n資料只在保守 effectiveDate 後使用；成交使用下一交易日開盤、真實費稅與滑價、T+2、跳空停損較差價格及每日總資產計價。\n`, 'utf8');
console.log(JSON.stringify({ metrics, benchmark, candidateRandom, selected: folds.map(row => row.selectedConfig.id), passed, conclusion: output.conclusion }, null, 2));
