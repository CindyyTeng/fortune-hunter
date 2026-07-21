import fs from 'node:fs/promises';
import { buyExecution, sellExecution } from '../lib/execution-simulator.mjs';
import { buildExperimentIdentity, loadRegistry, shouldSkipExperiment } from './strategy-experiment-registry.mjs';

const INPUT = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-practical-frontier-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_PRACTICAL_FRONTIER_V1.md', import.meta.url);
const INITIAL_CAPITAL = 1_000_000;
const STRATEGY_ID = 'stock_practical_frontier_v1';
const COSTS = Object.freeze({
  buyFeePct: 0.1425,
  sellFeePct: 0.1425,
  sellTaxPct: 0.3,
  buySlippagePct: 0.15,
  sellSlippagePct: 0.15,
  minimumFee: 20,
  boardLotShares: 1000
});

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

function monthsBetween(start, end) {
  const rows = [];
  const cursor = new Date(`${start}-01T00:00:00Z`);
  const last = new Date(`${end}-01T00:00:00Z`);
  while (cursor <= last) {
    rows.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return rows;
}

function foldWindows(months, trainMonths = 60, validationMonths = 24, stepMonths = 12) {
  const folds = [];
  for (let start = 0; start + trainMonths + validationMonths <= months.length; start += stepMonths) {
    folds.push({
      trainStart: months[start],
      trainEnd: months[start + trainMonths - 1],
      validationStart: months[start + trainMonths],
      validationEnd: months[start + trainMonths + validationMonths - 1]
    });
  }
  return folds;
}

function passes(trade, config) {
  if (!commonStock(trade)) return false;
  if ((trade.signalScore || 0) < config.minScore) return false;
  if ((trade.avg20TradeValue || 0) < config.minTradeValue) return false;
  if ((trade.atr14Pct || 0) > config.maxAtr) return false;
  if ((trade.rsi14 || 0) > config.maxRsi) return false;
  if ((trade.gapUpPct ?? 0) > config.maxGapUp) return false;
  if ((trade.distanceToMa20Pct ?? 0) > config.maxDistanceToMa20) return false;
  if ((trade.upperWickRatio || 0) > config.maxUpperWick) return false;
  if ((trade.return20Pct || 0) < config.minReturn20) return false;
  if ((trade.nearYearHigh || 0) < config.minNearYearHigh) return false;
  if (config.requireTrend && !trade.directionalTrendUp) return false;
  if (config.requireMa20 && !trade.ma20Rising) return false;
  if (config.requireMarket && (trade.marketMovePct || 0) < config.minMarketMove) return false;
  if (config.requireTheme && (trade.themeMovePct || 0) < config.minThemeMove) return false;
  if (config.excludeWeakVolume && ['price_up_volume_down', 'flat_down_volume_up', 'flat_volume_down'].includes(trade.priceVolumeState)) return false;
  return true;
}

function score(trade, mode) {
  if (mode === 'riskReward') {
    return (trade.signalScore || 0)
      + (trade.return20Pct || 0) * 0.8
      + (trade.nearYearHigh || 0) * 20
      + (trade.themeMovePct || 0) * 2
      - (trade.atr14Pct || 0) * 5
      - Math.max(0, trade.distanceToMa20Pct || 0);
  }
  if (mode === 'trendQuality') {
    return (trade.signalScore || 0)
      + (trade.momentum126_21 || 0) * 0.12
      + (trade.ma20Slope5Pct || 0) * 5
      - (trade.upperWickRatio || 0) * 10;
  }
  return (trade.signalScore || 0) / Math.max(1, trade.atr14Pct || 1);
}

function prepare(trades, config, startMonth, endMonth) {
  const byDate = new Map();
  for (const trade of trades) {
    const month = monthKey(trade.entryDate);
    if (month < startMonth || month > endMonth) continue;
    if (!passes(trade, config)) continue;
    if (!trade.exitDate || !Number.isFinite(trade.entryPrice) || !Number.isFinite(trade.exitPrice)) continue;
    const rows = byDate.get(trade.entryDate) || [];
    rows.push({
      ...trade,
      netReturnPct: netReturn(trade.entryPrice, trade.exitPrice),
      rankScore: score(trade, config.rankMode)
    });
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
  let open = [];
  let unsettled = [];
  const closed = [];
  const monthly = new Map();
  const dates = [...events.keys()].sort();
  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
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
      open = open.filter(row => row.tradeId !== trade.tradeId);
    }
    equity = cash + unsettled.reduce((sum, item) => sum + item.amount, 0) + open.reduce((sum, position) => sum + position.cost, 0);
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.min(maxDrawdownPct, (equity / peak - 1) * 100);
    if ((equity / monthStartEquity - 1) * 100 <= config.monthBrakePct) monthHalted = true;
    if (!monthHalted && cooldown <= 0) {
      const entries = today.entries.sort((left, right) => right.rankScore - left.rankScore);
      for (const trade of entries) {
        if (open.length >= config.maxOpenPositions) break;
        if (open.some(position => position.symbol === trade.symbol)) continue;
        const budget = Math.min(cash, equity * config.positionPct / 100);
        if (budget < 20_000) continue;
        cash -= budget;
        open.push({ ...trade, cost: budget });
      }
    }
    if (cooldown > 0) cooldown -= 1;
    equity = cash + unsettled.reduce((sum, item) => sum + item.amount, 0) + open.reduce((sum, position) => sum + position.cost, 0);
    monthly.set(month, equity);
  }
  let prior = INITIAL_CAPITAL;
  const monthRows = monthsBetween(startMonth, endMonth).map(month => {
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
    averageMonthlyReturnPct: round(avg(monthRows.map(row => row.returnPct))),
    annualizedReturnPct: round((monthRows.reduce((value, row) => value * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, monthRows.length)) - 1) * 100),
    maximumDrawdownPct: round(maxDrawdownPct),
    profitFactor: round(grossLoss ? grossProfit / grossLoss : grossProfit ? 99 : 0),
    winRatePct: round(closed.length ? wins.length / closed.length * 100 : 0),
    uniqueSymbols: new Set(closed.map(row => row.symbol)).size,
    monthly: monthRows
  };
}

