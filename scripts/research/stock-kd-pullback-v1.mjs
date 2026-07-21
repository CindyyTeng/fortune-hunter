import fs from 'node:fs/promises';
import { appendExperiment, buildExperimentIdentity, loadRegistry, shouldSkipExperiment } from './strategy-experiment-registry.mjs';

const INPUT = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const MARKET = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-kd-pullback-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_KD_PULLBACK_V1.md', import.meta.url);
const INITIAL_CAPITAL = 1_000_000;
const TARGET_MONTHLY = 5;
const COST_PCT = 0.1425 + 0.1425 + 0.3 + 0.15 + 0.15;

const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const monthKey = date => date.slice(0, 7);
const addMonths = (month, add) => {
  const [year, rawMonth] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, rawMonth - 1 + add, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};

function isCommonStock(row) {
  const symbol = String(row.symbol || '');
  return /^\d{4}$/.test(symbol) && !symbol.startsWith('00');
}

function netReturn(entry, exit) {
  return (exit / entry - 1) * 100 - COST_PCT;
}

function pass(row, config) {
  if ((row.avg20TradeValue || 0) < config.minTradeValue) return false;
  if ((row.signalScore || 0) < config.minScore) return false;
  if ((row.stochastic14 || 999) > config.maxStochastic) return false;
  if ((row.rsi14 || 0) < config.minRsi || (row.rsi14 || 999) > config.maxRsi) return false;
  if ((row.donchian20Position || 0) > config.maxDonchian) return false;
  if ((row.nearYearHigh || 0) < config.minNearYearHigh) return false;
  if ((row.return20Pct || 0) < config.minReturn20) return false;
  if ((row.return5Pct || 0) > config.maxReturn5) return false;
  if ((row.distanceToMa20Pct || 0) > config.maxDistanceMa20) return false;
  if ((row.gapUpPct || 0) > config.maxGap) return false;
  if ((row.upperWickRatio || 0) > config.maxUpperWick) return false;
  if ((row.atr14Pct || 0) > config.maxAtr) return false;
  if ((row.marketMovePct || 0) < config.minMarketMove) return false;
  if (row.donchian20Breakout || row.bollingerUpperBreakout) return false;
  if (config.requireSupport && !row.supportBounce && !row.crossAboveMa20 && !row.falseBreakdownReclaim) return false;
  if (config.requireMa20Rising && !row.ma20Rising) return false;
  return true;
}

function rank(row, mode) {
  const pullback = Math.max(0, 80 - (row.stochastic14 || 80)) + Math.max(0, 65 - (row.rsi14 || 65)) * 0.5;
  const power = (row.signalScore || 0) + (row.nearYearHigh || 0) * 25 + (row.return20Pct || 0);
  const risk = (row.atr14Pct || 0) * 2 + Math.max(0, row.gapUpPct || 0) + Math.max(0, row.distanceToMa20Pct || 0);
  if (mode === 'pullback_quality') return pullback + power - risk;
  return pullback + power + (row.themeMovePct || 0) * 2 - risk;
}

function exit(row, config) {
  const bars = row.forwardPrices || [];
  if (bars.length < config.holdDays) return null;
  let high = row.entryPrice;
  let exitIndex = Math.min(config.holdDays - 1, bars.length - 1);
  let exitPrice = bars[exitIndex].price;
  for (let index = 0; index <= exitIndex; index += 1) {
    const bar = bars[index];
    high = Math.max(high, bar.high ?? bar.price);
    const fixedStop = row.entryPrice * (1 - config.stopLossPct / 100);
    const trail = high >= row.entryPrice * (1 + config.trailTriggerPct / 100)
      ? high * (1 - config.trailGivebackPct / 100)
      : 0;
    const stop = Math.max(fixedStop, trail);
    if ((bar.low ?? bar.price) <= stop) {
      exitIndex = index;
      exitPrice = Math.min(bar.open ?? stop, stop);
      break;
    }
    const target = row.entryPrice * (1 + config.takeProfitPct / 100);
    if ((bar.high ?? bar.price) >= target) {
      exitIndex = index;
      exitPrice = Math.max(bar.open ?? target, target);
      break;
    }
  }
  return {
    ...row,
    exitDate: bars[exitIndex].date,
    netReturnPct: netReturn(row.entryPrice, exitPrice),
    marks: bars.slice(0, exitIndex + 1).map(bar => ({ date: bar.date, price: bar.price }))
  };
}

