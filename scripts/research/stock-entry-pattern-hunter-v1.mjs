import fs from 'node:fs/promises';
import { buyExecution, sellExecution } from '../lib/execution-simulator.mjs';

const INPUT = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-entry-pattern-hunter-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_ENTRY_PATTERN_HUNTER_V1.md', import.meta.url);
const INITIAL_CAPITAL = 1_000_000;
const COSTS = { buyFeePct: 0.1425, sellFeePct: 0.1425, sellTaxPct: 0.3, buySlippagePct: 0.15, sellSlippagePct: 0.15, minimumFee: 20 };

const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const monthKey = date => date.slice(0, 7);
const commonStock = row => /^\d{4}$/.test(String(row.symbol || '')) && !String(row.symbol).startsWith('00');

function netReturn(entryPrice, exitPrice) {
  const buy = buyExecution(entryPrice, 1, { ...COSTS, minimumFee: 0 }).total;
  const sell = sellExecution(exitPrice, 1, { ...COSTS, minimumFee: 0 }).net;
  return (sell / buy - 1) * 100;
}

function months(start, end) {
  const rows = [];
  const cursor = new Date(`${start}-01T00:00:00Z`);
  const last = new Date(`${end}-01T00:00:00Z`);
  while (cursor <= last) {
    rows.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return rows;
}

function folds(allMonths, trainMonths = 72, validationMonths = 24, stepMonths = 12) {
  const rows = [];
  for (let i = 0; i + trainMonths + validationMonths <= allMonths.length; i += stepMonths) {
    rows.push({
      trainStart: allMonths[i],
      trainEnd: allMonths[i + trainMonths - 1],
      validationStart: allMonths[i + trainMonths],
      validationEnd: allMonths[i + trainMonths + validationMonths - 1]
    });
  }
  return rows;
}

const patterns = [
  { id: 'support_bounce', test: row => row.supportBounce },
  { id: 'false_breakdown_reclaim', test: row => row.falseBreakdownReclaim },
  { id: 'donchian_breakout', test: row => row.donchian20Breakout },
  { id: 'bollinger_breakout', test: row => row.bollingerUpperBreakout },
  { id: 'compressed_trend', test: row => (row.volatilityCompression5To20 || 9) < 0.75 && row.ma20Rising && row.directionalTrendUp },
  { id: 'strong_pullback', test: row => row.ma20Rising && row.directionalTrendUp && (row.distanceToMa20Pct || 99) <= 8 && (row.return20Pct || 0) > 3 }
];

function configs() {
  const rows = [];
  for (const pattern of patterns) {
    for (const topN of [3, 5, 8]) {
      for (const positionPct of [5, 6, 8]) {
        rows.push({
          id: `${pattern.id}_top${topN}_p${positionPct}`,
          pattern,
          topN,
          positionPct,
          maxOpen: 10,
          minScore: 65,
          minTradeValue: 30_000_000,
          maxAtr: 10,
          maxRsi: 88,
          maxGapUp: 7,
          maxDistanceToMa20: 22,
          maxUpperWick: 0.7,
          minNearYearHigh: 0.35,
          monthBrakePct: -6
        });
      }
    }
  }
  return rows;
}

function pass(row, config) {
  if (!commonStock(row) || !config.pattern.test(row)) return false;
  if (!row.exitDate || !Number.isFinite(row.entryPrice) || !Number.isFinite(row.exitPrice)) return false;
  if ((row.signalScore || 0) < config.minScore) return false;
  if ((row.avg20TradeValue || 0) < config.minTradeValue) return false;
  if ((row.atr14Pct || 0) > config.maxAtr) return false;
  if ((row.rsi14 || 0) > config.maxRsi) return false;
  if ((row.gapUpPct ?? 0) > config.maxGapUp) return false;
  if ((row.distanceToMa20Pct ?? 0) > config.maxDistanceToMa20) return false;
  if ((row.upperWickRatio || 0) > config.maxUpperWick) return false;
  if ((row.nearYearHigh || 0) < config.minNearYearHigh) return false;
  if ((row.marketMovePct ?? 0) < -2) return false;
  return true;
}

function rank(row) {
  return (row.signalScore || 0)
    + (row.return20Pct || 0) * 0.4
    + (row.themeMovePct || 0) * 1.2
    + (row.nearYearHigh || 0) * 18
    - (row.atr14Pct || 0) * 3
    - Math.max(0, row.distanceToMa20Pct || 0) * 0.6
    - (row.upperWickRatio || 0) * 8;
}

function prepare(trades, config, startMonth, endMonth) {
  const byDate = new Map();
  for (const row of trades) {
    const month = monthKey(row.entryDate);
    if (month < startMonth || month > endMonth || !pass(row, config)) continue;
    const list = byDate.get(row.entryDate) || [];
    list.push({ ...row, rankScore: rank(row), netReturnPct: netReturn(row.entryPrice, row.exitPrice) });
    byDate.set(row.entryDate, list);
  }
  const selected = [];
  for (const list of byDate.values()) {
    list.sort((a, b) => b.rankScore - a.rankScore);
    selected.push(...list.slice(0, config.topN));
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
  let monthStart = INITIAL_CAPITAL;
  let currentMonth = '';
  let monthStopped = false;
  let open = [];
  let unsettled = [];
  const closed = [];
  const equityByMonth = new Map();
  for (const [index, date] of [...events.keys()].sort().entries()) {
    const month = monthKey(date);
    if (month !== currentMonth) {
      currentMonth = month;
      monthStart = equity;
      monthStopped = false;
    }
    cash += unsettled.filter(row => row.releaseIndex <= index).reduce((sum, row) => sum + row.amount, 0);
    unsettled = unsettled.filter(row => row.releaseIndex > index);
    const today = events.get(date);
    for (const trade of today.exits) {
      const position = open.find(row => row.tradeId === trade.tradeId);
      if (!position) continue;
      const proceeds = position.cost * (1 + trade.netReturnPct / 100);
      unsettled.push({ releaseIndex: index + 2, amount: proceeds });
      closed.push({ ...position, pnl: proceeds - position.cost, netReturnPct: trade.netReturnPct });
      open = open.filter(row => row.tradeId !== trade.tradeId);
    }
    equity = cash + unsettled.reduce((sum, row) => sum + row.amount, 0) + open.reduce((sum, row) => sum + row.cost, 0);
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.min(maxDrawdownPct, (equity / peak - 1) * 100);
    if ((equity / monthStart - 1) * 100 <= config.monthBrakePct) monthStopped = true;
    if (!monthStopped) {
      for (const trade of today.entries.sort((a, b) => b.rankScore - a.rankScore)) {
        if (open.length >= config.maxOpen || open.some(row => row.symbol === trade.symbol)) continue;
        const budget = Math.min(cash, equity * config.positionPct / 100);
        if (budget < 20_000) continue;
        cash -= budget;
        open.push({ ...trade, cost: budget });
      }
    }
    equity = cash + unsettled.reduce((sum, row) => sum + row.amount, 0) + open.reduce((sum, row) => sum + row.cost, 0);
    equityByMonth.set(month, equity);
  }
  let prior = INITIAL_CAPITAL;
  const monthly = months(startMonth, endMonth).map(month => {
    const endingEquity = equityByMonth.get(month) ?? prior;
    const returnPct = (endingEquity / prior - 1) * 100;
    prior = endingEquity;
    return { month, returnPct: round(returnPct), endingEquity: round(endingEquity, 0) };
  });
  const wins = closed.filter(row => row.pnl > 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.pnl, 0);
  const grossLoss = Math.abs(closed.filter(row => row.pnl <= 0).reduce((sum, row) => sum + row.pnl, 0));
  return {
    trades: closed.length,
    averageMonthlyReturnPct: round(avg(monthly.map(row => row.returnPct))),
    annualizedReturnPct: round((monthly.reduce((v, row) => v * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, monthly.length)) - 1) * 100),
    maximumDrawdownPct: round(maxDrawdownPct),
    profitFactor: round(grossLoss ? grossProfit / grossLoss : grossProfit ? 99 : 0),
    winRatePct: round(closed.length ? wins.length / closed.length * 100 : 0),
    monthly
  };
}

function aggregate(rows) {
  const monthly = rows.flatMap(row => row.monthly);
  const trades = rows.reduce((sum, row) => sum + row.trades, 0);
  return {
    folds: rows.length,
    trades,
    averageMonthlyReturnPct: round(avg(monthly.map(row => row.returnPct))),
    annualizedReturnPct: round((monthly.reduce((v, row) => v * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, monthly.length)) - 1) * 100),
    maximumDrawdownPct: round(Math.min(...rows.map(row => row.maximumDrawdownPct))),
    profitFactor: round(rows.reduce((sum, row) => sum + row.profitFactor * row.trades, 0) / Math.max(1, trades)),
    winRatePct: round(rows.reduce((sum, row) => sum + row.winRatePct * row.trades, 0) / Math.max(1, trades))
  };
}

