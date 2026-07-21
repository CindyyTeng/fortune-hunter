import fs from 'node:fs/promises';
import { buyExecution, sellExecution } from '../lib/execution-simulator.mjs';

const INPUT = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-fixed-top5-hybrid-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_FIXED_TOP5_HYBRID_V1.md', import.meta.url);
const INITIAL_CAPITAL = 1_000_000;
const TARGET_MONTHLY = 5;
const COSTS = { buyFeePct: 0.1425, sellFeePct: 0.1425, sellTaxPct: 0.3, buySlippagePct: 0.15, sellSlippagePct: 0.15, minimumFee: 0 };

const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const monthKey = date => date.slice(0, 7);

function commonStock(row) {
  const symbol = String(row.symbol || '');
  return /^\d{4}$/.test(symbol) && !symbol.startsWith('00');
}

function monthRange(start, end) {
  const out = [];
  const cursor = new Date(`${start}-01T00:00:00Z`);
  const last = new Date(`${end}-01T00:00:00Z`);
  while (cursor <= last) {
    out.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

function folds(months) {
  const out = [];
  for (let start = 0; start + 60 + 18 <= months.length; start += 12) {
    out.push({
      trainStart: months[start],
      trainEnd: months[start + 59],
      validationStart: months[start + 60],
      validationEnd: months[start + 77]
    });
  }
  return out;
}

function netReturnPct(entry, exit) {
  const buy = buyExecution(entry, 1, COSTS).total;
  const sell = sellExecution(exit, 1, COSTS).net;
  return (sell / buy - 1) * 100;
}

function passes(row, config) {
  if (!commonStock(row)) return false;
  if ((row.signalScore || 0) < config.minScore) return false;
  if ((row.avg20TradeValue || 0) < config.minTradeValue) return false;
  if ((row.nearYearHigh || 0) < config.minNearYearHigh) return false;
  if ((row.atr14Pct || 0) > config.maxAtr) return false;
  if ((row.rsi14 || 0) > config.maxRsi) return false;
  if ((row.gapUpPct || 0) > config.maxGap) return false;
  if ((row.upperWickRatio || 0) > config.maxUpperWick) return false;
  if ((row.distanceToMa20Pct || 0) > config.maxDistanceMa20) return false;
  if ((row.return20Pct || 0) < config.minReturn20) return false;
  if (config.requireMa20Rising && !row.ma20Rising) return false;
  if (config.excludeWeakVolume && ['price_up_volume_down', 'flat_down_volume_up', 'flat_volume_down'].includes(row.priceVolumeState)) return false;
  return true;
}

function rank(row, mode) {
  const quality = (row.signalScore || 0) + (row.nearYearHigh || 0) * 24 + (row.ma20Slope5Pct || 0) * 3 - (row.upperWickRatio || 0) * 10;
  if (mode === 'quality') return quality;
  if (mode === 'risk_adjusted') return quality - (row.atr14Pct || 0) * 4 - Math.max(0, row.distanceToMa20Pct || 0) * 0.5;
  return (row.signalScore || 0) + (row.return20Pct || 0) * 0.8 + (row.nearYearHigh || 0) * 18;
}

function closeTrade(row, config) {
  const bars = (row.forwardPrices || []).filter(bar => bar.date > row.entryDate);
  if (bars.length < config.holdDays) return null;
  let high = row.entryPrice;
  let exit = bars[Math.min(config.holdDays - 1, bars.length - 1)];
  let reason = '固定持有';
  const hardStop = row.entryPrice * (1 - config.stopLossPct / 100);
  for (const bar of bars.slice(0, config.holdDays)) {
    high = Math.max(high, bar.high ?? bar.price);
    const trail = high >= row.entryPrice * (1 + config.trailStartPct / 100)
      ? Math.max(row.entryPrice * (1 + config.trailLockPct / 100), high * (1 - config.trailGivebackPct / 100))
      : 0;
    const stop = Math.max(hardStop, trail);
    if ((bar.low ?? bar.price) <= stop) {
      exit = { ...bar, price: Math.min(bar.open ?? stop, stop) };
      reason = trail ? '移動停利' : '防守停損';
      break;
    }
  }
  return { ...row, exitDate: exit.date, exitPrice: exit.price, reason, netReturnPct: netReturnPct(row.entryPrice, exit.price), rankScore: rank(row, config.rankMode) };
}

function candidates(rows, config, start, end) {
  const byDate = new Map();
  for (const row of rows) {
    const month = monthKey(row.entryDate);
    if (month < start || month > end || !passes(row, config)) continue;
    const trade = closeTrade(row, config);
    if (!trade) continue;
    const list = byDate.get(row.entryDate) || [];
    list.push(trade);
    byDate.set(row.entryDate, list);
  }
  return [...byDate.values()].flatMap(list => list.sort((a, b) => b.rankScore - a.rankScore).slice(0, config.maxEntriesPerDay));
}

function simulate(rows, config, start, end) {
  const events = new Map();
  const ensure = date => {
    if (!events.has(date)) events.set(date, { entries: [], exits: [] });
    return events.get(date);
  };
  for (const trade of candidates(rows, config, start, end)) {
    ensure(trade.entryDate).entries.push(trade);
    ensure(trade.exitDate).exits.push(trade);
  }
  let cash = INITIAL_CAPITAL;
  let equity = INITIAL_CAPITAL;
  let peak = INITIAL_CAPITAL;
  let monthStart = INITIAL_CAPITAL;
  let activeMonth = '';
  let monthBlocked = false;
  let cooldown = 0;
  let maxDrawdown = 0;
  let open = [];
  let unsettled = [];
  const closed = [];
  const monthly = new Map();
  const dates = [...events.keys()].sort();
  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    const month = monthKey(date);
    if (month !== activeMonth) {
      activeMonth = month;
      monthStart = equity;
      monthBlocked = false;
    }
    cash += unsettled.filter(item => item.release <= index).reduce((sum, item) => sum + item.amount, 0);
    unsettled = unsettled.filter(item => item.release > index);
    const today = events.get(date);
    for (const trade of today.exits) {
      const position = open.find(item => item.tradeId === trade.tradeId);
      if (!position) continue;
      const proceeds = position.cost * (1 + trade.netReturnPct / 100);
      unsettled.push({ release: index + 2, amount: proceeds });
      closed.push({ ...position, pnl: proceeds - position.cost, netReturnPct: trade.netReturnPct });
      if (trade.netReturnPct < 0) cooldown = Math.max(cooldown, config.lossCooldownDays);
      open = open.filter(item => item.tradeId !== trade.tradeId);
    }
    equity = cash + unsettled.reduce((sum, item) => sum + item.amount, 0) + open.reduce((sum, item) => sum + item.cost, 0);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, (equity / peak - 1) * 100);
    if ((equity / monthStart - 1) * 100 <= config.monthBrakePct) monthBlocked = true;
    if ((equity / peak - 1) * 100 <= config.drawdownBrakePct) cooldown = Math.max(cooldown, config.accountCooldownDays);
    if (!monthBlocked && cooldown <= 0) {
      for (const trade of today.entries.sort((a, b) => b.rankScore - a.rankScore)) {
        if (open.length >= config.maxOpen || open.some(item => item.symbol === trade.symbol)) continue;
        const budget = Math.min(cash, equity * config.positionPct / 100);
        if (budget < 20_000) continue;
        cash -= budget;
        open.push({ ...trade, cost: budget });
      }
    }
    if (cooldown > 0) cooldown -= 1;
    equity = cash + unsettled.reduce((sum, item) => sum + item.amount, 0) + open.reduce((sum, item) => sum + item.cost, 0);
    monthly.set(month, equity);
  }
  let prior = INITIAL_CAPITAL;
  const monthRows = monthRange(start, end).map(month => {
    const endEquity = monthly.get(month) ?? prior;
    const returnPct = (endEquity / prior - 1) * 100;
    prior = endEquity;
    return { month, returnPct: round(returnPct) };
  });
  const wins = closed.filter(row => row.pnl > 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.pnl, 0);
  const grossLoss = Math.abs(closed.filter(row => row.pnl <= 0).reduce((sum, row) => sum + row.pnl, 0));
  return {
    trades: closed.length,
    averageMonthlyReturnPct: round(avg(monthRows.map(row => row.returnPct))),
    annualizedReturnPct: round((monthRows.reduce((value, row) => value * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, monthRows.length)) - 1) * 100),
    maximumDrawdownPct: round(maxDrawdown),
    profitFactor: round(grossLoss ? grossProfit / grossLoss : grossProfit ? 99 : 0),
    winRatePct: round(closed.length ? wins.length / closed.length * 100 : 0),
    monthly: monthRows
  };
}

