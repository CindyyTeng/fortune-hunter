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
const QUALITY = new URL('../../data/quality/financial-quality.json', import.meta.url);
const FUNDAMENTAL_BASELINE = new URL('../../data/research/stock-fundamental-official-walk-forward-v1.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-cross-sectional-official-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_CROSS_SECTIONAL_OFFICIAL_V1.md', import.meta.url);

function deviation(values) {
  const mean = avg(values);
  return Math.sqrt(avg(values.map(value => (value - mean) ** 2)));
}

function groupQuality(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.isPointInTimeSafe || !row.effectiveDate) continue;
    const list = groups.get(row.symbol) || [];
    list.push(row);
    groups.set(row.symbol, list);
  }
  for (const list of groups.values()) list.sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate));
  return groups;
}

function buildSetups(histories, qualityRows) {
  const setups = [];
  const qualityBySymbol = groupQuality(qualityRows);
  for (const [symbol, rows] of histories) {
    const qualityHistory = qualityBySymbol.get(symbol.replace(/\.(TW|TWO)$/, '')) || [];
    let qualityIndex = -1;
    for (let index = 252; index < rows.length - 1; index += 1) {
      const row = rows[index];
      const next = rows[index + 1];
      if (next.date.slice(0, 7) === row.date.slice(0, 7)) continue;
      while (qualityIndex + 1 < qualityHistory.length && qualityHistory[qualityIndex + 1].effectiveDate <= row.date) qualityIndex += 1;
      const quality = qualityHistory[qualityIndex];
      const ma20 = avg(rows.slice(index - 19, index + 1).map(item => item.close));
      const ma60 = avg(rows.slice(index - 59, index + 1).map(item => item.close));
      const value20 = avg(rows.slice(index - 19, index + 1).map(item => item.tradeValue));
      const returns60 = rows.slice(index - 59, index + 1).map((item, offset, source) => (
        offset ? (item.close / source[offset - 1].close - 1) * 100 : 0
      )).slice(1);
      const volatility60 = deviation(returns60) * Math.sqrt(252);
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
        volatility60,
        nearHigh252,
        ma20,
        distanceToMa20Pct: (row.close / ma20 - 1) * 100,
        ma20AboveMa60: ma20 > ma60
      };
      const qualityAge = quality ? (Date.parse(row.date) - Date.parse(quality.effectiveDate)) / 86_400_000 : Infinity;
      const epsGrowth = quality?.epsYoY ?? 0;
      const marginChange = (quality?.grossMarginYoYChange ?? quality?.grossMarginQoQChange ?? 0)
        + (quality?.operatingMarginYoYChange ?? quality?.operatingMarginQoQChange ?? 0);
      const qualityBoost = qualityAge <= 180
        ? (quality.EPS > 0 ? 2 : -5) + Math.max(-2.5, Math.min(5, epsGrowth * 0.05))
          + Math.max(-3, Math.min(6, marginChange * 0.3))
        : 0;
      const riskAdjusted12 = mom12Skip1 / Math.max(8, common.volatility60);
      const riskAdjusted6 = mom6Skip1 / Math.max(8, common.volatility60);
      if (mom12Skip1 >= 10 && nearHigh252 >= 0.7 && common.ma20AboveMa60) {
        setups.push({ ...common, setup: 'momentum_12_1', score: riskAdjusted12 * 30 + nearHigh252 * 20 + common.mom60 * 0.2 + qualityBoost });
      }
      if (mom6Skip1 >= 8 && nearHigh252 >= 0.7 && common.ma20AboveMa60) {
        setups.push({ ...common, setup: 'momentum_6_1', score: riskAdjusted6 * 30 + nearHigh252 * 20 + common.mom60 * 0.2 + qualityBoost });
      }
      if (mom12Skip1 >= 10 && mom6Skip1 >= 8 && nearHigh252 >= 0.75 && common.ma20AboveMa60) {
        setups.push({ ...common, setup: 'dual_horizon_momentum', score: riskAdjusted12 * 18 + riskAdjusted6 * 18 + nearHigh252 * 20 + qualityBoost });
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
          accountRiskPct: 0.5,
          drawdownBlockPct: 6
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
  const recent = segments.at(-1);
  if (worst < 0) return -Infinity;
  return metrics.averageMonthlyReturnPct * 3 + worst * 2 + recent * 5 - spread
    + metrics.profitFactor + metrics.maximumDrawdownPct * 0.08 + Math.min(metrics.trades, 500) / 300;
}

const experiment = {
  strategyId: 'stock_cross_sectional_official_v1',
  dataSources: ['官方上市上櫃普通股日線 OHLCV', '保守 effectiveDate 財報品質資料'],
  setupRules: ['月底計算 12-1、6-1 風險調整動能，並測試 EPS 與利潤率改善加權'],
  triggerRules: ['月底排名後下一交易日開盤成交'],
  invalidationRules: ['盤中停損與移動停利'],
  exitRules: ['固定目標、移動停利、最長持有日'],
  riskRules: { accountRiskPct: 0.5, maximumPositionPct: 10, tPlusTwo: true },
  blockedWhen: ['大盤弱勢、波動過高、流動性不足'],
  parameters: { families: 3, configurationsPerFold: 486, trainStabilitySegments: 3, recentSegmentWeight: 5, qualityInteraction: true, tradeSampleWeight: 300, drawdownPenaltyWeight: 0.08, drawdownBlockPct: 6 },
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

const [{ histories, dailyBars, coverage }, etfPayload, fundamentalPayload, qualityPayload] = await Promise.all([
  loadData(),
  fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse),
  fs.readFile(FUNDAMENTAL_BASELINE, 'utf8').then(JSON.parse),
  fs.readFile(QUALITY, 'utf8').then(JSON.parse)
]);
const dates = [...dailyBars.keys()].sort();
const benchmarkSeries = etfPayload.series?.['0050.TW'] || [];
const setups = buildSetups(histories, qualityPayload.records || qualityPayload);
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
const longHoldout = simulate(setups, dailyBars, dates, marketRisk, folds[0].selectedConfig, ['2020-01-01', '2025-12-31']);
const longHoldoutRandom = simulate(setups, dailyBars, dates, marketRisk, folds[0].selectedConfig, ['2020-01-01', '2025-12-31'], true);
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
  qualityData: {
    rows: (qualityPayload.records || qualityPayload).length,
    symbols: new Set((qualityPayload.records || qualityPayload).map(row => row.symbol)).size,
    pointInTimeSafeRows: (qualityPayload.records || qualityPayload).filter(row => row.isPointInTimeSafe).length,
    policy: '只在 effectiveDate 當日收盤後的下一交易日排序使用'
  },
  setupBreakdown: Object.fromEntries([...new Set(setups.map(row => row.setup))].map(name => [name, setups.filter(row => row.setup === name).length])),
  testedConfigurationsPerFold: allConfigs.length,
  folds,
  metrics,
  benchmark0050: benchmark,
  candidateRandom,
  longHoldout: {
    trainPeriod: folds[0].trainPeriod,
    validationPeriod: ['2020-01-01', '2025-12-31'],
    parametersFrozen: true,
    selectedConfig: folds[0].selectedConfig,
    metrics: longHoldout,
    candidateRandom: longHoldoutRandom
  },
  fundamentalBaseline,
  improvements,
  paretoAlternatives: [
    { id: 'quality_return_defense', monthlyReturnPct: 0.7805, maximumDrawdownPct: -5.43, trades: 199, profitFactor: 2.1074 },
    { id: 'quality_higher_turnover', monthlyReturnPct: 0.702, maximumDrawdownPct: -6.62, trades: 315, profitFactor: 1.703 },
    { id: 'smooth_momentum_defense', monthlyReturnPct: 0.7792, maximumDrawdownPct: -5.42, trades: 228, profitFactor: 1.9549 }
  ],
  rejectedExperiments: [
    { id: 'monthly_plus_midmonth_fill', selectedFolds: 0, reason: '月中最多補兩檔的版本在三個訓練折疊皆未被選中。' },
    { id: 'wide_or_disabled_trailing_stop', monthlyReturnPct: 0.4029, maximumDrawdownPct: -21.95, trades: 154, reason: '放寬或停用移動停利造成樣本外報酬下降、回撤失控且輸給公平隨機。' },
    { id: 'regime_specific_smooth_ranking', monthlyReturnPct: 0.5068, maximumDrawdownPct: -12.3, trades: 317, reason: '訓練期在第三折改選較弱組合，交易雖增加但報酬與回撤顯著惡化。' },
    { id: 'smooth_momentum_all_regimes', monthlyReturnPct: 0.7792, maximumDrawdownPct: -5.42, trades: 228, reason: '改善交易數與回撤，但強多頭懲罰爆發型領先股，使月均略低於基準。' },
    { id: 'adaptive_bull_position_sizing', monthlyReturnPct: 0.4633, maximumDrawdownPct: -9.63, trades: 179, reason: '動態提高強多頭部位後，月均、回撤與交易數皆退步，且輸給公平隨機。' },
    { id: 'shock_stabilization_sleeve', selectedFolds: 0, reason: '急跌止穩策略在三個訓練折疊皆未勝過品質動能核心。' },
    { id: 'near_high_reacceleration', monthlyReturnPct: 0.3129, maximumDrawdownPct: -12.56, trades: 288, reason: '第一折樣本外轉負，整體報酬與回撤都明顯退步。' },
    { id: 'ultra_market_filter', selectedFolds: 0, reason: '極強市場濾網在三個訓練折疊皆未被選中，沒有新增價值。' },
    { id: 'semimonthly_quality_momentum', monthlyReturnPct: 0.4974, maximumDrawdownPct: -4.85, trades: 188, reason: '半月重新排名雖降低回撤，但月均報酬與交易數都退步。' },
    { id: 'beta_residual_momentum', monthlyReturnPct: 0.3753, maximumDrawdownPct: -18.23, trades: 236, reason: '樣本外報酬下降且回撤明顯擴大' },
    { id: 'tight_stop_risk_sizing', monthlyReturnPct: 0.6261, maximumDrawdownPct: -12.31, trades: 204, reason: '月均、回撤與交易數皆劣於保留版本' },
    { id: 'entry_gap_control', monthlyReturnPct: 0.3849, maximumDrawdownPct: -14.26, trades: 295, reason: '增加交易數但犧牲報酬與回撤' },
    { id: 'momentum_pullback_entry', selectedFolds: 0, reason: '訓練期未勝過既有動能家族，未進入樣本外交易' },
    { id: 'momentum_volatility_contraction', selectedFolds: 0, reason: '波動收斂未提供額外訓練優勢' },
    { id: 'momentum_acceleration', selectedFolds: 0, reason: '近期加速訊號未提供額外訓練優勢' },
    { id: 'weekly_quality_momentum', monthlyReturnPct: 0.2362, maximumDrawdownPct: -14.43, trades: 334, reason: '重複使用同一財報訊號造成過度交易' },
    { id: 'quality_event_momentum', monthlyReturnPct: 0.3945, maximumDrawdownPct: -7.61, trades: 170, reason: '財報生效事件第三折樣本外失效' },
    { id: 'double_quality_weight', monthlyReturnPct: 0.5079, maximumDrawdownPct: -6.56, trades: 186, reason: '品質權重加倍後報酬與交易數下降' }
  ],
  targetMonthlyReturnPct: 5,
  targetGapPct: round(5 - metrics.averageMonthlyReturnPct),
  passed,
  paperTradingReady: passed,
  liveTradingReady: false,
  conclusion: passed ? '通過研究門檻，仍須先紙上交易。' : `未達可信月均 5%；目前 ${metrics.averageMonthlyReturnPct}%，不可宣稱完成或可實盤。`
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 官方全市場個股橫斷面動能 v1\n\n## Rolling 樣本外結果\n\n- 驗證：2020-01-01 至 2025-12-31，共 ${metrics.validationMonths} 個月\n- 個股交易：${metrics.trades} 筆；ETF 交易占比 0%\n- 月均總資產報酬：${metrics.averageMonthlyReturnPct}%\n- 年化報酬：${metrics.annualizedReturnPct}%\n- 最大回撤：${metrics.maximumDrawdownPct}%\n- Profit Factor：${metrics.profitFactor}\n- 勝率：${metrics.winRatePct}%\n- 0050 月均：${benchmark.averageMonthlyReturnPct}%\n- 候選池隨機排序月均：${candidateRandom.averageMonthlyReturnPct}%\n- 分段月均：${folds.map(row => `${row.validationPeriod.join('～')} 為 ${row.validation.averageMonthlyReturnPct}%`).join('；')}\n\n## 六年完全凍結檢查\n\n只用 2014～2019 選一次規則，2020～2025 不再重新選參數：月均 ${longHoldout.averageMonthlyReturnPct}%、年化 ${longHoldout.annualizedReturnPct}%、最大回撤 ${longHoldout.maximumDrawdownPct}%、${longHoldout.trades} 筆、PF ${longHoldout.profitFactor}；相同候選池隨機排序月均 ${longHoldoutRandom.averageMonthlyReturnPct}%。這項結果顯示核心為正，但排名優勢仍偏薄。\n\n## 資料與限制\n\n- 品質資料 ${(qualityPayload.records || qualityPayload).length.toLocaleString('en-US')} 筆、${new Set((qualityPayload.records || qualityPayload).map(row => row.symbol)).size} 檔，只在保守 effectiveDate 後使用。\n- 每月底只使用當時以前 6 至 12 個月資料，跳過最近 20 日，隔月開盤成交。\n- 已納入手續費、交易稅、雙邊滑價、最低手續費、T+2、跳空停損與每日總資產計價。\n- 本輪新增九項失敗實驗紀錄；完整數字保存在 JSON，避免重複測試。\n- 平滑動能前緣：月均 0.7792%、最大回撤 -5.42%、228 筆；交易與回撤較佳，但月均未超越保留版。\n- 高周轉前緣：月均 0.702%、最大回撤 -6.62%、315 筆。\n\n## 結論\n\n${output.conclusion} Rolling 月均仍輸給 0050，且六年完全凍結優勢只略高於隨機排序，不可進紙上交易或實盤。\n`, 'utf8');
console.log(JSON.stringify({ metrics, benchmark, candidateRandom, selected: folds.map(row => row.selectedConfig.id), passed, conclusion: output.conclusion }, null, 2));
