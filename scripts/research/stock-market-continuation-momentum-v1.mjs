import fs from 'node:fs/promises';
import {
  FOLDS,
  aggregate,
  avg,
  benchmark0050,
  buildBreadth,
  buildMarketRisk,
  loadData,
  round,
  simulate
} from './stock-official-market-walk-forward-v2.mjs';
import { buildSetups } from './stock-cross-sectional-official-v1.mjs';
import { appendExperiment, buildExperimentIdentity, loadRegistry, shouldSkipExperiment } from './strategy-experiment-registry.mjs';

const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const QUALITY = new URL('../../data/quality/financial-quality.json', import.meta.url);
const BASELINE = new URL('../../data/research/stock-cross-sectional-official-v1.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-market-continuation-momentum-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_MARKET_CONTINUATION_MOMENTUM_V1.md', import.meta.url);
const OVERLAYS = ['control', 'bull_3_days', 'bull_5_days', 'breadth_acceleration', 'stable_trend_5_days', 'bull_3_and_breadth'];

function state(row) {
  if (!row) return 'UNKNOWN';
  if (row.mom20Pct > 0 && row.mom60Pct > 0 && (row.aboveMa20Pct ?? 0) >= 50 && (row.positive20Pct ?? 0) >= 50) return 'BULL';
  if (row.mom20Pct < 0 && row.mom60Pct < 0) return 'BEAR';
  return 'TRANSITION';
}

function marketContexts(dates, marketRisk) {
  const result = new Map();
  for (let index = 5; index < dates.length; index += 1) {
    const window = dates.slice(index - 4, index + 1).map(date => marketRisk.get(date));
    const current = window.at(-1);
    if (!current || window.some(row => !row)) continue;
    const states = window.map(state);
    const bull3 = states.slice(-3).every(value => value === 'BULL');
    const bull5 = states.every(value => value === 'BULL');
    const stable5 = states.every(value => value === states[0]) && states[0] !== 'TRANSITION';
    const prior = window[0];
    const breadthAcceleration = state(current) === 'BULL'
      && current.aboveMa20Pct >= prior.aboveMa20Pct + 3
      && current.positive20Pct >= prior.positive20Pct;
    result.set(dates[index], { bull3, bull5, stable5, breadthAcceleration, state: state(current) });
  }
  return result;
}

function applyOverlays(baseSetups, contexts) {
  const output = [];
  for (const row of baseSetups.filter(item => ['momentum_6_1', 'momentum_12_1'].includes(item.setup))) {
    const context = contexts.get(row.signalDate);
    const add = overlay => output.push({ ...row, baseSetup: row.setup, setup: `${row.setup}__${overlay}` });
    add('control');
    if (!context) continue;
    if (context.bull3) add('bull_3_days');
    if (context.bull5) add('bull_5_days');
    if (context.breadthAcceleration) add('breadth_acceleration');
    if (context.stable5 && context.state === 'BULL') add('stable_trend_5_days');
    if (context.bull3 && context.breadthAcceleration) add('bull_3_and_breadth');
  }
  return output;
}

function trainScore(metrics) {
  if (metrics.trades < 60 || metrics.profitFactor < 0.95 || metrics.maximumDrawdownPct < -20) return -Infinity;
  const size = Math.ceil(metrics.monthly.length / 3);
  const thirds = [0, 1, 2].map(index => avg(metrics.monthly.slice(index * size, (index + 1) * size).map(row => row.returnPct)));
  if (thirds.filter(value => value > 0).length < 2 || thirds.at(-1) <= 0) return -Infinity;
  return metrics.averageMonthlyReturnPct * 4 + Math.min(...thirds) * 2 + thirds.at(-1) * 2
    + metrics.profitFactor + metrics.maximumDrawdownPct * 0.1;
}

const experiment = {
  strategyId: 'stock_market_continuation_momentum_v1',
  dataSources: ['官方個股 OHLCV', '0050 大盤代理', '全市場漲跌與 MA20 廣度'],
  setupRules: ['凍結既有 6／12 個月個股動能候選', '只測大盤狀態是否連續與市場廣度是否改善'],
  triggerRules: ['訊號日收盤確認，下一交易日開盤'],
  invalidationRules: ['沿用凍結策略的停損與大盤風控'],
  exitRules: ['沿用凍結策略的持有期、停利與移動停利'],
  riskRules: { accountRiskPct: 0.5, maximumPositionPct: 10, tPlusTwo: true },
  blockedWhen: ['大盤狀態轉換', '連續多頭條件不成立', '市場廣度惡化'],
  parameters: { overlays: OVERLAYS, baselineConfigurationFrozen: true },
  trainPeriod: '每段 72 個月', validationPeriod: '每段 24 個月，共 2020-2025',
  costModel: '真實手續費、交易稅、滑價與最低手續費',
  executionModel: '共用成交與投組模擬器、T+2、跳空按實際開盤價'
};
const identity = buildExperimentIdentity(experiment);
const duplicate = shouldSkipExperiment(await loadRegistry(), identity, { ...experiment, coreRulesChanged: true });
if (duplicate.skip && !process.argv.includes('--force')) {
  console.log(JSON.stringify({ skipped: true, ...duplicate, ...identity }, null, 2));
  process.exit(0);
}