function buildTrades(rows, config, start, end) {
  const byDate = new Map();
  for (const row of rows) {
    const month = monthKey(row.entryDate);
    if (month < start || month > end || !pass(row, config)) continue;
    const trade = exit(row, config);
    if (!trade) continue;
    const list = byDate.get(row.entryDate) || [];
    list.push(trade);
    byDate.set(row.entryDate, list);
  }
  return [...byDate.values()].flatMap(list => list.sort((a, b) => rank(b, config.rankMode) - rank(a, config.rankMode)).slice(0, config.maxEntriesPerDay));
}

function simulate(rows, config, start, end) {
  const trades = buildTrades(rows, config, start, end);
  const events = new Map();
  const ensure = date => {
    if (!events.has(date)) events.set(date, { entries: [], exits: [], marks: [] });
    return events.get(date);
  };
  for (const trade of trades) {
    ensure(trade.entryDate).entries.push(trade);
    ensure(trade.exitDate).exits.push(trade);
    for (const mark of trade.marks) ensure(mark.date).marks.push({ id: trade.tradeId, price: mark.price });
  }
  let cash = INITIAL_CAPITAL;
  let equity = INITIAL_CAPITAL;
  let peak = INITIAL_CAPITAL;
  let monthStart = INITIAL_CAPITAL;
  let currentMonth = '';
  let halted = false;
  let cooldown = 0;
  let open = [];
  let unsettled = [];
  let maxDrawdown = 0;
  const closed = [];
  const monthly = new Map();
  const dates = [...events.keys()].sort();
  const markValue = (position, today) => {
    position.lastPrice = today.marks.find(mark => mark.id === position.tradeId)?.price || position.lastPrice || position.entryPrice;
    return position.cost * (1 + netReturn(position.entryPrice, position.lastPrice) / 100);
  };
  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    const month = monthKey(date);
    const today = events.get(date);
    if (month !== currentMonth) {
      currentMonth = month;
      monthStart = equity;
      halted = false;
    }
    cash += unsettled.filter(row => row.release <= index).reduce((sum, row) => sum + row.amount, 0);
    unsettled = unsettled.filter(row => row.release > index);
    for (const trade of today.exits) {
      const position = open.find(row => row.tradeId === trade.tradeId);
      if (!position) continue;
      const proceeds = position.cost * (1 + trade.netReturnPct / 100);
      unsettled.push({ release: index + 2, amount: proceeds });
      closed.push({ ...position, pnl: proceeds - position.cost, netReturnPct: trade.netReturnPct });
      if (trade.netReturnPct < 0) cooldown = Math.max(cooldown, config.lossCooldownDays);
      open = open.filter(row => row.tradeId !== trade.tradeId);
    }
    equity = cash + unsettled.reduce((sum, row) => sum + row.amount, 0) + open.reduce((sum, row) => sum + markValue(row, today), 0);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, (equity / peak - 1) * 100);
    if ((equity / monthStart - 1) * 100 <= config.monthlyBrakePct) halted = true;
    if ((equity / peak - 1) * 100 <= config.drawdownBrakePct) cooldown = Math.max(cooldown, config.accountCooldownDays);
    if (!halted && cooldown <= 0) {
      for (const trade of today.entries.sort((a, b) => rank(b, config.rankMode) - rank(a, config.rankMode))) {
        if (open.length >= config.maxOpen || open.some(row => row.symbol === trade.symbol)) continue;
        const riskBudget = equity * config.accountRiskPct / 100;
        const budget = Math.min(cash, equity * config.positionPct / 100, riskBudget / (config.stopLossPct / 100));
        if (budget < 20_000) continue;
        cash -= budget;
        open.push({ ...trade, cost: budget, lastPrice: trade.entryPrice });
      }
    }
    if (cooldown > 0) cooldown -= 1;
    equity = cash + unsettled.reduce((sum, row) => sum + row.amount, 0) + open.reduce((sum, row) => sum + markValue(row, today), 0);
    monthly.set(month, equity);
  }
  let prior = INITIAL_CAPITAL;
  const monthRows = [...monthly].sort().map(([month, endEquity]) => {
    const returnPct = (endEquity / prior - 1) * 100;
    prior = endEquity;
    return { month, returnPct: round(returnPct) };
  });
  const wins = closed.filter(row => row.pnl > 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.pnl, 0);
  const grossLoss = Math.abs(closed.filter(row => row.pnl <= 0).reduce((sum, row) => sum + row.pnl, 0));
  return {
    averageMonthlyReturnPct: round(avg(monthRows.map(row => row.returnPct))),
    annualizedReturnPct: round((monthRows.reduce((v, row) => v * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, monthRows.length)) - 1) * 100),
    maximumDrawdownPct: round(maxDrawdown),
    trades: closed.length,
    winRatePct: round(wins.length / Math.max(1, closed.length) * 100),
    profitFactor: grossLoss ? round(grossProfit / grossLoss) : null,
    monthly: monthRows,
    closed
  };
}

