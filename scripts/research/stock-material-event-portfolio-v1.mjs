import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import {
  beginPortfolioDay,
  closePosition,
  createPortfolio,
  markPosition,
  openPosition,
  recordEquity,
  settleCash
} from '../lib/portfolio-simulator.mjs';
import { buyExecution, sellExecution } from '../lib/execution-simulator.mjs';
import { buildExperimentIdentity, loadRegistry, shouldSkipExperiment } from './strategy-experiment-registry.mjs';

const EVENTS = new URL('../../data/material-information/processed/history-liquid-universe.json.gz', import.meta.url);
const MARKET = new URL('../../data/market-history/processed/', import.meta.url);
const BENCHMARK = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-material-event-portfolio-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_MATERIAL_EVENT_PORTFOLIO_V1.md', import.meta.url);
const ALPHA_REPORT = new URL('../../data/research/stock-material-event-alpha-v1.json', import.meta.url);
const PERIODS = { train: ['2021-01-01', '2023-12-31'], validation: ['2024-01-01', '2025-12-31'] };
const COSTS = { buyFeePct: 0.1425, sellFeePct: 0.1425, sellTaxPct: 0.3, buySlippagePct: 0.1, sellSlippagePct: 0.1, minimumFee: 20, boardLotShares: 1 };
const CONFIG = { holdDays: 20, stopLossPct: 8, positionPct: 9, maxOpenPositions: 6, exposurePct: 60 };
const round = (value, digits = 4) => Number(Number(value || 0).toFixed(digits));

async function loadHistories() {
  const stocks = new Map();
  const dates = new Set();
  for (const year of [2021, 2022, 2023, 2024, 2025]) {
    const payload = JSON.parse(zlib.gunzipSync(await fs.readFile(new URL(`${year}.json.gz`, MARKET))));
    for (const [symbol, rows] of Object.entries(payload.symbols || {})) {
      if (!/^\d{4}\.(TW|TWO)$/.test(symbol) || symbol.startsWith('00')) continue;
      const usable = rows.filter(row => !row.corporateActionSuspected);
      stocks.set(symbol, (stocks.get(symbol) || []).concat(usable));
      usable.forEach(row => dates.add(row.date));
    }
  }
  for (const rows of stocks.values()) {
    rows.sort((a, b) => a.date.localeCompare(b.date));
    rows.dateIndex = new Map(rows.map((row, index) => [row.date, index]));
  }
  return { stocks, dates: [...dates].sort() };
}

function deterministicIndex(value, size) {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return Math.abs(hash) % Math.max(1, size);
}

const CATEGORY_PATTERN = {
  capital_cash_raise: /現金增資/,
  capital_convertible_bond: /可轉換公司債|轉換公司債/,
  capital_private_placement: /私募/
};