function benchmark(series, startMonth, endMonth) {
  const ends = new Map();
  for (const row of series) {
    const month = monthKey(row.date);
    if (month >= startMonth && month <= endMonth) ends.set(month, row.close);
  }
  const rows = [...ends].sort();
  let prior = rows[0]?.[1] || null;
  const returns = [];
  for (const [, close] of rows.slice(1)) {
    returns.push((close / prior - 1) * 100);
    prior = close;
  }
  return { averageMonthlyReturnPct: round(avg(returns)) };
}

async function main() {
  const payload = JSON.parse(await fs.readFile(INPUT, 'utf8'));
  const trades = (payload.candidateTrades || []).filter(commonStock);
  const allMonths = [...new Set(trades.map(row => monthKey(row.entryDate)))].sort();
  const allFolds = folds(allMonths);
  const allConfigs = configs();
  const foldRows = [];
  for (const fold of allFolds) {
    let best = null;
    for (const config of allConfigs) {
      const train = simulate(trades, config, fold.trainStart, fold.trainEnd);
      if (train.trades < 20) continue;
      const score = train.averageMonthlyReturnPct * 2 + train.profitFactor + train.maximumDrawdownPct * 0.03 + Math.min(1, train.trades / 300);
      if (!best || score > best.score) best = { config, train, score };
    }
    if (!best) {
      foldRows.push({ ...fold, status: 'no_candidate' });
      continue;
    }
    foldRows.push({ ...fold, status: 'validated', selectedConfig: { ...best.config, pattern: best.config.pattern.id }, train: best.train, validation: simulate(trades, best.config, fold.validationStart, fold.validationEnd) });
  }
  const validations = foldRows.filter(row => row.status === 'validated').map(row => row.validation);
  const metrics = aggregate(validations);
  const validationStart = foldRows.find(row => row.status === 'validated')?.validationStart;
  const validationEnd = [...foldRows].reverse().find(row => row.status === 'validated')?.validationEnd;
  const etf = JSON.parse(await fs.readFile(ETF_HISTORY, 'utf8'));
  const benchmark0050 = benchmark(etf.series['0050.TW'] || [], validationStart, validationEnd);
  const checks = {
    target5Pct: metrics.averageMonthlyReturnPct >= 5,
    enoughTrades: metrics.trades >= 300,
    drawdownOk: metrics.maximumDrawdownPct >= -20,
    profitFactorOk: metrics.profitFactor > 1.15,
    beats0050: metrics.averageMonthlyReturnPct > benchmark0050.averageMonthlyReturnPct
  };
  const output = {
    generatedAt: new Date().toISOString(),
    strategyId: 'stock_entry_pattern_hunter_v1',
    universe: 'common_stock_only_etf_as_benchmark',
    validationPeriod: `${validationStart}~${validationEnd}`,
    testedConfigurations: allConfigs.length,
    folds: foldRows,
    metrics,
    benchmark0050,
    checks,
    paperTradingReady: false,
    liveTradingReady: false,
    conclusion: checks.target5Pct && checks.enoughTrades && checks.drawdownOk && checks.profitFactorOk && checks.beats0050
      ? 'Reached 5pct observation threshold, paper trading still required.'
      : `Not reached 5pct monthly target. Current ${metrics.averageMonthlyReturnPct}%, gap ${round(5 - metrics.averageMonthlyReturnPct)} pct points.`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 純個股進場型態 Hunter v1\n\n- 驗證期間：${output.validationPeriod}\n- 測試型態：支撐反彈、假跌破收復、Donchian 突破、布林突破、波動收斂趨勢、強勢拉回\n- 測試組合：${allConfigs.length}\n- 月均報酬：${metrics.averageMonthlyReturnPct}%\n- 年化報酬：${metrics.annualizedReturnPct}%\n- 最大回撤：${metrics.maximumDrawdownPct}%\n- 交易筆數：${metrics.trades}\n- Profit Factor：${metrics.profitFactor}\n- 勝率：${metrics.winRatePct}%\n- 0050 同期月均：${benchmark0050.averageMonthlyReturnPct}%\n- 是否可紙上交易：否\n- 是否可實盤：否\n\n## 結論\n\n${output.conclusion}\n\n本策略不使用 ETF/0050 作為交易標的。若未達標，不得接券商 API 實盤。\n`, 'utf8');
  console.log(JSON.stringify({ validationPeriod: output.validationPeriod, testedConfigurations: allConfigs.length, metrics, benchmark0050, checks, conclusion: output.conclusion }, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

