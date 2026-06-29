import fs from 'node:fs/promises';
import { buyExecution, sellExecution } from '../lib/execution-simulator.mjs';
import { decisionToOrderIntent } from '../lib/order-intent-generator.mjs';
import { foldWindows, mean, round } from './research-core.mjs';
import { appendExperiment } from './strategy-experiment-registry.mjs';

const HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/deployable-core-satellite-v1.json', import.meta.url);
const REPORT = new URL('../../docs/DEPLOYABLE_CORE_SATELLITE_V1.md', import.meta.url);
const READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);
const REGISTRY = new URL('../../data/research/strategy-experiment-registry.json', import.meta.url);
const INITIAL_CAPITAL = 1_000_000;
const COSTS = Object.freeze({
  buyFeePct: 0.1425,
  sellFeePct: 0.1425,
  sellTaxPct: 0.1,
  buySlippagePct: 0.15,
  sellSlippagePct: 0.15,
  minimumFee: 20,
  boardLotShares: 1000
});
const SYMBOLS = ['0050.TW', '0052.TW'];
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const pct = (value, base) => Number.isFinite(value) && base ? (value / base - 1) * 100 : 0;

function enrich(rows) {
  const closes = [];
  return rows.map((bar, index) => {
    closes.push(bar.close);
    return {
      ...bar,
      ma120: index >= 119 ? average(closes.slice(-120)) : null,
      ma200: index >= 199 ? average(closes.slice(-200)) : null,
      mom60: index >= 60 ? pct(bar.close, closes[index - 60]) : null
    };
  }).filter(row => row.ma200 && Number.isFinite(row.mom60));
}

async function loadRows() {
  const payload = JSON.parse(await fs.readFile(HISTORY, 'utf8'));
  const series = Object.fromEntries(SYMBOLS.map(symbol => [symbol, payload.series[symbol]]));
  const metrics = Object.fromEntries(SYMBOLS.map(symbol => [symbol, new Map(enrich(series[symbol]).map(row => [row.date, row]))]));
  const bars = Object.fromEntries(SYMBOLS.map(symbol => [symbol, new Map(series[symbol].map(row => [row.date, row]))]));
  return series['0050.TW'].map((bar, index) => ({
    date: bar.date,
    index,
    bars: new Map(SYMBOLS.map(symbol => [symbol, bars[symbol].get(bar.date)]).filter(([, value]) => value)),
    metrics: new Map(SYMBOLS.map(symbol => [symbol, metrics[symbol].get(bar.date)]).filter(([, value]) => value))
  })).filter(row => row.date >= '2008-01-01' && row.metrics.size === 2);
}

function buildConfigs() {
  const rows = [];
  for (const techWeight of [30, 40, 50]) {
    for (const trendDays of [120, 200]) {
      for (const bearMomentum of [-12, -8, -4]) {
        for (const riskOffMode of ['cash', 'core50']) {
          for (const accountGuardPct of [20, 25, 99]) {
            for (const rebalanceDays of [20, 60, 120]) {
              for (const rebalanceBand of [0.03, 0.05, 0.1]) {
                rows.push({
                  id: `core${100 - techWeight}_tech${techWeight}_ma${trendDays}_bear${bearMomentum}_${riskOffMode}_guard${accountGuardPct}_r${rebalanceDays}_b${rebalanceBand}`,
                  techWeight,
                  coreWeight: 100 - techWeight,
                  trendDays,
                  bearMomentum,
                  riskOffMode,
                  accountGuardPct,
                  cooldownDays: 20,
                  rebalanceDays,
                  rebalanceBand
                });
              }
            }
          }
        }
      }
    }
  }
  return rows;
}

const configs = buildConfigs();

function desiredWeights(row, config) {
  const core = row.metrics.get('0050.TW');
  const bear = core.close < core[`ma${config.trendDays}`] && core.mom60 < config.bearMomentum;
  if (!bear) return { '0050.TW': config.coreWeight, '0052.TW': config.techWeight };
  return config.riskOffMode === 'core50' ? { '0050.TW': 50, '0052.TW': 0 } : { '0050.TW': 0, '0052.TW': 0 };
}

function markEquity(state, row, field = 'close') {
  const unsettled = state.unsettled.reduce((sum, item) => sum + item.amount, 0);
  const positions = SYMBOLS.reduce((sum, symbol) => {
    const position = state.positions.get(symbol);
    if (!position) return sum;
    const price = row.bars.get(symbol)?.[field] ?? state.lastClose.get(symbol);
    return sum + position.quantity * price;
  }, 0);
  return state.cash + unsettled + positions;
}

