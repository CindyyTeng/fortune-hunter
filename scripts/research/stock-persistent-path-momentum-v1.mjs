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
import {
  appendExperiment,
  buildExperimentIdentity,
  loadRegistry,
  shouldSkipExperiment
} from './strategy-experiment-registry.mjs';

const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const QUALITY = new URL('../../data/quality/financial-quality.json', import.meta.url);
const DOWNSIDE_DOMINANCE = process.argv.includes('--downside-dominance');
const OUTPUT = new URL(DOWNSIDE_DOMINANCE
  ? '../../data/research/stock-downside-dominance-momentum-v1.json'
  : '../../data/research/stock-persistent-path-momentum-v1.json', import.meta.url);
const REPORT = new URL(DOWNSIDE_DOMINANCE
  ? '../../docs/STOCK_DOWNSIDE_DOMINANCE_MOMENTUM_V1.md'
  : '../../docs/STOCK_PERSISTENT_PATH_MOMENTUM_V1.md', import.meta.url);

function formationStats(rows, endIndex, lookback) {
  const startIndex = endIndex - lookback;
  if (startIndex < 0) return null;
  const blocks = [];
  for (let start = startIndex; start + 21 <= endIndex; start += 21) {
    blocks.push(rows[start + 21].close / rows[start].close - 1);
  }
  let peak = rows[startIndex].close;
  let maximumDrawdownPct = 0;
  let pathLength = 0;
  const dailyReturns = [];
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    const prior = rows[index - 1].close;
    const close = rows[index].close;
    dailyReturns.push((close / prior - 1) * 100);
    pathLength += Math.abs(Math.log(close / prior));
    peak = Math.max(peak, close);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, (close / peak - 1) * 100);
  }
  const netMove = Math.log(rows[endIndex].close / rows[startIndex].close);
  const sortedReturns = [...dailyReturns].sort((left, right) => left - right);
  const tailSize = Math.max(1, Math.ceil(sortedReturns.length * 0.1));
  const negativeReturns = dailyReturns.filter(value => value < 0);
  return {
    positiveBlockShare: blocks.filter(value => value > 0).length / Math.max(1, blocks.length),
    pathEfficiency: pathLength ? Math.max(0, netMove) / pathLength : 0,
    maximumDrawdownPct,
    blocks: blocks.length,
    q10ReturnPct: sortedReturns[Math.floor((sortedReturns.length - 1) * 0.1)],
    q25ReturnPct: sortedReturns[Math.floor((sortedReturns.length - 1) * 0.25)],
    expectedShortfall10Pct: avg(sortedReturns.slice(0, tailSize)),
    downsideDeviationPct: Math.sqrt(avg(negativeReturns.map(value => value ** 2))),
    positiveDayShare: dailyReturns.filter(value => value > 0).length / dailyReturns.length
  };
}

function rank(values, value, lowerIsBetter = false) {
  const sorted = [...values].sort((left, right) => left - right);
  let index = 0;
  while (index < sorted.length && sorted[index] <= value) index += 1;
  const percentile = index / Math.max(1, sorted.length);
  return lowerIsBetter ? 1 - percentile : percentile;
}

