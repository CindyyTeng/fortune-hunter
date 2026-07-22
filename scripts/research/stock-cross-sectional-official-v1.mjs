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

const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const FUNDAMENTAL_BASELINE = new URL('../../data/research/stock-fundamental-official-walk-forward-v1.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-cross-sectional-official-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_CROSS_SECTIONAL_OFFICIAL_V1.md', import.meta.url);

function deviation(values) {
  const mean = avg(values);
  return Math.sqrt(avg(values.map(value => (value - mean) ** 2)));
}

function buildSetups(histories) {
  const setups = [];
  for (const [symbol, rows] of histories) {
    for (let index = 252; index < rows.length - 1; index += 1) {
      const row = rows[index];
      const next = rows[index + 1];
      if (next.date.slice(0, 7) === row.date.slice(0, 7)) continue;
      const ma20 = avg(rows.slice(index - 19, index + 1).map(item => item.close));
      const ma60 = avg(rows.slice(index - 59, index + 1).map(item => item.close));
      const value20 = avg(rows.slice(index - 19, index + 1).map(item => item.tradeValue));
      const returns60 = rows.slice(index - 59, index + 1).map((item, offset, source) => (
        offset ? (item.close / source[offset - 1].close - 1) * 100 : 0
      )).slice(1);
      const mom12Skip1 = (rows[index - 20].close / rows[index - 252].close - 1) * 100;
      const mom6Skip1 = (rows[index - 20].close / rows[index - 126].close - 1) * 100;
      const nearHigh252 = row.close / Math.max(...rows.slice(index - 251, index + 1).map(item => item.high));
      const common = {
        symbol,
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
        mom12Skip1,
        mom6Skip1,
        volatility60: deviation(returns60) * Math.sqrt(252),
        nearHigh252,
        ma20,
        distanceToMa20Pct: (row.close / ma20 - 1) * 100,
        ma20AboveMa60: ma20 > ma60
      };
      const riskAdjusted12 = mom12Skip1 / Math.max(8, common.volatility60);
      const riskAdjusted6 = mom6Skip1 / Math.max(8, common.volatility60);
      if (mom12Skip1 >= 10 && nearHigh252 >= 0.7 && common.ma20AboveMa60) {
        setups.push({ ...common, setup: 'momentum_12_1', score: riskAdjusted12 * 30 + nearHigh252 * 20 + common.mom60 * 0.2 });
      }
      if (mom6Skip1 >= 8 && nearHigh252 >= 0.7 && common.ma20AboveMa60) {
        setups.push({ ...common, setup: 'momentum_6_1', score: riskAdjusted6 * 30 + nearHigh252 * 20 + common.mom60 * 0.2 });
      }
      if (mom12Skip1 >= 10 && mom6Skip1 >= 8 && nearHigh252 >= 0.75 && common.ma20AboveMa60) {
        setups.push({ ...common, setup: 'dual_horizon_momentum', score: riskAdjusted12 * 18 + riskAdjusted6 * 18 + nearHigh252 * 20 });
      }
    }
  }
  const groups = new Map();
  for (const setup of setups) {
    const key = `${setup.signalDate}|${setup.setup}`;
    const rows = groups.get(key) || [];
    rows.push(setup);
    groups.set(key, rows);
  }
  for (const rows of groups.values()) {
    rows.sort((left, right) => right.score - left.score).forEach((row, index) => {
      row.strengthRankPct = rows.length === 1 ? 1 : 1 - index / (rows.length - 1);
      row.score += row.strengthRankPct * 20;
    });
  }
  return setups;
}

function configs() {
  const families = [
    { setup: 'momentum_12_1', minValue: 50e6, minMom20: -10, minMom60: 0, maxAtr: 8, minVolumeRatio: 0.3, maxDistance: 25, minRank: 0.8 },
    { setup: 'momentum_6_1', minValue: 50e6, minMom20: -10, minMom60: 0, maxAtr: 8, minVolumeRatio: 0.3, maxDistance: 25, minRank: 0.8 },
    { setup: 'dual_horizon_momentum', minValue: 50e6, minMom20: -10, minMom60: 0, maxAtr: 8, minVolumeRatio: 0.3, maxDistance: 25, minRank: 0.75 }
  ];
  const output = [];
  for (const family of families) {
    for (const top of [5, 10, 20]) for (const holdDays of [20, 40, 60]) for (const stopLossPct of [8, 12]) {
      for (const takeProfitPct of [20, 30, 50]) for (const marketMode of ['trend', 'strong', 'breadth']) {
        output.push({
          ...family,
          id: `${family.setup}_top${top}_h${holdDays}_s${stopLossPct}_t${takeProfitPct}_${marketMode}`,
          top,
          holdDays,
          stopLossPct,
          takeProfitPct,
          marketMode,
          stopMode: 'intraday',
          positionPct: Math.min(10, 100 / top),
          accountRiskPct: 0.5
        });
      }
    }
  }
  return output;
}

