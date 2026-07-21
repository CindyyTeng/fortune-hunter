import fs from 'node:fs/promises';
import { buyExecution, sellExecution } from '../lib/execution-simulator.mjs';
import { buildExperimentIdentity, loadRegistry, shouldSkipExperiment } from './strategy-experiment-registry.mjs';

const INPUT = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-practical-alpha-hunter-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_PRACTICAL_ALPHA_HUNTER_V1.md', import.meta.url);
const STRATEGY_ID = 'stock_practical_alpha_hunter_v1';
const INITIAL_CAPITAL = 1_000_000;
const COSTS = Object.freeze({ buyFeePct: 0.1425, sellFeePct: 0.1425, sellTaxPct: 0.3, buySlippagePct: 0.15, sellSlippagePct: 0.15, minimumFee: 20 });

const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const monthKey = date => date.slice(0, 7);
const commonStock = trade => /^\d{4}$/.test(String(trade.symbol || '')) && !String(trade.symbol).startsWith('00');

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
  for (let start = 0; start + trainMonths + validationMonths <= allMonths.length; start += stepMonths) {
    rows.push({
      trainStart: allMonths[start],
      trainEnd: allMonths[start + trainMonths - 1],
      validationStart: allMonths[start + trainMonths],
      validationEnd: allMonths[start + trainMonths + validationMonths - 1]
    });
  }
  return rows;
}

function netReturn(entryPrice, exitPrice) {
  const buy = buyExecution(entryPrice, 1, { ...COSTS, minimumFee: 0 }).total;
  const sell = sellExecution(exitPrice, 1, { ...COSTS, minimumFee: 0 }).net;
  return (sell / buy - 1) * 100;
}

function exitTrade(trade, config) {
  const bars = (trade.forwardPrices || []).filter(row => row.date > trade.entryDate);
  if (!bars.length) return null;
  let highWater = trade.entryPrice;
  const hardStop = trade.entryPrice * (1 - config.stopLossPct / 100);
  const maxIndex = Math.min(config.holdDays - 1, bars.length - 1);
  for (let index = 0; index <= maxIndex; index += 1) {
    const bar = bars[index];
    highWater = Math.max(highWater, bar.high ?? bar.price);
    const trail = highWater >= trade.entryPrice * (1 + config.trailStartPct / 100)
      ? highWater * (1 - config.trailGivebackPct / 100)
      : 0;
    const stop = Math.max(hardStop, trail);
    if ((bar.low ?? bar.price) <= stop) {
      return { date: bar.date, price: Math.min(bar.open ?? stop, stop), reason: 'risk_exit' };
    }
    if ((bar.high ?? bar.price) >= trade.entryPrice * (1 + config.takeProfitPct / 100)) {
      const target = trade.entryPrice * (1 + config.takeProfitPct / 100);
      return { date: bar.date, price: Math.max(bar.open ?? target, target), reason: 'take_profit' };
    }
  }
  const finalBar = bars[maxIndex];
  return { date: finalBar.date, price: finalBar.price, reason: 'time_exit' };
}

function passes(trade, config) {
  if (!commonStock(trade)) return false;
  if ((trade.signalScore || 0) < config.minScore) return false;
  if ((trade.avg20TradeValue || 0) < config.minTradeValue) return false;
  if ((trade.atr14Pct || 0) > config.maxAtr) return false;
  if ((trade.rsi14 || 0) > config.maxRsi) return false;
  if ((trade.gapUpPct ?? 0) > config.maxGapUp) return false;
  if ((trade.distanceToMa20Pct ?? 0) > config.maxDistanceToMa20) return false;
  if ((trade.return20Pct || 0) < config.minReturn20) return false;
  if ((trade.nearYearHigh || 0) < config.minNearYearHigh) return false;
  if (config.requireTrend && (!trade.ma20Rising || !trade.directionalTrendUp)) return false;
  if (config.requireConstructiveVolume && ['price_up_volume_down', 'flat_down_volume_up', 'flat_volume_down'].includes(trade.priceVolumeState)) return false;
  if (config.requireMarketSupport && (trade.marketMovePct ?? 0) < -1.2) return false;
  if (config.requireGlobalSupport && (trade.globalCompositePct ?? 0) < -1.2) return false;
  return true;
}

function rank(trade, config) {
  const momentum = (trade.return20Pct || 0) * config.return20Weight + (trade.momentum126_21 || 0) * config.momentumWeight;
  const quality = (trade.signalScore || 0) + (trade.nearYearHigh || 0) * 25 + (trade.ma20Slope5Pct || 0) * 4;
  const riskPenalty = (trade.atr14Pct || 0) * config.atrPenalty + Math.max(0, trade.distanceToMa20Pct || 0) * config.distancePenalty + (trade.upperWickRatio || 0) * 10;
  const support = (trade.marketMovePct || 0) * 1.5 + (trade.themeMovePct || 0) + (trade.globalCompositePct || 0);
  return quality + momentum + support - riskPenalty;
}

