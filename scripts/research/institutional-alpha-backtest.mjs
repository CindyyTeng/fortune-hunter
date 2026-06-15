import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  simulateEntry,
  simulateExit,
  trailingStopPrice
} from '../lib/execution-simulator.mjs';
import {
  beginPortfolioDay,
  closePosition,
  createPortfolio,
  markPosition,
  openPosition,
  portfolioEquity,
  recordEquity,
  settleCash
} from '../lib/portfolio-simulator.mjs';
import {
  generateStrategySignals,
  loadStrategySpecs
} from '../lib/strategy-signal-engine.mjs';
import {
  buildTradingDecisions,
  summarizeDecisions
} from '../lib/trading-decision-engine.mjs';
import { generateOrderIntents } from '../lib/order-intent-generator.mjs';
import { createMockBroker } from '../lib/broker-adapter.mock.mjs';
import {
  foldWindows,
  iterateObservations,
  loadResearchContext,
  summarizePerformance
} from './research-core.mjs';

const DATA = new URL('../../data/institutional/institutional-trades.json', import.meta.url);
const VALIDATION = new URL('../../data/institutional/validation-report.json', import.meta.url);
const OUTPUT = new URL('../../data/research/institutional-alpha-backtest.json', import.meta.url);
const DOCUMENT = new URL('../../docs/INSTITUTIONAL_ALPHA_BACKTEST.md', import.meta.url);
const STRATEGY_ID = 'trust_accumulation_pullback';
const MINIMUM_DATA = Object.freeze({
  pointInTimeRecords: 50_000,
  distinctDates: 1_000,
  distinctSymbols: 100,
  validationTrades: 300
});

const round = (value, digits = 4) => Number.isFinite(value)
  ? Number(value.toFixed(digits))
  : null;
const mean = values => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : null;
const EXECUTION_DATA_GAPS = Object.freeze([
  '注意股／處置股歷史資料',
  '除權息、減資與分割 point-in-time 資料',
  '歷史下市股票池'
]);

function deterministicScore(text) {
  const hash = createHash('sha256').update(String(text)).digest();
  return hash.readUInt32BE(0) / 0xffffffff;
}

async function readJson(url, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(url, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function dataAssessment(payload, validation) {
  const records = (payload?.records || []).filter(row =>
    row.isPointInTimeSafe === true
    && !Number.isNaN(Date.parse(row.publishedAt))
    && /^\d{4}-\d{2}-\d{2}$/.test(row.effectiveDate)
    && row.effectiveDate > row.date
    && Date.parse(row.publishedAt) < Date.parse(`${row.effectiveDate}T09:00:00+08:00`)
  );
  const dates = new Set(records.map(row => row.date));
  const symbols = new Set(records.map(row => row.symbol));
  const missing = [];
  if (!payload) missing.push('真實法人買賣超檔案');
  if (!validation) missing.push('法人資料驗證報告');
  if (records.length < MINIMUM_DATA.pointInTimeRecords) {
    missing.push(`point-in-time 安全紀錄至少 ${MINIMUM_DATA.pointInTimeRecords} 筆`);
  }
  if (dates.size < MINIMUM_DATA.distinctDates) {
    missing.push(`至少 ${MINIMUM_DATA.distinctDates} 個交易日`);
  }
  if (symbols.size < MINIMUM_DATA.distinctSymbols) {
    missing.push(`至少 ${MINIMUM_DATA.distinctSymbols} 檔股票`);
  }
  if (validation && validation.errors?.length) missing.push('修正所有法人資料驗證錯誤');
  return {
    records: records.length,
    distinctDates: dates.size,
    distinctSymbols: symbols.size,
    dateRange: dates.size ? {
      start: [...dates].sort().at(0),
      end: [...dates].sort().at(-1)
    } : null,
    readyForWalkForward: missing.length === 0,
    missing
  };
}

function consecutive(rows, index, selector) {
  let count = 0;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (!selector(rows[cursor])) break;
    count += 1;
  }
  return count;
}

function institutionalFeatures(records) {
  const bySymbol = new Map();
  for (const row of records) {
    const rows = bySymbol.get(row.symbol) || [];
    rows.push(row);
    bySymbol.set(row.symbol, rows);
  }
  const features = [];
  for (const rows of bySymbol.values()) {
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.publishedAt.localeCompare(b.publishedAt));
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const prior20 = rows.slice(Math.max(0, index - 19), index + 1);
      const averageForeignAbs = mean(prior20.map(item => Math.abs(item.foreignNetBuy))) || 1;
      const feature = {
        ...row,
        trustNetBuyDays: consecutive(rows, index, item => item.trustNetBuy > 0),
        foreignNetBuyDays: consecutive(rows, index, item => item.foreignNetBuy > 0),
        foreignLargeSellStreak: consecutive(
          rows,
          index,
          item => item.foreignNetBuy < -averageForeignAbs * 1.5
        )
      };
      for (const days of [3, 5, 10]) {
        feature[`trustNetBuySum${days}`] = rows
          .slice(Math.max(0, index - days + 1), index + 1)
          .reduce((sum, item) => sum + item.trustNetBuy, 0);
      }
      features.push(feature);
    }
  }
  for (const days of [3, 5, 10]) {
    const rowsByDate = Map.groupBy
      ? Map.groupBy(features, row => row.date)
      : features.reduce((map, row) => {
        const rows = map.get(row.date) || [];
        rows.push(row);
        map.set(row.date, rows);
        return map;
      }, new Map());
    for (const rows of rowsByDate.values()) {
      const sorted = rows.map(row => row[`trustNetBuySum${days}`]).sort((a, b) => a - b);
      for (const row of rows) {
        const rank = sorted.findLastIndex(value => value <= row[`trustNetBuySum${days}`]) + 1;
        row[`trustPercentile${days}`] = rank / Math.max(1, sorted.length);
      }
    }
  }
  return new Map(features.map(row => [`${row.date}|${row.symbol}`, row]));
}

