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

const CASHFLOW = new URL('../../data/cashflow-quality/cashflow-quality.json', import.meta.url);
const VALUATION = new URL('../../.cache/valuation/', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-cashflow-value-momentum-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_CASHFLOW_VALUE_MOMENTUM_V1.md', import.meta.url);
const FAMILIES = ['cashflow_yield_momentum', 'cashflow_value_momentum', 'cashflow_low_accrual_momentum', 'cashflow_acceleration_value'];

const number = value => {
  const parsed = Number(String(value ?? '').replaceAll(',', '').replaceAll('--', '').replace('N/A', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
};
const percentile = (sorted, value) => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return sorted.length ? low / sorted.length : 0;
};
const sorted = values => values.filter(Number.isFinite).sort((a, b) => a - b);

async function loadValuation() {
  const byDate = new Map();
  for (const market of ['twse', 'tpex']) {
    let files;
    try {
      files = (await fs.readdir(new URL(`${market}/`, VALUATION))).filter(file => file.endsWith('.json')).sort();
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`缺少官方估值快取：.cache/valuation/${market}`);
      throw error;
    }
    for (const file of files) {
      const date = file.slice(0, 10);
      if (date < '2014-01-01' || date > '2025-12-31') continue;
      const payload = JSON.parse(await fs.readFile(new URL(`${market}/${file}`, VALUATION), 'utf8'));
      const rows = market === 'twse' ? payload.data || [] : payload.tables?.[0]?.data || [];
      const suffix = market === 'twse' ? '.TW' : '.TWO';
      const snapshot = byDate.get(date) || [];
      for (const row of rows) {
        const symbol = String(row[0] || '').trim();
        const pb = number(row[6]);
        if (/^\d{4}$/.test(symbol) && !symbol.startsWith('00') && pb > 0) {
          snapshot.push({ symbol: `${symbol}${suffix}`, market: market.toUpperCase(), pb });
        }
      }
      byDate.set(date, snapshot);
    }
  }
  return byDate;
}

function cashflowIndex(records) {
  const result = new Map();
  for (const row of records) {
    if (!row.isPointInTimeSafe || !Number.isFinite(row.operatingCashFlow) || !Number.isFinite(row.totalEquity)) continue;
    const symbol = `${row.symbol}.${row.market === 'TPEX' ? 'TWO' : 'TW'}`;
    const rows = result.get(symbol) || [];
    rows.push(row);
    result.set(symbol, rows);
  }
  for (const rows of result.values()) rows.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  return result;
}

function latestCashflow(rows, date) {
  if (!rows) return null;
  let end = rows.length - 1;
  while (end >= 0 && rows[end].effectiveDate > date) end -= 1;
  if (end < 3) return null;
  const quarters = rows.slice(end - 3, end + 1);
  if (new Set(quarters.map(row => row.quarter)).size !== 4) return null;
  const ttmOperatingCashFlow = quarters.reduce((sum, row) => sum + row.operatingCashFlow, 0);
  const latest = quarters.at(-1);
  return { ttmOperatingCashFlow, latest };
}

function buildSetups(histories, valuationByDate, cashflows) {
  const indexes = new Map([...histories].map(([symbol, rows]) => [symbol, new Map(rows.map((row, index) => [row.date, index]))]));
  const setups = [];
  const coverage = [];
  for (const [date, valuations] of [...valuationByDate].sort(([a], [b]) => a.localeCompare(b))) {
    const observations = [];
    for (const valuation of valuations) {
      const rows = histories.get(valuation.symbol);
      const index = indexes.get(valuation.symbol)?.get(date);
      if (!rows || index < 120 || index + 1 >= rows.length) continue;
      const cashflow = latestCashflow(cashflows.get(valuation.symbol), date);
      if (!cashflow || cashflow.ttmOperatingCashFlow <= 0 || cashflow.latest.totalEquity <= 0) continue;
      const row = rows[index];
      const next = rows[index + 1];
      const ma20 = avg(rows.slice(index - 19, index + 1).map(item => item.close));
      const ma60 = avg(rows.slice(index - 59, index + 1).map(item => item.close));
      const value20 = avg(rows.slice(index - 19, index + 1).map(item => item.tradeValue || 0));
      const marketCapProxy = valuation.pb * cashflow.latest.totalEquity;
      if (marketCapProxy <= 0 || value20 < 20e6) continue;
      observations.push({
        symbol: valuation.symbol,
        name: row.name,
        market: row.market,
        signalDate: date,
        entryDate: next.date,
        entryOpen: next.open,
        tradeValue: row.tradeValue,
        volumeRatio20: row.tradeValue / Math.max(1, value20),
        atr20Pct: avg(rows.slice(index - 19, index + 1).map(item => (item.high - item.low) / item.close * 100)),
        mom20: (row.close / rows[index - 20].close - 1) * 100,
        mom60: (row.close / rows[index - 60].close - 1) * 100,
        ma20,
        distanceToMa20Pct: (row.close / ma20 - 1) * 100,
        ma20AboveMa60: ma20 > ma60,
        cashflowYield: cashflow.ttmOperatingCashFlow / marketCapProxy,
        bookToMarket: 1 / valuation.pb,
        accrualRatio: cashflow.latest.accrualRatio,
        cashflowYoY: cashflow.latest.operatingCashFlowYoY,
        pointInTimeEffectiveDate: cashflow.latest.effectiveDate
      });
    }
    for (const market of ['TWSE', 'TPEX']) {
      const peers = observations.filter(row => row.market === market);
      const ranks = {
        cashflowYield: sorted(peers.map(row => row.cashflowYield)),
        bookToMarket: sorted(peers.map(row => row.bookToMarket)),
        momentum: sorted(peers.map(row => row.mom60))
      };
      for (const row of peers) {
        row.cashflowYieldRank = percentile(ranks.cashflowYield, row.cashflowYield);
        row.bookToMarketRank = percentile(ranks.bookToMarket, row.bookToMarket);
        row.momentumRank = percentile(ranks.momentum, row.mom60);
        row.strengthRankPct = row.momentumRank;
        const add = (setup, score) => setups.push({ ...row, setup, score });
        if (row.cashflowYieldRank >= 0.8 && row.momentumRank >= 0.6) {
          add('cashflow_yield_momentum', row.cashflowYieldRank * 45 + row.momentumRank * 35 + row.bookToMarketRank * 10 - row.atr20Pct);
        }
        if (row.cashflowYieldRank >= 0.7 && row.bookToMarketRank >= 0.7 && row.momentumRank >= 0.6) {
          add('cashflow_value_momentum', row.cashflowYieldRank * 35 + row.bookToMarketRank * 30 + row.momentumRank * 35 - row.atr20Pct);
        }
        if (row.cashflowYieldRank >= 0.7 && row.accrualRatio <= 0.2 && row.momentumRank >= 0.6) {
          add('cashflow_low_accrual_momentum', row.cashflowYieldRank * 40 + row.momentumRank * 40 + Math.max(-10, -row.accrualRatio) - row.atr20Pct);
        }
        if (row.cashflowYieldRank >= 0.6 && row.bookToMarketRank >= 0.6 && row.momentumRank >= 0.6 && row.cashflowYoY >= 20) {
          add('cashflow_acceleration_value', row.cashflowYieldRank * 25 + row.bookToMarketRank * 25 + row.momentumRank * 35 + Math.min(15, row.cashflowYoY / 10) - row.atr20Pct);
        }
      }
    }
    coverage.push({ date, eligibleStocks: observations.length });
  }
  return { setups, coverage };
}

function configs(setup) {
  const result = [];
  for (const top of [5, 10]) {
    for (const holdDays of [20, 40, 60]) {
      for (const stopLossPct of [8, 12]) {
        for (const takeProfitPct of [20, 35]) {
          for (const marketMode of ['trend', 'strong']) {
            result.push({
              id: `${setup}_top${top}_h${holdDays}_s${stopLossPct}_t${takeProfitPct}_${marketMode}`,
              setup, top, holdDays, stopLossPct, takeProfitPct, marketMode,
              stopMode: 'intraday', positionPct: Math.min(10, 100 / top), accountRiskPct: 0.5,
              minValue: 30e6, minMom20: -10, minMom60: 0, maxAtr: 8,
              minVolumeRatio: 0.25, maxDistance: 25, minRank: 0
            });
          }
        }
      }
    }
  }
  return result;
}

function trainScore(metrics) {
  if (metrics.trades < 45 || metrics.profitFactor < 0.95 || metrics.maximumDrawdownPct < -25) return -Infinity;
  const size = Math.ceil(metrics.monthly.length / 3);
  const thirds = [0, 1, 2].map(index => avg(metrics.monthly.slice(index * size, (index + 1) * size).map(row => row.returnPct)));
  if (thirds.filter(value => value > 0).length < 2 || thirds.at(-1) <= 0) return -Infinity;
  return metrics.averageMonthlyReturnPct * 4 + Math.min(...thirds) * 2 + metrics.profitFactor + metrics.maximumDrawdownPct * 0.08;
}

const experiment = {
  strategyId: 'stock_cashflow_value_momentum_v1',
  dataSources: ['官方日線 OHLCV', 'TWSE/TPEx 官方月度估值', 'MOPS 季度現金流量表'],
  setupRules: ['正營業現金流殖利率排名', '股價淨值比價值排名', '中期相對動能確認'],
  triggerRules: ['月度訊號完成後下一交易日開盤'],
  invalidationRules: ['跌破風險停損或 MA20 防線'],
  exitRules: ['固定最長持有期、停損、停利與移動停利'],
  riskRules: { accountRiskPct: 0.5, maximumPositionPct: 10, tPlusTwo: true },
  blockedWhen: ['大盤風險狀態不允許', '成交值不足', '現金流非正或估值無效'],
  parameters: { families: FAMILIES, trainSelectionOnly: true },
  trainPeriod: '每段 72 個月', validationPeriod: '每段 24 個月，共 2020-2025',
  costModel: '手續費、交易稅、買賣滑價與最低手續費',
  executionModel: '共用成交與投組模擬器、T+2、跳空使用實際開盤價'
};
const identity = buildExperimentIdentity(experiment);
const duplicate = shouldSkipExperiment(await loadRegistry(), identity, { ...experiment, coreRulesChanged: true });
if (duplicate.skip && !process.argv.includes('--force')) {
  console.log(JSON.stringify({ skipped: true, ...duplicate, ...identity }, null, 2));
  process.exit(0);
}

const [{ histories, dailyBars, coverage: marketCoverage }, cashflowPayload, valuationByDate, etfPayload] = await Promise.all([
  loadData(), fs.readFile(CASHFLOW, 'utf8').then(JSON.parse), loadValuation(), fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)
]);
const dates = [...dailyBars.keys()].sort();
const marketRisk = buildMarketRisk(etfPayload.series['0050.TW'], buildBreadth(histories));
const { setups, coverage } = buildSetups(histories, valuationByDate, cashflowIndex(cashflowPayload.records || []));
const folds = [];
for (const fold of FOLDS) {
  let selected;
  for (const family of FAMILIES) {
    for (const config of configs(family)) {
      const train = simulate(setups, dailyBars, dates, marketRisk, config, fold.train);
      const candidate = { family, config, train, score: trainScore(train) };
      if (!selected || candidate.score > selected.score) selected = candidate;
    }
  }
  const enabled = Number.isFinite(selected?.score);
  folds.push({
    trainPeriod: fold.train, validationPeriod: fold.validation, enabled,
    selectedFamily: selected?.family || null, selectedConfig: selected?.config || null,
    train: selected?.train || null,
    validation: enabled ? simulate(setups, dailyBars, dates, marketRisk, selected.config, fold.validation) : null,
    random: enabled ? simulate(setups, dailyBars, dates, marketRisk, selected.config, fold.validation, true) : null
  });
}
const active = folds.filter(row => row.enabled);
const metrics = active.length ? aggregate(active.map(row => row.validation)) : null;
const random = active.length ? aggregate(active.map(row => row.random)) : null;
const benchmark = await benchmark0050(etfPayload.series['0050.TW']);
const passed = Boolean(metrics && active.length === FOLDS.length && metrics.trades > 300 && metrics.profitFactor > 1.15 && metrics.maximumDrawdownPct > -20 && metrics.averageMonthlyReturnPct > benchmark.averageMonthlyReturnPct && metrics.averageMonthlyReturnPct > random.averageMonthlyReturnPct);
const conclusion = passed
  ? '現金流價值動能策略通過最低候選標準，但仍只允許進入紙上交易。'
  : '找不到通過驗證的現金流價值動能策略，不可紙上交易或實盤。';