function selectTrades(trades, config, startMonth, endMonth) {
  const byDate = new Map();
  for (const trade of trades) {
    const month = monthKey(trade.entryDate);
    if (month < startMonth || month > endMonth || !passes(trade, config)) continue;
    const exit = exitTrade(trade, config);
    if (!exit) continue;
    const row = { ...trade, exitDate: exit.date, exitPrice: exit.price, exitReason: exit.reason, netReturnPct: netReturn(trade.entryPrice, exit.price), rankScore: rank(trade, config) };
    const rows = byDate.get(trade.entryDate) || [];
    rows.push(row);
    byDate.set(trade.entryDate, rows);
  }
  const selected = [];
  for (const rows of byDate.values()) {
    rows.sort((left, right) => right.rankScore - left.rankScore);
    selected.push(...rows.slice(0, config.entriesPerDay));
  }
  return selected;
}

function simulate(trades, config, startMonth, endMonth) {
  const selected = selectTrades(trades, config, startMonth, endMonth);
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
  let monthStopped = false;
  let cooldown = 0;
  let lossStreak = 0;
  let open = [];
  let unsettled = [];
  const closed = [];
  const equityByMonth = new Map();
  for (const [index, date] of [...events.keys()].sort().entries()) {
    const month = monthKey(date);
    if (month !== currentMonth) {
      currentMonth = month;
      monthStartEquity = equity;
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
      lossStreak = trade.netReturnPct < 0 ? lossStreak + 1 : 0;
      if (lossStreak >= config.lossStreakLimit) {
        cooldown = Math.max(cooldown, config.cooldownDays);
        lossStreak = 0;
      }
      open = open.filter(row => row.tradeId !== trade.tradeId);
    }
    equity = cash + unsettled.reduce((sum, row) => sum + row.amount, 0) + open.reduce((sum, row) => sum + row.cost, 0);
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.min(maxDrawdownPct, (equity / peak - 1) * 100);
    if ((equity / monthStartEquity - 1) * 100 <= config.monthStopPct) monthStopped = true;
    if (!monthStopped && cooldown <= 0) {
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
    startMonth,
    endMonth,
    trades: closed.length,
    averageMonthlyReturnPct: round(avg(monthly.map(row => row.returnPct))),
    annualizedReturnPct: round((monthly.reduce((value, row) => value * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, monthly.length)) - 1) * 100),
    maximumDrawdownPct: round(maxDrawdownPct),
    profitFactor: round(grossLoss ? grossProfit / grossLoss : grossProfit ? 99 : 0),
    winRatePct: round(closed.length ? wins.length / closed.length * 100 : 0),
    monthly,
    topFiveProfitContributionPct: round(closed.length ? closed.sort((a, b) => b.pnl - a.pnl).slice(0, 5).reduce((sum, row) => sum + row.pnl, 0) / Math.max(1, grossProfit) * 100 : 0)
  };
}