function enrichedObservation(observation, institutional) {
  if (!institutional || institutional.effectiveDate !== observation.nextDate) return null;
  const recent = observation.history.slice(Math.max(0, observation.historyIndex - 20), observation.historyIndex + 1);
  const priorHighSupport = Math.max(...recent.slice(0, -5).map(row => row.high));
  const dayRange = Math.max(observation.day.high - observation.day.low, observation.day.close * 0.001);
  const ma60Prior = observation.history
    .slice(observation.historyIndex - 64, observation.historyIndex - 4)
    .reduce((sum, row) => sum + row.close, 0) / 60;
  const pullbackLow = Math.min(...recent.slice(-5).map(row => row.low));
  return {
    observation,
    institutional,
    signalDate: observation.date,
    entryDate: observation.nextDate,
    symbol: observation.symbol,
    name: observation.name,
    regime: observation.factors.regime,
    close: observation.close,
    ma20: observation.ma20,
    ma60: observation.ma60,
    ma60Slope: observation.ma60 / ma60Prior - 1,
    priorHighSupport,
    pullbackLow,
    closeAboveMa60: observation.close > observation.ma60,
    pullbackHeldMa20: observation.day.low <= observation.ma20 * 1.02
      && observation.close >= observation.ma20,
    pullbackHeldPriorHigh: observation.day.low <= priorHighSupport * 1.01
      && observation.close >= priorHighSupport,
    closeUp: observation.day.close > observation.day.open,
    closeAbovePriorHigh: observation.day.close > observation.prior.high,
    longUpperWick: (observation.day.high - Math.max(observation.day.open, observation.day.close))
      / dayRange >= 0.4
  };
}

function parameterGrid() {
  const rows = [];
  for (const trustDays of [3, 5, 10]) {
    for (const trustPercentile of [0.5, 0.7, 0.9]) {
      for (const foreignMode of ['同步買超', '不連續大賣']) {
        for (const supportMode of ['MA20', '前高支撐']) {
          for (const stopMode of ['回測低點', 'MA20', 'ATR_1_5']) {
            for (const exitMode of ['1_5R', '2R', '移動停利']) {
              rows.push({
                id: [
                  trustDays,
                  trustPercentile,
                  foreignMode,
                  supportMode,
                  stopMode,
                  exitMode
                ].join('|'),
                trustDays,
                trustPercentile,
                foreignMode,
                supportMode,
                stopMode,
                exitMode
              });
            }
          }
        }
      }
    }
  }
  return rows;
}

