import fs from 'node:fs/promises';
import { appendExperiment, buildExperimentIdentity, loadRegistry, shouldSkipExperiment } from './strategy-experiment-registry.mjs';

const INPUT = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const MARKET = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-continuation-turnover-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_CONTINUATION_TURNOVER_V1.md', import.meta.url);
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

function isCommonStock(trade) {
  const symbol = String(trade.symbol || '');
  return /^\d{4}$/.test(symbol) && !symbol.startsWith('00');
}

function netReturnPct(entryPrice, exitPrice) {
  return (exitPrice / entryPrice - 1) * 100 - COST_PCT;
}

function rankScore(trade, mode) {
  const score = trade.signalScore || 0;
  const trend = (trade.return20Pct || 0) + (trade.return5Pct || 0) * 0.8;
  const quality = (trade.nearYearHigh || 0) * 30 + (trade.ma20Slope5Pct || 0) * 5;
  const risk = (trade.atr14Pct || 0) * 2 + Math.max(0, trade.distanceToMa20Pct || 0);
  if (mode === 'trend_quality') return score + trend + quality - risk;
  if (mode === 'theme_sync') return score + trend + (trade.themeMovePct || 0) * 4 + (trade.globalCompositePct || 0) * 2 - risk;
  return score + trend - risk;
}

function pass(trade, config) {
  if ((trade.signalScore || 0) < config.minScore) return false;
  if ((trade.avg20TradeValue || 0) < config.minTradeValue) return false;
  if ((trade.nearYearHigh || 0) < config.minNearYearHigh) return false;
  if ((trade.return20Pct || 0) < config.minReturn20Pct) return false;
  if ((trade.return5Pct || 0) < config.minReturn5Pct) return false;
  if ((trade.atr14Pct || 0) > config.maxAtr14Pct) return false;
  if ((trade.distanceToMa20Pct || 0) > config.maxDistanceToMa20Pct) return false;
  if ((trade.gapUpPct || 0) > config.maxGapUpPct) return false;
  if ((trade.upperWickRatio || 0) > config.maxUpperWickRatio) return false;
  if ((trade.marketMovePct || 0) < config.minMarketMovePct) return false;
  if ((trade.themeMovePct || 0) < config.minThemeMovePct) return false;
  if (config.requireMa20Rising && !trade.ma20Rising) return false;
  if (config.excludeWeakVolume && ['price_up_volume_down', 'flat_down_volume_up', 'flat_volume_down'].includes(trade.priceVolumeState)) return false;
  return true;
}

function exitTrade(trade, config) {
  const bars = trade.forwardPrices || [];
  if (bars.length < 3) return null;
  const maxIndex = Math.min(config.holdDays - 1, bars.length - 1);
  let highWater = trade.entryPrice;
  let exitPrice = bars[maxIndex].price;
  let exitIndex = maxIndex;
  for (let index = 0; index <= maxIndex; index += 1) {
    const bar = bars[index];
    highWater = Math.max(highWater, bar.high ?? bar.price);
    const stop = Math.max(
      trade.entryPrice * (1 - config.stopLossPct / 100),
      highWater >= trade.entryPrice * (1 + config.trailTriggerPct / 100)
        ? highWater * (1 - config.trailGivebackPct / 100)
        : 0
    );
    if ((bar.low ?? bar.price) <= stop) {
      exitIndex = index;
      exitPrice = Math.min(bar.open ?? stop, stop);
      break;
    }
    if ((bar.high ?? bar.price) >= trade.entryPrice * (1 + config.takeProfitPct / 100)) {
      const target = trade.entryPrice * (1 + config.takeProfitPct / 100);
      exitIndex = index;
      exitPrice = Math.max(bar.open ?? target, target);
      break;
    }
  }
  return {
    ...trade,
    exitDate: bars[exitIndex].date,
    exitPrice,
    netReturnPct: netReturnPct(trade.entryPrice, exitPrice),
    marks: bars.slice(0, exitIndex + 1).map(bar => ({ date: bar.date, price: bar.price }))
  };
}