function buildSignals(events, stocks, selectedCategory, random = false) {
  const symbols = [...stocks.keys()];
  const seen = new Set();
  const signals = new Map();
  for (const event of events) {
    if (!CATEGORY_PATTERN[selectedCategory]?.test(event.subject || '')) continue;
    const eventRows = stocks.get(event.symbol);
    const eventIndex = eventRows?.findIndex(row => row.date >= event.effectiveDate) ?? -1;
    if (eventIndex < 60 || eventIndex + CONFIG.holdDays >= eventRows.length) continue;
    const signalDate = eventRows[eventIndex].date;
    let symbol = event.symbol;
    if (random) {
      const start = deterministicIndex(`${event.symbol}|${event.effectiveDate}`, symbols.length);
      symbol = '';
      for (let offset = 0; offset < symbols.length; offset += 1) {
        const candidate = symbols[(start + offset) % symbols.length];
        const candidateIndex = stocks.get(candidate)?.dateIndex.get(signalDate);
        if (candidateIndex >= 60 && candidateIndex + CONFIG.holdDays < stocks.get(candidate).length) {
          symbol = candidate;
          break;
        }
      }
    }
    const rows = stocks.get(symbol);
    if (!rows) continue;
    const index = rows.dateIndex.get(signalDate) ?? -1;
    if (index < 60 || index + CONFIG.holdDays >= rows.length) continue;
    const date = rows[index].date;
    const key = `${symbol}|${date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = signals.get(date) || [];
    list.push({ symbol, event, row: rows[index] });
    signals.set(date, list);
  }
  return signals;
}

function metrics(portfolio, start, end) {
  const curve = portfolio.equityCurve;
  const months = new Map();
  curve.forEach(row => months.set(row.date.slice(0, 7), row.equity));
  let prior = portfolio.initialCapital;
  const monthlyReturns = [...months].map(([month, equity]) => {
    const value = (equity / prior - 1) * 100;
    prior = equity;
    return { month, returnPct: round(value) };
  });
  const years = Math.max(1 / 12, (Date.parse(end) - Date.parse(start)) / (365.25 * 86400000));
  const finalEquity = curve.at(-1)?.equity || portfolio.initialCapital;
  const gains = portfolio.closedTrades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(portfolio.closedTrades.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
  return {
    finalEquity,
    totalReturnPct: round((finalEquity / portfolio.initialCapital - 1) * 100),
    annualizedReturnPct: round((Math.pow(finalEquity / portfolio.initialCapital, 1 / years) - 1) * 100),
    averageMonthlyReturnPct: round(monthlyReturns.reduce((sum, row) => sum + row.returnPct, 0) / Math.max(1, monthlyReturns.length)),
    maxDrawdownPct: round(Math.min(0, ...curve.map(row => row.drawdownPct))),
    trades: portfolio.closedTrades.length,
    winRatePct: round(portfolio.closedTrades.filter(row => row.realizedPnl > 0).length / Math.max(1, portfolio.closedTrades.length) * 100),
    profitFactor: losses ? round(gains / losses) : null,
    rejectedEntries: portfolio.rejectedEntries.length,
    monthlyReturns
  };
}

function simulate(stocks, allDates, signals, period, selectedCategory) {
  const dates = allDates.filter(date => date >= period[0] && date <= period[1]);
  const portfolio = createPortfolio({
    initialCapital: 1_000_000,
    settlementDays: 2,
    maxOpenPositions: CONFIG.maxOpenPositions,
    executionCosts: COSTS,
    riskRules: {
      maxAccountRiskPct: 0.5,
      maxSinglePositionPct: 10,
      exposureLimits: { RANGE_BOUND: CONFIG.exposurePct }
    }
  });
  dates.forEach((date, dayIndex) => {
    settleCash(portfolio, dayIndex);
    beginPortfolioDay(portfolio, date, dayIndex, 'RANGE_BOUND');
    for (const position of [...portfolio.positions]) {
      const bar = stocks.get(position.symbol)?.find(row => row.date === date);
      if (!bar) continue;
      markPosition(portfolio, position.tradeId, bar.close);
      if (bar.open <= position.stopLoss) closePosition(portfolio, position, { date, price: bar.open, reason: '跳空跌破 8% 停損', type: 'stop_loss' }, dayIndex);
      else if (bar.low <= position.stopLoss) closePosition(portfolio, position, { date, price: position.stopLoss, reason: '盤中跌破 8% 停損', type: 'stop_loss' }, dayIndex);
      else if (dayIndex - position.entryDayIndex >= CONFIG.holdDays) closePosition(portfolio, position, { date, price: bar.close, reason: '固定持有 20 個交易日', type: 'time_exit' }, dayIndex);
    }
    for (const signal of signals.get(date) || []) {
      const entryPrice = signal.row.open;
      openPosition(portfolio, {
        tradeId: `${signal.symbol}-${date}`,
        symbol: signal.symbol,
        name: signal.event.stockName,
        strategy: `${selectedCategory}_event`,
        entryDate: date,
        entryPrice,
        stopLoss: entryPrice * (1 - CONFIG.stopLossPct / 100),
        setup: `公司發布 ${selectedCategory} 重大訊息`,
        trigger: '公告後下一個交易日開盤',
        invalidation: '價格跌破進場價 8%',
        orderIntent: { action: 'BUY', orderType: 'MARKET', timing: 'NEXT_OPEN' },
        regime: 'RANGE_BOUND'
      }, dayIndex, { regime: 'RANGE_BOUND', positionPct: CONFIG.positionPct, accountRiskPct: 0.5 });
    }
    recordEquity(portfolio, date, { dayIndex, regime: 'RANGE_BOUND' });
  });
  return { metrics: metrics(portfolio, period[0], period[1]), trades: portfolio.closedTrades };
}

function benchmarkMetrics(rows, period) {
  const range = rows.filter(row => row.date >= period[0] && row.date <= period[1]);
  if (range.length < 2) return null;
  const buy = buyExecution(range[0].open, 1000, COSTS);
  const sell = sellExecution(range.at(-1).close, 1000, COSTS);
  const years = (Date.parse(period[1]) - Date.parse(period[0])) / (365.25 * 86400000);
  const totalReturnPct = (sell.net / buy.total - 1) * 100;
  return { totalReturnPct: round(totalReturnPct), annualizedReturnPct: round((Math.pow(1 + totalReturnPct / 100, 1 / years) - 1) * 100) };
}

const { stocks, dates } = await loadHistories();
const eventPayload = JSON.parse(zlib.gunzipSync(await fs.readFile(EVENTS)).toString('utf8'));
const alphaReport = JSON.parse(await fs.readFile(ALPHA_REPORT, 'utf8'));
const trainEligible = alphaReport.results.filter(result => CATEGORY_PATTERN[result.category]
  && result.train.samples >= 50
  && result.train.medianReturnPct > 0
  && result.train.profitFactor > 1.1
  && result.train.alphaVsRandomPct > 0
  && result.train.alphaVsBenchmarkPct > 0)
  .sort((a, b) => b.train.alphaVsBenchmarkPct - a.train.alphaVsBenchmarkPct);
const selected = trainEligible[0];
if (!selected) throw new Error('訓練期沒有合格的資本事件子類，不執行投組回測');
CONFIG.holdDays = selected.holdDays;
const experiment = {
  strategyId: `stock-material-${selected.category}-event-v2`,
  dataSources: ['MOPS material information', 'official OHLCV'],
  setupRules: [`訓練期選出的 ${selected.category} 事件`],
  triggerRules: ['公告後下一個交易日開盤'],
  invalidationRules: ['進場價下方 8%'],
  exitRules: [`${selected.holdDays} 個交易日`, '8% 停損'],
  riskRules: CONFIG,
  blockedWhen: ['單檔或總曝險超限', '投組熔斷'],
  parameters: CONFIG,
  trainPeriod: PERIODS.train,
  validationPeriod: PERIODS.validation,
  costModel: COSTS,
  executionModel: '共用 execution-simulator 與 portfolio-simulator'
};
const identity = buildExperimentIdentity(experiment);
const registryCheck = shouldSkipExperiment(await loadRegistry(), identity, { ...experiment, coreRulesChanged: true });
if (registryCheck.skip && !process.argv.includes('--force')) {
  console.log(`策略查重略過：${registryCheck.reason}`);
  process.exit(0);
}
const signals = buildSignals(eventPayload.events || [], stocks, selected.category, false);
const randomSignals = buildSignals(eventPayload.events || [], stocks, selected.category, true);
const benchmarkRows = JSON.parse(await fs.readFile(BENCHMARK, 'utf8')).benchmark;
const train = simulate(stocks, dates, signals, PERIODS.train, selected.category);
const validation = simulate(stocks, dates, signals, PERIODS.validation, selected.category);
const randomValidation = simulate(stocks, dates, randomSignals, PERIODS.validation, selected.category);
const benchmark = benchmarkMetrics(benchmarkRows, PERIODS.validation);
const passed = validation.metrics.trades >= 100
  && validation.metrics.profitFactor > 1.15
  && validation.metrics.maxDrawdownPct > -20
  && validation.metrics.annualizedReturnPct > benchmark.annualizedReturnPct
  && validation.metrics.annualizedReturnPct > randomValidation.metrics.annualizedReturnPct;
const report = {
  generatedAt: new Date().toISOString(),
  experimentHash: identity.experimentHash,
  selectedUsingTrainOnly: true,
  selectedCategory: selected.category,
  survivorshipBiasWarning: true,
  config: CONFIG,
  train: train.metrics,
  validation: validation.metrics,
  randomValidation: randomValidation.metrics,
  benchmark0050: benchmark,
  passedResearchThreshold: passed,
  paperTradingAllowed: false,
  liveTradingAllowed: false,
  conclusion: passed
    ? '通過本次初步投組門檻，但因倖存者偏差與資料範圍有限，仍不可進 paper trading。'
    : '未通過完整投組門檻，不可進 paper trading 或實盤。'
};
await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 重大訊息事件投組驗證\n\n- 訓練：${PERIODS.train.join(' 至 ')}；驗證：${PERIODS.validation.join(' 至 ')}。\n- 訓練期選出：${selected.category}，持有 ${selected.holdDays} 日；validation 未參與選擇。\n- 規則：公告後下一交易日開盤進場，8% 停損。\n- 驗證：${validation.metrics.trades} 筆，月均 ${validation.metrics.averageMonthlyReturnPct}%，年化 ${validation.metrics.annualizedReturnPct}%，PF ${validation.metrics.profitFactor}，最大回撤 ${validation.metrics.maxDrawdownPct}%。\n- 0050 年化：${benchmark.annualizedReturnPct}%；公平隨機年化：${randomValidation.metrics.annualizedReturnPct}%。\n- 結論：${report.conclusion}\n`, 'utf8');
console.log(`事件投組驗證：${validation.metrics.trades} 筆、月均 ${validation.metrics.averageMonthlyReturnPct}%、年化 ${validation.metrics.annualizedReturnPct}%、PF ${validation.metrics.profitFactor}、回撤 ${validation.metrics.maxDrawdownPct}%。`);