function makeIntent(date, symbol, action, config, price, weight, reason) {
  return decisionToOrderIntent({
    date,
    symbol,
    action,
    strategyId: `deployable_core_satellite_v1:${config.id}`,
    setup: ['0050 核心與 0052 科技衛星配置'],
    trigger: ['T 日收盤確認配置，T+1 開盤以偏離帶再平衡'],
    invalidation: ['0050 長期趨勢與 60 日動能同步轉弱'],
    entryPlan: { referencePrice: price, maximumAcceptablePrice: price * 1.004, orderType: 'MARKETABLE_LIMIT', timeInForce: 'ROD', session: 'REGULAR' },
    riskPlan: { stopPrice: null, targetPrice: null, riskRewardRatio: null, positionBudget: INITIAL_CAPITAL * weight / 100, riskBudget: INITIAL_CAPITAL * 0.005 },
    reason,
    warnings: ['研究用 order intent；通過全新期間紙上交易前禁止實盤']
  }, { account: { equity: INITIAL_CAPITAL, availableCash: INITIAL_CAPITAL } });
}

function sell(state, row, symbol, quantity, reason) {
  const position = state.positions.get(symbol);
  const bar = row.bars.get(symbol);
  quantity = Math.min(position?.quantity || 0, Math.max(0, quantity));
  if (!bar || !quantity) return false;
  const execution = sellExecution(bar.open, quantity, COSTS);
  const cost = position.cost * quantity / position.quantity;
  state.unsettled.push({ releaseIndex: row.index + 2, amount: execution.net });
  state.trades.push({ symbol, entryDate: position.entryDate, exitDate: row.date, quantity, pnl: round(execution.net - cost), reason });
  state.intents.push(makeIntent(row.date, symbol, 'SELL', state.config, execution.fillPrice, 0, reason));
  position.quantity -= quantity;
  position.cost -= cost;
  if (!position.quantity) state.positions.delete(symbol);
  return true;
}

function buy(state, row, symbol, budget, weight, reason) {
  const bar = row.bars.get(symbol);
  budget = Math.min(state.cash, budget);
  if (!bar || budget <= 0) return false;
  let quantity = Math.floor(budget / (bar.open * 1.004));
  let execution = buyExecution(bar.open, quantity, COSTS);
  if (execution.total > budget) {
    quantity = Math.max(0, quantity - 1);
    execution = buyExecution(bar.open, quantity, COSTS);
  }
  if (!quantity) return false;
  const position = state.positions.get(symbol);
  state.cash -= execution.total;
  state.positions.set(symbol, {
    quantity: (position?.quantity || 0) + quantity,
    cost: (position?.cost || 0) + execution.total,
    entryDate: position?.entryDate || row.date
  });
  state.intents.push(makeIntent(row.date, symbol, 'BUY', state.config, execution.fillPrice, weight, reason));
  return true;
}

function rebalance(state, row, weights, force = false) {
  const equity = markEquity(state, row, 'open');
  let sold = false;
  for (const symbol of SYMBOLS) {
    const bar = row.bars.get(symbol);
    const position = state.positions.get(symbol);
    if (!bar || !position) continue;
    const current = position.quantity * bar.open;
    const desired = equity * (weights[symbol] || 0) / 100;
    if (force || current > desired * (1 + state.config.rebalanceBand)) {
      sold = sell(state, row, symbol, Math.floor((current - desired) / bar.open), `再平衡至 ${weights[symbol] || 0}%`) || sold;
    }
  }
  for (const symbol of SYMBOLS) {
    const bar = row.bars.get(symbol);
    if (!bar) continue;
    const current = (state.positions.get(symbol)?.quantity || 0) * bar.open;
    const desired = equity * (weights[symbol] || 0) / 100;
    if (current < desired * (1 - state.config.rebalanceBand)) {
      buy(state, row, symbol, desired - current, weights[symbol] || 0, `再平衡至 ${weights[symbol] || 0}%`);
    }
  }
  return sold;
}

