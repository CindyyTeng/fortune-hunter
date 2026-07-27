import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { buyExecution } from '../lib/execution-simulator.mjs';
import {
  beginPortfolioDay,
  closePosition,
  createPortfolio,
  markPosition,
  openPosition,
  recordEquity,
  settleCash
} from '../lib/portfolio-simulator.mjs';

const YEARS = ['2014', '2015', '2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025'];
export const FOLDS = [
  { train: ['2014-01-01', '2019-12-31'], validation: ['2020-01-01', '2021-12-31'] },
  { train: ['2016-01-01', '2021-12-31'], validation: ['2022-01-01', '2023-12-31'] },
  { train: ['2018-01-01', '2023-12-31'], validation: ['2024-01-01', '2025-12-31'] }
];
const PROCESSED = new URL('../../data/market-history/processed/', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-official-market-walk-forward-v2.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_OFFICIAL_MARKET_WALK_FORWARD_V2.md', import.meta.url);
export const COSTS = Object.freeze({
  buyFeePct: 0.1425,
  sellFeePct: 0.1425,
  sellTaxPct: 0.3,
  buySlippagePct: 0.1,
  sellSlippagePct: 0.1,
  minimumFee: 20,
  boardLotShares: 1
});

export const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
export const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const monthKey = date => date.slice(0, 7);

export async function loadData() {
  const histories = new Map();
  const dailyBars = new Map();
  const coverage = [];
  for (const year of YEARS) {
    const payload = JSON.parse(zlib.gunzipSync(await fs.readFile(new URL(`${year}.json.gz`, PROCESSED))));
    const dates = { TWSE: new Set(), TPEX: new Set() };
    for (const [symbol, rows] of Object.entries(payload.symbols || {})) {
      if (!histories.has(symbol)) histories.set(symbol, []);
      for (const row of rows) {
        dates[row.market]?.add(row.date);
        if (row.corporateActionSuspected) continue;
        histories.get(symbol).push(row);
        if (!dailyBars.has(row.date)) dailyBars.set(row.date, new Map());
        dailyBars.get(row.date).set(symbol, row);
      }
    }
    coverage.push({ year, twseDates: dates.TWSE.size, tpexDates: dates.TPEX.size });
  }
  for (const rows of histories.values()) rows.sort((a, b) => a.date.localeCompare(b.date));
  return { histories, dailyBars, coverage };
}

export function buildBreadth(histories) {
  const byDate = new Map();
  for (const rows of histories.values()) {
    for (let index = 20; index < rows.length; index += 1) {
      const row = rows[index];
      const ma20 = avg(rows.slice(index - 19, index + 1).map(item => item.close));
      const bucket = byDate.get(row.date) || { total: 0, positive20: 0, aboveMa20: 0 };
      bucket.total += 1;
      if (row.close > rows[index - 20].close) bucket.positive20 += 1;
      if (row.close > ma20) bucket.aboveMa20 += 1;
      byDate.set(row.date, bucket);
    }
  }
  return new Map([...byDate].map(([date, row]) => [date, {
    positive20Pct: row.positive20 / row.total * 100,
    aboveMa20Pct: row.aboveMa20 / row.total * 100
  }]));
}

export function buildMarketRisk(series, breadth) {
  const risk = new Map();
  for (let index = 60; index < series.length; index += 1) {
    const daily = series.slice(index - 19, index + 1).map((row, offset) => (
      (row.close / series[index - 20 + offset].close - 1) * 100
    ));
    const mean = avg(daily);
    const vol20Pct = Math.sqrt(avg(daily.map(value => (value - mean) ** 2))) * Math.sqrt(252);
    risk.set(series[index].date, {
      mom20Pct: (series[index].close / series[index - 20].close - 1) * 100,
      mom60Pct: (series[index].close / series[index - 60].close - 1) * 100,
      vol20Pct,
      ...(breadth.get(series[index].date) || {})
    });
  }
  return risk;
}

function buildSetups(histories) {
  const setups = [];
  for (const [symbol, rows] of histories) {
    if (rows.length < 130) continue;
    for (let index = 130; index < rows.length - 1; index += 1) {
      const row = rows[index];
      const previous = rows[index - 1];
      const next = rows[index + 1];
      const closes20 = rows.slice(index - 19, index + 1).map(item => item.close);
      const ma20 = avg(closes20);
      const ma60 = avg(rows.slice(index - 59, index + 1).map(item => item.close));
      const ma20Prev = avg(rows.slice(index - 24, index - 4).map(item => item.close));
      const high20 = Math.max(...rows.slice(index - 20, index).map(item => item.high));
      const low20 = Math.min(...rows.slice(index - 20, index).map(item => item.low));
      const value20 = avg(rows.slice(index - 19, index + 1).map(item => item.tradeValue));
      const atr20Pct = avg(rows.slice(index - 19, index + 1).map(item => (item.high - item.low) / item.close * 100));
      const mom5 = (row.close / rows[index - 5].close - 1) * 100;
      const mom20 = (row.close / rows[index - 20].close - 1) * 100;
      const mom60 = (row.close / rows[index - 60].close - 1) * 100;
      const mom120 = (row.close / rows[index - 120].close - 1) * 100;
      const volumeRatio20 = row.tradeValue / Math.max(1, value20);
      const rangeWidth20Pct = (high20 / Math.max(0.01, low20) - 1) * 100;
      const candleRange = Math.max(0.01, row.high - row.low);
      const lowerShadowPct = (Math.min(row.open, row.close) - row.low) / candleRange * 100;
      const closeLocationPct = (row.close - row.low) / candleRange * 100;
      const dayReturnPct = (row.close / previous.close - 1) * 100;
      const common = {
        symbol,
        name: row.name,
        market: row.market,
        signalDate: row.date,
        entryDate: next.date,
        entryOpen: next.open,
        tradeValue: row.tradeValue,
        volumeRatio20,
        atr20Pct,
        mom5,
        mom20,
        mom60,
        mom120,
        ma20SlopePct: (ma20 / ma20Prev - 1) * 100,
        ma20,
        distanceToMa20Pct: (row.close / ma20 - 1) * 100,
        ma20AboveMa60: ma20 > ma60,
        gapPct: (next.open / row.close - 1) * 100
      };
      if (row.close > high20 && mom20 > 5) {
        setups.push({ ...common, setup: 'breakout', score: mom20 + mom60 * 0.45 + volumeRatio20 * 4 - atr20Pct });
      }
      if (ma20 > ma60 && mom60 > 8 && row.low <= ma20 * 1.02 && row.close >= ma20 && row.close >= previous.close && mom5 < 5) {
        setups.push({ ...common, setup: 'pullback', score: mom60 * 0.7 + common.ma20SlopePct * 5 - Math.abs(common.distanceToMa20Pct) - atr20Pct });
      }
      if (ma20 > ma60 && mom60 > 10 && mom20 > 4 && mom5 > 1 && row.close > previous.high && volumeRatio20 > 1) {
        setups.push({ ...common, setup: 'acceleration', score: mom20 + mom60 * 0.35 + mom5 * 2 + volumeRatio20 * 3 - atr20Pct });
      }
      if (row.close > high20 && rangeWidth20Pct <= 25 && atr20Pct <= 6) {
        setups.push({ ...common, setup: 'squeeze_breakout', score: mom20 + mom60 * 0.3 + volumeRatio20 * 5 - rangeWidth20Pct * 0.3 });
      }
      if ([2, 5].includes(new Date(`${row.date}T00:00:00Z`).getUTCDay()) && ma20 > ma60 && mom60 > 15 && mom120 > 20 && mom5 < 8) {
        setups.push({ ...common, setup: 'leader_rotation', score: mom60 * 0.55 + mom120 * 0.3 + mom20 * 0.4 - atr20Pct * 2 - Math.max(0, common.distanceToMa20Pct - 10) });
      }
      if (mom5 <= -7 && mom20 >= -18 && lowerShadowPct >= 30 && row.close > row.open && row.close >= previous.close) {
        setups.push({ ...common, setup: 'shock_stabilization', score: Math.abs(mom5) * 2 + lowerShadowPct * 0.3 + mom60 * 0.1 - atr20Pct });
      }
      if ([2, 5].includes(new Date(`${row.date}T00:00:00Z`).getUTCDay()) && ma20 > ma60 && mom120 > 10 && mom60 > 5 && atr20Pct <= 5 && common.distanceToMa20Pct >= -1 && common.distanceToMa20Pct <= 10) {
        setups.push({ ...common, setup: 'low_vol_momentum', score: mom120 * 0.25 + mom60 * 0.6 + mom20 * 0.35 - atr20Pct * 4 - common.distanceToMa20Pct * 0.5 });
      }
      if (ma20 > ma60 && previous.close < ma20 && row.close >= ma20 && mom60 > 8 && volumeRatio20 >= 1 && common.distanceToMa20Pct <= 4) {
        setups.push({ ...common, setup: 'ma20_reclaim', score: mom60 * 0.5 + mom20 * 0.5 + volumeRatio20 * 4 + common.ma20SlopePct * 5 - atr20Pct * 2 });
      }
      if (ma20 > ma60 && rangeWidth20Pct <= 18 && mom60 > 8 && row.close > previous.high && volumeRatio20 >= 1.2) {
        setups.push({ ...common, setup: 'contraction_turn', score: mom60 * 0.4 + mom20 * 0.5 + volumeRatio20 * 5 - rangeWidth20Pct - atr20Pct * 2 });
      }
      if (dayReturnPct >= 4 && dayReturnPct <= 9.5 && closeLocationPct >= 75 && volumeRatio20 >= 1.8 && mom20 > 0 && common.distanceToMa20Pct <= 15) {
        setups.push({ ...common, setup: 'power_day_follow', score: dayReturnPct * 3 + volumeRatio20 * 5 + mom20 * 0.4 + mom60 * 0.2 - atr20Pct * 2 });
      }
      if (ma20 > ma60 && mom20 >= 8 && mom60 >= 12 && mom5 >= -6 && mom5 <= 1 && row.close >= high20 * 0.94 && row.close >= previous.close && volumeRatio20 <= 1.1) {
        setups.push({ ...common, setup: 'high_tight_pullback', score: mom60 * 0.45 + mom20 * 0.7 - Math.abs(mom5) - atr20Pct * 2 - volumeRatio20 });
      }
      if (ma20 > ma60 && mom60 >= 10 && mom5 <= -4 && mom5 >= -12 && row.close >= ma60 && row.close > row.open && lowerShadowPct >= 20 && volumeRatio20 <= 1.5) {
        setups.push({ ...common, setup: 'trend_dip_reversal', score: mom60 * 0.45 + Math.abs(mom5) * 1.5 + lowerShadowPct * 0.25 - atr20Pct * 2 - volumeRatio20 });
      }
    }
  }
  const byDate = new Map();
  for (const setup of setups) {
    if (!byDate.has(setup.signalDate)) byDate.set(setup.signalDate, []);
    byDate.get(setup.signalDate).push(setup);
  }
  for (const rows of byDate.values()) {
    const ranked = [...rows].sort((left, right) => (right.mom20 + right.mom60 * 0.5) - (left.mom20 + left.mom60 * 0.5));
    ranked.forEach((row, index) => {
      row.strengthRankPct = ranked.length === 1 ? 1 : 1 - index / (ranked.length - 1);
      row.score += row.strengthRankPct * 20;
    });
  }
  return setups;
}

function configs() {
  const families = [
    { setup: 'breakout', minValue: 30e6, minMom20: 8, minMom60: 10, maxAtr: 8, minVolumeRatio: 1.2, maxGap: 6, maxDistance: 18, minRank: 0.5 },
    { setup: 'breakout', minValue: 80e6, minMom20: 12, minMom60: 18, maxAtr: 7, minVolumeRatio: 1.4, maxGap: 5, maxDistance: 15, minRank: 0.7 },
    { setup: 'pullback', minValue: 30e6, minMom20: -5, minMom60: 12, maxAtr: 7, minVolumeRatio: 0.5, maxGap: 4, maxDistance: 4, minRank: 0.45 },
    { setup: 'acceleration', minValue: 30e6, minMom20: 5, minMom60: 12, maxAtr: 8, minVolumeRatio: 1, maxGap: 6, maxDistance: 15, minRank: 0.55 },
    { setup: 'squeeze_breakout', minValue: 30e6, minMom20: 4, minMom60: 5, maxAtr: 6, minVolumeRatio: 1.2, maxGap: 5, maxDistance: 12, minRank: 0.5 },
    { setup: 'leader_rotation', minValue: 80e6, minMom20: 3, minMom60: 15, maxAtr: 7, minVolumeRatio: 0.5, maxGap: 5, maxDistance: 16, minRank: 0.7 },
    { setup: 'shock_stabilization', minValue: 50e6, minMom20: -18, minMom60: -25, maxAtr: 10, minVolumeRatio: 0.7, maxGap: 4, maxDistance: 20, minRank: 0 },
    { setup: 'low_vol_momentum', minValue: 80e6, minMom20: 0, minMom60: 8, maxAtr: 5, minVolumeRatio: 0.5, maxGap: 4, maxDistance: 10, minRank: 0.65 },
    { setup: 'ma20_reclaim', minValue: 50e6, minMom20: -5, minMom60: 8, maxAtr: 7, minVolumeRatio: 1, maxGap: 4, maxDistance: 5, minRank: 0.5 },
    { setup: 'contraction_turn', minValue: 50e6, minMom20: 0, minMom60: 8, maxAtr: 6, minVolumeRatio: 1.2, maxGap: 5, maxDistance: 10, minRank: 0.55 },
    { setup: 'power_day_follow', minValue: 80e6, minMom20: 0, minMom60: 0, maxAtr: 8, minVolumeRatio: 1.8, maxGap: 4, maxDistance: 15, minRank: 0.55 },
    { setup: 'high_tight_pullback', minValue: 50e6, minMom20: 8, minMom60: 12, maxAtr: 7, minVolumeRatio: 0, maxGap: 4, maxDistance: 12, minRank: 0.65 },
    { setup: 'trend_dip_reversal', minValue: 50e6, minMom20: -8, minMom60: 10, maxAtr: 8, minVolumeRatio: 0, maxGap: 3, maxDistance: 8, minRank: 0.45 }
  ];
  const rows = [];
  for (const family of families) {
    const shortReversal = ['shock_stabilization', 'trend_dip_reversal'].includes(family.setup);
    for (const top of [5, 8, 10]) {
      for (const holdDays of shortReversal ? [3, 5] : [3, 5, 10]) {
        for (const stopLossPct of shortReversal ? [3, 4, 6] : [4, 6]) {
          for (const takeProfitPct of shortReversal ? [6, 8, 12] : [8, 12, 20]) {
            for (const marketMode of shortReversal ? ['broad', 'strong', 'breadth'] : ['strong', 'breadth', 'ultra']) {
              for (const stopMode of ['intraday']) {
                rows.push({
                  ...family,
                  id: `${family.setup}_top${top}_h${holdDays}_s${stopLossPct}_t${takeProfitPct}_${marketMode}_${stopMode}`,
                  top,
                  holdDays,
                  stopLossPct,
                  takeProfitPct,
                  marketMode,
                  stopMode,
                  positionPct: 10,
                  accountRiskPct: 0.5
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

function passes(setup, config) {
  return setup.setup === config.setup
    && setup.tradeValue >= config.minValue
    && setup.mom20 >= config.minMom20
    && setup.mom60 >= config.minMom60
    && setup.atr20Pct <= config.maxAtr
    && setup.volumeRatio20 >= config.minVolumeRatio
    && Math.abs(setup.distanceToMa20Pct) <= config.maxDistance
    && setup.strengthRankPct >= config.minRank
    && (setup.setup === 'shock_stabilization' || setup.ma20AboveMa60);
}

const candidateCache = new WeakMap();

function candidatesFor(setups, config) {
  let cache = candidateCache.get(setups);
  if (!cache) {
    cache = new Map();
    candidateCache.set(setups, cache);
  }
  const key = [
    config.setup, config.minValue, config.minMom20, config.minMom60,
    config.maxAtr, config.minVolumeRatio, config.maxDistance, config.minRank
  ].join('|');
  if (cache.has(key)) return cache.get(key);
  const candidates = new Map();
  for (const setup of setups) {
    if (!passes(setup, config)) continue;
    const rows = candidates.get(setup.entryDate) || [];
    rows.push(setup);
    candidates.set(setup.entryDate, rows);
  }
  cache.set(key, candidates);
  return candidates;
}

function regimeFor(risk, config) {
  if (!risk) return 'RANGE_BOUND';
  if (risk.vol20Pct > 38) return 'HIGH_VOLATILITY';
  if (config.marketMode === 'ultra' && (risk.mom20Pct < 5 || risk.mom60Pct < 8 || risk.vol20Pct > 30 || (risk.aboveMa20Pct ?? 0) < 55)) return 'BEAR_DEFENSE';
  if (config.marketMode === 'breadth' && (risk.mom20Pct < 0 || risk.mom60Pct < 0 || (risk.aboveMa20Pct ?? 0) < 60 || (risk.positive20Pct ?? 0) < 55)) return 'BEAR_DEFENSE';
  const floor = config.marketMode === 'strong' ? 3 : config.marketMode === 'trend' ? 0 : -4;
  if (risk.mom20Pct < floor || risk.mom60Pct < -8) return 'BEAR_DEFENSE';
  if (config.marketMode === 'strong' && risk.mom60Pct < 3) return 'BEAR_DEFENSE';
  if (risk.mom20Pct > 3 && risk.mom60Pct > 5) return 'BULL_TREND';
  return risk.mom60Pct > 0 ? 'BULL_PULLBACK' : 'RANGE_BOUND';
}

function exitFor(position, bar, dayIndex) {
  if (dayIndex <= position.entryDayIndex) return null;
  if (position.pendingStop) return { date: bar.date, price: bar.open, reason: '收盤跌破後隔日出場', type: 'stop_loss' };
  const entry = position.buy.fillPrice;
  const hardStop = entry * (1 - position.stopLossPct / 100);
  const target = entry * (1 + position.takeProfitPct / 100);
  const trail = position.peakPrice >= entry * 1.08 ? position.peakPrice * 0.94 : 0;
  const stop = Math.max(hardStop, trail);
  if (position.stopMode === 'intraday') {
    if (bar.open <= stop) return { date: bar.date, price: bar.open, reason: '跳空跌破停損', type: 'stop_loss' };
    if (bar.low <= stop) return { date: bar.date, price: stop, reason: trail ? '移動停利' : '盤中停損', type: 'stop_loss' };
  } else if (bar.close <= stop) {
    position.pendingStop = true;
  }
  if (bar.open >= target) return { date: bar.date, price: bar.open, reason: '跳空越過停利', type: 'take_profit' };
  if (bar.high >= target) return { date: bar.date, price: target, reason: '固定停利', type: 'take_profit' };
  if (dayIndex - position.entryDayIndex >= position.holdDays) return { date: bar.date, price: bar.close, reason: '持有期到期', type: 'time_exit' };
  return null;
}

function summarize(portfolio, start, end) {
  const byMonth = new Map();
  for (const row of portfolio.equityCurve) {
    if (row.date >= start && row.date <= end) byMonth.set(monthKey(row.date), row.equity);
  }
  let prior = 1_000_000;
  const monthly = [...byMonth].sort().map(([month, equity]) => {
    const returnPct = (equity / prior - 1) * 100;
    prior = equity;
    return { month, returnPct: round(returnPct), equity };
  });
  const closed = portfolio.closedTrades.filter(row => row.exitDate >= start && row.exitDate <= end);
  const wins = closed.filter(row => row.realizedPnl > 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.realizedPnl, 0);
  const grossLoss = Math.abs(closed.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
  return {
    trades: closed.length,
    months: monthly.length,
    averageMonthlyReturnPct: round(avg(monthly.map(row => row.returnPct))),
    annualizedReturnPct: round((monthly.reduce((value, row) => value * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, monthly.length)) - 1) * 100),
    maximumDrawdownPct: round(Math.min(0, ...portfolio.equityCurve.filter(row => row.date >= start && row.date <= end).map(row => row.drawdownPct))),
    profitFactor: round(grossLoss ? grossProfit / grossLoss : grossProfit ? 99 : 0),
    winRatePct: round(closed.length ? wins.length / closed.length * 100 : 0),
    negativeMonths: monthly.filter(row => row.returnPct < 0).length,
    endingEquity: round(prior, 0),
    monthly
  };
}

export function simulate(setups, dailyBars, dates, marketRisk, config, period, randomOrder = false) {
  const candidates = candidatesFor(setups, config);
  const portfolio = createPortfolio({
    initialCapital: 1_000_000,
    settlementDays: 2,
    maxOpenPositions: config.top,
    executionCosts: COSTS,
    riskRules: {
      maxAccountRiskPct: 0.5,
      maxSinglePositionPct: 10,
      exposureLimits: { BULL_TREND: 80, THEME_MOMENTUM: 80, BULL_PULLBACK: 60, RANGE_BOUND: 40, HIGH_VOLATILITY: 20, BEAR_DEFENSE: 0 },
      drawdownBlockPct: config.drawdownBlockPct ?? 8,
      drawdownBlockDays: 20,
      monthlyLossBlockPct: 5,
      dailyLossBlockPct: 2,
      dailyLossBlockDays: 1,
      losingStreakCount: 5,
      losingStreakBlockDays: 10
    }
  });
  const periodDates = dates.filter(date => date >= period[0] && date <= period[1]);
  for (let dayIndex = 0; dayIndex < periodDates.length; dayIndex += 1) {
    const date = periodDates[dayIndex];
    const bars = dailyBars.get(date) || new Map();
    // 開盤只能使用前一交易日收盤後已知的大盤狀態。
    const risk = marketRisk.get(periodDates[dayIndex - 1]);
    const regime = regimeFor(risk, config);
    settleCash(portfolio, dayIndex);
    beginPortfolioDay(portfolio, date, dayIndex, regime);
    for (const position of [...portfolio.positions]) {
      const bar = bars.get(position.symbol);
      if (!bar) continue;
      const exit = exitFor(position, bar, dayIndex);
      if (exit) closePosition(portfolio, position, exit, dayIndex);
      else markPosition(portfolio, position.tradeId, bar.close);
    }
    const rows = [...(candidates.get(date) || [])];
    rows.sort(randomOrder
      ? (left, right) => `${date}:${left.symbol}`.localeCompare(`${date}:${right.symbol}`) * (date.charCodeAt(9) % 2 ? 1 : -1)
      : (left, right) => right.score - left.score);
    for (const setup of rows.slice(0, config.top)) {
      if (portfolio.positions.length >= config.top) break;
      const fill = buyExecution(setup.entryOpen, 1, COSTS).fillPrice;
      openPosition(portfolio, {
        ...setup,
        tradeId: `${setup.symbol}:${date}:${setup.setup}`,
        strategy: setup.setup,
        regime,
        entryPrice: setup.entryOpen,
        stopLoss: Math.max(fill * (1 - config.stopLossPct / 100), setup.ma20 * 0.98),
        stopLossPct: config.stopLossPct,
        takeProfitPct: config.takeProfitPct,
        holdDays: config.holdDays,
        stopMode: config.stopMode,
        positionPct: config.positionPct
      }, dayIndex, { regime, positionPct: config.positionPct, accountRiskPct: config.accountRiskPct });
    }
    recordEquity(portfolio, date, { dayIndex, regime });
  }
  return summarize(portfolio, period[0], period[1]);
}

export function cashMetrics(period, dates) {
  const months = [...new Set(dates.filter(date => date >= period[0] && date <= period[1]).map(monthKey))]
    .map(month => ({ month, returnPct: 0, equity: 1_000_000 }));
  return { trades: 0, months: months.length, averageMonthlyReturnPct: 0, annualizedReturnPct: 0, maximumDrawdownPct: 0, profitFactor: 0, winRatePct: 0, negativeMonths: 0, endingEquity: 1_000_000, monthly: months };
}

function score(metrics) {
  if (metrics.trades < 120 || metrics.profitFactor < 1 || metrics.maximumDrawdownPct < -25) return -Infinity;
  const middle = Math.floor(metrics.monthly.length / 2);
  const firstHalf = avg(metrics.monthly.slice(0, middle).map(row => row.returnPct));
  const secondHalf = avg(metrics.monthly.slice(middle).map(row => row.returnPct));
  if (firstHalf < -0.1 || secondHalf < 0.1) return -Infinity;
  return metrics.averageMonthlyReturnPct * 3
    + Math.min(firstHalf, secondHalf) * 2
    + metrics.profitFactor
    + metrics.maximumDrawdownPct * 0.08
    + Math.min(metrics.trades, 500) / 500;
}

export function aggregate(rows) {
  const monthly = rows.flatMap(row => row.monthly);
  const trades = rows.reduce((sum, row) => sum + row.trades, 0);
  const weighted = key => trades ? rows.reduce((sum, row) => sum + row[key] * row.trades, 0) / trades : 0;
  return {
    folds: rows.length,
  validationStart: FOLDS[0].validation[0],
    validationEnd: FOLDS.at(-1).validation[1],
    validationMonths: monthly.length,
    trades,
    averageMonthlyReturnPct: round(avg(monthly.map(row => row.returnPct))),
    annualizedReturnPct: round((monthly.reduce((value, row) => value * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, monthly.length)) - 1) * 100),
    maximumDrawdownPct: round(Math.min(...rows.map(row => row.maximumDrawdownPct), 0)),
    profitFactor: round(weighted('profitFactor')),
    winRatePct: round(weighted('winRatePct')),
    negativeMonths: monthly.filter(row => row.returnPct < 0).length
  };
}

export async function benchmark0050(rows) {
  const monthEnds = new Map();
  for (const row of rows) {
    if (FOLDS.some(fold => row.date >= fold.validation[0] && row.date <= fold.validation[1])) monthEnds.set(monthKey(row.date), row.close);
  }
  let prior;
  const returns = [];
  for (const close of [...monthEnds].sort().map(([, value]) => value)) {
    if (prior) returns.push((close / prior - 1) * 100);
    prior = close;
  }
  return { months: returns.length, averageMonthlyReturnPct: round(avg(returns)) };
}

export async function runOfficialBaseline() {
const [{ histories, dailyBars, coverage }, etfPayload] = await Promise.all([
  loadData(),
  fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)
]);
const benchmarkSeries = etfPayload.series?.['0050.TW'] || [];
const marketRisk = buildMarketRisk(benchmarkSeries, buildBreadth(histories));
const setups = buildSetups(histories);
const dates = [...dailyBars.keys()].sort();
const allConfigs = configs();
const folds = [];
for (const fold of FOLDS) {
  let selected;
  for (const config of allConfigs) {
    const train = simulate(setups, dailyBars, dates, marketRisk, config, fold.train);
    const candidate = { config, train, score: score(train) };
    if (!selected || candidate.score > selected.score) selected = candidate;
  }
  const strategyEnabled = Number.isFinite(selected.score)
    && selected.train.averageMonthlyReturnPct > 0
    && selected.train.profitFactor >= 1.1;
  const validation = strategyEnabled
    ? simulate(setups, dailyBars, dates, marketRisk, selected.config, fold.validation)
    : cashMetrics(fold.validation, dates);
  const random = strategyEnabled
    ? simulate(setups, dailyBars, dates, marketRisk, selected.config, fold.validation, true)
    : cashMetrics(fold.validation, dates);
  folds.push({
    trainPeriod: fold.train,
    validationPeriod: fold.validation,
    strategyEnabled,
    selectedConfig: selected.config,
    trainMetrics: selected.train,
    validation,
    candidateRandom: random
  });
}
const metrics = aggregate(folds.map(row => row.validation));
const randomMetrics = aggregate(folds.map(row => row.candidateRandom));
const benchmark = await benchmark0050(benchmarkSeries);
const passed = metrics.averageMonthlyReturnPct >= 5
  && metrics.maximumDrawdownPct >= -20
  && metrics.trades >= 300
  && metrics.profitFactor > 1.15
  && metrics.averageMonthlyReturnPct > benchmark.averageMonthlyReturnPct
  && metrics.averageMonthlyReturnPct > randomMetrics.averageMonthlyReturnPct;
const output = {
  generatedAt: new Date().toISOString(),
  strategyId: 'stock_official_market_walk_forward_v2',
  universe: 'TWSE_TPEX_COMMON_STOCKS_ONLY',
  execution: { entry: '前一日收盤產生訊號，隔日開盤市價加滑價成交', costs: COSTS, settlement: 'T+2', maxSinglePositionPct: 10, maxAccountRiskPct: 0.5, gapAwareStops: true, dailyMarkToMarket: true, futureOpenFilter: false },
  coverage,
  symbols: histories.size,
  setups: setups.length,
  testedConfigurationsPerFold: allConfigs.length,
  folds,
  metrics,
  benchmark0050: benchmark,
  candidateRandom: randomMetrics,
  targetMonthlyReturnPct: 5,
  targetGapPct: round(5 - metrics.averageMonthlyReturnPct),
  passed,
  paperTradingReady: passed,
  liveTradingReady: false,
  conclusion: passed
    ? '已通過歷史 walk-forward 最低門檻，但仍只能進入紙上交易，不能直接實盤。'
    : `未達可實盤研究門檻；驗證月均 ${metrics.averageMonthlyReturnPct}%，距離 5% 尚差 ${round(5 - metrics.averageMonthlyReturnPct)} 個百分點。`
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 官方個股長期 Walk-forward v2\n\n- 個股範圍：上市／上櫃四位數普通股，ETF 與 0050 交易比重為 0%。\n- 訓練／驗證：每折 72 個月訓練、24 個月驗證，共三折；合併驗證為 2020-01-01 至 2025-12-31。\n- 成交與風控：逐日總資產估值、T+2、真實費稅、雙邊滑價、跳空較差價停損、單檔最高 10%、單筆風險最高 0.5%。\n- 進場時點：前一日收盤產生訊號，隔日開盤市價加滑價成交；不使用隔日開盤價反向篩選候選。\n- 每折測試組數：${allConfigs.length}\n- 驗證交易：${metrics.trades} 筆\n- 驗證月均總資產報酬：${metrics.averageMonthlyReturnPct}%\n- 年化報酬：${metrics.annualizedReturnPct}%\n- 最大回撤：${metrics.maximumDrawdownPct}%\n- Profit Factor：${metrics.profitFactor}\n- 勝率：${metrics.winRatePct}%\n- 0050 同期月均：${benchmark.averageMonthlyReturnPct}%\n- 同候選池隨機排序月均：${randomMetrics.averageMonthlyReturnPct}%\n- 是否達月均 5% 且通過完整門檻：${passed ? '是' : '否'}\n\n## 結論\n\n${output.conclusion}\n`, 'utf8');
console.log(JSON.stringify({ output: OUTPUT.pathname, report: REPORT.pathname, metrics, benchmark, randomMetrics, selected: folds.map(row => row.selectedConfig.id), passed }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runOfficialBaseline();
}
