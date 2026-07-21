import fs from 'node:fs/promises';
import { buyExecution, sellExecution } from '../lib/execution-simulator.mjs';
import { buildExperimentIdentity, loadRegistry, shouldSkipExperiment } from './strategy-experiment-registry.mjs';

const INPUT = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-fixed-top5-entry-refine-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_FIXED_TOP5_ENTRY_REFINE_V1.md', import.meta.url);
const INITIAL_CAPITAL = 1_000_000;
const STRATEGY_ID = 'stock_fixed_top5_entry_refine_v1';
const COSTS = { buyFeePct: 0.1425, sellFeePct: 0.1425, sellTaxPct: 0.3, buySlippagePct: 0.15, sellSlippagePct: 0.15, minimumFee: 20, boardLotShares: 1000 };
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const monthKey = date => date.slice(0, 7);

function commonStock(trade) {
  const symbol = String(trade.symbol || '');
  return /^\d{4}$/.test(symbol) && !symbol.startsWith('00');
}

function netReturn(entryPrice, exitPrice) {
  const buy = buyExecution(entryPrice, 1, { ...COSTS, minimumFee: 0 }).total;
  const sell = sellExecution(exitPrice, 1, { ...COSTS, minimumFee: 0 }).net;
  return (sell / buy - 1) * 100;
}

function monthRows(start, end) {
  const rows = [];
  const cursor = new Date(`${start}-01T00:00:00Z`);
  const last = new Date(`${end}-01T00:00:00Z`);
  while (cursor <= last) {
    rows.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return rows;
}

function folds(months, trainMonths = 60, validationMonths = 18, stepMonths = 12) {
  const rows = [];
  for (let start = 0; start + trainMonths + validationMonths <= months.length; start += stepMonths) {
    rows.push({
      trainStart: months[start],
      trainEnd: months[start + trainMonths - 1],
      validationStart: months[start + trainMonths],
      validationEnd: months[start + trainMonths + validationMonths - 1]
    });
  }
  return rows;
}

function passes(trade, config) {
  if (!commonStock(trade)) return false;
  if (!trade.exitDate || trade.exitDate <= trade.entryDate) return false;
  if ((trade.signalScore || 0) < config.minScore) return false;
  if ((trade.avg20TradeValue || 0) < config.minTradeValue) return false;
  if ((trade.atr14Pct || 0) > config.maxAtr) return false;
  if ((trade.rsi14 || 0) > config.maxRsi) return false;
  if ((trade.gapUpPct ?? 0) > config.maxGapUp) return false;
  if ((trade.distanceToMa20Pct ?? 0) > config.maxDistanceToMa20) return false;
  if ((trade.upperWickRatio || 0) > config.maxUpperWick) return false;
  if ((trade.return20Pct || 0) < config.minReturn20) return false;
  if (config.requireMa20Rising && !trade.ma20Rising) return false;
  if (config.excludeWeakVolume && ['price_up_volume_down', 'flat_down_volume_up', 'flat_volume_down'].includes(trade.priceVolumeState)) return false;
  return true;
}

function rank(trade, mode) {
  if (mode === 'score') return trade.signalScore || 0;
  if (mode === 'quality') return (trade.signalScore || 0) + (trade.nearYearHigh || 0) * 20 + (trade.ma20Slope5Pct || 0) * 3 - (trade.upperWickRatio || 0) * 10;
  return (trade.signalScore || 0) + (trade.return20Pct || 0) * 0.5 - (trade.atr14Pct || 0) * 4 - Math.max(0, trade.distanceToMa20Pct || 0);
}

function prepare(trades, config, startMonth, endMonth) {
  const byDate = new Map();
  for (const trade of trades) {
    const month = monthKey(trade.entryDate);
    if (month < startMonth || month > endMonth || !passes(trade, config)) continue;
    const rows = byDate.get(trade.entryDate) || [];
    rows.push({ ...trade, netReturnPct: netReturn(trade.entryPrice, trade.exitPrice), rankScore: rank(trade, config.rankMode) });
    byDate.set(trade.entryDate, rows);
  }
  const selected = [];
  for (const rows of byDate.values()) {
    rows.sort((left, right) => right.rankScore - left.rankScore);
    selected.push(...rows.slice(0, config.maxEntriesPerDay));
  }
  return selected;
}

function simulate(trades, config, startMonth, endMonth) {
  const selected = prepare(trades, config, startMonth, endMonth);
  const events = new Map();
  const event = date => {
    if (!events.has(date)) events.set(date, { entries: [], exits: [] });
    return events.get(date);
  };
  for (const trade of selected) {
    event(trade.entryDate).entries.push(trade);
    event(trade.exitDate).exits.push(trade);
  }
  let cash = INITIAL_CAPITAL;
  let equity = INITIAL_CAPITAL;
  let peak = INITIAL_CAPITAL;
  let maxDrawdownPct = 0;
  let currentMonth = '';
  let monthStartEquity = INITIAL_CAPITAL;
  let monthHalted = false;
  let cooldown = 0;
  let lossStreak = 0;
  let open = [];
  let unsettled = [];
  const closed = [];
  const monthly = new Map();
  for (const [index, date] of [...events.keys()].sort().entries()) {
    const month = monthKey(date);
    if (month !== currentMonth) {
      currentMonth = month;
      monthStartEquity = equity;
      monthHalted = false;
    }
    cash += unsettled.filter(item => item.releaseIndex <= index).reduce((sum, item) => sum + item.amount, 0);
    unsettled = unsettled.filter(item => item.releaseIndex > index);
    const today = events.get(date);
    for (const trade of today.exits) {
      const position = open.find(row => row.tradeId === trade.tradeId);
      if (!position) continue;
      const proceeds = position.cost * (1 + trade.netReturnPct / 100);
      unsettled.push({ releaseIndex: index + 2, amount: proceeds });
      closed.push({ ...position, pnl: proceeds - position.cost, netReturnPct: trade.netReturnPct });
      lossStreak = trade.netReturnPct < 0 ? lossStreak + 1 : 0;
      if (lossStreak >= config.lossStreakLimit) {
        cooldown = Math.max(cooldown, config.lossCooldownDays);
        lossStreak = 0;
      }
      open = open.filter(row => row.tradeId !== trade.tradeId);
    }
    equity = cash + unsettled.reduce((sum, item) => sum + item.amount, 0) + open.reduce((sum, row) => sum + row.cost, 0);
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.min(maxDrawdownPct, (equity / peak - 1) * 100);
    if ((equity / monthStartEquity - 1) * 100 <= config.monthBrakePct) monthHalted = true;
    if (!monthHalted && cooldown <= 0) {
      for (const trade of today.entries.sort((left, right) => right.rankScore - left.rankScore)) {
        if (open.length >= config.maxOpenPositions) break;
        if (open.some(row => row.symbol === trade.symbol)) continue;
        const budget = Math.min(cash, equity * config.positionPct / 100);
        if (budget < 20_000) continue;
        cash -= budget;
        open.push({ ...trade, cost: budget });
      }
    }
    if (cooldown > 0) cooldown -= 1;
    equity = cash + unsettled.reduce((sum, item) => sum + item.amount, 0) + open.reduce((sum, row) => sum + row.cost, 0);
    monthly.set(month, equity);
  }
  let prior = INITIAL_CAPITAL;
  const months = monthRows(startMonth, endMonth).map(month => {
    const endingEquity = monthly.get(month) ?? prior;
    const returnPct = (endingEquity / prior - 1) * 100;
    prior = endingEquity;
    return { month, returnPct: round(returnPct), endingEquity: round(endingEquity, 0) };
  });
  const wins = closed.filter(row => row.pnl > 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.pnl, 0);
  const grossLoss = Math.abs(closed.filter(row => row.pnl <= 0).reduce((sum, row) => sum + row.pnl, 0));
  return {
    startMonth,
    endMonth,
    trades: closed.length,
    averageMonthlyReturnPct: round(avg(months.map(row => row.returnPct))),
    annualizedReturnPct: round((months.reduce((value, row) => value * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, months.length)) - 1) * 100),
    maximumDrawdownPct: round(maxDrawdownPct),
    profitFactor: round(grossLoss ? grossProfit / grossLoss : grossProfit ? 99 : 0),
    winRatePct: round(closed.length ? wins.length / closed.length * 100 : 0),
    monthly: months
  };
}

