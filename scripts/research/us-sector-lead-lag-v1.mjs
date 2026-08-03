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
import {
  appendExperiment,
  buildExperimentIdentity,
  loadRegistry,
  shouldSkipExperiment
} from './strategy-experiment-registry.mjs';

const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const SECTORS = new URL('../../data/sector/sector-classification.json', import.meta.url);
const CACHE = new URL('../../data/research/us-sector-history-v1.json', import.meta.url);
const OUTPUT = new URL('../../data/research/us-sector-lead-lag-v1.json', import.meta.url);
const REPORT = new URL('../../docs/US_SECTOR_LEAD_LAG_V1.md', import.meta.url);
const US_SYMBOLS = Object.freeze({ SPY: 'SPY', SOXX: 'SOXX', XLK: 'XLK', XLF: 'XLF', XLE: 'XLE', XLI: 'XLI', XBI: 'XBI' });
const SECTOR_ETF = Object.freeze({
  '05': 'XLI', '06': 'XLI', '10': 'XLI', '12': 'XLI', '15': 'XLI', '35': 'XLI',
  '17': 'XLF', '22': 'XBI', '23': 'XLE', '24': 'SOXX',
  '25': 'XLK', '26': 'XLK', '27': 'XLK', '28': 'XLK', '29': 'XLK', '30': 'XLK', '31': 'XLK', '32': 'XLK', '36': 'XLK'
});
const SETUPS = ['technical_control', 'us_sector_downside_filter', 'us_sector_underreaction', 'us_sector_broad_confirmation', 'us_sector_cooling_pullback'];

