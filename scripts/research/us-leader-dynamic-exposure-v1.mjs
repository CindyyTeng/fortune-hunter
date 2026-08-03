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

const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const CACHE = new URL('../../data/research/us-leader-history-v1.json', import.meta.url);
const OUTPUT = new URL('../../data/research/us-leader-dynamic-exposure-v1.json', import.meta.url);
const REPORT = new URL('../../docs/US_LEADER_DYNAMIC_EXPOSURE_V1.md', import.meta.url);
const LEADERS = Object.freeze({
  semiconductor: ['NVDA', 'AMD', 'AVGO', 'MU', 'QCOM'],
  equipment: ['AMAT', 'LRCX', 'KLAC'],
  hardware: ['AAPL', 'DELL', 'HPE']
});
const FAMILIES = ['leader_positive_exposure', 'leader_shock_exposure', 'leader_underreaction', 'leader_multi_day'];

async function fetchYahoo(symbol) {
  const period1 = Math.floor(Date.parse('2013-01-01T00:00:00Z') / 1000);
  const period2 = Math.floor(Date.parse('2026-01-10T00:00:00Z') / 1000);
  let lastError;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const response = await fetch(`https://${host}/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d&includePrePost=false&events=div%2Csplits`, {
        headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const result = payload.chart?.result?.[0];
      const quote = result?.indicators?.quote?.[0];
      if (!result?.timestamp?.length || !quote) throw new Error('回傳欄位不完整');
      return result.timestamp.map((timestamp, index) => ({
        date: new Date(timestamp * 1000).toISOString().slice(0, 10),
        open: quote.open[index], high: quote.high[index], low: quote.low[index], close: quote.close[index]
      })).filter(row => [row.open, row.high, row.low, row.close].every(Number.isFinite));
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${symbol} 下載失敗：${lastError?.message || '未知錯誤'}`);
}

async function loadHistory() {
  const symbols = [...new Set(Object.values(LEADERS).flat())];
  try {
    const cached = JSON.parse(await fs.readFile(CACHE, 'utf8'));
    if (symbols.every(symbol => cached.series?.[symbol]?.length > 1_500)) return cached;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const series = {};
  for (const symbol of symbols) series[symbol] = await fetchYahoo(symbol);
  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'Yahoo Finance chart API（免費公開行情；非交易所逐筆官方資料）',
    pointInTimePolicy: '美股 D 日收盤只允許下一個台股交易日使用',
    leaders: LEADERS,
    series
  };
  await fs.writeFile(CACHE, `${JSON.stringify(payload)}\n`, 'utf8');
  return payload;
}

function basketSeries(payload) {
  const output = {};
  for (const [basket, symbols] of Object.entries(LEADERS)) {
    const byDate = new Map();
    for (const symbol of symbols) {
      const rows = payload.series[symbol] || [];
      for (let index = 1; index < rows.length; index += 1) {
        const values = byDate.get(rows[index].date) || [];
        values.push((rows[index].close / rows[index - 1].close - 1) * 100);
        byDate.set(rows[index].date, values);
      }
    }
    const dates = [...byDate].filter(([, values]) => values.length >= 2).sort(([a], [b]) => a.localeCompare(b));
    output[basket] = dates.map(([date, values], index) => ({
      date,
      return1: avg(values),
      return3: index >= 2 ? dates.slice(index - 2, index + 1).reduce((sum, [, part]) => sum + avg(part), 0) : null
    }));
  }
  return output;
}

function alignToTaiwan(series, dates) {
  const map = new Map();
  let index = 0;
  for (const date of dates) {
    while (index + 1 < series.length && series[index + 1].date < date) index += 1;
    const row = series[index];
    if (!row || row.date >= date || (Date.parse(date) - Date.parse(row.date)) / 86_400_000 > 4) continue;
    map.set(date, row);
  }
  return map;
}

function rollingExposure(history, aligned, basket) {
  const prefix = [{ n: 0, x: 0, y: 0, xx: 0, yy: 0, xy: 0 }];
  for (let index = 0; index < history.length; index += 1) {
    const prior = prefix.at(-1);
    const us = aligned[basket].get(history[index].date)?.return1;
    const taiwan = index ? (history[index].close / history[index - 1].close - 1) * 100 : null;
    if (!Number.isFinite(us) || !Number.isFinite(taiwan)) prefix.push({ ...prior });
    else prefix.push({ n: prior.n + 1, x: prior.x + us, y: prior.y + taiwan, xx: prior.xx + us * us, yy: prior.yy + taiwan * taiwan, xy: prior.xy + us * taiwan });
  }
  return index => {
    const end = prefix[index + 1];
    const start = prefix[Math.max(0, index + 1 - 120)];
    const n = end.n - start.n;
    if (n < 80) return null;
    const sx = end.x - start.x;
    const sy = end.y - start.y;
    const sxx = end.xx - start.xx;
    const syy = end.yy - start.yy;
    const sxy = end.xy - start.xy;
    const cov = sxy - sx * sy / n;
    const varX = sxx - sx * sx / n;
    const varY = syy - sy * sy / n;
    if (varX <= 0 || varY <= 0) return null;
    return { correlation: cov / Math.sqrt(varX * varY), beta: cov / varX, samples: n };
  };
}

function addCandidate(setups, common, family, match) {
  setups.push({
    ...common,
    setup: family,
    leaderBasket: match.basket,
    leaderSourceDate: match.us.date,
    leaderReturn1Pct: match.us.return1,
    leaderReturn3Pct: match.us.return3,
    rollingCorrelation: match.exposure.correlation,
    rollingBeta: match.exposure.beta,
    predictedMovePct: match.predicted,
    score: common.technicalScore + match.predicted * 8 + match.exposure.correlation * 20
  });
}

function buildSetups(histories, aligned) {
  const setups = [];
  for (const [symbol, history] of histories) {
    if (history.length < 180) continue;
    const exposure = Object.fromEntries(Object.keys(LEADERS).map(basket => [basket, rollingExposure(history, aligned, basket)]));
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
      if (row.close <= ma20 || ma20 <= ma60 || mom20 < 0 || mom60 < 5 || row.tradeValue < 50e6 || atr20Pct > 8 || distanceToMa20Pct > 15) continue;
      const matches = Object.keys(LEADERS).map(basket => {
        const us = aligned[basket].get(next.date);
        const currentExposure = exposure[basket](index);
        return us && currentExposure ? { basket, us, exposure: currentExposure, predicted: us.return1 * currentExposure.beta } : null;
      }).filter(Boolean).sort((a, b) => b.predicted - a.predicted);
      const common = {
        symbol, name: row.name, market: row.market, signalDate: row.date, entryDate: next.date, entryOpen: next.open,
        tradeValue: row.tradeValue, volumeRatio20: row.tradeValue / Math.max(1, value20), atr20Pct, mom20, mom60,
        ma20, ma20AboveMa60: true, distanceToMa20Pct, gapPct: (next.open / row.close - 1) * 100,
        technicalScore: mom20 + mom60 * 0.4 - atr20Pct + row.tradeValue / Math.max(1, value20) * 2
      };
      const positive = matches.find(match => match.us.return1 >= 0.75 && match.exposure.correlation >= 0.1 && match.exposure.beta >= 0.1);
      const shock = matches.find(match => match.us.return1 >= 1.5 && match.exposure.correlation >= 0.12 && match.exposure.beta >= 0.1);
      const multiDay = matches.find(match => match.us.return1 > 0 && match.us.return3 >= 2.5 && match.exposure.correlation >= 0.12 && match.exposure.beta >= 0.1);
      if (positive) addCandidate(setups, common, 'leader_positive_exposure', positive);
      if (shock) addCandidate(setups, common, 'leader_shock_exposure', shock);
      if (shock && common.gapPct >= -1 && common.gapPct <= Math.max(0.75, Math.min(2, shock.predicted * 0.7))) addCandidate(setups, common, 'leader_underreaction', shock);
      if (multiDay) addCandidate(setups, common, 'leader_multi_day', multiDay);
    }
  }
  const groups = new Map();
  for (const setup of setups) {
    const key = `${setup.entryDate}|${setup.setup}`;
    const rows = groups.get(key) || [];
    rows.push(setup);
    groups.set(key, rows);
  }
  for (const rows of groups.values()) rows.sort((a, b) => b.score - a.score).forEach((row, index) => {
    row.strengthRankPct = rows.length === 1 ? 1 : 1 - index / (rows.length - 1);
    row.score += row.strengthRankPct * 20;
  });
  return setups;
}

function configs(setup) {
  const rows = [];
  for (const top of [3, 5, 8]) for (const holdDays of [1, 2, 3, 5]) for (const stopLossPct of [3, 4]) {
    for (const takeProfitPct of [5, 8]) for (const marketMode of ['broad', 'strong']) rows.push({
      id: `${setup}_top${top}_h${holdDays}_s${stopLossPct}_t${takeProfitPct}_${marketMode}`,
      setup, top, holdDays, stopLossPct, takeProfitPct, marketMode, stopMode: 'intraday', positionPct: 10,
      accountRiskPct: 0.5, minValue: 50e6, minMom20: 0, minMom60: 5, maxAtr: 8,
      minVolumeRatio: 0, maxDistance: 15, minRank: 0.5
    });
  }
  return rows;
}

function trainScore(metrics) {
  if (metrics.trades < 80 || metrics.profitFactor < 1 || metrics.maximumDrawdownPct < -20) return -Infinity;
  const middle = Math.floor(metrics.monthly.length / 2);
  const first = avg(metrics.monthly.slice(0, middle).map(row => row.returnPct));
  const second = avg(metrics.monthly.slice(middle).map(row => row.returnPct));
  if (Math.min(first, second) < -0.1) return -Infinity;
  return metrics.averageMonthlyReturnPct * 4 + Math.min(first, second) * 2 + metrics.profitFactor + metrics.maximumDrawdownPct * 0.08 + Math.min(metrics.trades, 400) / 400;
}

async function evaluate(family, setups, dailyBars, dates, marketRisk) {
  const folds = [];
  for (const fold of FOLDS) {
    let selected;
    for (const config of configs(family)) {
      const train = simulate(setups, dailyBars, dates, marketRisk, config, fold.train);
      const candidate = { config, train, score: trainScore(train) };
      if (!selected || candidate.score > selected.score) selected = candidate;
    }
    const enabled = Number.isFinite(selected.score);
    folds.push({
      trainPeriod: fold.train, validationPeriod: fold.validation, enabled, selectedConfig: selected.config, train: selected.train,
      validation: enabled ? simulate(setups, dailyBars, dates, marketRisk, selected.config, fold.validation) : null,
      random: enabled ? simulate(setups, dailyBars, dates, marketRisk, selected.config, fold.validation, true) : null
    });
  }
  const active = folds.filter(row => row.enabled);
  return { family, folds, metrics: active.length ? aggregate(active.map(row => row.validation)) : null, random: active.length ? aggregate(active.map(row => row.random)) : null };
}

const experiment = {
  strategyId: 'us_leader_dynamic_exposure_v1',
  dataSources: ['台股官方 OHLCV', 'Yahoo Finance 美國科技龍頭日線'],
  setupRules: ['用訊號日前 120 日資料動態估計每檔台股對三組美國科技龍頭的落後相關性與 beta', '美國龍頭上漲且台股維持多頭趨勢'],
  triggerRules: ['隔日開盤進場；未充分反映策略排除過度跳空'],
  invalidationRules: ['盤中停損與跳空較差價'],
  exitRules: ['1、2、3、5 日短打與停損停利'],
  riskRules: { accountRiskPct: 0.5, maximumPositionPct: 10, tPlusTwo: true },
  blockedWhen: ['大盤風險狀態不允許', '歷史相關樣本少於 80 日'],
  parameters: { leaders: LEADERS, rollingDays: 120, families: FAMILIES, configurationsPerFamilyPerFold: configs('x').length },
  trainPeriod: '每段 72 個月', validationPeriod: '每段 24 個月，合併 2020-2025',
  costModel: '手續費、交易稅、雙邊滑價、最低手續費', executionModel: '共用成交與投組模擬器；T+2；跳空停損使用較差價格'
};
const identity = buildExperimentIdentity(experiment);
const duplicate = shouldSkipExperiment(await loadRegistry(), identity, { ...experiment, coreRulesChanged: true });
if (duplicate.skip && !process.argv.includes('--force')) {
  console.log(JSON.stringify({ skipped: true, ...duplicate, ...identity }, null, 2));
  process.exit(0);
}

const [{ histories, dailyBars, coverage }, etfPayload, usPayload] = await Promise.all([
  loadData(), fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse), loadHistory()
]);
const dates = [...dailyBars.keys()].sort();
const baskets = basketSeries(usPayload);
const aligned = Object.fromEntries(Object.entries(baskets).map(([name, rows]) => [name, alignToTaiwan(rows, dates)]));
const setups = buildSetups(histories, aligned);
const marketRisk = buildMarketRisk(etfPayload.series['0050.TW'], buildBreadth(histories));
const results = [];
for (const family of FAMILIES) results.push(await evaluate(family, setups, dailyBars, dates, marketRisk));
const best = results.filter(row => row.metrics).sort((a, b) => b.metrics.averageMonthlyReturnPct - a.metrics.averageMonthlyReturnPct)[0] || null;
const benchmark = await benchmark0050(etfPayload.series['0050.TW']);
const passed = Boolean(best && best.folds.every(row => row.enabled) && best.metrics.trades > 300 && best.metrics.profitFactor > 1.15 && best.metrics.maximumDrawdownPct > -20 && best.metrics.averageMonthlyReturnPct > benchmark.averageMonthlyReturnPct && best.metrics.averageMonthlyReturnPct > best.random.averageMonthlyReturnPct);
const output = {
  generatedAt: new Date().toISOString(), ...identity, registryChecked: true, coverage,
  taiwanUniverse: '不寫死台股代號；依歷史相關性動態選股',
  usHistoryCoverage: Object.fromEntries(Object.entries(usPayload.series).map(([symbol, rows]) => [symbol, { rows: rows.length, start: rows[0]?.date, end: rows.at(-1)?.date }])),
  setupCounts: Object.fromEntries(FAMILIES.map(family => [family, setups.filter(row => row.setup === family).length])),
  results, bestStrategy: best, benchmark0050: benchmark,
  comparison: best ? { versus0050MonthlyPct: round(best.metrics.averageMonthlyReturnPct - benchmark.averageMonthlyReturnPct), versusRandomMonthlyPct: round(best.metrics.averageMonthlyReturnPct - best.random.averageMonthlyReturnPct) } : null,
  passed, paperTradingReady: passed, liveTradingReady: false,
  conclusion: passed ? '美國科技龍頭動態曝險策略通過最低候選標準，但仍只能進紙上交易。' : '美國科技龍頭動態曝險策略未通過最低候選標準，不可進紙上交易或實盤。'
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
const metric = row => row?.metrics ? `月均 ${row.metrics.averageMonthlyReturnPct}%、年化 ${row.metrics.annualizedReturnPct}%、最大回撤 ${row.metrics.maximumDrawdownPct}%、${row.metrics.trades} 筆、PF ${row.metrics.profitFactor}` : '訓練未穩定啟用';
await fs.writeFile(REPORT, `# 美國科技龍頭動態曝險策略 v1\n\n- 驗證：2020-01-01 至 2025-12-31；每段訓練 72 個月、驗證 24 個月。\n- 台股沒有寫死名單，以訊號日前 120 日相關性與 beta 動態選股。\n${results.map(row => `- ${row.family}：${metric(row)}。`).join('\n')}\n- 最佳：${best?.family || '沒有'}；${metric(best)}。\n- 0050 月均：${benchmark.averageMonthlyReturnPct}%；公平隨機：${best?.random?.averageMonthlyReturnPct ?? '無'}%。\n- 結論：${output.conclusion}\n\n美股 D 日收盤只供下一個台股交易日使用；所有相關性只使用進場日前資料。費稅、滑價、T+2 與跳空停損共用既有模擬器。\n`, 'utf8');
await appendExperiment({ ...experiment, metrics: best?.metrics || null, resultStatus: passed ? 'passed' : 'failed', passedMinimum: passed, passedHighProfit: false, failureReason: passed ? null : output.conclusion, notes: `最佳 ${best?.family || '無'}；相對 0050 月均 ${output.comparison?.versus0050MonthlyPct ?? '無'} 個百分點。`, force: true });
console.log(JSON.stringify({ best: best ? { family: best.family, metrics: best.metrics, random: best.random, folds: best.folds.map(row => ({ validationPeriod: row.validationPeriod, enabled: row.enabled, selectedConfig: row.selectedConfig.id, validation: row.validation })) } : null, benchmark0050: benchmark, comparison: output.comparison, setupCounts: output.setupCounts, passed, conclusion: output.conclusion }, null, 2));