function buildPersistentSetups(baseSetups, histories) {
  const dateIndexes = new Map();
  for (const [symbol, rows] of histories) {
    dateIndexes.set(symbol, new Map(rows.map((row, index) => [row.date, index])));
  }
  const output = [];
  const seen = new Set();
  for (const row of baseSetups) {
    if (!['momentum_6_1', 'momentum_12_1'].includes(row.setup)) continue;
    const key = `${row.signalDate}|${row.symbol}|${row.setup}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = histories.get(row.symbol);
    const index = dateIndexes.get(row.symbol)?.get(row.signalDate);
    if (!rows || !Number.isInteger(index)) continue;
    const lookback = row.setup === 'momentum_6_1' ? 106 : 232;
    const stats = formationStats(rows, index - 20, lookback);
    if (!stats) continue;
    const add = setup => output.push({
      ...row,
      setup,
      baseSetup: row.setup,
      positiveBlockShare: stats.positiveBlockShare,
      pathEfficiency: stats.pathEfficiency,
      formationMaximumDrawdownPct: stats.maximumDrawdownPct,
      score: row.score + stats.positiveBlockShare * 35
        + stats.pathEfficiency * 100 + stats.maximumDrawdownPct * 0.3
    });
    if (row.setup === 'momentum_6_1' && stats.positiveBlockShare >= 0.6
      && stats.pathEfficiency >= 0.08 && stats.maximumDrawdownPct >= -25) add('persistent_6_1');
    if (row.setup === 'momentum_12_1' && stats.positiveBlockShare >= 0.64
      && stats.pathEfficiency >= 0.05 && stats.maximumDrawdownPct >= -30) add('persistent_12_1');
    if (row.setup === 'momentum_12_1' && stats.positiveBlockShare >= 0.72
      && stats.pathEfficiency >= 0.06 && stats.maximumDrawdownPct >= -20) add('persistent_compound_winner');
  }
  const groups = new Map();
  for (const row of output) {
    const key = `${row.signalDate}|${row.setup}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  for (const rows of groups.values()) {
    rows.sort((left, right) => right.score - left.score).forEach((row, index) => {
      row.strengthRankPct = rows.length === 1 ? 1 : 1 - index / (rows.length - 1);
    });
  }
  return output;
}

function buildDownsideDominanceSetups(baseSetups, histories) {
  const dateIndexes = new Map();
  for (const [symbol, rows] of histories) dateIndexes.set(symbol, new Map(rows.map((row, index) => [row.date, index])));
  const observations = [];
  const seen = new Set();
  for (const row of baseSetups) {
    if (!['momentum_6_1', 'momentum_12_1'].includes(row.setup)) continue;
    const key = `${row.signalDate}|${row.symbol}|${row.setup}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = histories.get(row.symbol);
    const index = dateIndexes.get(row.symbol)?.get(row.signalDate);
    if (!rows || !Number.isInteger(index)) continue;
    const stats = formationStats(rows, index - 20, row.setup === 'momentum_6_1' ? 106 : 232);
    if (stats) observations.push({ ...row, ...stats });
  }
  const groups = new Map();
  for (const row of observations) {
    const key = `${row.signalDate}|${row.setup}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  const output = [];
  for (const rows of groups.values()) {
    const q10 = rows.map(row => row.q10ReturnPct);
    const q25 = rows.map(row => row.q25ReturnPct);
    const shortfall = rows.map(row => row.expectedShortfall10Pct);
    const downside = rows.map(row => row.downsideDeviationPct);
    const drawdowns = rows.map(row => row.maximumDrawdownPct);
    for (const row of rows) {
      const dominanceRank = avg([
        rank(q10, row.q10ReturnPct),
        rank(q25, row.q25ReturnPct),
        rank(shortfall, row.expectedShortfall10Pct),
        rank(downside, row.downsideDeviationPct, true),
        rank(drawdowns, row.maximumDrawdownPct)
      ]);
      if (dominanceRank < 0.7) continue;
      output.push({
        ...row,
        baseSetup: row.setup,
        setup: row.setup === 'momentum_6_1' ? 'downside_dominant_6_1' : 'downside_dominant_12_1',
        downsideDominanceRank: dominanceRank,
        score: row.score + dominanceRank * 50 + row.positiveDayShare * 10
      });
    }
  }
  const rankedGroups = new Map();
  for (const row of output) {
    const key = `${row.signalDate}|${row.setup}`;
    const group = rankedGroups.get(key) || [];
    group.push(row);
    rankedGroups.set(key, group);
  }
  for (const rows of rankedGroups.values()) rows.sort((left, right) => right.score - left.score)
    .forEach((row, index) => { row.strengthRankPct = rows.length === 1 ? 1 : 1 - index / (rows.length - 1); });
  return output;
}

function configurations() {
  const families = DOWNSIDE_DOMINANCE
    ? [{ setup: 'downside_dominant_6_1', minRank: 0.5 }, { setup: 'downside_dominant_12_1', minRank: 0.5 }]
    : [
      { setup: 'persistent_6_1', minRank: 0.6 },
      { setup: 'persistent_12_1', minRank: 0.6 },
      { setup: 'persistent_compound_winner', minRank: 0.5 }
    ];
  const output = [];
  for (const family of families) for (const top of [5, 10, 20]) {
    for (const holdDays of [20, 40, 60]) for (const stopLossPct of [8, 12]) {
      for (const marketMode of ['trend', 'strong']) output.push({
        ...family,
        id: `${family.setup}_top${top}_h${holdDays}_s${stopLossPct}_${marketMode}`,
        top,
        holdDays,
        stopLossPct,
        takeProfitPct: 50,
        marketMode,
        stopMode: 'intraday',
        positionPct: Math.min(10, 100 / top),
        accountRiskPct: 0.5,
        drawdownBlockPct: 6,
        minValue: 50e6,
        minMom20: -10,
        minMom60: 0,
        maxAtr: 8,
        minVolumeRatio: 0.3,
        maxDistance: 25
      });
    }
  }
  return output;
}

function trainingScore(metrics) {
  if (metrics.trades < 45 || metrics.profitFactor < 1 || metrics.maximumDrawdownPct < -20) return -Infinity;
  const size = Math.ceil(metrics.monthly.length / 3);
  const thirds = [0, 1, 2].map(index => avg(metrics.monthly
    .slice(index * size, (index + 1) * size).map(row => row.returnPct)));
  if (thirds.filter(value => value > 0).length < 2 || thirds.at(-1) <= 0) return -Infinity;
  return metrics.averageMonthlyReturnPct * 4 + Math.min(...thirds) * 2
    + metrics.profitFactor + metrics.maximumDrawdownPct * 0.08;
}

const experiment = {
  strategyId: DOWNSIDE_DOMINANCE ? 'stock_downside_dominance_momentum_v1' : 'stock_persistent_path_momentum_v1',
  dataSources: ['台股官方日線 OHLCV', '0050 市場風險資料'],
  setupRules: DOWNSIDE_DOMINANCE
    ? ['6／12 個月動能', '同日候選的最差 10% 報酬較佳', '下檔半變異與形成期回撤較低']
    : ['6／12 個月動能', '多數 21 日區段上漲', '形成期路徑效率與回撤限制'],
  triggerRules: ['月底訊號成立後下一交易日開盤成交'],
  invalidationRules: ['盤中停損、投組熔斷與市場風險封鎖'],
  exitRules: ['20／40／60 日持有上限、50% 停利或移動停利'],
  riskRules: { accountRiskPct: 0.5, maximumPositionPct: 10, tPlusTwo: true },
  blockedWhen: ['高波動市場', '總曝險超限', '帳戶風控冷卻'],
  parameters: { formationBlocks: 21, configurations: DOWNSIDE_DOMINANCE ? 72 : 108 },
  trainPeriod: '滾動 72 個月',
  validationPeriod: '滾動 24 個月，共 2020-2025',
  costModel: '手續費、交易稅、雙邊滑價與最低手續費',
  executionModel: '共用成交與投組模擬器、T+2、跳空採較差成交價'
};
const identity = buildExperimentIdentity(experiment);
const duplicate = shouldSkipExperiment(await loadRegistry(), identity, { ...experiment, coreRulesChanged: true });
if (duplicate.skip && !process.argv.includes('--force')) {
  console.log(JSON.stringify({ skipped: true, ...duplicate, ...identity }, null, 2));
  process.exit(0);
}

const [{ histories, dailyBars, coverage }, quality, etfPayload] = await Promise.all([
  loadData(),
  fs.readFile(QUALITY, 'utf8').then(JSON.parse),
  fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)
]);
const dates = [...dailyBars.keys()].sort();
const marketRisk = buildMarketRisk(etfPayload.series['0050.TW'], buildBreadth(histories));
const baseSetups = buildSetups(histories, quality.records || quality);
const setups = DOWNSIDE_DOMINANCE
  ? buildDownsideDominanceSetups(baseSetups, histories)
  : buildPersistentSetups(baseSetups, histories);
const configs = configurations();
const folds = [];
for (const fold of FOLDS) {
  let selected = null;
  for (const config of configs) {
    const train = simulate(setups, dailyBars, dates, marketRisk, config, fold.train);
    const candidate = { config, train, score: trainingScore(train) };
    if (!selected || candidate.score > selected.score) selected = candidate;
  }
  const enabled = Number.isFinite(selected?.score);
  folds.push({
    trainPeriod: fold.train,
    validationPeriod: fold.validation,
    enabled,
    selectedConfig: selected?.config || null,
    train: selected?.train || null,
    validation: enabled ? simulate(setups, dailyBars, dates, marketRisk, selected.config, fold.validation) : null,
    random: enabled ? simulate(setups, dailyBars, dates, marketRisk, selected.config, fold.validation, true) : null
  });
}
const active = folds.filter(row => row.enabled);
const metrics = active.length ? aggregate(active.map(row => row.validation)) : null;
const random = active.length ? aggregate(active.map(row => row.random)) : null;
const benchmark = await benchmark0050(etfPayload.series['0050.TW']);
const passed = Boolean(metrics && active.length === FOLDS.length && metrics.trades > 300
  && metrics.profitFactor > 1.15 && metrics.maximumDrawdownPct > -20
  && metrics.averageMonthlyReturnPct > benchmark.averageMonthlyReturnPct
  && metrics.averageMonthlyReturnPct > random.averageMonthlyReturnPct);
const conclusion = passed
  ? `${DOWNSIDE_DOMINANCE ? '個股下檔風險支配動能' : '個股路徑持續動能'}通過最低樣本外門檻，只允許進入紙上交易。`
  : `${DOWNSIDE_DOMINANCE ? '個股下檔風險支配動能' : '個股路徑持續動能'}未通過完整樣本外門檻，不進入紙上交易或實盤。`;
const output = {
  generatedAt: new Date().toISOString(),
  ...identity,
  registryChecked: true,
  coverage,
  methodology: DOWNSIDE_DOMINANCE
    ? '只使用訊號日以前資料，以同日動能候選的下檔報酬分布、半變異與形成期回撤進行相對支配排序。'
    : '只使用訊號日以前資料，將形成期拆成 21 日區段，排除由少數急漲日拉高的非持續贏家。',
  setupCounts: Object.fromEntries((DOWNSIDE_DOMINANCE
    ? ['downside_dominant_6_1', 'downside_dominant_12_1']
    : ['persistent_6_1', 'persistent_12_1', 'persistent_compound_winner'])
    .map(setup => [setup, setups.filter(row => row.setup === setup).length])),
  testedConfigurations: configs.length,
  folds,
  metrics,
  candidateOrderRandom: random,
  benchmark0050: benchmark,
  passedMinimum: passed,
  passedHighProfit: false,
  paperTradingReady: passed,
  liveTradingReady: false,
  conclusion
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# ${DOWNSIDE_DOMINANCE ? '個股下檔風險支配動能' : '個股路徑持續動能'} v1\n\n- 驗證區間：2020-01-01 至 2025-12-31，三段各 24 個月樣本外驗證。\n- 方法：${DOWNSIDE_DOMINANCE ? '在同日動能候選內，以最差 10% 報酬、下檔半變異與形成期回撤排序。' : '形成期拆成 21 日區段，只保留多數區段上漲且回撤受控的 6／12 個月贏家。'}\n- 成交：已計入手續費、交易稅、滑價、最低手續費、T+2 與跳空。\n- 結果：${metrics ? `月均 ${metrics.averageMonthlyReturnPct}%、年化 ${metrics.annualizedReturnPct}%、最大回撤 ${metrics.maximumDrawdownPct}%、${metrics.trades} 筆、PF ${metrics.profitFactor}` : '訓練期沒有可啟用組合'}。\n- 基準：0050 月均 ${benchmark.averageMonthlyReturnPct}%；候選池隨機排序 ${random?.averageMonthlyReturnPct ?? '無資料'}%。\n- 結論：${conclusion}\n`, 'utf8');
await appendExperiment({
  ...experiment,
  metrics,
  resultStatus: passed ? 'passed' : 'failed',
  passedMinimum: passed,
  passedHighProfit: false,
  failureReason: passed ? null : conclusion,
  notes: `${DOWNSIDE_DOMINANCE ? '下檔報酬分布支配' : '報酬路徑持續性'}策略；未通過前不可部署。`,
  force: true
});
console.log(JSON.stringify({
  setupCounts: output.setupCounts,
  folds: folds.map(row => ({
    validationPeriod: row.validationPeriod,
    enabled: row.enabled,
    selectedConfig: row.selectedConfig,
    train: row.train,
    validation: row.validation
  })),
  metrics,
  random,
  benchmark,
  passed,
  conclusion
}, null, 2));
