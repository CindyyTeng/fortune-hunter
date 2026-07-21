import fs from 'node:fs/promises';
import { decisionToOrderIntent } from '../lib/order-intent-generator.mjs';
import {
  deterministicScore,
  foldWindows,
  iterateObservations,
  loadResearchContext,
  mean,
  round,
  simulateSignalMap
} from './research-core.mjs';
import {
  appendExperiment,
  buildExperimentIdentity,
  loadRegistry,
  shouldSkipExperiment
} from './strategy-experiment-registry.mjs';

const INSTITUTIONAL = new URL('../../data/institutional/institutional-trades.json', import.meta.url);
const SECTORS = new URL('../../data/sector/sector-classification.json', import.meta.url);
const REVENUE = new URL('../../data/revenue/monthly-revenue.json', import.meta.url);
const QUALITY = new URL('../../data/quality/financial-quality.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-alpha-compound-hunter-v2.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_ALPHA_COMPOUND_HUNTER_V2.md', import.meta.url);
const READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);
const TARGET_MONTHLY = 5;

const readJson = url => fs.readFile(url, 'utf8').then(JSON.parse).catch(error => {
  if (error.code === 'ENOENT') return { records: [] };
  throw error;
});

const rank = (sorted, value) => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] <= value) low = mid + 1;
    else high = mid;
  }
  return sorted.length ? low / sorted.length : 0;
};

const isCommonStock = row => /^\d{4}$/.test(row.symbol)
  && !/(ETF|ETN|指數|反|正2|期貨|0050|00631|00632|00670|00757|00881)/i.test(`${row.name || ''} ${row.stockName || ''}`);

function buildSectorMetrics(context, sectorBySymbol, startDate, endDate) {
  const groups = new Map();
  iterateObservations(context, observation => {
    if (!isCommonStock(observation)) return;
    const sector = sectorBySymbol.get(observation.symbol);
    if (!sector) return;
    const key = `${observation.date}|${sector.sectorCode}`;
    const row = groups.get(key) || {
      date: observation.date, code: sector.sectorCode, name: sector.sectorName,
      count: 0, return5: 0, return20: 0, advancers: 0, highs: 0, valueRatio: 0
    };
    row.count += 1;
    row.return5 += observation.factors.return5;
    row.return20 += observation.factors.return20;
    row.advancers += observation.day.close > observation.prior.close ? 1 : 0;
    row.highs += observation.factors.breakout20 ? 1 : 0;
    row.valueRatio += observation.factors.volumeRatio20 || 0;
    groups.set(key, row);
  }, { startDate, endDate });

  const byDate = new Map();
  for (const row of groups.values()) {
    const sector = {
      code: row.code,
      name: row.name,
      count: row.count,
      return5: row.return5 / row.count,
      return20: row.return20 / row.count,
      advancersRatio: row.advancers / row.count,
      highRatio: row.highs / row.count,
      valueChange: row.valueRatio / row.count - 1
    };
    sector.score = sector.return5 * 0.25
      + sector.return20 * 0.5
      + sector.advancersRatio * 5
      + sector.highRatio * 6
      + Math.max(-1, Math.min(2, sector.valueChange));
    const list = byDate.get(row.date) || [];
    list.push(sector);
    byDate.set(row.date, list);
  }

  const output = new Map();
  for (const [date, list] of byDate) {
    const scores = list.map(row => row.score).sort((a, b) => a - b);
    for (const sector of list) {
      sector.rank = rank(scores, sector.score);
      sector.top20 = sector.rank >= 0.8;
      output.set(`${date}|${sector.code}`, sector);
    }
  }
  return output;
}

function buildDailyFlow(records, marketDates) {
  const validDates = new Set(marketDates);
  const map = new Map();
  for (const row of records || []) {
    if (row.isPointInTimeSafe !== true || row.effectiveDate <= row.date || !validDates.has(row.effectiveDate)) continue;
    const key = `${row.effectiveDate}|${row.symbol}`;
    const value = map.get(key) || { foreign: 0, trust: 0, dealer: 0 };
    value.foreign += Number(row.foreignNetBuy) || 0;
    value.trust += Number(row.trustNetBuy) || 0;
    value.dealer += Number(row.dealerNetBuy) || 0;
    map.set(key, value);
  }
  return map;
}