function passes(row, variant) {
  const institutional = row.institutional;
  const trustSetup = institutional.trustNetBuyDays >= variant.trustDays
    || (institutional[`trustNetBuySum${variant.trustDays}`] > 0
      && institutional[`trustPercentile${variant.trustDays}`] >= variant.trustPercentile);
  const foreignSetup = variant.foreignMode === '同步買超'
    ? institutional.foreignNetBuy > 0
    : institutional.foreignLargeSellStreak <= 1;
  const trend = row.closeAboveMa60
    && (row.observation.factors.ma20Slope > 0 || row.ma60Slope > 0)
    && row.observation.factors.relativeMarket20 >= 2
    && row.observation.factors.transactionValue >= 30_000_000;
  const support = variant.supportMode === 'MA20'
    ? row.pullbackHeldMa20
    : row.pullbackHeldPriorHigh;
  const trigger = row.closeUp || row.closeAbovePriorHigh;
  const blocked = row.observation.factors.gapPct > 4
    || row.observation.factors.distanceMa20 > 8
    || row.observation.factors.atrPct > 6
    || row.longUpperWick
    || ['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.regime);
  return trustSetup && foreignSetup && trend && support && trigger && !blocked;
}

function signalMap(rows, variant, random = false) {
  const normal = new Map();
  for (const row of rows) {
    if (!passes(row, variant)) continue;
    const candidates = normal.get(row.entryDate) || [];
    candidates.push({
      ...row,
      score: row.institutional[`trustPercentile${variant.trustDays}`]
        + row.observation.factors.relativeMarket20 / 100
    });
    normal.set(row.entryDate, candidates);
  }
  for (const [date, candidates] of normal) {
    normal.set(date, candidates.sort((a, b) => b.score - a.score).slice(0, 6));
  }
  if (!random) return normal;

  const randomMap = new Map();
  for (const [date, strategyRows] of normal) {
    const pool = rows.filter(row =>
      row.entryDate === date
      && row.observation.factors.transactionValue >= 30_000_000
      && row.observation.factors.gapPct <= 4
      && row.observation.factors.atrPct <= 6
      && !row.longUpperWick
      && !['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.regime)
    );
    randomMap.set(date, pool
      .map(row => ({
        ...row,
        score: deterministicScore(`${row.entryDate}|${row.symbol}|公平隨機`)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, strategyRows.length));
  }
  return randomMap;
}

function plannedStop(row, variant, entryPrice) {
  if (variant.stopMode === '回測低點') return Math.min(row.pullbackLow, entryPrice * 0.99);
  if (variant.stopMode === 'MA20') return Math.min(row.ma20 * 0.99, entryPrice * 0.99);
  return entryPrice * (1 - row.observation.factors.atrPct * 1.5 / 100);
}

function barsWithMa20(row) {
  return row.observation.futureBars.map((bar, offset) => {
    const end = row.observation.historyIndex + offset + 2;
    const closes = row.observation.history.slice(Math.max(0, end - 20), end).map(day => day.close);
    const source = row.observation.history[end - 1];
    return {
      ...bar,
      open: source.open,
      high: source.high,
      low: source.low,
      close: source.close,
      volume: source.volume,
      price: source.close,
      ma20: closes.reduce((sum, value) => sum + value, 0) / closes.length
    };
  });
}

function simulateVariant(context, rows, variant, startDate, endDate, random = false) {
  const dates = context.marketHistory
    .map(row => row.date)
    .filter(date => date >= startDate && date <= endDate);
  const entries = signalMap(rows.filter(row =>
    row.signalDate >= startDate && row.entryDate <= endDate
  ), variant, random);
  const portfolio = createPortfolio({
    initialCapital: 1_000_000,
    settlementDays: 2,
    maxOpenPositions: 6,
    riskControls: true
  });
  for (let dayIndex = 0; dayIndex < dates.length; dayIndex += 1) {
    const date = dates[dayIndex];
    const regime = context.marketByDate.get(date)?.regime || 'RANGE_BOUND';
    settleCash(portfolio, dayIndex);
    beginPortfolioDay(portfolio, date, dayIndex, regime);
    for (const position of [...portfolio.positions]) {
      const bar = position.bars.find(item => item.date === date);
      if (!bar) continue;
      markPosition(portfolio, position.tradeId, bar.price);
      const trail = variant.exitMode === '移動停利'
        ? trailingStopPrice(position.entryPrice, position.peakPrice, {
          triggerPct: position.initialRiskPct * 1.5,
          givebackPct: position.initialRiskPct * 0.75,
          lockPct: position.initialRiskPct * 0.5
        })
        : null;
      const exit = simulateExit({
        day: bar,
        stopLoss: position.stopLoss,
        takeProfit: position.takeProfit,
        trailingStop: trail,
        peakPrice: position.peakPrice
      });
      if (exit?.price) {
        closePosition(portfolio, position, { ...exit, date }, dayIndex);
      } else if (bar.close < bar.ma20) {
        closePosition(portfolio, position, {
          date,
          price: bar.close,
          reason: '收盤跌破 MA20',
          type: 'ma20_break'
        }, dayIndex);
      } else if (bar.high >= position.resistance * 0.98
        && bar.close < bar.open
        && bar.volume < position.averageVolume20) {
        closePosition(portfolio, position, {
          date,
          price: bar.close,
          reason: '靠近前高壓力且量縮攻不上去',
          type: 'resistance_rejection'
        }, dayIndex);
      } else if (['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(regime)) {
        closePosition(portfolio, position, {
          date,
          price: bar.close,
          reason: '大盤轉弱提前出場',
          type: 'market_weak'
        }, dayIndex);
      } else if (dayIndex - position.entryDayIndex + 1 >= 15) {
        closePosition(portfolio, position, {
          date,
          price: bar.close,
          reason: '達到最長持有十五日',
          type: 'maximum_holding_days'
        }, dayIndex);
      }
    }
    for (const candidate of entries.get(date) || []) {
      const nextDay = candidate.observation.futureBars[0];
      const fill = simulateEntry({
        mode: 'next_open_limit',
        nextDay,
        limitPrice: candidate.close * 1.03,
        limitFloor: candidate.close * 0.94
      });
      if (!fill || fill.price / candidate.close - 1 > 0.04) continue;
      const stopLoss = plannedStop(candidate, variant, fill.price);
      if (!Number.isFinite(stopLoss) || stopLoss >= fill.price) continue;
      const risk = fill.price - stopLoss;
      const rewardR = variant.exitMode === '1_5R' ? 1.5 : 2;
      const takeProfit = variant.exitMode === '移動停利'
        ? fill.price + risk * 2
        : fill.price + risk * rewardR;
      const equity = portfolioEquity(portfolio);
      const [orderIntent] = generateOrderIntents({
        decisions: [{
          date,
          symbol: candidate.symbol,
          action: 'BUY',
          strategyId: STRATEGY_ID,
          setup: ['投信連買或累計買超為正', `外資${variant.foreignMode}`],
          trigger: [`回測${variant.supportMode}不破後轉強`],
          invalidation: [`跌破${variant.stopMode}`, '大盤轉弱'],
          entryPlan: {
            referencePrice: fill.price,
            maximumAcceptablePrice: candidate.close * 1.03,
            orderType: 'LIMIT',
            timeInForce: 'ROD',
            session: 'REGULAR'
          },
          riskPlan: {
            stopPrice: stopLoss,
            targetPrice: takeProfit,
            riskRewardRatio: (takeProfit - fill.price) / risk,
            riskBudget: equity * 0.005,
            positionBudget: equity * 0.09
          },
          reason: '法人籌碼與價格回檔條件同時成立',
          warnings: ['注意／處置股與公司行動資料尚未完備，不可直接實盤']
        }],
        account: {
          equity,
          availableCash: portfolio.availableCash
        }
      });
      if (!orderIntent || orderIntent.status === 'BLOCKED') continue;
      const position = openPosition(portfolio, {
        tradeId: `${candidate.symbol}-${candidate.signalDate}-${variant.id}`,
        symbol: candidate.symbol,
        name: candidate.name,
        signalDate: candidate.signalDate,
        entryDate: date,
        entryPrice: fill.price,
        stopLoss,
        takeProfit,
        positionPct: 9,
        strategy: `投信連買強勢股回檔｜${variant.id}`,
        regime,
        bars: barsWithMa20(candidate),
        initialRiskPct: risk / fill.price * 100,
        setup: `投信連買／累計買超，外資${variant.foreignMode}，價格位於 MA60 上方`,
        trigger: `回測${variant.supportMode}不破後轉強`,
        invalidation: `跌破${variant.stopMode}或大盤轉弱`,
        reason: '法人籌碼與價格回檔條件同時成立',
        orderIntent,
        resistance: candidate.observation.priorHigh20,
        averageVolume20: candidate.observation.averageVolume20
      }, dayIndex, {
        positionPct: 9,
        accountRiskPct: 0.5,
        regime
      });
      if (position?.orderIntent) {
        position.orderIntent.quantity = position.quantity;
        position.orderIntent.brokerPayload.quantity = position.quantity;
      }
    }
    recordEquity(portfolio, date, { dayIndex, regime });
  }
  const finalDate = dates.at(-1);
  if (finalDate && portfolio.positions.length) {
    beginPortfolioDay(portfolio, finalDate, dates.length - 1, context.marketByDate.get(finalDate)?.regime);
    for (const position of [...portfolio.positions]) {
      closePosition(portfolio, position, {
        date: finalDate,
        price: position.markPrice,
        reason: '驗證區間結束',
        type: 'end_of_validation'
      }, dates.length - 1);
    }
    portfolio.equityCurve.pop();
    recordEquity(portfolio, finalDate, {
      dayIndex: dates.length - 1,
      regime: context.marketByDate.get(finalDate)?.regime
    });
  }
  const summary = summarizePerformance(portfolio, startDate, endDate);
  const realizedPnl = portfolio.closedTrades.reduce((sum, trade) => sum + trade.realizedPnl, 0);
  summary.realizedPnl = round(realizedPnl, 0);
  summary.realizedReturnPct = round(realizedPnl / portfolio.initialCapital * 100);
  return {
    summary,
    trades: portfolio.closedTrades,
    equityCurve: portfolio.equityCurve,
    riskEvents: portfolio.riskEvents
  };
}

function marketMonthlyReturn(context, startDate, endDate) {
  const monthEnds = new Map();
  for (const row of context.marketHistory) {
    if (row.date >= startDate && row.date <= endDate) monthEnds.set(row.date.slice(0, 7), row.close);
  }
  const values = [...monthEnds.values()];
  return mean(values.slice(1).map((value, index) => (value / values[index] - 1) * 100)) || 0;
}

function variantScore(summary) {
  return summary.averageMonthlyEquityReturnPct * 3
    + ((summary.profitFactor ?? 0) - 1) * 2
    - Math.abs(summary.maximumDrawdownPct) * 0.1
    - (summary.trades < 100 ? 5 : 0);
}

async function runWalkForward(records) {
  const context = await loadResearchContext();
  const features = institutionalFeatures(records);
  const rows = [];
  iterateObservations(context, observation => {
    const row = enrichedObservation(
      observation,
      features.get(`${observation.date}|${observation.symbol}`)
    );
    if (row) rows.push(row);
  });
  const startDate = rows.map(row => row.signalDate).sort().at(0);
  const endDate = rows.map(row => row.signalDate).sort().at(-1);
  if (!startDate || !endDate) {
    return {
      parameterGridCount: parameterGrid().length,
      folds: [],
      combined: null,
      blockedReason: '法人資料與現有 OHLCV 股票池沒有可對齊的交易日與股票'
    };
  }
  const windows = foldWindows(startDate, endDate, 36, 12);
  const grid = parameterGrid();
  const folds = [];
  for (const window of windows) {
    let selected = null;
    for (const variant of grid) {
      const train = simulateVariant(
        context,
        rows,
        variant,
        window.trainStart,
        window.trainEnd
      );
      const score = variantScore(train.summary);
      if (!selected || score > selected.score) selected = { variant, train, score };
    }
    const validation = simulateVariant(
      context,
      rows,
      selected.variant,
      window.validationStart,
      window.validationEnd
    );
    const randomValidation = simulateVariant(
      context,
      rows,
      selected.variant,
      window.validationStart,
      window.validationEnd,
      true
    );
    folds.push({
      ...window,
      selectedVariant: selected.variant,
      train: selected.train.summary,
      validation: validation.summary,
      randomValidation: randomValidation.summary,
      marketAverageMonthlyReturnPct: round(
        marketMonthlyReturn(context, window.validationStart, window.validationEnd)
      ),
      validationTrades: validation.trades
    });
  }
  const monthly = folds.flatMap(fold => fold.validation.monthly);
  const trades = folds.flatMap(fold => fold.validationTrades);
  const gains = trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(trades.filter(row => row.realizedPnl <= 0)
    .reduce((sum, row) => sum + row.realizedPnl, 0));
  const combined = {
    validationTrades: trades.length,
    validationAverageMonthlyEquityReturnPct: round(mean(monthly.map(row => row.equityReturnPct)) || 0),
    marketAverageMonthlyReturnPct: round(mean(folds.map(row => row.marketAverageMonthlyReturnPct)) || 0),
    randomAverageMonthlyEquityReturnPct: round(mean(
      folds.map(row => row.randomValidation.averageMonthlyEquityReturnPct)
    ) || 0),
    validationProfitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    validationMaximumDrawdownPct: round(Math.min(
      0,
      ...folds.map(row => row.validation.maximumDrawdownPct)
    )),
    validationWinRatePct: round(trades.filter(row => row.realizedPnl > 0).length
      / Math.max(1, trades.length) * 100),
    validationAverageAnnualizedReturnPct: round(mean(
      folds.map(row => row.validation.annualizedReturnPct)
    ) || 0),
    validationAverageRealizedReturnPct: round(mean(
      folds.map(row => row.validation.realizedReturnPct)
    ) || 0),
    maximumSymbolConcentrationPct: round(Math.max(
      0,
      ...Object.values(trades.reduce((groups, trade) => {
        groups[trade.symbol] = (groups[trade.symbol] || 0) + 1;
        return groups;
      }, {}))
    ) / Math.max(1, trades.length) * 100)
  };
  combined.minimumCandidatePassed = combined.validationAverageMonthlyEquityReturnPct
    > combined.marketAverageMonthlyReturnPct
    && combined.validationProfitFactor > 1.15
    && Math.abs(combined.validationMaximumDrawdownPct) < 20
    && combined.validationTrades > MINIMUM_DATA.validationTrades
    && combined.validationAverageMonthlyEquityReturnPct
      > combined.randomAverageMonthlyEquityReturnPct
    && combined.maximumSymbolConcentrationPct < 10;
  combined.highProfitCandidatePassed = combined.minimumCandidatePassed
    && combined.validationAverageMonthlyEquityReturnPct > 2
    && combined.validationProfitFactor > 1.3
    && (combined.validationAverageAnnualizedReturnPct > 30
      || combined.validationAverageMonthlyEquityReturnPct
        > combined.marketAverageMonthlyReturnPct * 1.25);
  return { parameterGridCount: grid.length, folds, combined };
}

async function mockIntegration() {
  const specs = await loadStrategySpecs();
  const strategy = specs.strategies.find(row => row.strategyId === STRATEGY_ID);
  const technical = {
    relativeMarket20: 5,
    closeAboveMa60: true,
    ma20Slope: 1,
    ma60Slope: 0.5,
    transactionValue: 100_000_000,
    pullbackHeldMa20: true,
    pullbackHeldPriorHigh: false,
    closeUp: true,
    closeAbovePriorHigh: true,
    distanceMa20: 2,
    closeBelowPullbackLow: false,
    closeBelowMa20: false,
    gapPct: 0,
    atrPct: 3,
    longUpperWick: false,
    triggerPrice: 100,
    support: 94,
    ma20: 96,
    ma60: 90,
    atr: 3
  };
  const base = {
    quote: { close: 99 },
    technical,
    institutional: {
      trustNetBuyDays: 5,
      trustNetBuySumN: 2_000_000,
      trustNetBuyValue20Rank: 0.9,
      foreignLargeSellStreak: 0,
      trustStoppedAndPriceWeak: false
    },
    market: { regime: 'BULL_PULLBACK', riskOff: false },
    risk: {
      isAttention: false,
      isDisposition: false,
      attentionDispositionDataMissing: false,
      corporateActionDataMissing: false
    }
  };
  const stocks = [
    { ...base, symbol: 'MOCK-BUY', name: '模擬買進' },
    {
      ...base,
      symbol: 'MOCK-SELL',
      name: '模擬賣出',
      technical: { ...technical, closeBelowPullbackLow: true }
    },
    {
      ...base,
      symbol: 'MOCK-HOLD',
      name: '模擬續抱',
      technical: { ...technical, closeUp: false, closeAbovePriorHigh: false }
    },
    {
      ...base,
      symbol: 'MOCK-SKIP',
      name: '模擬略過',
      institutional: { ...base.institutional, trustNetBuyDays: 0, trustNetBuySumN: -1 }
    }
  ];
  const signals = generateStrategySignals({
    date: '2026-06-15',
    stocks,
    strategySpecs: { strategies: [strategy] },
    availableData: strategy.requiredData,
    approvedStrategyIds: [STRATEGY_ID],
    simulationOnly: true
  });
  const positions = [
    { symbol: 'MOCK-SELL', strategyId: STRATEGY_ID, quantity: 1000, stopPrice: 94 },
    { symbol: 'MOCK-HOLD', strategyId: STRATEGY_ID, quantity: 500, stopPrice: 94 }
  ];
  const account = { equity: 1_000_000, availableCash: 800_000 };
  const decisions = buildTradingDecisions({ signals, account, positions });
  const summary = summarizeDecisions(decisions);
  for (const action of ['BUY', 'SELL', 'HOLD', 'SKIP']) {
    assert.equal(summary[action], 1, `缺少 ${action} 模擬決策`);
  }
  const intents = generateOrderIntents({ decisions, account, positions });
  const broker = createMockBroker({ failureRate: 0, partialFillRate: 0 });
  const results = intents.map(intent => broker.submitOrderIntent(
    intent,
    { price: intent.side === 'BUY' ? 100 : 95, askAvailable: true, bidAvailable: true },
    account
  ));
  return {
    mode: 'MOCK_ONLY',
    decisions: summary,
    orderIntents: intents.length,
    realOrdersSubmitted: 0,
    brokerStatuses: [...new Set(results.map(row => row.status))]
  };
}

function markdown(report) {
  const walkForward = report.walkForward?.combined;
  const metric = (value, suffix = '') => value == null ? '無資料' : `${value}${suffix}`;
  return `# 投信連買強勢股回檔策略回測

產生時間：${report.generatedAt}

## 結論

**${report.conclusion}**

目前法人資料紀錄 ${report.dataAssessment.records} 筆、交易日 ${report.dataAssessment.distinctDates} 日、股票 ${report.dataAssessment.distinctSymbols} 檔。${report.dataAssessment.readyForWalkForward
    ? '資料已達到執行 walk-forward 的最低覆蓋要求。'
    : '資料未達到真實 walk-forward 的最低覆蓋要求，因此沒有產生假績效。'}

## 資料缺口

${report.dataAssessment.missing.length
    ? report.dataAssessment.missing.map(item => `- ${item}`).join('\n')
    : '- 無'}

## Point-in-time 規則

1. 法人資料交易日為 \`date\`，只能在 \`publishedAt\` 後得知。
2. 實際交易日使用 \`effectiveDate\`，且必須晚於 \`date\`。
3. 回測只使用 \`isPointInTimeSafe: true\` 的版本。
4. 同一交易日與股票若有修訂版本，不用後來版本覆蓋當時決策。
5. 下一交易日若跳空超過限價，視為未成交。

## Walk-forward

- 訓練：36 個月
- 驗證：12 個月
- 每次前進：12 個月
- 參數組合：${report.parameterGridCount}
- 完成區段：${report.walkForward?.folds?.length || 0}
- Validation 交易數：${metric(walkForward?.validationTrades)}
- Validation 月均總資產報酬：${metric(walkForward?.validationAverageMonthlyEquityReturnPct, '%')}
- Validation 平均年化報酬：${metric(walkForward?.validationAverageAnnualizedReturnPct, '%')}
- Validation 平均已實現報酬：${metric(walkForward?.validationAverageRealizedReturnPct, '%')}
- 同期大盤月均報酬：${metric(walkForward?.marketAverageMonthlyReturnPct, '%')}
- 公平隨機策略月均報酬：${metric(walkForward?.randomAverageMonthlyEquityReturnPct, '%')}
- Profit Factor：${metric(walkForward?.validationProfitFactor)}
- 最大回撤：${metric(walkForward?.validationMaximumDrawdownPct, '%')}
- 通過 Validation 標準的策略：${report.qualification.researchMinimumCandidatePassed ? '有' : '0'}

## 可執行接線

- BUY／SELL／HOLD／SKIP：${JSON.stringify(report.mockIntegration.decisions)}
- Order intent：${report.mockIntegration.orderIntents} 筆
- 真實下單：${report.mockIntegration.realOrdersSubmitted} 筆
- Mock broker 狀態：${report.mockIntegration.brokerStatuses.join('、')}

## 尚未解決的實盤風險

1. 注意股與處置股歷史資料尚未匯入。
2. 除權息、減資與分割 point-in-time 資料尚未匯入。
3. 歷史下市股票池仍不完整，存在倖存者偏差。
4. 官方法人端點的歷史深度、實際公布時間與自動化使用條款仍待確認。
`;
}

const [payload, validation] = await Promise.all([
  readJson(DATA),
  readJson(VALIDATION)
]);
const assessment = dataAssessment(payload, validation);
const mock = await mockIntegration();
let walkForward = null;
if (assessment.readyForWalkForward) {
  walkForward = await runWalkForward(payload.records.filter(row =>
    row.isPointInTimeSafe === true
    && row.effectiveDate > row.date
    && Date.parse(row.publishedAt) < Date.parse(`${row.effectiveDate}T09:00:00+08:00`)
  ));
}
const report = {
  branch: 'institutional-alpha-pipeline-v1',
  generatedAt: new Date().toISOString(),
  strategyId: STRATEGY_ID,
  strategyName: '投信連買強勢股回檔策略',
  sourceStatus: payload?.sourceStatus || '待確認',
  survivorshipBiasWarning: true,
  parameterGridCount: parameterGrid().length,
  walkForwardConfiguration: {
    trainMonths: 36,
    validationMonths: 12,
    stepMonths: 12,
    trainOnlyParameterSelection: true
  },
  dataAssessment: assessment,
  executionDataGaps: EXECUTION_DATA_GAPS,
  mockIntegration: mock,
  walkForward,
  qualification: walkForward ? {
    researchMinimumCandidatePassed: walkForward.combined?.minimumCandidatePassed === true,
    researchHighProfitCandidatePassed: walkForward.combined?.highProfitCandidatePassed === true,
    executableCandidatePassed: false,
    blockedByExecutionDataGaps: EXECUTION_DATA_GAPS
  } : {
    researchMinimumCandidatePassed: false,
    researchHighProfitCandidatePassed: false,
    executableCandidatePassed: false,
    blockedByExecutionDataGaps: EXECUTION_DATA_GAPS
  },
  conclusion: walkForward
    ? walkForward.combined?.highProfitCandidatePassed
      ? '研究績效通過高報酬門檻，但執行資料仍有缺口，不可進入實盤'
      : walkForward.combined?.minimumCandidatePassed
        ? '研究績效通過最低門檻，但執行資料仍有缺口，不可進入實盤'
        : '沒有任何 validation 策略通過標準'
    : '因資料缺口尚無法完成真實驗證'
};
await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await fs.writeFile(DOCUMENT, markdown(report), 'utf8');

console.log(`法人安全紀錄：${assessment.records} 筆；交易日：${assessment.distinctDates}；股票：${assessment.distinctSymbols}。`);
console.log(`參數組合：${report.parameterGridCount}；mock 決策：${JSON.stringify(mock.decisions)}。`);
console.log(report.conclusion);