function configs() {
  const rows = [];
  for (const holdDays of [5, 10, 15]) {
    for (const stopLossPct of [5, 7, 9]) {
      for (const takeProfitPct of [8, 12, 16]) {
        for (const positionPct of [5, 6, 7]) {
          rows.push({
            holdDays,
            stopLossPct,
            takeProfitPct,
            positionPct,
            trailStartPct: takeProfitPct / 2,
            trailGivebackPct: Math.max(4, stopLossPct - 1),
            minScore: 65,
            minTradeValue: 30_000_000,
            maxAtr: 12,
            maxRsi: 88,
            maxGapUp: 8,
            maxDistanceToMa20: 25,
            minReturn20: -8,
            minNearYearHigh: 0.25,
            requireTrend: false,
            requireConstructiveVolume: false,
            requireMarketSupport: false,
            requireGlobalSupport: false,
            entriesPerDay: 3,
            maxOpenPositions: 8,
            monthStopPct: -5,
            lossStreakLimit: 5,
            cooldownDays: 8,
            return20Weight: 0.45,
            momentumWeight: 0.18,
            atrPenalty: 3.5,
            distancePenalty: 0.8
          });
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
    winRatePct: round(results.reduce((sum, row) => sum + row.winRatePct * row.trades, 0) / Math.max(1, trades)),
    topFiveProfitContributionPct: round(results.reduce((sum, row) => sum + row.topFiveProfitContributionPct, 0) / Math.max(1, results.length))
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
    dataSources: ['OHLCV', 'market_risk_factors'],
    setupRules: ['common_stock_only', 'high_liquidity', 'strong_trend', 'not_overextended', 'avoid_weak_market'],
    triggerRules: ['candidate_signal_next_open'],
    invalidationRules: ['hard_stop', 'trailing_stop', 'monthly_brake', 'loss_streak_cooldown'],
    exitRules: ['max_holding_days', 'take_profit', 'stop_loss', 'trailing_stop'],
    riskRules: { tPlusTwo: true, positionPct: [5, 6, 7], monthStopPct: -5 },
    parameters: { trainMonths: 72, validationMonths: 24, stepMonths: 12, configurations: configs().length },
    costModel: COSTS,
    executionModel: 'shared_execution_simulator_with_gap_aware_stops'
  };
  const identity = buildExperimentIdentity(identityInput);
  const decision = shouldSkipExperiment(await loadRegistry(), identity, { ...identityInput, coreRulesChanged: true });
  if (decision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...decision, ...identity }, null, 2));
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
      if (train.trades < 40) continue;
      const score = train.averageMonthlyReturnPct * 4 + train.profitFactor * 1.5 + train.maximumDrawdownPct * 0.04 + Math.min(1, train.trades / 350);
      if (!best || score > best.score) best = { config, train, score };
    }
    if (!best) {
      foldReports.push({ ...fold, status: 'no_train_candidate' });
      continue;
    }
    foldReports.push({
      ...fold,
      status: 'validated',
      selectedConfig: best.config,
      train: best.train,
      validation: simulate(trades, best.config, fold.validationStart, fold.validationEnd)
    });
  }
  const validations = foldReports.filter(row => row.status === 'validated').map(row => row.validation);
  const metrics = aggregate(validations);
  const validationStart = foldReports.find(row => row.status === 'validated')?.validationStart;
  const validationEnd = [...foldReports].reverse().find(row => row.status === 'validated')?.validationEnd;
  const etf = JSON.parse(await fs.readFile(ETF_HISTORY, 'utf8'));
  const benchmark0050 = benchmark(etf.series['0050.TW'] || [], validationStart, validationEnd);
  const checks = {
    target5Pct: metrics.averageMonthlyReturnPct >= 5,
    enoughTrades: metrics.trades >= 300,
    drawdownOk: metrics.maximumDrawdownPct >= -20,
    profitFactorOk: metrics.profitFactor > 1.15,
    beats0050: metrics.averageMonthlyReturnPct > benchmark0050.averageMonthlyReturnPct,
    notConcentrated: metrics.topFiveProfitContributionPct < 35
  };
  const output = {
    generatedAt: new Date().toISOString(),
    ...identity,
    strategyId: STRATEGY_ID,
    validationPeriod: `${validationStart} ??${validationEnd}`,
    folds: foldReports,
    testedConfigurations: allConfigs.length,
    metrics,
    benchmark0050,
    checks,
    paperTradingReady: false,
    liveTradingReady: false,
    conclusion: checks.target5Pct && checks.enoughTrades && checks.drawdownOk && checks.profitFactorOk && checks.beats0050
      ? 'Reached 5pct observation threshold, paper trading still required.'
      : `Not reached 5pct monthly target. Current monthly ${metrics.averageMonthlyReturnPct}%, gap ${round(5 - metrics.averageMonthlyReturnPct)} pct points.`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 個股務實 Alpha Hunter v1\n\n- 驗證期間：${output.validationPeriod}\n- 訓練 / 驗證：72 個月 / 24 個月，每 12 個月滾動\n- 測試組合：${allConfigs.length}\n- 月均報酬：${metrics.averageMonthlyReturnPct}%\n- 年化報酬：${metrics.annualizedReturnPct}%\n- 最大回撤：${metrics.maximumDrawdownPct}%\n- 交易筆數：${metrics.trades}\n- Profit Factor：${metrics.profitFactor}\n- 勝率：${metrics.winRatePct}%\n- 0050 同期月均：${benchmark0050.averageMonthlyReturnPct}%\n- 是否可紙上交易：否\n- 是否可實盤：否\n\n## 結論\n\n${output.conclusion}\n\n這版仍以個股為主，排除 ETF，並使用真實成本、滑價、T+2、停損跳空較差價格與月虧損熔斷。結果若未達標，不得接券商 API 實盤。\n`, 'utf8');
  console.log(JSON.stringify({ validationPeriod: output.validationPeriod, testedConfigurations: allConfigs.length, metrics, benchmark0050, checks, conclusion: output.conclusion }, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});



