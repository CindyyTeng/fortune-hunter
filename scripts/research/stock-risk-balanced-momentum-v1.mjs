import fs from 'node:fs/promises';
import { buyExecution, sellExecution } from '../lib/execution-simulator.mjs';
import { appendExperiment, buildExperimentIdentity, loadRegistry, shouldSkipExperiment } from './strategy-experiment-registry.mjs';

const INPUT = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const MARKET = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-risk-balanced-momentum-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_RISK_BALANCED_MOMENTUM_V1.md', import.meta.url);
const INITIAL_CAPITAL = 1_000_000;
const TARGET_MONTHLY = 5;
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
const addMonths = (month, add) => {
  const [year, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, m - 1 + add, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};

function isCommonStock(trade) {
  const symbol = String(trade.symbol || '');
  return /^\d{4}$/.test(symbol) && !symbol.startsWith('00');
}

function netReturn(entryPrice, exitPrice) {
  const buy = buyExecution(entryPrice, 1, { ...COSTS, minimumFee: 0 }).total;
  const sell = sellExecution(exitPrice, 1, { ...COSTS, minimumFee: 0 }).net;
  return (sell / buy - 1) * 100;
}

function exitTrade(trade, rule) {
  const forward = trade.forwardPrices || [];
  if (!forward.length) return null;
  const maxIndex = Math.min(rule.holdDays - 1, forward.length - 1);
  let exitIndex = maxIndex;
  let exitPrice = forward[maxIndex].price;
  let highWater = trade.entryPrice;
  const fixedStop = trade.entryPrice * (1 - rule.stopLossPct / 100);
  const supportStop = Number.isFinite(trade.stopLoss) ? trade.stopLoss : fixedStop;
  const hardStop = Math.max(fixedStop, supportStop);
  for (let index = 0; index <= maxIndex; index += 1) {
    const day = forward[index];
    highWater = Math.max(highWater, day.high ?? day.price);
    const trailStop = rule.trailTriggerPct && (highWater / trade.entryPrice - 1) * 100 >= rule.trailTriggerPct
      ? Math.max(trade.entryPrice * (1 + rule.trailLockPct / 100), highWater * (1 - rule.trailGivebackPct / 100))
      : null;
    const stop = Math.max(hardStop, trailStop || 0);
    if ((rule.closeStop ? day.price : day.low ?? day.price) <= stop) {
      exitIndex = index;
      exitPrice = rule.closeStop ? day.price : Math.min(day.open ?? stop, stop);
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

function passes(trade, filter) {
  if ((trade.signalScore || 0) < filter.minScore) return false;
  if ((trade.avg20TradeValue || 0) < filter.minTradeValue) return false;
  if ((trade.nearYearHigh || 0) < filter.minNearYearHigh) return false;
  if ((trade.return20Pct || 0) < filter.minReturn20Pct) return false;
  if ((trade.return5Pct || 0) < filter.minReturn5Pct) return false;
  if ((trade.atr14Pct || 0) < filter.minAtr14Pct || (trade.atr14Pct || 0) > filter.maxAtr14Pct) return false;
  if ((trade.distanceToMa20Pct ?? 0) > filter.maxDistanceToMa20Pct) return false;
  if ((trade.gapUpPct ?? 0) > filter.maxGapUpPct) return false;
  if ((trade.upperWickRatio ?? 0) > filter.maxUpperWickRatio) return false;
  if ((trade.globalCompositePct ?? 0) < filter.minGlobalCompositePct) return false;
  if ((trade.asiaCompositePct ?? 0) < filter.minAsiaCompositePct) return false;
  if ((trade.marketMovePct ?? 0) < filter.minMarketMovePct) return false;
  if ((trade.themeMovePct ?? 0) < filter.minThemeMovePct) return false;
  if (filter.requireMa20Rising && !trade.ma20Rising) return false;
  if (filter.requireDirectionalTrend && !trade.directionalTrendUp) return false;
  if (filter.requireBreakout && !trade.donchian20Breakout) return false;
  if (filter.requireSupport && !trade.supportBounce && !trade.falseBreakdownReclaim && !trade.crossAboveMa20) return false;
  if (filter.excludeWeakVolume && ['price_up_volume_down', 'flat_down_volume_up', 'flat_volume_down'].includes(trade.priceVolumeState)) return false;
  return true;
}

function rankValue(trade, mode) {
  if (mode === 'riskAdjusted') return (trade.return20Pct || 0) / Math.max(trade.atr14Pct || 1, 1);
  if (mode === 'qualityTrend') return (trade.signalScore || 0) + (trade.nearYearHigh || 0) * 20 + (trade.ma20Slope5Pct || 0) * 3 - (trade.upperWickRatio || 0) * 10;
  if (mode === 'globalSync') return (trade.signalScore || 0) + (trade.globalCompositePct || 0) * 5 + (trade.themeMovePct || 0) * 3;
  return trade.signalScore || 0;
}

function prepareTrades(trades, config, startMonth, endMonth) {
  const byDate = new Map();
  for (const trade of trades) {
    const month = monthKey(trade.entryDate);
    if (month < startMonth || month > endMonth) continue;
    if (!passes(trade, config.filter)) continue;
    const exit = exitTrade(trade, config.exit);
    if (!exit) continue;
    const rows = byDate.get(trade.entryDate) || [];
    rows.push({ ...trade, ...exit });
    byDate.set(trade.entryDate, rows);
  }
  const selected = [];
  for (const rows of byDate.values()) {
    rows.sort((left, right) => rankValue(right, config.rankMode) - rankValue(left, config.rankMode));
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
  let monthStartEquity = INITIAL_CAPITAL;
  let currentMonth = '';
  let monthHalted = false;
  let cooldown = 0;
  let lossStreak = 0;
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
      closed.push({ ...position, exitDate: trade.exitDate, netReturnPct: trade.netReturnPct, pnl: proceeds - position.cost });
      lossStreak = trade.netReturnPct < 0 ? lossStreak + 1 : 0;
      if (lossStreak >= config.lossStreakLimit) {
        cooldown = Math.max(cooldown, config.lossCooldownDays);
        lossStreak = 0;
      }
      open = open.filter(row => row.tradeId !== trade.tradeId);
    }
    equity = cash + unsettled.reduce((sum, item) => sum + item.amount, 0) + open.reduce((sum, position) => sum + markValue(position, today), 0);
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.min(maxDrawdownPct, (equity / peak - 1) * 100);
    if ((equity / peak - 1) * 100 <= config.accountDrawdownBrakePct) cooldown = Math.max(cooldown, config.accountCooldownDays);
    if ((equity / monthStartEquity - 1) * 100 <= config.monthlyEquityBrakePct) monthHalted = true;
    if (!monthHalted && cooldown <= 0) {
      const entries = today.entries.sort((left, right) => rankValue(right, config.rankMode) - rankValue(left, config.rankMode));
      for (const trade of entries) {
        if (open.length >= config.maxOpenPositions) break;
        if (open.some(position => position.symbol === trade.symbol)) continue;
        const riskBudget = equity * config.accountRiskPct / 100;
        const stopDistancePct = Math.max(config.exit.stopLossPct, Math.abs((trade.entryPrice - (trade.stopLoss || trade.entryPrice * 0.93)) / trade.entryPrice * 100));
        const byRisk = riskBudget / Math.max(stopDistancePct / 100, 0.02);
        const budget = Math.min(cash, equity * config.positionPct / 100, byRisk);
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
  const monthRows = [...monthly].sort().map(([month, endEquity]) => {
    const returnPct = (endEquity / prior - 1) * 100;
    prior = endEquity;
    return { month, returnPct: round(returnPct), endingEquity: round(endEquity, 0) };
  });
  const wins = closed.filter(row => row.pnl > 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.pnl, 0);
  const grossLoss = Math.abs(closed.filter(row => row.pnl <= 0).reduce((sum, row) => sum + row.pnl, 0));
  return {
    startMonth,
    endMonth,
    months: monthRows.length,
    averageMonthlyReturnPct: round(average(monthRows.map(row => row.returnPct))),
    annualizedReturnPct: round((monthRows.reduce((value, row) => value * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, monthRows.length)) - 1) * 100),
    maximumDrawdownPct: round(maxDrawdownPct),
    trades: closed.length,
    winRatePct: round(wins.length / Math.max(1, closed.length) * 100),
    profitFactor: grossLoss ? round(grossProfit / grossLoss) : grossProfit > 0 ? null : 0,
    topFiveProfitContributionPct: round(closed.sort((a, b) => b.pnl - a.pnl).slice(0, 5).reduce((sum, row) => sum + row.pnl, 0) / Math.max(1, grossProfit) * 100),
    monthly: monthRows,
    closed
  };
}

function buildConfigs() {
  const filters = [
    { id: 'broad_quality_momentum', minScore: 55, minTradeValue: 25e6, minNearYearHigh: 0.72, minReturn20Pct: -2, minReturn5Pct: -8, minAtr14Pct: 0.7, maxAtr14Pct: 8, maxDistanceToMa20Pct: 16, maxGapUpPct: 9, maxUpperWickRatio: 0.75, minGlobalCompositePct: -8, minAsiaCompositePct: -8, minMarketMovePct: -2.5, minThemeMovePct: -2.5, requireMa20Rising: false, requireDirectionalTrend: false, requireBreakout: false, requireSupport: false, excludeWeakVolume: false },
    { id: 'near90_quality', minScore: 60, minTradeValue: 30e6, minNearYearHigh: 0.9, minReturn20Pct: 0, minReturn5Pct: -6, minAtr14Pct: 1, maxAtr14Pct: 7, maxDistanceToMa20Pct: 14, maxGapUpPct: 8, maxUpperWickRatio: 0.65, minGlobalCompositePct: -6, minAsiaCompositePct: -6, minMarketMovePct: -2, minThemeMovePct: -2, requireMa20Rising: true, requireDirectionalTrend: false, requireBreakout: false, requireSupport: false, excludeWeakVolume: true },
    { id: 'liquid_near_high', minScore: 68, minTradeValue: 80e6, minNearYearHigh: 0.9, minReturn20Pct: 2, minReturn5Pct: -4, minAtr14Pct: 1.2, maxAtr14Pct: 6, maxDistanceToMa20Pct: 10, maxGapUpPct: 6, maxUpperWickRatio: 0.55, minGlobalCompositePct: -3, minAsiaCompositePct: -3, minMarketMovePct: -1, minThemeMovePct: -1, requireMa20Rising: true, requireDirectionalTrend: false, requireBreakout: false, requireSupport: false, excludeWeakVolume: true },
    { id: 'quiet_breakout', minScore: 65, minTradeValue: 120e6, minNearYearHigh: 0.92, minReturn20Pct: 3, minReturn5Pct: -2, minAtr14Pct: 1.5, maxAtr14Pct: 5.5, maxDistanceToMa20Pct: 8, maxGapUpPct: 4, maxUpperWickRatio: 0.45, minGlobalCompositePct: -2, minAsiaCompositePct: -2, minMarketMovePct: -0.8, minThemeMovePct: -0.5, requireMa20Rising: true, requireDirectionalTrend: true, requireBreakout: true, requireSupport: false, excludeWeakVolume: true },
    { id: 'support_reclaim', minScore: 62, minTradeValue: 60e6, minNearYearHigh: 0.82, minReturn20Pct: 0, minReturn5Pct: -6, minAtr14Pct: 1, maxAtr14Pct: 5, maxDistanceToMa20Pct: 6, maxGapUpPct: 3, maxUpperWickRatio: 0.5, minGlobalCompositePct: -2.5, minAsiaCompositePct: -2.5, minMarketMovePct: -0.8, minThemeMovePct: -1, requireMa20Rising: true, requireDirectionalTrend: false, requireBreakout: false, requireSupport: true, excludeWeakVolume: false }
  ];
  const exits = [
    { id: 'h5_s5', holdDays: 5, stopLossPct: 5, closeStop: false },
    { id: 'h7_s6_t12', holdDays: 7, stopLossPct: 6, takeProfitPct: 12, closeStop: false },
    { id: 'h10_s7_trail', holdDays: 10, stopLossPct: 7, closeStop: false, trailTriggerPct: 9, trailGivebackPct: 5, trailLockPct: 2 },
    { id: 'h15_s8_trail', holdDays: 15, stopLossPct: 8, closeStop: true, trailTriggerPct: 12, trailGivebackPct: 6, trailLockPct: 3 }
  ];
  const rows = [];
  for (const filter of filters) {
    for (const exit of exits) {
      for (const rankMode of ['score', 'riskAdjusted', 'qualityTrend', 'globalSync']) {
        for (const maxOpenPositions of [6, 10, 12]) {
          for (const positionPct of [8, 10, 12]) {
            for (const risk of [
              { accountRiskPct: 1.5, monthlyEquityBrakePct: -4, accountDrawdownBrakePct: -8 },
              { accountRiskPct: 2, monthlyEquityBrakePct: -6, accountDrawdownBrakePct: -12 }
            ]) {
              rows.push({
                id: `${filter.id}_${exit.id}_${rankMode}_open${maxOpenPositions}_p${positionPct}_r${risk.accountRiskPct}`,
                filter,
                exit,
                rankMode,
                maxOpenPositions,
                maxEntriesPerDay: Math.min(5, maxOpenPositions),
                positionPct,
                ...risk,
                accountCooldownDays: 15,
                lossStreakLimit: 5,
                lossCooldownDays: 8
              });
            }
          }
        }
      }
    }
  }
  return rows;
}

function scoreTrain(metrics) {
  if (metrics.trades < 50 || metrics.profitFactor < 1.05 || metrics.averageMonthlyReturnPct <= 0) return -Infinity;
  return metrics.averageMonthlyReturnPct * 4
    + metrics.profitFactor
    + Math.min(0, metrics.maximumDrawdownPct + 12) * 0.25
    + Math.min(metrics.trades, 250) / 250;
}

function buildFolds(months, trainMonths = 60, validationMonths = 18, stepMonths = 18) {
  const folds = [];
  for (let trainStartIndex = 0; trainStartIndex + trainMonths + validationMonths <= months.length; trainStartIndex += stepMonths) {
    const trainStart = months[trainStartIndex];
    const trainEnd = months[trainStartIndex + trainMonths - 1];
    const validationStart = months[trainStartIndex + trainMonths];
    const validationEnd = months[trainStartIndex + trainMonths + validationMonths - 1];
    folds.push({ trainStart, trainEnd, validationStart, validationEnd });
  }
  return folds;
}

function mergeValidation(rows) {
  const monthly = rows.flatMap(row => row.validation.monthly);
  const closed = rows.flatMap(row => row.validation.closed);
  const wins = closed.filter(row => row.pnl > 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.pnl, 0);
  const grossLoss = Math.abs(closed.filter(row => row.pnl <= 0).reduce((sum, row) => sum + row.pnl, 0));
  return {
    months: monthly.length,
    averageMonthlyReturnPct: round(average(monthly.map(row => row.returnPct))),
    annualizedReturnPct: round((monthly.reduce((value, row) => value * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, monthly.length)) - 1) * 100),
    maximumDrawdownPct: round(Math.min(...rows.map(row => row.validation.maximumDrawdownPct), 0)),
    trades: closed.length,
    winRatePct: round(wins.length / Math.max(1, closed.length) * 100),
    profitFactor: grossLoss ? round(grossProfit / grossLoss) : grossProfit > 0 ? null : 0,
    topFiveProfitContributionPct: round(closed.sort((a, b) => b.pnl - a.pnl).slice(0, 5).reduce((sum, row) => sum + row.pnl, 0) / Math.max(1, grossProfit) * 100),
    negativeMonths: monthly.filter(row => row.returnPct < 0).length
  };
}

function benchmark0050(benchmark, folds) {
  const byMonth = new Map();
  for (const row of benchmark) byMonth.set(monthKey(row.date), row.price || row.close);
  const returns = [];
  for (const fold of folds) {
    for (let month = fold.validationStart; month <= fold.validationEnd; month = addMonths(month, 1)) {
      const previous = byMonth.get(addMonths(month, -1));
      const current = byMonth.get(month);
      if (previous && current) returns.push((current / previous - 1) * 100);
    }
  }
  return {
    averageMonthlyReturnPct: round(average(returns)),
    months: returns.length
  };
}

async function main() {
  const identityInput = {
    strategyId: 'stock_risk_balanced_momentum_v1',
    dataSources: ['daily_ohlcv', 'tw_backtest_candidate_features', 'market_composite_features'],
    setupRules: ['接近年高', '流動性足夠', 'MA20 上彎', '排除跳空過高與長上影'],
    triggerRules: ['突破', '支撐轉強', '相對強勢排序'],
    invalidationRules: ['停損', '月虧損熔斷', '帳戶回撤熔斷', '連虧冷卻'],
    exitRules: ['固定持有', '停利', '移動停利', '停損'],
    riskRules: { version: 'v3_tradeable_risk_budget', trainMonths: 60, validationMonths: 18, stepMonths: 18, noEtf: true },
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
  const [payload, marketPayload] = await Promise.all([
    fs.readFile(INPUT, 'utf8').then(JSON.parse),
    fs.readFile(MARKET, 'utf8').then(JSON.parse)
  ]);
  const trades = (payload.candidateTrades || []).filter(trade => isCommonStock(trade) && trade.forwardPrices?.length >= 5);
  const months = [...new Set(trades.map(trade => monthKey(trade.entryDate)))].sort();
  const folds = buildFolds(months);
  const configs = buildConfigs();
  const foldRows = [];
  for (const fold of folds) {
    const ranked = configs.map(config => ({
      config,
      train: simulate(trades, config, fold.trainStart, fold.trainEnd)
    })).sort((left, right) => scoreTrain(right.train) - scoreTrain(left.train));
    const selected = ranked.find(row => Number.isFinite(scoreTrain(row.train))) || ranked[0];
    const validation = simulate(trades, selected.config, fold.validationStart, fold.validationEnd);
    foldRows.push({ ...fold, selectedConfigId: selected.config.id, train: selected.train, validation });
  }
  const metrics = mergeValidation(foldRows);
  const benchmark = benchmark0050(marketPayload.benchmark || [], folds);
  const passed = metrics.averageMonthlyReturnPct >= TARGET_MONTHLY
    && metrics.maximumDrawdownPct >= -20
    && metrics.trades >= 300
    && metrics.profitFactor > 1.15
    && metrics.averageMonthlyReturnPct > benchmark.averageMonthlyReturnPct;
  const output = {
    generatedAt: new Date().toISOString(),
    strategyId: identityInput.strategyId,
    identity,
    universe: {
      candidateTrades: payload.candidateTrades?.length || 0,
      commonStockTrades: trades.length,
      etfExcluded: true,
      benchmarkOnly0050: true
    },
    validation: {
      trainMonths: 60,
      validationMonths: 18,
      stepMonths: 18,
      folds: foldRows.length,
      startMonth: foldRows[0]?.validationStart || null,
      endMonth: foldRows.at(-1)?.validationEnd || null,
      configsTested: configs.length
    },
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
    folds: foldRows.map(row => ({
      trainPeriod: `${row.trainStart}～${row.trainEnd}`,
      validationPeriod: `${row.validationStart}～${row.validationEnd}`,
      selectedConfigId: row.selectedConfigId,
      train: { averageMonthlyReturnPct: row.train.averageMonthlyReturnPct, maximumDrawdownPct: row.train.maximumDrawdownPct, trades: row.train.trades, profitFactor: row.train.profitFactor },
      validation: { averageMonthlyReturnPct: row.validation.averageMonthlyReturnPct, maximumDrawdownPct: row.validation.maximumDrawdownPct, trades: row.validation.trades, profitFactor: row.validation.profitFactor }
    })),
    conclusion: passed
      ? '找到達到月均 5% 與最低風控門檻的純個股候選，但仍只能進入 paper trading。'
      : `尚未找到月均 5% 的可實盤純個股策略；目前月均 ${metrics.averageMonthlyReturnPct}%，距離目標 ${round(TARGET_MONTHLY - metrics.averageMonthlyReturnPct)} 個百分點。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 風險平衡強勢股動能 v1

## 結論

${output.conclusion}

## Validation

- 區間：${output.validation.startMonth}～${output.validation.endMonth}
- 訓練 / 驗證：60 個月 / 18 個月，每 18 個月前進一次。
- 測試組數：${configs.length}
- Validation 月數：${metrics.months}
- 交易數：${metrics.trades}
- 月均總資產報酬：${metrics.averageMonthlyReturnPct}%
- 距離月均 5%：${output.targetGapPct} 個百分點
- 年化報酬：${metrics.annualizedReturnPct}%
- 最大回撤：${metrics.maximumDrawdownPct}%
- Profit Factor：${metrics.profitFactor}
- 勝率：${metrics.winRatePct}%
- 0050 benchmark 月均：${benchmark.averageMonthlyReturnPct}%

## 交易邏輯

- 只交易四碼個股，排除 ETF 與 0050。
- 選股使用接近年高、成交值、20 日動能、MA20 上彎、上影線、跳空、ATR、全球與亞洲風險同步條件。
- 進場使用既有候選交易的隔日可交易價格，排序後集中持股。
- 出場包含固定持有、停損、停利、移動停利。
- 風控包含單筆風險、最大持倉、月虧損熔斷、帳戶回撤熔斷與連虧冷卻。

## 可實盤狀態

- Paper trading：${passed ? '可評估，但仍需人工審核' : '不可'}
- 實盤：不可
- 券商 API：不可接真實下單
`, 'utf8');
  await appendExperiment({
    ...identityInput,
    parameters: { configsTested: configs.length },
    trainPeriod: { months: 60 },
    validationPeriod: { months: 18, stepMonths: 18 },
    costModel: COSTS,
    executionModel: { entry: 'next_open_from_candidate', exit: 'shared realistic gap stop/take simulation', settlement: 'T+2' },
    metrics,
    resultStatus: passed ? 'passed' : 'failed',
    failureReason: passed ? null : output.conclusion,
    passedMinimum: passed,
    passedHighProfit: false,
    allowRetest: false,
    notes: '純個股風險平衡動能策略，不以 ETF 或 0050 為交易標的。'
  });
  console.log(JSON.stringify({
    output: OUTPUT.pathname,
    report: REPORT.pathname,
    metrics,
    benchmark0050: benchmark,
    passed
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
