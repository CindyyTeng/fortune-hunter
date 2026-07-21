import fs from 'node:fs/promises';
import { buyExecution, sellExecution } from '../lib/execution-simulator.mjs';
import {
  buildExperimentIdentity,
  loadRegistry,
  shouldSkipExperiment
} from './strategy-experiment-registry.mjs';

const INPUT = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-behavioral-momentum-v2.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_BEHAVIORAL_MOMENTUM_V2.md', import.meta.url);
const STRATEGY_ID = 'stock_behavioral_momentum_v2';
const INITIAL_CAPITAL = 1_000_000;
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
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const monthKey = date => date.slice(0, 7);

function isCommonStock(trade) {
  return /^\d{4}$/.test(String(trade.symbol || '')) && !String(trade.symbol).startsWith('00');
}

function monthRange(start, end) {
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

function netReturn(entryPrice, exitPrice) {
  const buy = buyExecution(entryPrice, 1, { ...COSTS, minimumFee: 0 }).total;
  const sell = sellExecution(exitPrice, 1, { ...COSTS, minimumFee: 0 }).net;
  return (sell / buy - 1) * 100;
}

function exitTrade(trade, rule) {
  const forward = (trade.forwardPrices || []).filter(row => row.date > trade.entryDate);
  if (!forward.length) return null;
  const maxIndex = Math.min(rule.holdDays - 1, forward.length - 1);
  let exitIndex = maxIndex;
  let exitPrice = forward[maxIndex].price;
  let highWater = trade.entryPrice;
  const baseStop = trade.entryPrice * (1 - rule.stopLossPct / 100);
  const supportStop = Number.isFinite(trade.stopLoss) ? trade.stopLoss : baseStop;
  for (let index = 0; index <= maxIndex; index += 1) {
    const day = forward[index];
    highWater = Math.max(highWater, day.high ?? day.price);
    const trailingStop = highWater >= trade.entryPrice * (1 + rule.trailStartPct / 100)
      ? Math.max(trade.entryPrice, highWater * (1 - rule.trailGivebackPct / 100))
      : null;
    const stop = Math.max(baseStop, supportStop, trailingStop || 0);
    if ((day.low ?? day.price) <= stop) {
      exitIndex = index;
      exitPrice = Math.min(day.open ?? stop, stop);
      break;
    }
    if (rule.takeProfitPct && (day.high ?? day.price) >= trade.entryPrice * (1 + rule.takeProfitPct / 100)) {
      const target = trade.entryPrice * (1 + rule.takeProfitPct / 100);
      exitIndex = index;
      exitPrice = Math.max(day.open ?? target, target);
      break;
    }
  }
  return {
    exitDate: forward[exitIndex].date,
    exitPrice,
    netReturnPct: netReturn(trade.entryPrice, exitPrice),
    marks: forward.slice(0, exitIndex + 1).map(day => ({ date: day.date, price: day.price }))
  };
}

function rankScore(trade, mode) {
  if (mode === 'signal') return trade.signalScore || 0;
  if (mode === 'lowRisk') {
    return (trade.signalScore || 0)
      + (trade.nearYearHigh || 0) * 12
      + (trade.return20Pct || 0) * 0.4
      - (trade.atr14Pct || 0) * 8
      - Math.max(0, trade.distanceToMa20Pct || 0) * 1.5
      - (trade.upperWickRatio || 0) * 15;
  }
  if (mode === 'riskAdjusted') {
    return ((trade.return20Pct || 0) + (trade.signalScore || 0) * 0.15) / Math.max(trade.atr14Pct || 1, 1);
  }
  const volumePressure = (trade.volumeRatio5To20 || 1) * 8 + (trade.previousVolumeRatio || 1) * 2;
  const continuation = (trade.intradayMomentum20Pct || 0) - Math.max(0, trade.overnightMomentum20Pct || 0) * 0.4;
  const trend = (trade.return20Pct || 0) * 0.8 + (trade.nearYearHigh || 0) * 18;
  const riskPenalty = Math.max(0, (trade.atr14Pct || 0) - 6) * 2 + (trade.upperWickRatio || 0) * 8;
  return trend + continuation + volumePressure - riskPenalty;
}

function passes(trade, config) {
  if (!isCommonStock(trade)) return false;
  if ((trade.avg20TradeValue || 0) < config.minTradeValue) return false;
  if ((trade.rsi14 || 0) > config.maxRsi) return false;
  if ((trade.atr14Pct || 0) > config.maxAtr) return false;
  if ((trade.distanceToMa20Pct ?? 0) > config.maxDistanceToMa20) return false;
  if ((trade.gapUpPct ?? 0) > config.maxGapUp) return false;
  if ((trade.return20Pct || 0) < config.minReturn20) return false;
  if ((trade.volumeRatio5To20 || 0) < config.minVolumeRatio) return false;
  if ((trade.upperWickRatio || 0) > config.maxUpperWick) return false;
  if (config.requireMarketSupport && (trade.marketMovePct || 0) < -1) return false;
  if (config.requireThemeSupport && (trade.themeMovePct || 0) < 0) return false;
  if (config.requireTrend && !trade.ma20Rising) return false;
  return true;
}

function prepareTrades(trades, config, startMonth, endMonth) {
  const byDate = new Map();
  for (const trade of trades) {
    const month = monthKey(trade.entryDate);
    if (month < startMonth || month > endMonth) continue;
    if (!passes(trade, config)) continue;
    const exit = exitTrade(trade, config.exit);
    if (!exit) continue;
    const rows = byDate.get(trade.entryDate) || [];
    rows.push({ ...trade, ...exit, rankScore: rankScore(trade, config.rankMode) });
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
  const selected = prepareTrades(trades, config, startMonth, endMonth);
  const events = new Map();
  const event = date => {
    if (!events.has(date)) events.set(date, { entries: [], exits: [], marks: [] });
    return events.get(date);
  };
  for (const trade of selected) {
    event(trade.entryDate).entries.push(trade);
    event(trade.exitDate).exits.push(trade);
    for (const mark of trade.marks) event(mark.date).marks.push({ tradeId: trade.tradeId, price: mark.price });
  }

  let cash = INITIAL_CAPITAL;
  let equity = INITIAL_CAPITAL;
  let peak = INITIAL_CAPITAL;
  let currentMonth = '';
  let monthStartEquity = INITIAL_CAPITAL;
  let cooldown = 0;
  let open = [];
  let unsettled = [];
  let maxDrawdownPct = 0;
  const closed = [];
  const monthly = new Map();
  const dates = [...events.keys()].sort();
  const markValue = (position, today) => {
    const price = today.marks.find(row => row.tradeId === position.tradeId)?.price ?? position.lastPrice ?? position.entryPrice;
    position.lastPrice = price;
    return position.cost * (1 + netReturn(position.entryPrice, price) / 100);
  };

  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    const month = monthKey(date);
    if (month !== currentMonth) {
      currentMonth = month;
      monthStartEquity = equity;
    }
    cash += unsettled.filter(item => item.releaseIndex <= index).reduce((sum, item) => sum + item.amount, 0);
    unsettled = unsettled.filter(item => item.releaseIndex > index);
    const today = events.get(date);
    for (const trade of today.exits) {
      const position = open.find(row => row.tradeId === trade.tradeId);
      if (!position) continue;
      const proceeds = position.cost * (1 + trade.netReturnPct / 100);
      unsettled.push({ releaseIndex: index + 2, amount: proceeds });
      closed.push({ ...position, exitDate: trade.exitDate, netReturnPct: trade.netReturnPct, pnl: proceeds - position.cost });
      open = open.filter(row => row.tradeId !== trade.tradeId);
    }
    equity = cash + unsettled.reduce((sum, item) => sum + item.amount, 0) + open.reduce((sum, position) => sum + markValue(position, today), 0);
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.min(maxDrawdownPct, (equity / peak - 1) * 100);
    if (config.accountBrakePct > -90 && (equity / peak - 1) * 100 <= config.accountBrakePct) {
      cooldown = Math.max(cooldown, config.cooldownDays);
    }
    if (cooldown <= 0 && (equity / monthStartEquity - 1) * 100 > config.monthBrakePct) {
      const entries = today.entries.sort((left, right) => right.rankScore - left.rankScore);
      for (const trade of entries) {
        if (open.length >= config.maxOpenPositions) break;
        if (open.some(position => position.symbol === trade.symbol)) continue;
        const budget = Math.min(cash, equity * config.positionPct / 100);
        if (budget < 20_000) continue;
        cash -= budget;
        open.push({ ...trade, cost: budget, lastPrice: trade.entryPrice });
      }
    }
    if (cooldown > 0) cooldown -= 1;
    equity = cash + unsettled.reduce((sum, item) => sum + item.amount, 0) + open.reduce((sum, position) => sum + markValue(position, today), 0);
    monthly.set(month, equity);
  }

  let prior = INITIAL_CAPITAL;
  const monthRows = [...monthly].sort().map(([month, endingEquity]) => {
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
    months: monthRows.length,
    trades: closed.length,
    averageMonthlyReturnPct: round(average(monthRows.map(row => row.returnPct))),
    annualizedReturnPct: round((monthRows.reduce((value, row) => value * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, monthRows.length)) - 1) * 100),
    maximumDrawdownPct: round(maxDrawdownPct),
    profitFactor: round(grossLoss ? grossProfit / grossLoss : grossProfit ? 99 : 0),
    winRatePct: round(closed.length ? wins.length / closed.length * 100 : 0),
    uniqueSymbols: new Set(closed.map(row => row.symbol)).size,
    topSymbolSharePct: round(closed.length ? Math.max(...Object.values(closed.reduce((map, row) => {
      map[row.symbol] = (map[row.symbol] || 0) + 1;
      return map;
    }, {}))) / closed.length * 100 : 0),
    monthly: monthRows
  };
}

function configurations() {
  const rows = [];
  for (const maxOpenPositions of [8, 12, 16]) {
    for (const maxEntriesPerDay of [1, 2]) {
      for (const positionPct of [8, 10]) {
        for (const minReturn20 of [0, 5]) {
          for (const maxAtr of [6, 9]) {
            for (const holdDays of [10, 15]) {
              for (const rankMode of ['lowRisk', 'riskAdjusted']) {
                for (const requireTrend of [true, false]) rows.push({
                maxOpenPositions,
                maxEntriesPerDay,
                positionPct,
                minReturn20,
                minTradeValue: 20_000_000,
                minVolumeRatio: 0.5,
                maxRsi: 85,
                maxAtr,
                maxDistanceToMa20: 25,
                maxGapUp: 5,
                maxUpperWick: 0.7,
                requireMarketSupport: false,
                requireThemeSupport: false,
                requireTrend,
                rankMode,
                accountBrakePct: -99,
                monthBrakePct: -8,
                cooldownDays: 10,
                exit: {
                  holdDays,
                  stopLossPct: 6,
                  takeProfitPct: 14,
                  trailStartPct: 9,
                  trailGivebackPct: 7
                }
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

function aggregate(results) {
  const monthly = results.flatMap(row => row.monthly);
  const trades = results.reduce((sum, row) => sum + row.trades, 0);
  const grossProxyProfit = results.reduce((sum, row) => sum + Math.max(0, row.profitFactor) * row.trades, 0);
  return {
    folds: results.length,
    trades,
    averageMonthlyReturnPct: round(average(monthly.map(row => row.returnPct))),
    annualizedReturnPct: round((monthly.reduce((value, row) => value * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, monthly.length)) - 1) * 100),
    maximumDrawdownPct: round(Math.min(...results.map(row => row.maximumDrawdownPct))),
    profitFactor: round(results.reduce((sum, row) => sum + row.profitFactor * row.trades, 0) / Math.max(1, trades)),
    winRatePct: round(results.reduce((sum, row) => sum + row.winRatePct * row.trades, 0) / Math.max(1, trades)),
    uniqueSymbols: null,
    grossProxyProfit: round(grossProxyProfit)
  };
}

function benchmark0050(series, startMonth, endMonth) {
  const rows = series.filter(row => monthKey(row.date) >= startMonth && monthKey(row.date) <= endMonth);
  const monthEnds = new Map();
  for (const row of rows) monthEnds.set(monthKey(row.date), row.close);
  const sorted = [...monthEnds].sort();
  let prior = sorted[0]?.[1] || null;
  const returns = [];
  for (const [, close] of sorted.slice(1)) {
    returns.push((close / prior - 1) * 100);
    prior = close;
  }
  return { averageMonthlyReturnPct: round(average(returns)) };
}

async function main() {
  const identityInput = {
    strategyId: STRATEGY_ID,
    dataSources: ['OHLCV 候選交易池'],
    setupRules: ['純個股', '行為動能排序', '排除低流動性與過熱波動'],
    triggerRules: ['訊號日收盤後排序，隔日開盤進場'],
    invalidationRules: ['跳空過高不追', '跌破停損或觸發帳戶風控'],
    exitRules: ['固定持有、停損、停利、移動停利'],
    riskRules: { tPlusTwo: true, maxPositionPct: 10, accountBrakePct: -10 },
    blockedWhen: ['ETF', '低成交值', '高 ATR', '長上影過高'],
    parameters: { configurations: configurations().length, trainMonths: 60, validationMonths: 24 },
    trainPeriod: 'rolling 60 months',
    validationPeriod: 'rolling 24 months',
    costModel: '手續費、交易稅、滑價、T+2',
    executionModel: '訊號日後隔日開盤進場，出場遇跳空採較差成交價'
  };
  const identity = buildExperimentIdentity(identityInput);
  const registryDecision = shouldSkipExperiment(await loadRegistry(), identity, { ...identityInput, coreRulesChanged: true });
  if (registryDecision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...registryDecision, ...identity }, null, 2));
    return;
  }

  const dataset = JSON.parse(await fs.readFile(INPUT, 'utf8'));
  const trades = dataset.candidateTrades.filter(isCommonStock);
  const months = [...new Set(trades.map(row => monthKey(row.entryDate)))].sort();
  const folds = foldWindows(months, 60, 24, 12);
  const configs = configurations();
  const foldResults = [];
  for (const fold of folds) {
    let bestTrain = null;
    for (let configIndex = 0; configIndex < configs.length; configIndex += 1) {
      const config = configs[configIndex];
      const train = simulate(trades, config, fold.trainStart, fold.trainEnd);
      if (process.env.DEBUG_BEHAVIORAL === '1' && !bestTrain && configIndex === 0) {
        console.log(JSON.stringify({ debugFold: fold, firstConfigTrain: train }, null, 2));
      }
      if (train.trades < 10) continue;
      if (!bestTrain || train.averageMonthlyReturnPct > bestTrain.train.averageMonthlyReturnPct) {
        bestTrain = { config, train };
      }
    }
    if (!bestTrain) {
      foldResults.push({ ...fold, status: '無合格訓練組合' });
      continue;
    }
    const validation = simulate(trades, bestTrain.config, fold.validationStart, fold.validationEnd);
    foldResults.push({ ...fold, status: '已驗證', selectedConfig: bestTrain.config, train: bestTrain.train, validation });
  }
  const validationRows = foldResults.filter(row => row.status === '已驗證').map(row => row.validation);
  const metrics = aggregate(validationRows);
  const validationStart = foldResults.find(row => row.status === '已驗證')?.validationStart;
  const validationEnd = [...foldResults].reverse().find(row => row.status === '已驗證')?.validationEnd;
  const etfHistory = JSON.parse(await fs.readFile(ETF_HISTORY, 'utf8'));
  const benchmark = benchmark0050(etfHistory.series['0050.TW'] || [], validationStart, validationEnd);
  const passed = metrics.averageMonthlyReturnPct >= 5
    && metrics.trades >= 300
    && metrics.maximumDrawdownPct >= -20
    && metrics.profitFactor > 1.15
    && metrics.averageMonthlyReturnPct > benchmark.averageMonthlyReturnPct;
  const output = {
    generatedAt: new Date().toISOString(),
    ...identity,
    strategyId: STRATEGY_ID,
    validationPeriod: `${validationStart} 至 ${validationEnd}`,
    testedConfigurations: configs.length,
    folds: foldResults,
    metrics,
    benchmark0050: benchmark,
    targetMonthlyReturnPct: 5,
    targetMet: passed,
    paperTradingReady: false,
    liveTradingReady: false,
    conclusion: passed
      ? '通過月均 5% 與基本風控門檻，但仍需人工驗收後才可進紙上交易。'
      : `未達可信月均 5% 門檻，目前月均 ${metrics.averageMonthlyReturnPct}% ，不可紙上交易或實盤。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 純個股行為動能 v2\n\n- 驗證期間：${output.validationPeriod}\n- 測試組合：${configs.length}\n- 月均總資產報酬：${metrics.averageMonthlyReturnPct}%\n- 年化報酬：${metrics.annualizedReturnPct}%\n- 最大回撤：${metrics.maximumDrawdownPct}%\n- 交易數：${metrics.trades}\n- Profit Factor：${metrics.profitFactor}\n- 勝率：${metrics.winRatePct}%\n- 0050 同期月均：${benchmark.averageMonthlyReturnPct}%\n- 結論：${output.conclusion}\n\n本策略只使用個股候選池，不使用 ETF 作為交易標的。訊號日收盤後排序，隔日才進場，並扣除費稅與滑價；目前未達月均 5% 可信門檻，不可接實盤。\n`, 'utf8');
  console.log(JSON.stringify({
    output: OUTPUT.pathname,
    report: REPORT.pathname,
    validationPeriod: output.validationPeriod,
    testedConfigurations: configs.length,
    metrics,
    benchmark0050: benchmark,
    targetMet: passed,
    conclusion: output.conclusion
  }, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