const [{ histories, dailyBars, coverage }, quality, etfPayload, baseline] = await Promise.all([
  loadData(), fs.readFile(QUALITY, 'utf8').then(JSON.parse),
  fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse), fs.readFile(BASELINE, 'utf8').then(JSON.parse)
]);
const dates = [...dailyBars.keys()].sort();
const marketRisk = buildMarketRisk(etfPayload.series['0050.TW'], buildBreadth(histories));
const setups = applyOverlays(buildSetups(histories, quality.records || quality), marketContexts(dates, marketRisk));
const folds = [];
for (let index = 0; index < FOLDS.length; index += 1) {
  const fold = FOLDS[index];
  const frozen = baseline.folds[index].selectedConfig;
  let selected;
  for (const overlay of OVERLAYS) {
    const config = { ...frozen, id: `${frozen.id}__${overlay}`, setup: `${frozen.setup}__${overlay}` };
    const train = simulate(setups, dailyBars, dates, marketRisk, config, fold.train);
    const candidate = { overlay, config, train, score: trainScore(train) };
    if (!selected || candidate.score > selected.score) selected = candidate;
  }
  const enabled = Number.isFinite(selected.score);
  folds.push({
    trainPeriod: fold.train, validationPeriod: fold.validation, enabled,
    selectedOverlay: selected.overlay, selectedConfig: selected.config, train: selected.train,
    validation: enabled ? simulate(setups, dailyBars, dates, marketRisk, selected.config, fold.validation) : null,
    random: enabled ? simulate(setups, dailyBars, dates, marketRisk, selected.config, fold.validation, true) : null
  });
}
const active = folds.filter(row => row.enabled);
const metrics = active.length ? aggregate(active.map(row => row.validation)) : null;
const random = active.length ? aggregate(active.map(row => row.random)) : null;
const benchmark = await benchmark0050(etfPayload.series['0050.TW']);
const retained = baseline.metrics;
const passed = Boolean(metrics && active.length === FOLDS.length && metrics.trades > 300
  && metrics.profitFactor > 1.15 && metrics.maximumDrawdownPct > -20
  && metrics.averageMonthlyReturnPct > benchmark.averageMonthlyReturnPct
  && metrics.averageMonthlyReturnPct > random.averageMonthlyReturnPct);
const improvements = metrics ? {
  monthlyReturnPctPoints: round(metrics.averageMonthlyReturnPct - retained.averageMonthlyReturnPct),
  drawdownPctPoints: round(metrics.maximumDrawdownPct - retained.maximumDrawdownPct),
  trades: metrics.trades - retained.trades
} : null;
const conclusion = passed
  ? '市場延續動能通過最低門檻，但仍只允許紙上交易驗收。'
  : '市場狀態延續條件未通過完整驗證，不可紙上交易或實盤。';
const output = {
  generatedAt: new Date().toISOString(), ...identity, registryChecked: true, coverage,
  methodology: '凍結既有個股動能參數，只由訓練期選擇市場延續覆蓋層；所有條件只使用訊號日以前資料。',
  setupCounts: Object.fromEntries(OVERLAYS.map(overlay => [overlay, setups.filter(row => row.setup.endsWith(`__${overlay}`)).length])),
  folds, metrics, candidateRandom: random, benchmark0050: benchmark, retainedBaseline: retained,
  improvements, passedMinimum: passed, passedHighProfit: false,
  paperTradingReady: passed, liveTradingReady: false, conclusion
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 市場延續個股動能 v1\n\n- 驗證：2020-2025，共三段各 24 個月樣本外期間。\n- 方法：凍結既有個股候選與交易參數，只測訊號日前大盤多頭連續性及市場廣度改善。\n- 結果：${metrics ? `月均 ${metrics.averageMonthlyReturnPct}%、年化 ${metrics.annualizedReturnPct}%、最大回撤 ${metrics.maximumDrawdownPct}%、${metrics.trades} 筆、PF ${metrics.profitFactor}` : '沒有訓練組合達到啟用門檻'}。\n- 原基準：月均 ${retained.averageMonthlyReturnPct}%、最大回撤 ${retained.maximumDrawdownPct}%、${retained.trades} 筆。\n- 比較：0050 月均 ${benchmark.averageMonthlyReturnPct}%；公平隨機 ${random?.averageMonthlyReturnPct ?? '無資料'}%。\n- 結論：${conclusion}\n`, 'utf8');
await appendExperiment({ ...experiment, metrics, resultStatus: passed ? 'passed' : 'failed', passedMinimum: passed, passedHighProfit: false, failureReason: passed ? null : conclusion, notes: '市場狀態持續性是新核心規則；既有個股交易參數完全凍結。', force: true });
console.log(JSON.stringify({ setupCounts: output.setupCounts, folds: folds.map(row => ({ validationPeriod: row.validationPeriod, enabled: row.enabled, selectedOverlay: row.selectedOverlay, train: row.train, validation: row.validation })), metrics, random, benchmark, retained, improvements, passed, conclusion }, null, 2));