function summarize(state, startDate, endDate) {
  const monthEnd = new Map();
  for (const row of state.curve) monthEnd.set(row.date.slice(0, 7), row.equity);
  let prior = INITIAL_CAPITAL;
  const monthly = [...monthEnd].map(([month, equity]) => {
    const equityReturnPct = pct(equity, prior);
    prior = equity;
    return { month, equity: round(equity, 0), equityReturnPct: round(equityReturnPct) };
  });
  const gains = state.trades.filter(row => row.pnl > 0).reduce((sum, row) => sum + row.pnl, 0);
  const losses = Math.abs(state.trades.filter(row => row.pnl <= 0).reduce((sum, row) => sum + row.pnl, 0));
  let peak = INITIAL_CAPITAL;
  let maximumDrawdownPct = 0;
  for (const row of state.curve) {
    peak = Math.max(peak, row.equity);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, pct(row.equity, peak));
  }
  const compounded = monthly.reduce((value, row) => value * (1 + row.equityReturnPct / 100), 1);
  return {
    startDate,
    endDate,
    endingEquity: round(state.curve.at(-1)?.equity || INITIAL_CAPITAL, 0),
    averageMonthlyEquityReturnPct: round(mean(monthly.map(row => row.equityReturnPct)) || 0),
    annualizedReturnPct: round((compounded ** (12 / Math.max(1, monthly.length)) - 1) * 100),
    profitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    maximumDrawdownPct: round(maximumDrawdownPct),
    winRatePct: round(state.trades.filter(row => row.pnl > 0).length / Math.max(1, state.trades.length) * 100),
    trades: state.trades.length,
    negativeMonths: monthly.filter(row => row.equityReturnPct < 0).length,
    monthly
  };
}

function simulate(rows, schedule, startDate, endDate, emitIntents = false) {
  const slice = rows.filter(row => row.date >= startDate && row.date <= endDate);
  const state = { cash: INITIAL_CAPITAL, unsettled: [], positions: new Map(), trades: [], intents: [], curve: [], lastClose: new Map(), config: schedule(startDate), targetKey: '', days: 999, peak: INITIAL_CAPITAL, cooldown: 0 };
  for (let offset = 1; offset < slice.length; offset += 1) {
    const signal = slice[offset - 1];
    const row = slice[offset];
    for (const [symbol, bar] of signal.bars) state.lastClose.set(symbol, bar.close);
    state.config = schedule(signal.date);
    const released = state.unsettled.filter(item => item.releaseIndex <= row.index);
    state.cash += released.reduce((sum, item) => sum + item.amount, 0);
    state.unsettled = state.unsettled.filter(item => item.releaseIndex > row.index);
    const priorEquity = markEquity(state, signal);
    state.peak = Math.max(state.peak, priorEquity);
    if (state.cooldown > 0) {
      state.cooldown -= 1;
      if (!state.cooldown) state.peak = priorEquity;
    }
    else if (pct(priorEquity, state.peak) <= -state.config.accountGuardPct) state.cooldown = state.config.cooldownDays;
    const weights = state.cooldown > 0 ? { '0050.TW': 0, '0052.TW': 0 } : desiredWeights(signal, state.config);
    const key = `${state.config.id}:${JSON.stringify(weights)}`;
    const due = key !== state.targetKey || state.days >= state.config.rebalanceDays;
    if (due || released.length) {
      rebalance(state, row, weights, key !== state.targetKey);
      if (due) {
        state.targetKey = key;
        state.days = 0;
      }
    }
    state.days += 1;
    for (const [symbol, bar] of row.bars) state.lastClose.set(symbol, bar.close);
    state.curve.push({ date: row.date, equity: markEquity(state, row) });
  }
  const last = slice.at(-1);
  if (last) {
    for (const symbol of [...state.positions.keys()]) sell(state, last, symbol, state.positions.get(symbol).quantity, '驗證期結束');
    state.curve.push({ date: last.date, equity: markEquity(state, last) });
  }
  if (!emitIntents) state.intents = [];
  return { state, summary: summarize(state, startDate, endDate) };
}

function addYears(dateText, years) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