function configs() {
  const rows = [];
  for (const maxStochastic of [45, 60, 70]) {
    for (const minNearYearHigh of [0.72, 0.82, 0.9]) {
      for (const maxReturn5 of [0, 3]) {
        for (const holdDays of [5, 8, 12]) {
          rows.push({
            id: `kd_pullback_k${maxStochastic}_nyh${minNearYearHigh}_r5${maxReturn5}_h${holdDays}`,
            minTradeValue: 40e6,
            minScore: 55,
            maxStochastic,
            minRsi: 35,
            maxRsi: 70,
            maxDonchian: 0.9,
            minNearYearHigh,
            minReturn20: -4,
            maxReturn5,
            maxDistanceMa20: 10,
            maxGap: 4,
            maxUpperWick: 0.6,
            maxAtr: 6,
            minMarketMove: -2,
            requireSupport: maxStochastic <= 60,
            requireMa20Rising: true,
            holdDays,
            stopLossPct: holdDays <= 5 ? 4.5 : 6,
            takeProfitPct: holdDays <= 5 ? 7 : 12,
            trailTriggerPct: holdDays <= 5 ? 5 : 8,
            trailGivebackPct: 4,
            rankMode: maxStochastic <= 60 ? 'pullback_quality' : 'pullback_theme',
            maxEntriesPerDay: 5,
            maxOpen: 10,
            positionPct: 10,
            accountRiskPct: 1,
            monthlyBrakePct: -5,
            drawdownBrakePct: -10,
            accountCooldownDays: 12,
            lossCooldownDays: 3
          });
        }
      }
    }
  }
  return rows;
}

function folds(months) {
  const out = [];
  for (let i = 0; i + 60 + 18 <= months.length; i += 18) {
    out.push({ trainStart: months[i], trainEnd: months[i + 59], validationStart: months[i + 60], validationEnd: months[i + 77] });
  }
  return out;
}

function score(row) {
  if (row.trades < 40 || row.averageMonthlyReturnPct <= 0 || row.profitFactor < 1.05) return -Infinity;
  return row.averageMonthlyReturnPct * 5 + row.profitFactor * 2 + row.maximumDrawdownPct * 0.1 + Math.min(row.trades, 250) / 150;
}