function candidates(trades, config, startMonth, endMonth) {
  const byDate = new Map();
  for (const trade of trades) {
    const month = monthKey(trade.entryDate);
    if (month < startMonth || month > endMonth || !pass(trade, config)) continue;
    const row = exitTrade(trade, config);
    if (!row) continue;
    const list = byDate.get(trade.entryDate) || [];
    list.push(row);
    byDate.set(trade.entryDate, list);
  }
  const selected = [];
  for (const list of byDate.values()) {
    list.sort((a, b) => rankScore(b, config.rankMode) - rankScore(a, config.rankMode));
    selected.push(...list.slice(0, config.maxEntriesPerDay));
  }
  return selected;
}

function simulate(trades, config, startMonth, endMonth) {
  const rows = candidates(trades, config, startMonth, endMonth);
  const events = new Map();
  const ensure = date => {
    if (!events.has(date)) events.set(date, { entries: [], exits: [], marks: [] });
    return events.get(date);
  };
  for (const trade of rows) {
    ensure(trade.entryDate).entries.push(trade);
    ensure(trade.exitDate).exits.push(trade);
    for (const mark of trade.marks) ensure(mark.date).marks.push({ id: trade.tradeId, price: mark.price });
  }
  let cash = INITIAL_CAPITAL;
  let equity = INITIAL_CAPITAL;
  let peak = INITIAL_CAPITAL;
  let monthStart = INITIAL_CAPITAL;
  let currentMonth = '';
  let monthHalted = false;
  let cooldown = 0;
  let lossStreak = 0;
  let maxDrawdownPct = 0;
  let open = [];
  let unsettled = [];
  const closed = [];
  const monthly = new Map();
  const dates = [...events.keys()].sort();
  const markValue = (position, today) => {
    const mark = today.marks.find(row => row.id === position.tradeId);
    position.lastPrice = mark?.price || position.lastPrice || position.entryPrice;
    return position.cost * (1 + netReturnPct(position.entryPrice, position.lastPrice) / 100);
  };
  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    const month = monthKey(date);
    const today = events.get(date);
    if (month !== currentMonth) {
      currentMonth = month;
      monthStart = equity;
      monthHalted = false;
    }
    cash += unsettled.filter(row => row.releaseIndex <= index).reduce((sum, row) => sum + row.amount, 0);
    unsettled = unsettled.filter(row => row.releaseIndex > index);
    for (const trade of today.exits) {
      const position = open.find(row => row.tradeId === trade.tradeId);
      if (!position) continue;
      const proceeds = position.cost * (1 + trade.netReturnPct / 100);
      unsettled.push({ releaseIndex: index + 2, amount: proceeds });
      closed.push({ ...position, exitDate: trade.exitDate, pnl: proceeds - position.cost, netReturnPct: trade.netReturnPct });
      lossStreak = trade.netReturnPct < 0 ? lossStreak + 1 : 0;
      if (lossStreak >= config.lossStreakLimit) {
        cooldown = Math.max(cooldown, config.lossCooldownDays);
        lossStreak = 0;
      }
      open = open.filter(row => row.tradeId !== trade.tradeId);
    }
    equity = cash + unsettled.reduce((sum, row) => sum + row.amount, 0) + open.reduce((sum, row) => sum + markValue(row, today), 0);
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.min(maxDrawdownPct, (equity / peak - 1) * 100);
    if ((equity / monthStart - 1) * 100 <= config.monthlyEquityBrakePct) monthHalted = true;
    if ((equity / peak - 1) * 100 <= config.accountDrawdownBrakePct) cooldown = Math.max(cooldown, config.accountCooldownDays);
    if (!monthHalted && cooldown <= 0) {
      for (const trade of today.entries.sort((a, b) => rankScore(b, config.rankMode) - rankScore(a, config.rankMode))) {
        if (open.length >= config.maxOpenPositions || open.some(row => row.symbol === trade.symbol)) continue;
        const stopDistancePct = Math.max(config.stopLossPct, Math.abs((trade.entryPrice - (trade.stopLoss || trade.entryPrice * 0.94)) / trade.entryPrice * 100));
        const riskBudget = equity * config.accountRiskPct / 100;
        const budget = Math.min(cash, equity * config.positionPct / 100, riskBudget / Math.max(stopDistancePct / 100, 0.02));
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
    return { month, returnPct: round(returnPct), endingEquity: round(endEquity, 0) };
  });
  const wins = closed.filter(row => row.pnl > 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.pnl, 0);
  const grossLoss = Math.abs(closed.filter(row => row.pnl <= 0).reduce((sum, row) => sum + row.pnl, 0));
  return {
    averageMonthlyReturnPct: round(avg(monthRows.map(row => row.returnPct))),
    annualizedReturnPct: round((monthRows.reduce((v, row) => v * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, monthRows.length)) - 1) * 100),
    maximumDrawdownPct: round(maxDrawdownPct),
    trades: closed.length,
    winRatePct: round(wins.length / Math.max(1, closed.length) * 100),
    profitFactor: grossLoss ? round(grossProfit / grossLoss) : null,
    topFiveProfitContributionPct: round(closed.sort((a, b) => b.pnl - a.pnl).slice(0, 5).reduce((sum, row) => sum + row.pnl, 0) / Math.max(1, grossProfit) * 100),
    monthly: monthRows,
    closed
  };
}