function configs() {
  const rows = [];
  for (const positionPct of [6, 8]) {
    for (const maxOpenPositions of [10, 12]) {
      for (const maxEntriesPerDay of [3, 5]) {
        for (const monthBrakePct of [-4, -6]) {
          for (const rankMode of ['score', 'quality', 'riskAdjusted']) {
            rows.push({
              positionPct,
              maxOpenPositions,
              maxEntriesPerDay,
              monthBrakePct,
              rankMode,
              minScore: 65,
              minTradeValue: 30_000_000,
              maxAtr: 10,
              maxRsi: 88,
              maxGapUp: 6,
              maxDistanceToMa20: 25,
              maxUpperWick: 0.8,
              minReturn20: -6,
              requireMa20Rising: false,
              excludeWeakVolume: false,
              lossStreakLimit: 6,
              lossCooldownDays: 8
            });
          }
        }
      }
    }
  }
  return rows;
}

function aggregate(results) {
  const months = results.flatMap(row => row.monthly);
  const trades = results.reduce((sum, row) => sum + row.trades, 0);
  return {
    folds: results.length,
    trades,
    averageMonthlyReturnPct: round(avg(months.map(row => row.returnPct))),
    annualizedReturnPct: round((months.reduce((value, row) => value * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, months.length)) - 1) * 100),
    maximumDrawdownPct: round(Math.min(...results.map(row => row.maximumDrawdownPct))),
    profitFactor: round(results.reduce((sum, row) => sum + row.profitFactor * row.trades, 0) / Math.max(1, trades)),
    winRatePct: round(results.reduce((sum, row) => sum + row.winRatePct * row.trades, 0) / Math.max(1, trades))
  };
}