function trainScore(metrics) {
  if (metrics.trades < 100 || metrics.profitFactor < 0.95 || metrics.maximumDrawdownPct < -25) return -Infinity;
  const size = Math.ceil(metrics.monthly.length / 3);
  const segments = [0, 1, 2].map(index => avg(metrics.monthly.slice(index * size, (index + 1) * size).map(row => row.returnPct)));
  const worst = Math.min(...segments);
  const spread = Math.max(...segments) - worst;
  if (worst < 0) return -Infinity;
  return metrics.averageMonthlyReturnPct * 3 + worst * 3 - spread
    + metrics.profitFactor + metrics.maximumDrawdownPct * 0.08 + Math.min(metrics.trades, 500) / 500;
}

const experiment = {
  strategyId: 'stock_cross_sectional_official_v1',
  dataSources: ['官方上市上櫃普通股日線 OHLCV'],
  setupRules: ['月底計算 12-1、6-1 風險調整動能與 52 週高點距離'],
  triggerRules: ['月底排名後下一交易日開盤成交'],
  invalidationRules: ['盤中停損與移動停利'],
  exitRules: ['固定目標、移動停利、最長持有日'],
  riskRules: { accountRiskPct: 0.5, maximumPositionPct: 10, tPlusTwo: true },
  blockedWhen: ['大盤弱勢、波動過高、流動性不足'],
  parameters: { families: 3, configurationsPerFold: 486, trainStabilitySegments: 3 },
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

const [{ histories, dailyBars, coverage }, etfPayload, fundamentalPayload] = await Promise.all([
  loadData(),
  fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse),
  fs.readFile(FUNDAMENTAL_BASELINE, 'utf8').then(JSON.parse)
]);
const setups = buildSetups(histories);
const dates = [...dailyBars.keys()].sort();
const benchmarkSeries = etfPayload.series?.['0050.TW'] || [];
const marketRisk = buildMarketRisk(benchmarkSeries, buildBreadth(histories));
const allConfigs = configs();
const folds = [];
for (const fold of FOLDS) {
  let selected;
  for (const config of allConfigs) {
    const train = simulate(setups, dailyBars, dates, marketRisk, config, fold.train);
    const candidate = { config, train, score: trainScore(train) };
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
const fundamentalBaseline = fundamentalPayload.metrics;
const improvements = {
  monthlyReturn: metrics.averageMonthlyReturnPct > fundamentalBaseline.averageMonthlyReturnPct,
  maximumDrawdown: metrics.maximumDrawdownPct > fundamentalBaseline.maximumDrawdownPct,
  tradeCount: metrics.trades > fundamentalBaseline.trades
};
const passed = metrics.averageMonthlyReturnPct >= 5 && metrics.maximumDrawdownPct >= -20 && metrics.trades >= 300
  && metrics.profitFactor > 1.15 && metrics.averageMonthlyReturnPct > benchmark.averageMonthlyReturnPct
  && metrics.averageMonthlyReturnPct > candidateRandom.averageMonthlyReturnPct;
const output = {
  generatedAt: new Date().toISOString(),
  ...identity,
  registryChecked: true,
  universe: 'TWSE_TPEX_COMMON_STOCKS_ONLY',
  coverage,
  symbols: histories.size,
  setups: setups.length,
  setupBreakdown: Object.fromEntries([...new Set(setups.map(row => row.setup))].map(name => [name, setups.filter(row => row.setup === name).length])),
  testedConfigurationsPerFold: allConfigs.length,
  folds,
  metrics,
  benchmark0050: benchmark,
  candidateRandom,
  fundamentalBaseline,
  improvements,
  targetMonthlyReturnPct: 5,
  targetGapPct: round(5 - metrics.averageMonthlyReturnPct),
  passed,
  paperTradingReady: passed,
  liveTradingReady: false,
  conclusion: passed ? '通過研究門檻，仍須先紙上交易。' : `未達可信月均 5%；目前 ${metrics.averageMonthlyReturnPct}%，不可宣稱完成或可實盤。`
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 官方全市場個股橫斷面動能 v1\n\n- 驗證：2020-01-01 至 2025-12-31，共 ${metrics.validationMonths} 個月\n- 個股交易：${metrics.trades} 筆；ETF 交易占比 0%\n- 月均總資產報酬：${metrics.averageMonthlyReturnPct}%\n- 年化報酬：${metrics.annualizedReturnPct}%\n- 最大回撤：${metrics.maximumDrawdownPct}%\n- Profit Factor：${metrics.profitFactor}\n- 勝率：${metrics.winRatePct}%\n- 0050 月均：${benchmark.averageMonthlyReturnPct}%\n- 候選池隨機排序月均：${candidateRandom.averageMonthlyReturnPct}%\n- 修正後基本面基準：月均 ${fundamentalBaseline.averageMonthlyReturnPct}%、最大回撤 ${fundamentalBaseline.maximumDrawdownPct}%、${fundamentalBaseline.trades} 筆\n- 三項比較：月均較高 ${improvements.monthlyReturn ? '是' : '否'}、回撤較小 ${improvements.maximumDrawdown ? '是' : '否'}、交易較多 ${improvements.tradeCount ? '是' : '否'}\n- 結論：${output.conclusion}\n\n每月底只使用當時以前 6 至 12 個月資料，跳過最近 20 日，隔月開盤成交；包含真實費稅、滑價、T+2、跳空停損及每日總資產計價。\n`, 'utf8');
console.log(JSON.stringify({ metrics, benchmark, candidateRandom, selected: folds.map(row => row.selectedConfig.id), passed, conclusion: output.conclusion }, null, 2));