const output = {
  generatedAt: new Date().toISOString(), ...identity, registryChecked: true,
  pointInTimePolicy: '財報僅於保守 effectiveDate 後使用；月度估值於訊號日收盤後形成，下一交易日才進場。',
  approximationWarning: '現金流殖利率以股價淨值比乘最新權益估算市值，非逐日精確流通市值。',
  marketCoverage, valuationMonths: valuationByDate.size,
  coverage: { months: coverage.length, averageEligibleStocks: round(avg(coverage.map(row => row.eligibleStocks))) },
  setupCounts: Object.fromEntries(FAMILIES.map(family => [family, setups.filter(row => row.setup === family).length])),
  folds, metrics, candidateRandom: random, benchmark0050: benchmark,
  passedMinimum: passed, passedHighProfit: false, paperTradingReady: passed, liveTradingReady: false, conclusion
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 現金流價值動能策略 v1\n\n- 驗證區間：2020-01-01 至 2025-12-31，共三段各 24 個月的樣本外驗證。\n- 資料：官方 OHLCV、官方月度股價淨值比、MOPS 季度營業現金流；所有財報僅在 effectiveDate 後使用。\n- 方法：每段只在 72 個月訓練期選擇策略與參數，驗證期固定不調整。\n- 結果：${metrics ? `月均 ${metrics.averageMonthlyReturnPct}%、年化 ${metrics.annualizedReturnPct}%、最大回撤 ${metrics.maximumDrawdownPct}%、${metrics.trades} 筆、PF ${metrics.profitFactor}` : '沒有任何訓練組合達到啟用門檻'}。\n- 基準：0050 月均 ${benchmark.averageMonthlyReturnPct}%；公平隨機 ${random?.averageMonthlyReturnPct ?? '無資料'}%。\n- 限制：現金流殖利率的市值分母由股價淨值比乘最新權益估算，應視為研究近似值。\n- 結論：${conclusion}\n`, 'utf8');
await appendExperiment({ ...experiment, metrics, resultStatus: passed ? 'passed' : 'failed', passedMinimum: passed, passedHighProfit: false, failureReason: passed ? null : conclusion, notes: '現金流價值、低應計與動能的全新資料組合。', force: true });
console.log(JSON.stringify({ setupCounts: output.setupCounts, folds: folds.map(row => ({ validationPeriod: row.validationPeriod, enabled: row.enabled, selectedFamily: row.selectedFamily, train: row.train, validation: row.validation })), metrics, random, benchmark, passed, conclusion }, null, 2));