function configs() {
  const rows = [];
  for (const minScore of [58, 64, 70]) {
    for (const minReturn20Pct of [0, 3, 6]) {
      for (const maxAtr14Pct of [5, 6.5]) {
        for (const maxDistanceToMa20Pct of [8, 12]) {
          for (const holdDays of [5, 7, 10]) {
            for (const rankMode of ['trend_quality', 'theme_sync']) {
              rows.push({
                id: `ct_s${minScore}_r20_${minReturn20Pct}_atr${maxAtr14Pct}_d${maxDistanceToMa20Pct}_h${holdDays}_${rankMode}`,
                minScore,
                minTradeValue: 50e6,
                minNearYearHigh: 0.82,
                minReturn20Pct,
                minReturn5Pct: -4,
                maxAtr14Pct,
                maxDistanceToMa20Pct,
                maxGapUpPct: 6,
                maxUpperWickRatio: 0.55,
                minMarketMovePct: -1.5,
                minThemeMovePct: -1.5,
                requireMa20Rising: true,
                excludeWeakVolume: true,
                holdDays,
                stopLossPct: holdDays <= 5 ? 4.5 : 6,
                takeProfitPct: holdDays <= 5 ? 8 : 12,
                trailTriggerPct: holdDays <= 5 ? 6 : 9,
                trailGivebackPct: 4,
                rankMode,
                maxOpenPositions: 10,
                maxEntriesPerDay: 6,
                positionPct: 10,
                accountRiskPct: 1.2,
                monthlyEquityBrakePct: -5,
                accountDrawdownBrakePct: -10,
                accountCooldownDays: 12,
                lossStreakLimit: 4,
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

function folds(months, train = 60, validation = 18, step = 18) {
  const rows = [];
  for (let i = 0; i + train + validation <= months.length; i += step) {
    rows.push({ trainStart: months[i], trainEnd: months[i + train - 1], validationStart: months[i + train], validationEnd: months[i + train + validation - 1] });
  }
  return rows;
}

function scoreTrain(row) {
  if (row.trades < 80 || row.profitFactor < 1.1 || row.averageMonthlyReturnPct <= 0) return -Infinity;
  return row.averageMonthlyReturnPct * 5 + row.profitFactor * 1.5 + Math.min(row.trades, 300) / 120 + row.maximumDrawdownPct * 0.12;
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
    strategyId: 'stock_continuation_turnover_v1',
    dataSources: ['tw_backtest_candidate_features', 'daily_ohlcv', 'market_composite_features'],
    setupRules: ['純個股強勢續航', 'MA20 上彎', '成交值足夠', '排除弱量與過熱跳空'],
    triggerRules: ['候選股進榜後隔日可交易價格進場'],
    invalidationRules: ['固定停損', '移動停利回吐', '月虧損熔斷', '連虧冷卻'],
    exitRules: ['短持有天數', '停利', '移動停利', '停損'],
    riskRules: { trainMonths: 60, validationMonths: 18, stepMonths: 18, noEtf: true },
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
  const trades = (payload.candidateTrades || []).filter(trade => isCommonStock(trade) && trade.forwardPrices?.length >= 10);
  const months = [...new Set(trades.map(trade => monthKey(trade.entryDate)))].sort();
  const foldRows = [];
  const allConfigs = configs();
  for (const fold of folds(months)) {
    const ranked = allConfigs.map(config => ({ config, train: simulate(trades, config, fold.trainStart, fold.trainEnd) }))
      .sort((a, b) => scoreTrain(b.train) - scoreTrain(a.train));
    const selected = ranked.find(row => Number.isFinite(scoreTrain(row.train))) || ranked[0];
    foldRows.push({ ...fold, selectedConfigId: selected.config.id, train: selected.train, validation: simulate(trades, selected.config, fold.validationStart, fold.validationEnd) });
  }
  const metrics = merge(foldRows);
  const benchmark = benchmark0050(market.benchmark || [], foldRows);
  const passed = metrics.averageMonthlyReturnPct >= TARGET_MONTHLY && metrics.maximumDrawdownPct >= -20 && metrics.trades >= 300 && metrics.profitFactor > 1.15 && metrics.averageMonthlyReturnPct > benchmark.averageMonthlyReturnPct;
  const output = {
    generatedAt: new Date().toISOString(),
    strategyId: identityInput.strategyId,
    identity,
    universe: { commonStockTrades: trades.length, etfExcluded: true, benchmarkOnly0050: true },
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
    folds: foldRows.map(row => ({
      validationPeriod: `${row.validationStart}~${row.validationEnd}`,
      selectedConfigId: row.selectedConfigId,
      train: { averageMonthlyReturnPct: row.train.averageMonthlyReturnPct, maximumDrawdownPct: row.train.maximumDrawdownPct, trades: row.train.trades, profitFactor: row.train.profitFactor },
      validation: { averageMonthlyReturnPct: row.validation.averageMonthlyReturnPct, maximumDrawdownPct: row.validation.maximumDrawdownPct, trades: row.validation.trades, profitFactor: row.validation.profitFactor }
    })),
    conclusion: passed
      ? '達到月均 5% 初步門檻，但仍需紙上交易驗證後才可考慮實盤。'
      : `未達月均 5% 可實盤門檻；validation 月均 ${metrics.averageMonthlyReturnPct}%，距離 5% 還差 ${round(TARGET_MONTHLY - metrics.averageMonthlyReturnPct)} 個百分點。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 純個股續航換手 v1\n\n- 驗證期：${output.validation.startMonth}~${output.validation.endMonth}\n- 月均報酬：${metrics.averageMonthlyReturnPct}%\n- 年化報酬：${metrics.annualizedReturnPct}%\n- 最大回撤：${metrics.maximumDrawdownPct}%\n- 交易筆數：${metrics.trades}\n- Profit Factor：${metrics.profitFactor}\n- 勝率：${metrics.winRatePct}%\n- 0050 月均：${benchmark.averageMonthlyReturnPct}%\n- 是否達月均 5%：${passed}\n- 結論：${output.conclusion}\n\n此策略只交易個股，不以 ETF/0050 為主；核心是強勢續航、較高換手、弱量與跳空排除、短持有停利/移動停利。\n`, 'utf8');
  await appendExperiment({
    ...identityInput,
    parameters: { configsTested: allConfigs.length },
    trainPeriod: { months: 60 },
    validationPeriod: { months: 18, stepMonths: 18 },
    costModel: { roundTripPct: COST_PCT },
    executionModel: { entry: 'candidate_next_entry', exit: 'stop/take/trailing with gap handling', settlement: 'T+2 cash delay' },
    metrics,
    resultStatus: passed ? 'passed' : 'failed',
    failureReason: passed ? null : output.conclusion,
    passedMinimum: passed,
    passedHighProfit: false,
    allowRetest: false,
    notes: '純個股續航換手策略，不以 ETF 或 0050 為交易主體。'
  });
  console.log(JSON.stringify({ output: OUTPUT.pathname, report: REPORT.pathname, metrics, benchmark0050: benchmark, passed }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