function configs() {
  const out = [];
  for (const rankMode of ['quality', 'risk_adjusted', 'momentum']) {
    for (const holdDays of [15, 20]) {
      for (const positionPct of [6, 8]) {
        for (const stopLossPct of [5, 7]) {
          out.push({
            id: `hybrid_${rankMode}_h${holdDays}_p${positionPct}_s${stopLossPct}`,
            rankMode,
            holdDays,
            positionPct,
            stopLossPct,
            trailStartPct: 12,
            trailLockPct: 2,
            trailGivebackPct: 8,
            maxOpen: positionPct === 8 ? 12 : 14,
            maxEntriesPerDay: 3,
            minScore: 65,
            minTradeValue: 30_000_000,
            minNearYearHigh: 0.45,
            maxAtr: 9,
            maxRsi: 88,
            maxGap: 6,
            maxUpperWick: 0.75,
            maxDistanceMa20: 22,
            minReturn20: -5,
            requireMa20Rising: false,
            excludeWeakVolume: false,
            monthBrakePct: -5,
            drawdownBrakePct: -12,
            accountCooldownDays: 8,
            lossCooldownDays: 1
          });
        }
      }
    }
  }
  return out;
}

function score(result) {
  if (result.trades < 80 || result.profitFactor < 1.1 || result.averageMonthlyReturnPct <= 0) return -Infinity;
  return result.averageMonthlyReturnPct * 4 + result.profitFactor * 1.5 + result.maximumDrawdownPct * 0.08 + Math.min(result.trades, 500) / 250;
}