function buildRollingFlow(flowMap, marketDates) {
  const symbols = new Set([...flowMap.keys()].map(key => key.split('|')[1]));
  const output = new Map();
  for (const symbol of symbols) {
    const queue = [];
    for (const date of marketDates) {
      const flow = flowMap.get(`${date}|${symbol}`) || { foreign: 0, trust: 0, dealer: 0 };
      queue.push(flow);
      if (queue.length > 20) queue.shift();
      const trust5 = queue.slice(-5).reduce((sum, row) => sum + row.trust, 0);
      const trust10 = queue.slice(-10).reduce((sum, row) => sum + row.trust, 0);
      const foreign5 = queue.slice(-5).reduce((sum, row) => sum + row.foreign, 0);
      const total5 = queue.slice(-5).reduce((sum, row) => sum + row.foreign + row.trust + row.dealer, 0);
      output.set(`${date}|${symbol}`, { ...flow, trust5, trust10, foreign5, total5 });
    }
  }
  return output;
}

function latestBefore(records, date) {
  if (!records?.length) return null;
  let low = 0;
  let high = records.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (records[mid].effectiveDate <= date) low = mid + 1;
    else high = mid;
  }
  return records[low - 1] || null;
}

function bySymbolLatest(records) {
  const map = new Map();
  for (const row of records || []) {
    if (row.isPointInTimeSafe !== true || !row.effectiveDate) continue;
    const list = map.get(row.symbol) || [];
    list.push(row);
    map.set(row.symbol, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  return map;
}

function buildRows(context, payloads, startDate, endDate) {
  const marketDates = context.marketHistory.map(row => row.date);
  const sectorBySymbol = new Map((payloads.sectors.records || []).map(row => [row.symbol, row]));
  const sectors = buildSectorMetrics(context, sectorBySymbol, startDate, endDate);
  const flows = buildRollingFlow(buildDailyFlow(payloads.institutional.records || [], marketDates), marketDates);
  const revenueBySymbol = bySymbolLatest(payloads.revenue.records || []);
  const qualityBySymbol = bySymbolLatest(payloads.quality.records || []);
  const rowsByDate = new Map();

  iterateObservations(context, observation => {
    if (!isCommonStock(observation)) return;
    const sector = sectorBySymbol.get(observation.symbol);
    const sectorMetric = sector && sectors.get(`${observation.date}|${sector.sectorCode}`);
    if (!sectorMetric) return;
    const flow = flows.get(`${observation.date}|${observation.symbol}`) || { foreign: 0, trust: 0, dealer: 0, trust5: 0, trust10: 0, foreign5: 0, total5: 0 };
    const revenue = latestBefore(revenueBySymbol.get(observation.symbol), observation.date);
    const quality = latestBefore(qualityBySymbol.get(observation.symbol), observation.date);
    const qualityScore = quality
      ? (Number(quality.epsYoY) > 20 ? 10 : 0)
        + (Number(quality.EPS) > 0 ? 4 : 0)
        + (Number(quality.grossMarginYoYChange) > 0 ? 5 : 0)
        + (Number(quality.operatingMarginYoYChange) > 0 ? 5 : 0)
        + (quality.epsTurnPositive ? 8 : 0)
        + (quality.epsHigh4 ? 5 : 0)
      : 0;
    const revenueScore = revenue
      ? (Number(revenue.YoY) > 20 ? 8 : 0)
        + (Number(revenue.YoY) > 50 ? 8 : 0)
        + (revenue.yoyAcceleration ? 6 : 0)
        + (revenue.revenueHigh12 ? 6 : 0)
        + (revenue.declineToGrowth ? 5 : 0)
      : 0;
    const syncBuy = flow.foreign > 0 && flow.trust > 0;
    const baseScore = observation.factors.relativeMarket20 * 1.5
      + observation.factors.relativeTheme20 * 1.2
      + sectorMetric.rank * 24
      + (sectorMetric.top20 ? 8 : 0)
      + Math.min(4, observation.factors.volumeRatio20 || 0) * 4
      + (observation.factors.breakout20 ? 8 : 0)
      + (syncBuy ? 8 : 0)
      + Math.sign(flow.trust5) * Math.min(8, Math.abs(flow.trust5) / 300)
      + Math.sign(flow.foreign5) * Math.min(5, Math.abs(flow.foreign5) / 800)
      + revenueScore
      + qualityScore
      - Math.max(0, observation.factors.atrPct - 5) * 2.2
      - Math.max(0, Math.abs(observation.factors.distanceMa20) - 8) * 1.5;
    const row = { observation, sector: sectorMetric, flow, revenue, quality, score: baseScore };
    if (!baseTradable(row)) return;
    if (!strategyFamilies.some(family => family.filter(row))) return;
    const list = rowsByDate.get(observation.date) || [];
    list.push(row);
    rowsByDate.set(observation.date, list);
  }, { startDate, endDate });

  for (const [date, list] of rowsByDate) {
    const scores = list.map(row => row.score).sort((a, b) => a - b);
    list.sort((a, b) => b.score - a.score);
    list.forEach((row, index) => {
      row.dailyRank = index + 1;
      row.scoreRank = rank(scores, row.score);
    });
  }
  return { rowsByDate };
}

const strategyFamilies = [
  {
    id: 'triple_confirmed_growth_breakout',
    name: '三資料同向成長突破',
    filter: row => row.revenue
      && row.quality
      && row.sector.rank >= 0.7
      && (row.flow.trust5 > 0 || row.flow.total5 > 0)
      && row.flow.foreign5 > -1000
      && (row.revenue.YoY >= 20 || row.revenue.revenueHigh12 || row.revenue.yoyAcceleration)
      && (row.quality.EPS > 0 || row.quality.epsTurnPositive || row.quality.epsHigh4)
      && (row.quality.grossMarginYoYChange >= 0 || row.quality.operatingMarginYoYChange >= 0)
      && row.observation.factors.marketAboveMa60
      && row.observation.factors.marketReturn20 >= -1
      && row.observation.factors.relativeMarket20 >= 2
      && row.observation.factors.ma20AboveMa60
      && row.observation.factors.breakout20
      && row.observation.factors.volumeRatio20 >= 1.1
      && row.observation.factors.transactionValuePercentile >= 0.6,
    score: row => row.score
      + row.sector.rank * 14
      + Math.min(12, Math.max(0, row.flow.total5 / 500))
      + (row.revenue.yoyAcceleration ? 8 : 0)
      + (row.revenue.revenueHigh12 ? 6 : 0)
      + (row.quality.epsHigh4 ? 8 : 0)
  },
  {
    id: 'quality_revenue_pullback_reclaim',
    name: '營收品質拉回站回',
    filter: row => row.revenue
      && row.quality
      && row.sector.rank >= 0.55
      && row.revenue.YoY >= 10
      && (row.revenue.yoyAcceleration || row.revenue.revenueHigh12 || row.revenue.declineToGrowth)
      && row.quality.EPS > 0
      && (row.quality.grossMarginYoYChange >= 0 || row.quality.operatingMarginYoYChange >= 0 || row.quality.epsHigh4)
      && row.observation.factors.marketAboveMa60
      && row.observation.factors.return60 >= 5
      && row.observation.factors.return5 >= -6
      && row.observation.factors.return5 <= 4
      && row.observation.factors.distanceMa20 >= -4
      && row.observation.factors.distanceMa20 <= 4
      && row.observation.day.close > row.observation.day.open
      && row.observation.day.close >= row.observation.prior.close
      && row.observation.factors.transactionValuePercentile >= 0.55,
    score: row => row.score
      + row.sector.rank * 10
      + (row.quality.epsHigh4 ? 8 : 0)
      + (row.revenue.declineToGrowth ? 6 : 0)
      - Math.abs(row.observation.factors.distanceMa20) * 1.5
  },
  {
    id: 'flow_quality_second_strength',
    name: '籌碼品質二次轉強',
    filter: row => row.quality
      && row.sector.rank >= 0.65
      && row.flow.trust5 > 0
      && row.flow.total5 > 0
      && row.quality.EPS > 0
      && (row.quality.epsHigh4 || row.quality.grossMarginYoYChange > 0 || row.quality.operatingMarginYoYChange > 0)
      && row.observation.factors.marketAboveMa60
      && row.observation.factors.relativeMarket20 >= 3
      && row.observation.factors.return20 >= 0
      && row.observation.factors.return20 <= 30
      && row.observation.factors.return5 >= -3
      && row.observation.factors.return5 <= 8
      && row.observation.factors.ma20Slope > 0
      && row.observation.factors.transactionValuePercentile >= 0.65
      && !row.observation.factors.longUpperWick,
    score: row => row.score
      + row.observation.factors.relativeMarket20 * 1.4
      + Math.min(10, row.flow.trust5 / 300)
      + row.sector.rank * 12
  }
];
const entries = [
  { id: 'next_open_rank', name: '進榜隔日開盤', filter: () => true },
  { id: 'breakout_confirm', name: '突破確認', filter: row => row.observation.factors.breakout20 },
  { id: 'ma20_turn', name: '回測 MA20 轉強', filter: row => row.observation.factors.distanceMa20 >= -3 && row.observation.factors.distanceMa20 <= 3 && row.observation.day.close > row.observation.day.open }
];
const exits = [
  { id: 'fast_12r', name: '短打 1.2R', rewardRisk: 1.2, stopMult: 0.95, holdingDays: 4 },
  { id: 'balanced_18r', name: '平衡 1.8R', rewardRisk: 1.8, stopMult: 1.2, holdingDays: 7 },
  { id: 'trail_2r', name: '移動停利 2R', rewardRisk: 2, stopMult: 1.45, holdingDays: 10, trailing: { triggerPct: 5, lockPct: 1.5, givebackPct: 3.5 } }
];
const topCounts = [2, 3, 5];
const positionByTop = new Map([[2, [18, 24]], [3, [12, 16]], [5, [8, 10]]]);
const configs = strategyFamilies.flatMap(family => topCounts.flatMap(topCount => entries.flatMap(entry => exits.flatMap(exit => (
  positionByTop.get(topCount).map(positionPct => ({
    id: `${family.id}_${entry.id}_${exit.id}_top${topCount}_pct${positionPct}`,
    name: `${family.name} / ${entry.name} / ${exit.name} / Top${topCount} / ${positionPct}%`,
    family, entry, exit, topCount, positionPct
  }))
)))));

function baseTradable(row) {
  const f = row.observation.factors;
  return isCommonStock(row.observation)
    && row.observation.day.close >= 15
    && f.transactionValue >= 40_000_000
    && f.transactionValuePercentile >= 0.55
    && f.atrPct >= 1
    && f.atrPct <= 7
    && Math.abs(f.gapPct) <= 4
    && f.marketReturn20 >= -1
    && (f.marketVolatilityPercentile ?? 0.5) <= 0.85
    && !f.longUpperWick
    && !['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(f.regime);
}

function addCandidate(map, date, row, limit) {
  const list = map.get(date) || [];
  list.push(row);
  list.sort((a, b) => b.score - a.score);
  map.set(date, list.slice(0, limit));
}

function makeCandidate(row, config) {
  const observation = row.observation;
  const stopDistancePct = Math.min(10, Math.max(2.5, observation.factors.atrPct * config.exit.stopMult));
  const bars = observation.futureBars.map(bar => ({ ...bar }));
  let score = row.score;
  try {
    score = config.family.score(row);
  } catch {
    score = row.score;
  }
  const decision = {
    date: observation.nextDate,
    symbol: observation.symbol,
    action: 'BUY',
    strategyId: config.id,
    setup: [config.family.name, `族群 ${row.sector.name}`, `分數 ${round(row.score, 2)}`],
    trigger: [config.entry.name],
    invalidation: [`跌破停損 ${round(stopDistancePct, 2)}%`, '跌破 MA20 或大盤轉弱'],
    entryPlan: {
      referencePrice: observation.nextOpen,
      maximumAcceptablePrice: observation.nextOpen * 1.006,
      orderType: 'MARKETABLE_LIMIT',
      timeInForce: 'ROD',
      session: 'REGULAR'
    },
    riskPlan: {
      stopPrice: observation.nextOpen * (1 - stopDistancePct / 100),
      targetPrice: observation.nextOpen * (1 + stopDistancePct * config.exit.rewardRisk / 100),
      riskRewardRatio: config.exit.rewardRisk,
      positionBudget: config.positionPct / 100 * 1_000_000,
      riskBudget: config.positionPct >= 18 ? 11_000 : 7_000
    },
    reason: config.name,
    warnings: ['驗證未達標前不可實盤，只能當研究候選。']
  };
  return {
    signalDate: observation.date,
    entryDate: observation.nextDate,
    symbol: observation.symbol,
    name: observation.name,
    market: observation.market,
    regime: observation.factors.regime,
    atrPct: observation.factors.atrPct,
    score,
    futureBars: bars,
    stopDistancePct,
    rewardRisk: config.exit.rewardRisk,
    maxHoldingDays: config.exit.holdingDays,
    trailingStopRule: config.exit.trailing,
    positionPct: config.positionPct,
    accountRiskPct: config.positionPct >= 18 ? 1.1 : 0.7,
    setup: decision.setup,
    trigger: decision.trigger,
    invalidation: decision.invalidation,
    exitPlan: config.exit.name,
    reason: decision.reason,
    orderIntent: decisionToOrderIntent(decision, { account: { equity: 1_000_000, availableCash: 1_000_000 } })
  };
}

function signalMap(data, config, startDate, endDate) {
  const map = new Map();
  for (const [date, list] of data.rowsByDate) {
    if (date < startDate || date > endDate) continue;
    for (const row of list) {
      if (!baseTradable(row) || !config.family.filter(row) || !config.entry.filter(row)) continue;
      addCandidate(map, date, makeCandidate(row, config), config.topCount);
    }
  }
  return map;
}

function randomMap(data, selected, config, startDate, endDate) {
  const map = new Map();
  for (const [date, chosen] of selected) {
    if (date < startDate || date > endDate) continue;
    const pool = (data.rowsByDate.get(date) || []).filter(baseTradable)
      .sort((a, b) => deterministicScore(`${date}|${b.observation.symbol}`) - deterministicScore(`${date}|${a.observation.symbol}`));
    map.set(date, pool.slice(0, chosen.length).map(row => makeCandidate(row, config)));
  }
  return map;
}

function riskRules(config) {
  return {
    maxAccountRiskPct: config.positionPct >= 18 ? 1.1 : 0.7,
    maxSinglePositionPct: Math.min(30, config.positionPct + 4),
    exposureLimits: {
      BULL_TREND: 95,
      THEME_MOMENTUM: 95,
      BULL_PULLBACK: 70,
      RANGE_BOUND: 35,
      HIGH_VOLATILITY: 0,
      BEAR_DEFENSE: 0
    },
    drawdownBlockPct: 10,
    drawdownBlockDays: 12,
    monthlyLossBlockPct: 7,
    dailyLossBlockPct: 3,
    dailyLossBlockDays: 1,
    losingStreakCount: 5,
    losingStreakBlockDays: 8
  };
}

function marketMonthly(context, startDate, endDate) {
  let prior;
  const ends = new Map();
  for (const row of context.marketHistory.filter(row => row.date <= endDate)) {
    if (row.date < startDate) prior = row.close;
    else ends.set(row.date.slice(0, 7), row.close);
  }
  const returns = [];
  for (const close of ends.values()) {
    if (prior) returns.push((close / prior - 1) * 100);
    prior = close;
  }
  return returns;
}

function objective(summary) {
  if (!summary || summary.trades < 20) return -Infinity;
  const pf = Number.isFinite(summary.profitFactor) ? Math.min(3, summary.profitFactor) : 3;
  return summary.averageMonthlyEquityReturnPct * 12
    + pf * 4
    + Math.min(1, summary.trades / 120) * 3
    + summary.maximumDrawdownPct * 0.55
    - summary.concentrationPct * 0.03
    - summary.negativeMonths * 0.12;
}

function combine(folds) {
  const trades = folds.flatMap(row => row.validation.trades);
  const monthly = folds.flatMap(row => row.validation.summary.monthly.map(value => value.equityReturnPct));
  const random = folds.flatMap(row => row.random.summary.monthly.map(value => value.equityReturnPct));
  const market = folds.flatMap(row => row.marketReturns);
  const gains = trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(trades.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
  const symbols = new Map();
  for (const trade of trades) symbols.set(trade.symbol, (symbols.get(trade.symbol) || 0) + 1);
  const compounded = monthly.reduce((value, item) => value * (1 + item / 100), 1);
  const metrics = {
    validationStart: folds[0]?.validationStart || null,
    validationEnd: folds.at(-1)?.validationEnd || null,
    validationMonths: monthly.length,
    validationTrades: trades.length,
    validationAverageMonthlyEquityReturnPct: round(mean(monthly) || 0),
    targetGapPct: round(TARGET_MONTHLY - (mean(monthly) || 0)),
    validationAnnualizedReturnPct: round(monthly.length ? (compounded ** (12 / monthly.length) - 1) * 100 : 0),
    validationProfitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    validationMaximumDrawdownPct: round(Math.min(0, ...folds.map(row => row.validation.summary.maximumDrawdownPct))),
    validationWinRatePct: round(trades.filter(row => row.realizedPnl > 0).length / Math.max(1, trades.length) * 100),
    marketAverageMonthlyReturnPct: round(mean(market) || 0),
    randomAverageMonthlyReturnPct: round(mean(random) || 0),
    concentrationPct: round(trades.length ? Math.max(...symbols.values()) / trades.length * 100 : 100),
    orderIntentCoveragePct: round(trades.filter(row => row.orderIntent).length / Math.max(1, trades.length) * 100)
  };
  metrics.checks = {
    monthlyAtLeastTarget: metrics.validationAverageMonthlyEquityReturnPct >= TARGET_MONTHLY,
    tradeCount: metrics.validationTrades > 300,
    beatsMarket: metrics.validationAverageMonthlyEquityReturnPct > metrics.marketAverageMonthlyReturnPct,
    beatsRandom: metrics.validationAverageMonthlyEquityReturnPct > metrics.randomAverageMonthlyReturnPct,
    profitFactor: metrics.validationProfitFactor > 1.15,
    drawdown: metrics.validationMaximumDrawdownPct > -20,
    diversified: metrics.concentrationPct < 20,
    orderIntent: metrics.orderIntentCoveragePct === 100
  };
  metrics.passedDeployable = Object.values(metrics.checks).every(Boolean);
  return metrics;
}

function registryInput(range, metrics = null) {
  return {
    strategyId: 'stock_alpha_compound_hunter_v2',
    dataSources: [
      'daily_ohlcv',
      'institutional_point_in_time_t_plus_1',
      'sector_static_current_classification_v1',
      'monthly_revenue_conservative_t_plus_1',
      'financial_quality_conservative_t_plus_1'
    ],
    setupRules: strategyFamilies.map(row => row.name),
    triggerRules: entries.map(row => row.name),
    invalidationRules: ['跌破 MA20', '大盤轉弱', '跌出個股強勢排行', '停損或移動停利'],
    exitRules: exits.map(row => row.name),
    riskRules: ['個股集中持股但單檔上限 50%', '大盤高波動與空頭不開新倉', 'T+2', '費稅滑價'],
    blockedWhen: ['ETF/0050 排除', '成交值太低', 'ATR 過高', '跳空過大', '長上影線', '空頭或高波動盤'],
    parameters: {
      targetMonthlyPct: TARGET_MONTHLY,
      marketFilterVersion: 'market_return20_positive_volatility_under_75_fast_exit',
      families: strategyFamilies.map(row => row.id),
      configurations: configs.length,
      trainMonths: 24,
      validationMonths: 6,
      stepMonths: 6,
      range
    },
    trainPeriod: { months: 24 },
    validationPeriod: { months: 6, stepMonths: 6 },
    costModel: { buyFeePct: 0.1425, sellFeePct: 0.1425, sellTaxPct: 0.3, slippagePct: 0.15 },
    executionModel: { entry: 'next_open_market', settlement: 'T+2', simulator: 'shared' },
    metrics,
    resultStatus: metrics ? (metrics.passedDeployable ? 'passed' : 'failed') : 'inconclusive',
    failureReason: metrics?.passedDeployable ? null : '尚未同時達到月均 5%、交易數、勝率風險與比較基準要求。',
    passedMinimum: metrics?.passedDeployable === true,
    passedHighProfit: metrics?.passedDeployable === true,
    coreRulesChanged: true,
    allowRetest: false,
    notes: '個股為主，0050 僅作為大盤比較基準，不作為主交易標的。'
  };
}

async function main() {
  const [institutional, sectors, revenue, quality] = await Promise.all([
    readJson(INSTITUTIONAL),
    readJson(SECTORS),
    readJson(REVENUE),
    readJson(QUALITY)
  ]);
  const context = await loadResearchContext();
  const validInstitutionalDates = [...new Set((institutional.records || [])
    .filter(row => row.isPointInTimeSafe && row.effectiveDate > row.date)
    .map(row => row.effectiveDate))].sort();
  const revenueDates = [...new Set((revenue.records || []).filter(row => row.isPointInTimeSafe).map(row => row.effectiveDate))].sort();
  const qualityDates = [...new Set((quality.records || []).filter(row => row.isPointInTimeSafe).map(row => row.effectiveDate))].sort();
  const range = {
    start: [revenueDates[0], qualityDates[0], context.startDate].filter(Boolean).sort()[0],
    end: [validInstitutionalDates.at(-1), revenueDates.at(-1), qualityDates.at(-1), context.endDate].filter(Boolean).sort()[0]
  };
  const identity = buildExperimentIdentity(registryInput(range));
  const precheck = shouldSkipExperiment(await loadRegistry(), identity, registryInput(range));
  if (precheck.skip) {
    console.log(`已測過相同個股複合策略，跳過：${precheck.reason}`);
    return;
  }
  const folds = foldWindows(range.start, range.end, 24, 6);
  const data = buildRows(context, { institutional, sectors, revenue, quality }, range.start, range.end);
  const foldResults = [];
  for (const fold of folds) {
    let best = null;
    for (const config of configs) {
      const train = simulateSignalMap(context, signalMap(data, config, fold.trainStart, fold.trainEnd), {
        startDate: fold.trainStart,
        endDate: fold.trainEnd,
        strategyId: config.id,
        maxOpenPositions: Math.min(config.topCount, 5),
        riskRules: riskRules(config)
      });
      const score = objective(train.summary);
      if (!best || score > best.score) best = { config, score, summary: train.summary };
    }
    const selected = signalMap(data, best.config, fold.validationStart, fold.validationEnd);
    const validation = simulateSignalMap(context, selected, {
      startDate: fold.validationStart,
      endDate: fold.validationEnd,
      strategyId: best.config.id,
      maxOpenPositions: Math.min(best.config.topCount, 5),
      riskRules: riskRules(best.config)
    });
    const random = simulateSignalMap(context, randomMap(data, selected, best.config, fold.validationStart, fold.validationEnd), {
      startDate: fold.validationStart,
      endDate: fold.validationEnd,
      strategyId: `${best.config.id}:fair_random`,
      maxOpenPositions: Math.min(best.config.topCount, 5),
      riskRules: riskRules(best.config)
    });
    foldResults.push({
      ...fold,
      selectedConfig: best.config,
      trainSummary: best.summary,
      validation,
      random,
      marketReturns: marketMonthly(context, fold.validationStart, fold.validationEnd)
    });
    console.log(`${fold.validationStart}～${fold.validationEnd}：${best.config.name}，驗證 ${validation.summary.trades} 筆，月均 ${validation.summary.averageMonthlyEquityReturnPct}%`);
  }
  const metrics = combine(foldResults);
  await appendExperiment(registryInput(range, metrics));
  const report = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    target: `validation 月均至少 ${TARGET_MONTHLY}%`,
    data: {
      range,
      rowsByDate: data.rowsByDate.size,
      institutionalRecords: institutional.records?.length || 0,
      revenueRecords: revenue.records?.length || 0,
      qualityRecords: quality.records?.length || 0,
      sectorPointInTimeSafe: false,
      universe: '個股為主；ETF/0050 排除為交易標的，0050/大盤僅作比較基準。'
    },
    walkForward: { trainMonths: 24, validationMonths: 6, stepMonths: 6, folds: foldResults.length },
    search: {
      strategyFamilies: strategyFamilies.map(row => row.name),
      configurations: configs.length,
      topCounts,
      entries: entries.map(row => row.name),
      exits: exits.map(row => row.name)
    },
    folds: foldResults.map(row => ({
      trainStart: row.trainStart,
      trainEnd: row.trainEnd,
      validationStart: row.validationStart,
      validationEnd: row.validationEnd,
      selectedStrategy: row.selectedConfig.name,
      trainSummary: row.trainSummary,
      validationSummary: row.validation.summary,
      randomSummary: row.random.summary
    })),
    metrics,
    bestStrategy: {
      name: [...new Set(foldResults.map(row => row.selectedConfig.name))].join(' / '),
      selectionLogic: '個股複合分數：相對大盤強度、族群強度、法人流向、月營收、財報品質、量價與風險排除。',
      entryLogic: '由訓練期選出的進場模式，包含進榜隔日開盤、突破確認、MA20 回測轉強、整理後放量轉強。',
      exitLogic: '停損、1.5R/2R/2.5R、移動停利、跌破 MA20、跌出強勢排行或大盤轉弱。',
      positionRule: 'Top1～Top5 集中持股，單檔上限 50%，空頭/高波動不開新倉。'
    },
    readiness: {
      paperTradingAllowed: metrics.passedDeployable,
      liveTradingAllowed: false,
      realBrokerAllowed: false,
      reason: metrics.passedDeployable
        ? '通過研究門檻後仍需先紙上交易驗證，不可直接實盤。'
        : '未達月均 5% 或其他可實盤門檻，不可 paper trading、不可實盤。'
    },
    conclusion: metrics.passedDeployable
      ? '找到達到本輪門檻的個股可執行候選策略，但仍只能先進紙上交易。'
      : `尚未找到月均 ${TARGET_MONTHLY}% 以上的可實盤個股策略；目前月均 ${metrics.validationAverageMonthlyEquityReturnPct}%，距離目標 ${metrics.targetGapPct} 個百分點。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const foldRows = report.folds.map(row => `| ${row.validationStart}～${row.validationEnd} | ${row.selectedStrategy} | ${row.validationSummary.trades} | ${row.validationSummary.averageMonthlyEquityReturnPct}% | ${row.validationSummary.maximumDrawdownPct}% |`).join('\n');
  await fs.writeFile(REPORT, `# 個股複合 Alpha Hunter v2\n\n${report.conclusion}\n\n## 核心結果\n\n- 驗證區間：${metrics.validationStart}～${metrics.validationEnd}\n- 驗證月份：${metrics.validationMonths}\n- 驗證交易數：${metrics.validationTrades}\n- 月均總資產報酬：${metrics.validationAverageMonthlyEquityReturnPct}%\n- 距離月均 ${TARGET_MONTHLY}%：${metrics.targetGapPct} 個百分點\n- 年化報酬：${metrics.validationAnnualizedReturnPct}%\n- Profit Factor：${metrics.validationProfitFactor}\n- 最大回撤：${metrics.validationMaximumDrawdownPct}%\n- 勝率：${metrics.validationWinRatePct}%\n- 大盤月均：${metrics.marketAverageMonthlyReturnPct}%\n- 公平隨機月均：${metrics.randomAverageMonthlyReturnPct}%\n- 可進 paper trading：${metrics.passedDeployable ? '可以，但仍不可直接實盤' : '不可以'}\n\n## 每段驗證\n\n| 驗證區間 | 訓練期選出的策略 | 交易數 | 月均 | 最大回撤 |\n|---|---|---:|---:|---:|\n${foldRows}\n\n## 結論\n\n${metrics.passedDeployable ? '此策略達到本輪研究門檻，但實盤前仍需紙上交易與券商 API dry-run。' : '這版仍未達月均 5% 的可實盤門檻；不能包裝成成功，也不能接真實券商下單。'}\n`, 'utf8');
  await fs.writeFile(READINESS, `# 自動交易落地判斷\n\n更新時間：${report.generatedAt}\n\n## 目前結論\n\n- 個股策略搜尋：${metrics.passedDeployable ? '有候選可進紙上交易' : '尚未通過'}\n- Paper trading：${metrics.passedDeployable ? '可評估，但需人工確認' : '不可'}\n- 實盤：不可\n- 真實券商 API 下單：不可\n\n## 關鍵數字\n\n- 驗證區間：${metrics.validationStart}～${metrics.validationEnd}\n- 驗證交易數：${metrics.validationTrades}\n- 月均總資產報酬：${metrics.validationAverageMonthlyEquityReturnPct}%\n- 目標差距：${metrics.targetGapPct} 個百分點\n- 最大回撤：${metrics.validationMaximumDrawdownPct}%\n- Profit Factor：${metrics.validationProfitFactor}\n\n## 下一步\n\n${metrics.passedDeployable ? '先將此策略接入 paper trading 與 order intent dry-run，至少觀察 1～3 個月。' : '需繼續尋找新的可交易 alpha，例如更精準的產業題材資料、法人分點/主力籌碼、注意股/處置股、除權息與公司行動資料。'}\n`, 'utf8');
  console.log(report.conclusion);
}

await main();