function benchmark(series, startMonth, endMonth) {
  const monthEnds = new Map();
  for (const row of series) {
    const month = monthKey(row.date);
    if (month >= startMonth && month <= endMonth) monthEnds.set(month, row.close);
  }
  const rows = [...monthEnds].sort();
  let prior = rows[0]?.[1] || null;
  const returns = [];
  for (const [, close] of rows.slice(1)) {
    returns.push((close / prior - 1) * 100);
    prior = close;
  }
  return { averageMonthlyReturnPct: round(avg(returns)) };
}

async function main() {
  const identityInput = {
    strategyId: 'stock_fixed_top5_entry_refine_v1',
    dataSources: ['OHLCV 候選池原始出場'],
    setupRules: ['純個股', '沿用 fixed-top5 原出場模型', '只精煉進場排序與風控'],
    triggerRules: ['訊號日後依候選池 entryDate 進場'],
    invalidationRules: ['月虧損熔斷', '連虧冷卻'],
    exitRules: ['沿用候選池既有 exitDate / exitPrice，不重算出場'],
    riskRules: { tPlusTwo: true, monthlyBrakePct: [-4, -6] },
    parameters: { trainMonths: 60, validationMonths: 18, configs: configs().length },
    costModel: '手續費、交易稅、滑價、T+2',
    executionModel: '純個股候選池原出場，不使用 ETF 作為交易標的'
  };
  const identity = buildExperimentIdentity(identityInput);
  const registryDecision = shouldSkipExperiment(await loadRegistry(), identity, { ...identityInput, coreRulesChanged: true });
  if (registryDecision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...registryDecision, ...identity }, null, 2));
    return;
  }
  const payload = JSON.parse(await fs.readFile(INPUT, 'utf8'));
  const trades = (payload.candidateTrades || []).filter(commonStock);
  const allMonths = [...new Set(trades.map(row => monthKey(row.entryDate)))].sort();
  const allFolds = folds(allMonths);
  const allConfigs = configs();
  const foldReports = [];
  for (const fold of allFolds) {
    let best = null;
    for (const config of allConfigs) {
      const train = simulate(trades, config, fold.trainStart, fold.trainEnd);
      if (train.trades < 1) continue;
      const objective = train.averageMonthlyReturnPct - Math.abs(train.maximumDrawdownPct) * 0.02 + Math.min(1, train.trades / 500);
      if (!best || objective > best.objective) best = { config, train, objective };
    }
    if (!best) {
      foldReports.push({ ...fold, status: '無合格訓練組合' });
      continue;
    }
    foldReports.push({ ...fold, status: '已驗證', selectedConfig: best.config, train: best.train, validation: simulate(trades, best.config, fold.validationStart, fold.validationEnd) });
  }
  const validations = foldReports.filter(row => row.status === '已驗證').map(row => row.validation);
  const metrics = aggregate(validations);
  const validationStart = foldReports.find(row => row.status === '已驗證')?.validationStart;
  const validationEnd = [...foldReports].reverse().find(row => row.status === '已驗證')?.validationEnd;
  const etf = JSON.parse(await fs.readFile(ETF_HISTORY, 'utf8'));
  const benchmark0050 = benchmark(etf.series['0050.TW'] || [], validationStart, validationEnd);
  const passed = metrics.averageMonthlyReturnPct >= 5 && metrics.trades >= 300 && metrics.maximumDrawdownPct >= -20 && metrics.profitFactor > 1.15 && metrics.averageMonthlyReturnPct > benchmark0050.averageMonthlyReturnPct;
  const output = {
    generatedAt: new Date().toISOString(),
    ...identity,
    strategyId: STRATEGY_ID,
    validationPeriod: `${validationStart} 至 ${validationEnd}`,
    testedConfigurations: allConfigs.length,
    folds: foldReports,
    metrics,
    benchmark0050,
    targetMonthlyReturnPct: 5,
    targetMet: passed,
    paperTradingReady: false,
    liveTradingReady: false,
    conclusion: passed ? '通過可信月均 5% 門檻，但仍需人工驗收。' : `未達可信月均 5% 門檻，目前月均 ${metrics.averageMonthlyReturnPct}% ，不可紙上交易或實盤。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 固定 Top5 純個股進場精煉 v1\n\n- 驗證期間：${output.validationPeriod}\n- 測試組合：${allConfigs.length}\n- 月均總資產報酬：${metrics.averageMonthlyReturnPct}%\n- 年化報酬：${metrics.annualizedReturnPct}%\n- 最大回撤：${metrics.maximumDrawdownPct}%\n- 交易數：${metrics.trades}\n- Profit Factor：${metrics.profitFactor}\n- 勝率：${metrics.winRatePct}%\n- 0050 同期月均：${benchmark0050.averageMonthlyReturnPct}%\n- 結論：${output.conclusion}\n\n本策略沿用 fixed-top5 原候選池出場，只測進場排序與風控，不使用 ETF 作為交易標的。\n`, 'utf8');
  console.log(JSON.stringify({ output: OUTPUT.pathname, report: REPORT.pathname, validationPeriod: output.validationPeriod, testedConfigurations: allConfigs.length, metrics, benchmark0050, targetMet: passed, conclusion: output.conclusion }, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