function merge(foldRows) {
  const monthly = foldRows.flatMap(row => row.validation.monthly);
  const validations = foldRows.map(row => row.validation);
  const trades = validations.reduce((sum, row) => sum + row.trades, 0);
  return {
    months: monthly.length,
    averageMonthlyReturnPct: round(avg(monthly.map(row => row.returnPct))),
    annualizedReturnPct: round((monthly.reduce((value, row) => value * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, monthly.length)) - 1) * 100),
    maximumDrawdownPct: round(Math.min(...validations.map(row => row.maximumDrawdownPct), 0)),
    trades,
    profitFactor: round(validations.reduce((sum, row) => sum + row.profitFactor * row.trades, 0) / Math.max(1, trades)),
    winRatePct: round(validations.reduce((sum, row) => sum + row.winRatePct * row.trades, 0) / Math.max(1, trades))
  };
}

function benchmark0050(series, start, end) {
  const byMonth = new Map();
  for (const row of series) {
    const month = monthKey(row.date);
    if (month >= start && month <= end) byMonth.set(month, row.close);
  }
  const rows = [...byMonth].sort();
  let prior = rows[0]?.[1];
  const returns = [];
  for (const [, close] of rows.slice(1)) {
    returns.push((close / prior - 1) * 100);
    prior = close;
  }
  return { averageMonthlyReturnPct: round(avg(returns)), months: returns.length };
}