function configs() {
  const rows = [];
  for (const maxOpenPositions of [5, 8, 12]) {
    for (const maxEntriesPerDay of [1, 2]) {
      for (const positionPct of [8, 10]) {
        for (const minScore of [70, 75, 80]) {
          for (const rankMode of ['riskReward', 'trendQuality', 'scorePerAtr']) {
            rows.push({
              maxOpenPositions,
              maxEntriesPerDay,
              positionPct,
              minScore,
              rankMode,
              minTradeValue: 50_000_000,
              maxAtr: 8,
              maxRsi: 82,
              maxGapUp: 5,
              maxDistanceToMa20: 18,
              maxUpperWick: 0.55,
              minReturn20: 0,
              minNearYearHigh: 0.65,
              requireTrend: false,
              requireMa20: true,
              requireMarket: false,
              requireTheme: false,
              minMarketMove: -0.5,
              minThemeMove: -0.5,
              excludeWeakVolume: true,
              monthBrakePct: -6
            });
          }
        }
      }
    }
  }
  return rows;
}

function aggregate(results) {
  const monthly = results.flatMap(row => row.monthly);
  const trades = results.reduce((sum, row) => sum + row.trades, 0);
  return {
    folds: results.length,
    trades,
    averageMonthlyReturnPct: round(avg(monthly.map(row => row.returnPct))),
    annualizedReturnPct: round((monthly.reduce((value, row) => value * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, monthly.length)) - 1) * 100),
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
    strategyId: STRATEGY_ID,
    dataSources: ['OHLCV 候選池與既有真實成交模擬欄位'],
    setupRules: ['純個股', '高分候選', '流動性與風險報酬過濾'],
    triggerRules: ['訊號日後依候選池進場日期執行'],
    invalidationRules: ['月虧損熔斷', '單檔不重複持倉'],
    exitRules: ['沿用候選池已計算之實盤可執行出場價'],
    riskRules: { tPlusTwo: true, maxPositionPct: 10, monthlyBrakePct: -6 },
    parameters: { trainMonths: 60, validationMonths: 24, configs: configs().length },
    costModel: '手續費、交易稅、滑價、T+2',
    executionModel: '以候選池 entryDate/exitDate 模擬，不使用 ETF 作為交易標的'
  };
  const identity = buildExperimentIdentity(identityInput);
  const registryDecision = shouldSkipExperiment(await loadRegistry(), identity, { ...identityInput, coreRulesChanged: true });
  if (registryDecision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...registryDecision, ...identity }, null, 2));
    return;
  }
  const payload = JSON.parse(await fs.readFile(INPUT, 'utf8'));
  const trades = (payload.candidateTrades || []).filter(commonStock);
  const months = [...new Set(trades.map(row => monthKey(row.entryDate)))].sort();
  const folds = foldWindows(months, 60, 24, 12);
  const allConfigs = configs();
  const foldReports = [];
  for (const fold of folds) {
    let best = null;
    for (const config of allConfigs) {
      const train = simulate(trades, config, fold.trainStart, fold.trainEnd);
      if (train.trades < 1) continue;
      const objective = train.averageMonthlyReturnPct - Math.abs(train.maximumDrawdownPct) * 0.03 + Math.min(1, train.trades / 500);
      if (!best || objective > best.objective) best = { config, train, objective };
    }
    if (!best) {
      foldReports.push({ ...fold, status: '無合格訓練組合' });
      continue;
    }
    foldReports.push({
      ...fold,
      status: '已驗證',
      selectedConfig: best.config,
      train: best.train,
      validation: simulate(trades, best.config, fold.validationStart, fold.validationEnd)
    });
  }
  const validationRows = foldReports.filter(row => row.status === '已驗證').map(row => row.validation);
  const metrics = aggregate(validationRows);
  const validationStart = foldReports.find(row => row.status === '已驗證')?.validationStart;
  const validationEnd = [...foldReports].reverse().find(row => row.status === '已驗證')?.validationEnd;
  const etf = JSON.parse(await fs.readFile(ETF_HISTORY, 'utf8'));
  const benchmark0050 = benchmark(etf.series['0050.TW'] || [], validationStart, validationEnd);
  const passed = metrics.averageMonthlyReturnPct >= 5
    && metrics.trades >= 300
    && metrics.maximumDrawdownPct >= -20
    && metrics.profitFactor > 1.15
    && metrics.averageMonthlyReturnPct > benchmark0050.averageMonthlyReturnPct;
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
    conclusion: passed
      ? '通過可信月均 5% 門檻，但仍需人工驗收才可進紙上交易。'
      : `未達可信月均 5% 門檻，目前月均 ${metrics.averageMonthlyReturnPct}% ，不可紙上交易或實盤。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 純個股實盤前沿 v1\n\n- 驗證期間：${output.validationPeriod}\n- 測試組合：${allConfigs.length}\n- 月均總資產報酬：${metrics.averageMonthlyReturnPct}%\n- 年化報酬：${metrics.annualizedReturnPct}%\n- 最大回撤：${metrics.maximumDrawdownPct}%\n- 交易數：${metrics.trades}\n- Profit Factor：${metrics.profitFactor}\n- 勝率：${metrics.winRatePct}%\n- 0050 同期月均：${benchmark0050.averageMonthlyReturnPct}%\n- 結論：${output.conclusion}\n\n本策略只交易個股，不以 ETF 或 0050 作為交易標的；0050 僅作為比較基準。\n`, 'utf8');
  console.log(JSON.stringify({
    output: OUTPUT.pathname,
    report: REPORT.pathname,
    validationPeriod: output.validationPeriod,
    testedConfigurations: allConfigs.length,
    metrics,
    benchmark0050,
    targetMet: passed,
    conclusion: output.conclusion
  }, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