function merge(rows) {
  const monthly = rows.flatMap(row => row.validation.monthly);
  const closed = rows.flatMap(row => row.validation.closed);
  const wins = closed.filter(row => row.pnl > 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.pnl, 0);
  const grossLoss = Math.abs(closed.filter(row => row.pnl <= 0).reduce((sum, row) => sum + row.pnl, 0));
  return {
    months: monthly.length,
    averageMonthlyReturnPct: round(avg(monthly.map(row => row.returnPct))),
    annualizedReturnPct: round((monthly.reduce((v, row) => v * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, monthly.length)) - 1) * 100),
    maximumDrawdownPct: round(Math.min(...rows.map(row => row.validation.maximumDrawdownPct), 0)),
    trades: closed.length,
    winRatePct: round(wins.length / Math.max(1, closed.length) * 100),
    profitFactor: grossLoss ? round(grossProfit / grossLoss) : null,
    topFiveProfitContributionPct: round(closed.sort((a, b) => b.pnl - a.pnl).slice(0, 5).reduce((sum, row) => sum + row.pnl, 0) / Math.max(1, grossProfit) * 100)
  };
}

function benchmark0050(rows, foldRows) {
  const byMonth = new Map(rows.map(row => [monthKey(row.date), row.price || row.close]));
  const returns = [];
  for (const fold of foldRows) {
    for (let month = fold.validationStart; month <= fold.validationEnd; month = addMonths(month, 1)) {
      const previous = byMonth.get(addMonths(month, -1));
      const current = byMonth.get(month);
      if (previous && current) returns.push((current / previous - 1) * 100);
    }
  }
  return { averageMonthlyReturnPct: round(avg(returns)), months: returns.length };
}