async function main() {
  const [payload, etf] = await Promise.all([
    fs.readFile(INPUT, 'utf8').then(JSON.parse),
    fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)
  ]);
  const rows = (payload.candidateTrades || []).filter(row => commonStock(row) && row.forwardPrices?.length >= 20);
  const allMonths = [...new Set(rows.map(row => monthKey(row.entryDate)))].sort();
  const allConfigs = configs();
  const foldRows = [];
  for (const fold of folds(allMonths)) {
    const selected = allConfigs
      .map(config => ({ config, train: simulate(rows, config, fold.trainStart, fold.trainEnd) }))
      .sort((a, b) => score(b.train) - score(a.train))[0];
    foldRows.push({ ...fold, selectedConfigId: selected.config.id, train: selected.train, validation: simulate(rows, selected.config, fold.validationStart, fold.validationEnd) });
  }
  const metrics = merge(foldRows);
  const validationStart = foldRows[0]?.validationStart;
  const validationEnd = foldRows.at(-1)?.validationEnd;
  const benchmark = benchmark0050(etf.series['0050.TW'] || [], validationStart, validationEnd);
  const passed = metrics.averageMonthlyReturnPct >= TARGET_MONTHLY && metrics.maximumDrawdownPct >= -20 && metrics.trades >= 300 && metrics.profitFactor > 1.15 && metrics.averageMonthlyReturnPct > benchmark.averageMonthlyReturnPct;
  const output = {
    generatedAt: new Date().toISOString(),
    strategyId: 'stock_fixed_top5_hybrid_v1',
    universe: { stocksOnly: true, etfExcluded: true, commonStockCandidates: rows.length },
    validation: { startMonth: validationStart, endMonth: validationEnd, folds: foldRows.length, trainMonths: 60, validationMonths: 18, stepMonths: 12, testedConfigurations: allConfigs.length },
    metrics,
    benchmark0050: benchmark,
    targetMonthlyReturnPct: TARGET_MONTHLY,
    targetGapPct: round(TARGET_MONTHLY - metrics.averageMonthlyReturnPct),
    passed,
    paperTradingReady: passed,
    liveTradingReady: false,
    folds: foldRows.map(row => ({ validationPeriod: `${row.validationStart}~${row.validationEnd}`, selectedConfigId: row.selectedConfigId, train: row.train, validation: row.validation })),
    conclusion: passed ? '達到初步門檻，但仍需紙上交易驗證。' : `未達月均 5%，目前月均 ${metrics.averageMonthlyReturnPct}%，距離 5% 還差 ${round(TARGET_MONTHLY - metrics.averageMonthlyReturnPct)} 個百分點。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 純個股 Top5 混合策略 v1\n\n- 驗證期：${validationStart}~${validationEnd}\n- 設定組數：${allConfigs.length}\n- 月均報酬：${metrics.averageMonthlyReturnPct}%\n- 年化報酬：${metrics.annualizedReturnPct}%\n- 最大回撤：${metrics.maximumDrawdownPct}%\n- 交易筆數：${metrics.trades}\n- Profit Factor：${metrics.profitFactor}\n- 勝率：${metrics.winRatePct}%\n- 0050 月均：${benchmark.averageMonthlyReturnPct}%\n- 是否達月均 5%：${passed}\n\n## 結論\n\n${output.conclusion}\n\n此策略只交易個股，不以 ETF/0050 為主要標的。核心是延伸歷史較佳的固定 Top5 思路，混合品質排名、風險調整排名、持有 15/20 日、5%/7% 停損、移動停利與月度/帳戶煞車。\n`, 'utf8');
  console.log(JSON.stringify({ output: OUTPUT.pathname, report: REPORT.pathname, metrics, benchmark0050: benchmark, passed }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
