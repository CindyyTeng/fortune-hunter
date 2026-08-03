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
import { appendExperiment, buildExperimentIdentity, loadRegistry, shouldSkipExperiment } from './strategy-experiment-registry.mjs';

const QUALITY = new URL('../../data/quality/financial-quality.json', import.meta.url);
const SECTORS = new URL('../../data/sector/sector-classification.json', import.meta.url);
const US_HISTORY = new URL('../../data/research/us-sector-history-v1.json', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const BASELINE = new URL('../../data/research/stock-cross-sectional-official-v1.json', import.meta.url);
const OUTPUT = new URL('../../data/research/us-sector-official-overlay-v1.json', import.meta.url);
const REPORT = new URL('../../docs/US_SECTOR_OFFICIAL_OVERLAY_V1.md', import.meta.url);
const SECTOR_ETF = Object.freeze({
  '05': 'XLI', '06': 'XLI', '10': 'XLI', '12': 'XLI', '15': 'XLI', '35': 'XLI',
  '17': 'XLF', '22': 'XBI', '23': 'XLE', '24': 'SOXX',
  '25': 'XLK', '26': 'XLK', '27': 'XLK', '28': 'XLK', '29': 'XLK', '30': 'XLK', '31': 'XLK', '32': 'XLK', '36': 'XLK'
});
const OVERLAYS = ['full_control', 'mapped_control', 'downside_filter', 'strict_downside_filter', 'positive_confirmation', 'three_day_cooling'];

function deviation(values) {
  const mean = avg(values);
  return Math.sqrt(avg(values.map(value => (value - mean) ** 2)));
}

function qualityBySymbol(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row.isPointInTimeSafe || !row.effectiveDate) continue;
    const list = map.get(row.symbol) || [];
    list.push(row);
    map.set(row.symbol, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  return map;
}

function latestUsReturns(series, entryDates) {
  const map = new Map();
  let index = 1;
  for (const entryDate of entryDates) {
    while (index + 1 < series.length && series[index + 1].date < entryDate) index += 1;
    const row = series[index];
    if (!row || row.date >= entryDate || (Date.parse(entryDate) - Date.parse(row.date)) / 86_400_000 > 4) continue;
    map.set(entryDate, { date: row.date, r1: (row.close / series[index - 1].close - 1) * 100, r3: index >= 3 ? (row.close / series[index - 3].close - 1) * 100 : null });
  }
  return map;
}

function buildUsMaps(payload, dates) {
  return Object.fromEntries(Object.entries(payload.series).map(([symbol, rows]) => [symbol, latestUsReturns(rows, dates)]));
}

function buildBaseSetups(histories, qualityRows) {
  const setups = [];
  const qualities = qualityBySymbol(qualityRows);
  for (const [symbol, rows] of histories) {
    const history = qualities.get(symbol.replace(/\.(TW|TWO)$/, '')) || [];
    let qualityIndex = -1;
    for (let index = 252; index < rows.length - 1; index += 1) {
      const row = rows[index];
      const next = rows[index + 1];
      if (next.date.slice(0, 7) === row.date.slice(0, 7)) continue;
      while (qualityIndex + 1 < history.length && history[qualityIndex + 1].effectiveDate <= row.date) qualityIndex += 1;
      const quality = history[qualityIndex];
      const ma20 = avg(rows.slice(index - 19, index + 1).map(item => item.close));
      const ma60 = avg(rows.slice(index - 59, index + 1).map(item => item.close));
      const value20 = avg(rows.slice(index - 19, index + 1).map(item => item.tradeValue));
      const dailyReturns = rows.slice(index - 59, index + 1).map((item, offset, source) => offset ? (item.close / source[offset - 1].close - 1) * 100 : 0).slice(1);
      const volatility60 = deviation(dailyReturns) * Math.sqrt(252);
      const mom12Skip1 = (rows[index - 20].close / rows[index - 252].close - 1) * 100;
      const mom6Skip1 = (rows[index - 20].close / rows[index - 126].close - 1) * 100;
      const mom20 = (row.close / rows[index - 20].close - 1) * 100;
      const mom60 = (row.close / rows[index - 60].close - 1) * 100;
      const nearHigh252 = row.close / Math.max(...rows.slice(index - 251, index + 1).map(item => item.high));
      const qualityAge = quality ? (Date.parse(row.date) - Date.parse(quality.effectiveDate)) / 86_400_000 : Infinity;
      const marginChange = (quality?.grossMarginYoYChange ?? quality?.grossMarginQoQChange ?? 0) + (quality?.operatingMarginYoYChange ?? quality?.operatingMarginQoQChange ?? 0);
      const qualityBoost = qualityAge <= 180 ? (quality.EPS > 0 ? 2 : -5) + Math.max(-2.5, Math.min(5, (quality?.epsYoY ?? 0) * 0.05)) + Math.max(-3, Math.min(6, marginChange * 0.3)) : 0;
      const common = {
        symbol, name: row.name, market: row.market, signalDate: row.date, entryDate: next.date, entryOpen: next.open,
        tradeValue: row.tradeValue, volumeRatio20: row.tradeValue / Math.max(1, value20),
        atr20Pct: avg(rows.slice(index - 19, index + 1).map(item => (item.high - item.low) / item.close * 100)),
        mom20, mom60, ma20, distanceToMa20Pct: (row.close / ma20 - 1) * 100, ma20AboveMa60: ma20 > ma60
      };
      if (mom12Skip1 >= 10 && nearHigh252 >= 0.7 && common.ma20AboveMa60) setups.push({ ...common, baseSetup: 'momentum_12_1', score: mom12Skip1 / Math.max(8, volatility60) * 30 + nearHigh252 * 20 + mom60 * 0.2 + qualityBoost });
      if (mom6Skip1 >= 8 && nearHigh252 >= 0.7 && common.ma20AboveMa60) setups.push({ ...common, baseSetup: 'momentum_6_1', score: mom6Skip1 / Math.max(8, volatility60) * 30 + nearHigh252 * 20 + mom60 * 0.2 + qualityBoost });
      if (mom12Skip1 >= 10 && mom6Skip1 >= 8 && nearHigh252 >= 0.75 && common.ma20AboveMa60) setups.push({ ...common, baseSetup: 'dual_horizon_momentum', score: mom12Skip1 / Math.max(8, volatility60) * 18 + mom6Skip1 / Math.max(8, volatility60) * 18 + nearHigh252 * 20 + qualityBoost });
    }
  }
  const grouped = new Map();
  for (const setup of setups) {
    const key = `${setup.signalDate}|${setup.baseSetup}`;
    const list = grouped.get(key) || [];
    list.push(setup);
    grouped.set(key, list);
  }
  for (const rows of grouped.values()) rows.sort((a, b) => b.score - a.score).forEach((row, index) => {
    row.strengthRankPct = rows.length === 1 ? 1 : 1 - index / (rows.length - 1);
    row.score += row.strengthRankPct * 20;
  });
  return setups;
}

function applyOverlays(baseSetups, classifications, usMaps) {
  const sectorBySymbol = new Map(classifications.records.map(row => [row.symbol, row.sectorCode]));
  const output = [];
  for (const row of baseSetups) {
    output.push({ ...row, setup: `${row.baseSetup}__full_control` });
    const sectorEtf = SECTOR_ETF[sectorBySymbol.get(row.symbol.replace(/\.(TW|TWO)$/, ''))];
    const us = sectorEtf && usMaps[sectorEtf]?.get(row.entryDate);
    const spy = usMaps.SPY.get(row.entryDate);
    if (!us || !spy || us.date !== spy.date) continue;
    const common = { ...row, sectorEtf, usDate: us.date, usReturn1Pct: us.r1, usReturn3Pct: us.r3, usExcess1Pct: us.r1 - spy.r1 };
    const add = overlay => output.push({ ...common, setup: `${row.baseSetup}__${overlay}`, score: row.score + us.r1 * 3 + (us.r1 - spy.r1) * 2 });
    add('mapped_control');
    if (us.r1 > -1 && spy.r1 > -1.5 && us.r1 - spy.r1 > -1) add('downside_filter');
    if (us.r1 > -0.5 && spy.r1 > -1 && us.r1 - spy.r1 > -0.5) add('strict_downside_filter');
    if (us.r1 > 0 && us.r1 - spy.r1 > -0.5) add('positive_confirmation');
    if (us.r3 > 0 && us.r1 > -1 && us.r1 <= 0.5) add('three_day_cooling');
  }
  return output;
}

function trainScore(metrics) {
  if (metrics.trades < 100 || metrics.profitFactor < 0.95 || metrics.maximumDrawdownPct < -25) return -Infinity;
  const size = Math.ceil(metrics.monthly.length / 3);
  const segments = [0, 1, 2].map(index => avg(metrics.monthly.slice(index * size, (index + 1) * size).map(row => row.returnPct)));
  if (Math.min(...segments) < 0) return -Infinity;
  return metrics.averageMonthlyReturnPct * 3 + Math.min(...segments) * 2 + segments.at(-1) * 5 - (Math.max(...segments) - Math.min(...segments)) + metrics.profitFactor + metrics.maximumDrawdownPct * 0.08;
}

const experiment = {
  strategyId: 'us_sector_official_overlay_v1',
  dataSources: ['台股官方 OHLCV', 'point-in-time 財報品質', 'Yahoo Finance 美股產業 ETF 日線', '目前靜態產業分類'],
  setupRules: ['官方個股多週期動能基準', '美股產業隔夜訊號只作風險排除或確認'],
  triggerRules: ['月底訊號後下一個交易日開盤'],
  invalidationRules: ['固定停損與跳空較差價'],
  exitRules: ['原基準 20、40、60 日與移動停利'],
  riskRules: { accountRiskPct: 0.5, maximumPositionPct: 10, tPlusTwo: true },
  blockedWhen: ['大盤風險狀態不允許', '美股來源日期不早於台股進場日'],
  parameters: { overlays: OVERLAYS, baselineConfigFrozenFromTraining: true },
  trainPeriod: '每段 72 個月', validationPeriod: '每段 24 個月，合併 2020-2025',
  costModel: '手續費、交易稅、雙邊滑價、最低手續費',
  executionModel: '共用成交與投組模擬器；T+2；跳空停損使用較差價格'
};
const identity = buildExperimentIdentity(experiment);
const duplicate = shouldSkipExperiment(await loadRegistry(), identity, { ...experiment, coreRulesChanged: true });
if (duplicate.skip && !process.argv.includes('--force')) {
  console.log(JSON.stringify({ skipped: true, ...duplicate, ...identity }, null, 2));
  process.exit(0);
}

const [{ histories, dailyBars, coverage }, quality, classifications, usPayload, etfPayload, baseline] = await Promise.all([
  loadData(), fs.readFile(QUALITY, 'utf8').then(JSON.parse), fs.readFile(SECTORS, 'utf8').then(JSON.parse),
  fs.readFile(US_HISTORY, 'utf8').then(JSON.parse), fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse), fs.readFile(BASELINE, 'utf8').then(JSON.parse)
]);
const dates = [...dailyBars.keys()].sort();
const usMaps = buildUsMaps(usPayload, dates);
const setups = applyOverlays(buildBaseSetups(histories, quality.records || quality), classifications, usMaps);
const marketRisk = buildMarketRisk(etfPayload.series['0050.TW'], buildBreadth(histories));
const folds = [];
for (let index = 0; index < FOLDS.length; index += 1) {
  const fold = FOLDS[index];
  const baseConfig = baseline.folds[index].selectedConfig;
  let selected;
  for (const overlay of OVERLAYS) {
    const config = { ...baseConfig, id: `${baseConfig.id}__${overlay}`, setup: `${baseConfig.setup}__${overlay}` };
    const train = simulate(setups, dailyBars, dates, marketRisk, config, fold.train);
    const candidate = { overlay, config, train, score: trainScore(train) };
    if (!selected || candidate.score > selected.score) selected = candidate;
  }
  const enabled = Number.isFinite(selected.score);
  folds.push({
    trainPeriod: fold.train, validationPeriod: fold.validation, enabled, selectedOverlay: selected.overlay,
    selectedConfig: selected.config, train: selected.train,
    validation: enabled ? simulate(setups, dailyBars, dates, marketRisk, selected.config, fold.validation) : null,
    random: enabled ? simulate(setups, dailyBars, dates, marketRisk, selected.config, fold.validation, true) : null
  });
}
const active = folds.filter(row => row.enabled);
const metrics = active.length ? aggregate(active.map(row => row.validation)) : null;
const random = active.length ? aggregate(active.map(row => row.random)) : null;
const benchmark = await benchmark0050(etfPayload.series['0050.TW']);
const passed = Boolean(metrics && active.length === FOLDS.length && metrics.trades > 300 && metrics.profitFactor > 1.15 && metrics.maximumDrawdownPct > -20 && metrics.averageMonthlyReturnPct > benchmark.averageMonthlyReturnPct && metrics.averageMonthlyReturnPct > random.averageMonthlyReturnPct);
const output = {
  generatedAt: new Date().toISOString(), ...identity, registryChecked: true, coverage,
  staticSectorClassificationWarning: true,
  setupCounts: Object.fromEntries(OVERLAYS.map(overlay => [overlay, setups.filter(row => row.setup.endsWith(`__${overlay}`)).length])),
  folds, metrics, candidateRandom: random, benchmark0050: benchmark, retainedBaseline: baseline.metrics,
  improvements: metrics ? {
    monthlyReturnVsRetained: round(metrics.averageMonthlyReturnPct - baseline.metrics.averageMonthlyReturnPct),
    drawdownVsRetained: round(metrics.maximumDrawdownPct - baseline.metrics.maximumDrawdownPct),
    tradesVsRetained: metrics.trades - baseline.metrics.trades
  } : null,
  passed, paperTradingReady: passed, liveTradingReady: false,
  conclusion: passed ? '隔夜產業覆蓋層通過最低候選標準，但只能進紙上交易。' : '隔夜產業覆蓋層未穩定改善保留基準，不可進紙上交易或實盤。'
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 美股產業隔夜覆蓋層 v1\n\n- 驗證：2020-01-01 至 2025-12-31；每段訓練 72 個月、驗證 24 個月。\n- 保留基準：月均 ${baseline.metrics.averageMonthlyReturnPct}%、最大回撤 ${baseline.metrics.maximumDrawdownPct}%、${baseline.metrics.trades} 筆。\n- 覆蓋層：${metrics ? `月均 ${metrics.averageMonthlyReturnPct}%、最大回撤 ${metrics.maximumDrawdownPct}%、${metrics.trades} 筆、PF ${metrics.profitFactor}` : '三折訓練未穩定啟用'}。\n- 0050 月均：${benchmark.averageMonthlyReturnPct}%；公平隨機：${random?.averageMonthlyReturnPct ?? '無'}%。\n- 各折選擇：${folds.map(row => `${row.validationPeriod.join('～')}=${row.enabled ? row.selectedOverlay : '現金'}`).join('；')}。\n- 結論：${output.conclusion}\n\n美股 D 日收盤只允許下一個台股交易日使用；費稅、滑價、T+2 與跳空停損共用既有模擬器。產業分類為目前靜態分類，仍有分類倖存者偏差。\n`, 'utf8');
await appendExperiment({ ...experiment, metrics, resultStatus: passed ? 'passed' : 'failed', passedMinimum: passed, passedHighProfit: false, failureReason: passed ? null : output.conclusion, notes: `相對保留基準月均 ${output.improvements?.monthlyReturnVsRetained ?? '無'} 個百分點。`, force: true });
console.log(JSON.stringify({ metrics, random, benchmark, retainedBaseline: baseline.metrics, improvements: output.improvements, folds: folds.map(row => ({ validationPeriod: row.validationPeriod, enabled: row.enabled, selectedOverlay: row.selectedOverlay, validation: row.validation })), passed, conclusion: output.conclusion }, null, 2));