async function fetchYahoo(symbol) {
  const start = Math.floor(Date.parse('2013-01-01T00:00:00Z') / 1000);
  const end = Math.floor(Date.parse('2026-01-10T00:00:00Z') / 1000);
  let lastError;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const url = `https://${host}/v8/finance/chart/${symbol}?period1=${start}&period2=${end}&interval=1d&includePrePost=false&events=div%2Csplits`;
      const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const result = payload.chart?.result?.[0];
      const quote = result?.indicators?.quote?.[0];
      if (!result?.timestamp?.length || !quote) throw new Error('回傳欄位不完整');
      return result.timestamp.map((timestamp, index) => ({
        date: new Date(timestamp * 1000).toISOString().slice(0, 10),
        open: quote.open[index],
        high: quote.high[index],
        low: quote.low[index],
        close: quote.close[index]
      })).filter(row => [row.open, row.high, row.low, row.close].every(Number.isFinite));
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${symbol} 歷史行情下載失敗：${lastError?.message || '未知錯誤'}`);
}

async function loadUsHistory() {
  try {
    const cached = JSON.parse(await fs.readFile(CACHE, 'utf8'));
    if (Object.values(US_SYMBOLS).every(symbol => cached.series?.[symbol]?.length > 2_000)) return cached;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const series = {};
  for (const symbol of Object.values(US_SYMBOLS)) series[symbol] = await fetchYahoo(symbol);
  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'Yahoo Finance chart API（免費公開行情；非交易所逐筆官方資料）',
    pointInTimePolicy: '美股 D 日收盤只允許台股下一個交易日使用',
    series
  };
  await fs.writeFile(CACHE, `${JSON.stringify(payload)}\n`, 'utf8');
  return payload;
}

function returnsByEntryDate(series, entryDates) {
  const result = new Map();
  let index = 1;
  for (const entryDate of entryDates) {
    while (index + 1 < series.length && series[index + 1].date < entryDate) index += 1;
    const row = series[index];
    if (!row || row.date >= entryDate) continue;
    const age = (Date.parse(entryDate) - Date.parse(row.date)) / 86_400_000;
    if (age > 4) continue;
    result.set(entryDate, {
      sourceDate: row.date,
      return1: (row.close / series[index - 1].close - 1) * 100,
      return3: index >= 3 ? (row.close / series[index - 3].close - 1) * 100 : null
    });
  }
  return result;
}

function buildUsMaps(payload, entryDates) {
  return Object.fromEntries(Object.entries(payload.series).map(([symbol, rows]) => [symbol, returnsByEntryDate(rows, entryDates)]));
}

function addSetup(rows, common, setup, us, spy) {
  const usBoost = us ? us.return1 * 4 + (us.return3 || 0) * 1.5 + (us.return1 - spy.return1) * 3 : 0;
  rows.push({ ...common, setup, score: common.technicalScore + usBoost, usSourceDate: us?.sourceDate || null, usReturn1Pct: us?.return1 ?? null, usReturn3Pct: us?.return3 ?? null, usExcess1Pct: us ? us.return1 - spy.return1 : null });
}

function buildSetups(histories, classifications, usMaps) {
  const sectorBySymbol = new Map(classifications.records.map(row => [row.symbol, row.sectorCode]));
  const setups = [];
  const sectorCoverage = new Map();
  for (const [symbol, history] of histories) {
    const code = symbol.replace(/\.(TW|TWO)$/, '');
    const sectorCode = sectorBySymbol.get(code);
    const sectorEtf = SECTOR_ETF[sectorCode];
    if (!sectorEtf || history.length < 125) continue;
    sectorCoverage.set(sectorEtf, (sectorCoverage.get(sectorEtf) || 0) + 1);
    const closePrefix = [0];
    const valuePrefix = [0];
    const atrPrefix = [0];
    for (const row of history) {
      closePrefix.push(closePrefix.at(-1) + row.close);
      valuePrefix.push(valuePrefix.at(-1) + row.tradeValue);
      atrPrefix.push(atrPrefix.at(-1) + (row.high - row.low) / row.close * 100);
    }
    const mean = (prefix, end, length) => (prefix[end + 1] - prefix[end + 1 - length]) / length;
    for (let index = 120; index < history.length - 1; index += 1) {
      const row = history[index];
      const next = history[index + 1];
      const ma20 = mean(closePrefix, index, 20);
      const ma60 = mean(closePrefix, index, 60);
      const value20 = mean(valuePrefix, index, 20);
      const atr20Pct = mean(atrPrefix, index, 20);
      const mom20 = (row.close / history[index - 20].close - 1) * 100;
      const mom60 = (row.close / history[index - 60].close - 1) * 100;
      const distanceToMa20Pct = (row.close / ma20 - 1) * 100;
      const volumeRatio20 = row.tradeValue / Math.max(1, value20);
      if (row.close <= ma20 || ma20 <= ma60 || mom20 < 2 || mom60 < 5 || row.tradeValue < 50e6 || atr20Pct > 8 || distanceToMa20Pct > 15) continue;
      const us = usMaps[sectorEtf].get(next.date);
      const spy = usMaps.SPY.get(next.date);
      if (!us || !spy || us.sourceDate !== spy.sourceDate) continue;
      const common = {
        symbol,
        name: row.name,
        market: row.market,
        sectorCode,
        sectorEtf,
        signalDate: row.date,
        entryDate: next.date,
        entryOpen: next.open,
        tradeValue: row.tradeValue,
        volumeRatio20,
        atr20Pct,
        mom20,
        mom60,
        ma20,
        ma20AboveMa60: true,
        distanceToMa20Pct,
        gapPct: (next.open / row.close - 1) * 100,
        technicalScore: mom20 + mom60 * 0.45 + volumeRatio20 * 3 - atr20Pct
      };
      addSetup(setups, common, 'technical_control', null, spy);
      const excess = us.return1 - spy.return1;
      if (us.return1 > -1 && spy.return1 > -1.5 && excess > -1) addSetup(setups, common, 'us_sector_downside_filter', us, spy);
      if (us.return1 >= 0.75 && excess >= 0 && common.gapPct >= -0.5 && common.gapPct <= 1.5) addSetup(setups, common, 'us_sector_underreaction', us, spy);
      if (us.return1 >= 0.5 && spy.return1 >= 0 && common.gapPct <= 2) addSetup(setups, common, 'us_sector_broad_confirmation', us, spy);
      if (us.return3 >= 2 && us.return1 >= -1 && us.return1 <= 0.5 && common.gapPct <= 1) addSetup(setups, common, 'us_sector_cooling_pullback', us, spy);
    }
  }
  const byDateSetup = new Map();
  for (const setup of setups) {
    const key = `${setup.entryDate}|${setup.setup}`;
    const list = byDateSetup.get(key) || [];
    list.push(setup);
    byDateSetup.set(key, list);
  }
  for (const rows of byDateSetup.values()) {
    rows.sort((a, b) => b.score - a.score).forEach((row, index) => {
      row.strengthRankPct = rows.length === 1 ? 1 : 1 - index / (rows.length - 1);
      row.score += row.strengthRankPct * 20;
    });
  }
  return { setups, sectorCoverage: Object.fromEntries(sectorCoverage) };
}

function configs(setup) {
  const rows = [];
  for (const top of [3, 5, 8]) for (const holdDays of [3, 5, 10]) for (const stopLossPct of [4, 6]) {
    for (const takeProfitPct of [8, 12]) for (const marketMode of ['strong', 'breadth']) rows.push({
      id: `${setup}_top${top}_h${holdDays}_s${stopLossPct}_t${takeProfitPct}_${marketMode}`,
      setup,
      top,
      holdDays,
      stopLossPct,
      takeProfitPct,
      marketMode,
      stopMode: 'intraday',
      positionPct: 10,
      accountRiskPct: 0.5,
      minValue: 50e6,
      minMom20: 2,
      minMom60: 5,
      maxAtr: 8,
      minVolumeRatio: 0,
      maxDistance: 15,
      minRank: 0.5
    });
  }
  return rows;
}

function trainScore(metrics) {
  if (metrics.trades < 60 || metrics.profitFactor < 1 || metrics.maximumDrawdownPct < -20) return -Infinity;
  const middle = Math.floor(metrics.monthly.length / 2);
  const first = avg(metrics.monthly.slice(0, middle).map(row => row.returnPct));
  const second = avg(metrics.monthly.slice(middle).map(row => row.returnPct));
  if (Math.min(first, second) < -0.1) return -Infinity;
  return metrics.averageMonthlyReturnPct * 4 + Math.min(first, second) * 2 + metrics.profitFactor + metrics.maximumDrawdownPct * 0.08 + Math.min(300, metrics.trades) / 300;
}

async function evaluateFamily(setup, setups, dailyBars, dates, marketRisk) {
  const folds = [];
  for (const fold of FOLDS) {
    let selected;
    for (const config of configs(setup)) {
      const train = simulate(setups, dailyBars, dates, marketRisk, config, fold.train);
      const candidate = { config, train, score: trainScore(train) };
      if (!selected || candidate.score > selected.score) selected = candidate;
    }
    const enabled = Number.isFinite(selected.score);
    const validation = enabled ? simulate(setups, dailyBars, dates, marketRisk, selected.config, fold.validation) : null;
    const random = enabled ? simulate(setups, dailyBars, dates, marketRisk, selected.config, fold.validation, true) : null;
    folds.push({ trainPeriod: fold.train, validationPeriod: fold.validation, enabled, selectedConfig: selected.config, train: selected.train, validation, random });
  }
  const active = folds.filter(row => row.enabled);
  return {
    setup,
    testedConfigurationsPerFold: configs(setup).length,
    folds,
    metrics: active.length ? aggregate(active.map(row => row.validation)) : null,
    candidateRandom: active.length ? aggregate(active.map(row => row.random)) : null
  };
}

const experiment = {
  strategyId: 'us_sector_lead_lag_v1',
  dataSources: ['台股官方 OHLCV', 'Yahoo Finance 美股產業 ETF 日線', '目前靜態產業分類'],
  setupRules: ['美股產業 ETF D 日收盤領先台股 D+1 開盤', '台股位於 MA20 與 MA60 多頭排列', '測試下跌風險排除、未充分反映、廣泛確認與強勢降溫回檔'],
  triggerRules: ['下一個台股交易日開盤成交；未充分反映策略在開盤跳空過高時取消'],
  invalidationRules: ['固定風險停損與跳空較差價成交'],
  exitRules: ['3、5、10 日與停損停利'],
  riskRules: { accountRiskPct: 0.5, maximumPositionPct: 10, tPlusTwo: true },
  blockedWhen: ['台股大盤風險狀態不允許', '美股資料距離台股進場日超過四日'],
  parameters: { setupFamilies: SETUPS, configurationsPerFamilyPerFold: configs('x').length, staticSectorClassification: true },
  trainPeriod: '每段 72 個月',
  validationPeriod: '每段 24 個月，合併 2020-2025',
  costModel: '手續費、交易稅、雙邊滑價、最低手續費',
  executionModel: '共用 execution simulator 與 portfolio simulator；T+2；跳空停損使用較差價格'
};
const identity = buildExperimentIdentity(experiment);
const duplicate = shouldSkipExperiment(await loadRegistry(), identity, { ...experiment, coreRulesChanged: true });
if (duplicate.skip && !process.argv.includes('--force')) {
  console.log(JSON.stringify({ skipped: true, ...duplicate, ...identity }, null, 2));
  process.exit(0);
}

const [{ histories, dailyBars, coverage }, etfPayload, classifications, usPayload] = await Promise.all([
  loadData(),
  fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse),
  fs.readFile(SECTORS, 'utf8').then(JSON.parse),
  loadUsHistory()
]);
const dates = [...dailyBars.keys()].sort();
const entryDates = dates.filter(date => date >= '2014-01-01' && date <= '2025-12-31');
const usMaps = buildUsMaps(usPayload, entryDates);
const { setups, sectorCoverage } = buildSetups(histories, classifications, usMaps);
const marketRisk = buildMarketRisk(etfPayload.series['0050.TW'], buildBreadth(histories));
const results = [];
for (const setup of SETUPS) results.push(await evaluateFamily(setup, setups, dailyBars, dates, marketRisk));
const control = results.find(row => row.setup === 'technical_control');
const candidates = results.filter(row => row.setup !== 'technical_control' && row.metrics);
const best = candidates.sort((a, b) => b.metrics.averageMonthlyReturnPct - a.metrics.averageMonthlyReturnPct)[0] || null;
const benchmark = await benchmark0050(etfPayload.series['0050.TW']);
const passed = Boolean(best && best.metrics.trades > 300 && best.metrics.profitFactor > 1.15
  && best.metrics.maximumDrawdownPct > -20 && best.metrics.averageMonthlyReturnPct > benchmark.averageMonthlyReturnPct
  && best.metrics.averageMonthlyReturnPct > best.candidateRandom.averageMonthlyReturnPct);
const output = {
  generatedAt: new Date().toISOString(),
  ...identity,
  registryChecked: true,
  dataPolicy: {
    usPointInTime: '美股來源日必須早於台股進場日；美股 D 日收盤只供下一個台股交易日使用',
    sectorClassification: classifications.classificationMode,
    survivorshipBiasWarning: true,
    warning: '產業分類是目前靜態分類，不是歷史 point-in-time 分類；不得宣稱完全無倖存者偏差。'
  },
  coverage,
  usHistoryCoverage: Object.fromEntries(Object.entries(usPayload.series).map(([symbol, rows]) => [symbol, { rows: rows.length, start: rows[0]?.date, end: rows.at(-1)?.date }])),
  sectorCoverage,
  setupCounts: Object.fromEntries(SETUPS.map(setup => [setup, setups.filter(row => row.setup === setup).length])),
  results,
  benchmark0050: benchmark,
  bestStrategy: best,
  comparison: best ? {
    versusTechnicalControlMonthlyPct: round(best.metrics.averageMonthlyReturnPct - (control.metrics?.averageMonthlyReturnPct || 0)),
    versus0050MonthlyPct: round(best.metrics.averageMonthlyReturnPct - benchmark.averageMonthlyReturnPct),
    versusRandomMonthlyPct: round(best.metrics.averageMonthlyReturnPct - best.candidateRandom.averageMonthlyReturnPct)
  } : null,
  passed,
  paperTradingReady: passed,
  liveTradingReady: false,
  conclusion: passed ? '美股產業領先訊號通過最低候選標準，但仍只能進紙上交易。' : '美股產業領先訊號未通過最低候選標準，不可進紙上交易或實盤。'
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
const metricLine = row => row?.metrics ? `月均 ${row.metrics.averageMonthlyReturnPct}%、年化 ${row.metrics.annualizedReturnPct}%、最大回撤 ${row.metrics.maximumDrawdownPct}%、${row.metrics.trades} 筆、PF ${row.metrics.profitFactor}` : '訓練樣本不足，未啟用';
await fs.writeFile(REPORT, `# 美股產業隔夜領先台股策略 v1\n\n## 驗證結果\n\n- 驗證區間：2020-01-01 至 2025-12-31，三段 72 個月訓練／24 個月驗證。\n- 技術面對照：${metricLine(control)}。\n${candidates.map(row => `- ${row.setup}：${metricLine(row)}。`).join('\n')}\n- 0050 同期月均：${benchmark.averageMonthlyReturnPct}%。\n- 最佳策略：${best?.setup || '沒有'}；${best ? metricLine(best) : '沒有可驗證結果'}。\n- 結論：${output.conclusion}\n\n## 時間點與限制\n\n- 美股 D 日收盤只可用於下一個台股交易日，程式強制要求美股來源日期早於台股進場日期。\n- 成交、費稅、滑價、T+2、停損跳空皆共用現有模擬器。\n- 台股產業分類為目前靜態分類，存在分類倖存者偏差；本輪不能視為最終可實盤證據。\n`, 'utf8');
await appendExperiment({
  ...experiment,
  metrics: best?.metrics || null,
  resultStatus: passed ? 'passed' : 'failed',
  passedMinimum: passed,
  passedHighProfit: false,
  failureReason: passed ? null : output.conclusion,
  notes: `最佳 ${best?.setup || '無'}；相對 0050 月均差 ${output.comparison?.versus0050MonthlyPct ?? '無'} 個百分點。`,
  force: true
});
console.log(JSON.stringify({ best: best ? { setup: best.setup, metrics: best.metrics, random: best.candidateRandom } : null, technicalControl: control.metrics, benchmark0050: benchmark, comparison: output.comparison, setupCounts: output.setupCounts, passed, conclusion: output.conclusion }, null, 2));