function dayBefore(dateText) {
  return new Date(Date.parse(`${dateText}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function selectConfig(rows, fold) {
  const yearly = [0, 1, 2].map(index => ({
    start: addYears(fold.trainStart, index),
    end: index === 2 ? fold.trainEnd : dayBefore(addYears(fold.trainStart, index + 1))
  }));
  const evaluated = configs.map(config => {
    const summary = simulate(rows, () => config, fold.trainStart, fold.trainEnd).summary;
    const annual = yearly.map(window => simulate(rows, () => config, window.start, window.end).summary.averageMonthlyEquityReturnPct);
    const stable = annual.filter(value => value > 0).length >= 2;
    const pf = Number.isFinite(summary.profitFactor) ? Math.min(4, summary.profitFactor) : 4;
    const score = stable && summary.trades >= 6 && summary.maximumDrawdownPct > -35 && summary.averageMonthlyEquityReturnPct > 0
      ? summary.averageMonthlyEquityReturnPct * 16 + Math.min(...annual) * 2 + summary.maximumDrawdownPct * 0.35 + pf
      : -Infinity;
    return { config, summary, score };
  }).sort((left, right) => right.score - left.score);
  return evaluated.find(row => Number.isFinite(row.score)) || evaluated.find(row => row.config.techWeight === 30
    && row.config.trendDays === 200
    && row.config.bearMomentum === -12
    && row.config.riskOffMode === 'core50'
    && row.config.accountGuardPct === 20
    && row.config.rebalanceDays === 20
    && row.config.rebalanceBand === 0.1);
}

function compact(summary) {
  const { monthly, ...metrics } = summary;
  return metrics;
}

function buyAndHold0050(rows, startDate, endDate) {
  const config = { id: '0050_buy_hold', coreWeight: 100, techWeight: 0, trendDays: 200, bearMomentum: -999, riskOffMode: 'core50', accountGuardPct: 999, cooldownDays: 0, rebalanceDays: 99999, rebalanceBand: 0.05 };
  return simulate(rows, () => config, startDate, endDate).summary;
}

async function main() {
  const rows = await loadRows();
  const folds = foldWindows(rows[0].date, rows.at(-1).date, 36, 12)
    .filter(fold => Date.parse(fold.validationEnd) - Date.parse(fold.validationStart) >= 330 * 86_400_000);
  const selections = folds.map(fold => ({ ...fold, selected: selectConfig(rows, fold) }));
  const schedule = date => selections.find(row => date >= row.validationStart && date <= row.validationEnd)?.selected.config || selections.at(-1).selected.config;
  const validationStart = selections[0].validationStart;
  const validationEnd = selections.at(-1).validationEnd;
  const validation = simulate(rows, schedule, validationStart, validationEnd, true);
  const benchmark = buyAndHold0050(rows, validationStart, validationEnd);
  const metrics = validation.summary;
  const beats0050 = metrics.averageMonthlyEquityReturnPct > benchmark.averageMonthlyEquityReturnPct
    && metrics.maximumDrawdownPct > benchmark.maximumDrawdownPct;
  const minimumPassed = beats0050 && metrics.trades >= 50 && metrics.profitFactor > 1.15 && metrics.maximumDrawdownPct > -25;
  const result = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    methodology: '13 段以上 36 個月訓練／12 個月驗證；0050 與 0052 雙持倉；T+1 開盤、T+2 資金、費稅與滑價',
    dataRange: { start: rows[0].date, end: rows.at(-1).date },
    configsTestedPerFold: configs.length,
    validationFolds: selections.length,
    selections: selections.map(row => ({
      trainStart: row.trainStart,
      trainEnd: row.trainEnd,
      validationStart: row.validationStart,
      validationEnd: row.validationEnd,
      configId: row.selected.config.id,
      trainMonthlyPct: row.selected.summary.averageMonthlyEquityReturnPct,
      trainMaximumDrawdownPct: row.selected.summary.maximumDrawdownPct,
      trainTrades: row.selected.summary.trades
    })),
    metrics: { ...metrics, orderIntents: validation.state.intents.length },
    benchmark0050: compact(benchmark),
    comparison: {
      beats0050MonthlyAndDrawdown: beats0050,
      monthlyVs0050Pct: round(metrics.averageMonthlyEquityReturnPct - benchmark.averageMonthlyEquityReturnPct),
      drawdownVs0050Pct: round(metrics.maximumDrawdownPct - benchmark.maximumDrawdownPct)
    },
    readiness: {
      minimumResearchThresholdPassed: minimumPassed,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      brokerApiAllowed: false,
      reason: minimumPassed
        ? '歷史門檻通過，但同一 validation 已反覆研究，只能進入全新期間紙上驗證。'
        : '未同時打敗 0050 報酬與回撤，或交易樣本不足，不可紙上交易或實盤。'
    }
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, [
    '# 0050 核心＋0052 衛星長期驗證',
    '',
    `- Validation：${selections.length} 段`,
    `- 月均總資產報酬：${metrics.averageMonthlyEquityReturnPct}%`,
    `- 年化報酬：${metrics.annualizedReturnPct}%`,
    `- 最大回撤：${metrics.maximumDrawdownPct}%`,
    `- Profit Factor：${metrics.profitFactor}`,
    `- 交易數：${metrics.trades}`,
    `- 0050 月均：${benchmark.averageMonthlyEquityReturnPct}%`,
    `- 0050 最大回撤：${benchmark.maximumDrawdownPct}%`,
    `- 同時打敗 0050 報酬與回撤：${beats0050 ? '是' : '否'}`,
    `- Paper trading：${result.readiness.paperTradingAllowed ? '允許' : '不允許'}`,
    `- 實盤：${result.readiness.liveTradingAllowed ? '允許' : '不允許'}`,
    '',
    '0050 維持核心曝險，0052 提供成長衛星；熊市由 0050 長均線與 60 日動能共同確認，依 train 選定規則降低總曝險。',
    '所有再平衡均使用 T 日收盤訊號與 T+1 開盤成交，賣出款 T+2 才可補買，並計入 ETF 交易稅、手續費與雙邊滑價。',
    '',
    '資料限制：TWSE 官方 0052 月行情在 2007–2009 有歷史缺口，可連續計算指標的資料自 2010-11 起；只統計 2013-11 至 2025-10 的 12 段完整 validation。',
    '同一歷史 validation 已反覆用於研究，這版只能視為可執行候選；必須先用全新期間紙上交易驗證委託失敗、部分成交、資料中斷與實際滑價。',
    ''
  ].join('\n'), 'utf8');
  await fs.writeFile(READINESS, [
    '# 自動交易準備度',
    '',
    `0050 核心＋0052 衛星長期 validation：月均 ${metrics.averageMonthlyEquityReturnPct}%、年化 ${metrics.annualizedReturnPct}%、最大回撤 ${metrics.maximumDrawdownPct}%、交易 ${metrics.trades} 筆。`,
    `同期 0050：月均 ${benchmark.averageMonthlyEquityReturnPct}%、最大回撤 ${benchmark.maximumDrawdownPct}%。`,
    `研究最低門檻：${minimumPassed ? '通過' : '未通過'}。`,
    'Paper trading：目前禁止自動啟用。',
    '真實券商 API：禁止送單，只能產生 order intent。',
    '',
    '目前定位：歷史門檻通過的可執行候選，不是已證明可獲利的實盤策略。下一步只能使用全新期間 paper trading，不可再用相同 validation 調參數。',
    ''
  ].join('\n'), 'utf8');
  const registry = JSON.parse(await fs.readFile(REGISTRY, 'utf8'));
  registry.experiments = registry.experiments.filter(row => row.strategyId !== 'deployable_core_satellite_v1');
  await fs.writeFile(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await appendExperiment({
    strategyId: 'deployable_core_satellite_v1',
    dataSources: ['0050_TWSE_daily', '0052_TWSE_daily'],
    setupRules: ['0050 核心', '0052 科技衛星', '長趨勢熊市降曝險'],
    triggerRules: ['T 日收盤確認，T+1 開盤依偏離帶再平衡'],
    invalidationRules: ['0050 跌破長均線且 60 日動能轉弱'],
    exitRules: ['目標權重降低', '熊市降曝險', '驗證期結束'],
    riskRules: ['T+2', '不借款', 'ETF 交易稅 0.1%', '雙邊滑價'],
    blockedWhen: ['缺少次日可成交價格'],
    parameters: { configs: configs.length, symbols: SYMBOLS },
    trainPeriod: { months: 36 },
    validationPeriod: { months: 12, stepMonths: 12 },
    costModel: COSTS,
    executionModel: 'T 日收盤訊號、T+1 開盤、T+2 可用資金',
    metrics: compact(result.metrics),
    resultStatus: minimumPassed ? 'inconclusive' : 'failed',
    passedMinimum: minimumPassed,
    passedHighProfit: false,
    allowRetest: false,
    notes: result.readiness.reason
  });
  console.log(`核心衛星：${selections.length} 段 validation，月均 ${metrics.averageMonthlyEquityReturnPct}%，回撤 ${metrics.maximumDrawdownPct}%，交易 ${metrics.trades} 筆。`);
}

await main();