async function main() {
  const identityInput = {
    strategyId: 'stock_kd_pullback_v1',
    dataSources: ['tw_backtest_candidate_features', 'stochastic_rsi_features', 'daily_ohlcv'],
    setupRules: ['純個股強勢回檔', 'KD 偏低', '不追突破', 'MA20 上彎'],
    triggerRules: ['回檔後仍在近高區或支撐轉強後進場'],
    invalidationRules: ['固定停損', '移動停利回吐', '帳戶回撤冷卻'],
    exitRules: ['短持有', '停利', '移動停利', '停損'],
    riskRules: { noEtf: true, trainMonths: 60, validationMonths: 18, stepMonths: 18 },
    blockedWhen: ['ETF', '0050_as_tradable', 'future_leakage']
  };
  const identity = buildExperimentIdentity(identityInput);
  const skip = shouldSkipExperiment(await loadRegistry(), identity, { ...identityInput, coreRulesChanged: true });
  if (skip.skip) {
    const output = { generatedAt: new Date().toISOString(), status: 'skipped', identity, skip };
    await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  const [payload, market] = await Promise.all([fs.readFile(INPUT, 'utf8').then(JSON.parse), fs.readFile(MARKET, 'utf8').then(JSON.parse)]);
  const rows = (payload.candidateTrades || []).filter(row => isCommonStock(row) && row.forwardPrices?.length >= 12);
  const months = [...new Set(rows.map(row => monthKey(row.entryDate)))].sort();
  const allConfigs = configs();
  const foldRows = [];
  for (const fold of folds(months)) {
    const ranked = allConfigs.map(config => ({ config, train: simulate(rows, config, fold.trainStart, fold.trainEnd) })).sort((a, b) => score(b.train) - score(a.train));
    const selected = ranked.find(row => Number.isFinite(score(row.train))) || ranked[0];
    foldRows.push({ ...fold, selectedConfigId: selected.config.id, train: selected.train, validation: simulate(rows, selected.config, fold.validationStart, fold.validationEnd) });
  }
  const metrics = merge(foldRows);
  const benchmark = benchmark0050(market.benchmark || [], foldRows);
  const passed = metrics.averageMonthlyReturnPct >= TARGET_MONTHLY && metrics.maximumDrawdownPct >= -20 && metrics.trades >= 300 && metrics.profitFactor > 1.15 && metrics.averageMonthlyReturnPct > benchmark.averageMonthlyReturnPct;
  const output = {
    generatedAt: new Date().toISOString(),
    strategyId: identityInput.strategyId,
    identity,
    universe: { commonStockTrades: rows.length, etfExcluded: true, benchmarkOnly0050: true },
    validation: { trainMonths: 60, validationMonths: 18, stepMonths: 18, folds: foldRows.length, startMonth: foldRows[0]?.validationStart || null, endMonth: foldRows.at(-1)?.validationEnd || null, configsTested: allConfigs.length },
    metrics,
    benchmark0050: benchmark,
    targetMonthlyReturnPct: TARGET_MONTHLY,
    targetGapPct: round(TARGET_MONTHLY - metrics.averageMonthlyReturnPct),
    checks: {
      target5Pct: metrics.averageMonthlyReturnPct >= TARGET_MONTHLY,
      drawdownUnder20Pct: metrics.maximumDrawdownPct >= -20,
      tradesAbove300: metrics.trades >= 300,
      profitFactor: metrics.profitFactor > 1.15,
      beats0050: metrics.averageMonthlyReturnPct > benchmark.averageMonthlyReturnPct,
      paperTradingReady: passed,
      liveTradingReady: false
    },
    folds: foldRows.map(row => ({ validationPeriod: `${row.validationStart}~${row.validationEnd}`, selectedConfigId: row.selectedConfigId, train: { averageMonthlyReturnPct: row.train.averageMonthlyReturnPct, maximumDrawdownPct: row.train.maximumDrawdownPct, trades: row.train.trades, profitFactor: row.train.profitFactor }, validation: { averageMonthlyReturnPct: row.validation.averageMonthlyReturnPct, maximumDrawdownPct: row.validation.maximumDrawdownPct, trades: row.validation.trades, profitFactor: row.validation.profitFactor } })),
    conclusion: passed ? '達到月均 5% 初步門檻，但仍需紙上交易驗證。' : `未達月均 5% 可實盤門檻；validation 月均 ${metrics.averageMonthlyReturnPct}%，距離 5% 還差 ${round(TARGET_MONTHLY - metrics.averageMonthlyReturnPct)} 個百分點。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 純個股 KD 回檔 v1\n\n- 驗證期：${output.validation.startMonth}~${output.validation.endMonth}\n- 月均報酬：${metrics.averageMonthlyReturnPct}%\n- 年化報酬：${metrics.annualizedReturnPct}%\n- 最大回撤：${metrics.maximumDrawdownPct}%\n- 交易筆數：${metrics.trades}\n- Profit Factor：${metrics.profitFactor}\n- 勝率：${metrics.winRatePct}%\n- 0050 月均：${benchmark.averageMonthlyReturnPct}%\n- 是否達月均 5%：${passed}\n- 結論：${output.conclusion}\n\n此策略只交易個股，不以 ETF/0050 為主；核心是強勢股不追突破，等 KD/RSI 回檔到較安全區後再進場。\n`, 'utf8');
  await appendExperiment({ ...identityInput, parameters: { configsTested: allConfigs.length }, trainPeriod: { months: 60 }, validationPeriod: { months: 18, stepMonths: 18 }, costModel: { roundTripPct: COST_PCT }, executionModel: { entry: 'candidate_next_entry', exit: 'stop/take/trailing', settlement: 'T+2 cash delay' }, metrics, resultStatus: passed ? 'passed' : 'failed', failureReason: passed ? null : output.conclusion, passedMinimum: passed, passedHighProfit: false, allowRetest: false, notes: '純個股 KD 回檔策略，不以 ETF 或 0050 為交易主體。' });
  console.log(JSON.stringify({ output: OUTPUT.pathname, report: REPORT.pathname, metrics, benchmark0050: benchmark, passed }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
