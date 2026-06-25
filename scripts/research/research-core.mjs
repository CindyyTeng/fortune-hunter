import fs from 'node:fs/promises';
import { buildMarketRegimes } from '../lib/market-regime.mjs';
import { loadOhlcvDataset } from '../lib/ohlcv-dataset.mjs';
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
  portfolioExposure,
  recordEquity,
  settleCash
} from '../lib/portfolio-simulator.mjs';

const BACKTEST_INPUT = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const MARKET_INPUT = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const HORIZONS = Object.freeze([1, 3, 5, 10, 20]);

const round = (value, digits = 4) => Number.isFinite(value)
  ? Number(value.toFixed(digits))
  : null;
const mean = values => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : null;
const pct = (value, base) => Number.isFinite(value) && Number.isFinite(base) && base
  ? (value / base - 1) * 100
  : null;

function prefix(values) {
  const rows = new Float64Array(values.length + 1);
  for (let index = 0; index < values.length; index += 1) {
    rows[index + 1] = rows[index] + (Number(values[index]) || 0);
  }
  return rows;
}

function windowMean(prefixValues, endIndex, size) {
  if (endIndex + 1 < size) return null;
  return (prefixValues[endIndex + 1] - prefixValues[endIndex + 1 - size]) / size;
}

function standardDeviation(values) {
  if (!values.length) return null;
  const average = mean(values);
  return Math.sqrt(mean(values.map(value => (value - average) ** 2)));
}

function percentile(sortedValues, value) {
  if (!sortedValues?.length || !Number.isFinite(value)) return null;
  let low = 0;
  let high = sortedValues.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sortedValues[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return low / sortedValues.length;
}

function correlation(left, right) {
  if (left.length !== right.length || left.length < 3) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDiff = left[index] - leftMean;
    const rightDiff = right[index] - rightMean;
    numerator += leftDiff * rightDiff;
    leftSquare += leftDiff ** 2;
    rightSquare += rightDiff ** 2;
  }
  return leftSquare && rightSquare ? numerator / Math.sqrt(leftSquare * rightSquare) : 0;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function transactionCostAdjustedReturn(entryPrice, exitPrice) {
  const buyCostPct = 0.1425 + 0.15;
  const sellCostPct = 0.1425 + 0.3 + 0.15;
  return pct(exitPrice, entryPrice) - buyCostPct - sellCostPct;
}

function thresholds(values, groups = 5) {
  if (!values.length) return [];
  const sorted = [...values].sort((a, b) => a - b);
  return Array.from({ length: groups - 1 }, (_, index) => (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * (index + 1) / groups))]
  ));
}

function quantileGroup(value, cuts) {
  if (!Number.isFinite(value)) return null;
  let group = 1;
  while (group <= cuts.length && value > cuts[group - 1]) group += 1;
  return `Q${group}`;
}

function deterministicScore(text) {
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function addTopCandidate(map, date, candidate, limit = 8) {
  const rows = map.get(date) || [];
  if (rows.length < limit) {
    rows.push(candidate);
  } else {
    let worstIndex = 0;
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index].score < rows[worstIndex].score) worstIndex = index;
    }
    if (candidate.score <= rows[worstIndex].score) return;
    rows[worstIndex] = candidate;
  }
  map.set(date, rows);
}

function primaryTheme(stock) {
  return (stock.themes || []).find(Boolean) || '未分類';
}

function rollingData(history) {
  const closes = history.map(day => day.close);
  const volumes = history.map(day => day.volume);
  const tradeValues = history.map(day => day.close * day.volume);
  const returns = history.map((day, index) => index
    ? day.close / history[index - 1].close - 1
    : 0);
  return {
    closes,
    volumes,
    tradeValues,
    returns,
    closePrefix: prefix(closes),
    volumePrefix: prefix(volumes)
  };
}

function buildObservation(context, stockRow, rolling, index) {
  const { stock, history } = stockRow;
  const day = history[index];
  const prior = history[index - 1];
  const market = context.marketByDate.get(day.date);
  if (!market || index < 120 || index + 20 >= history.length) return null;
  const surroundingReturns = rolling.returns.slice(index - 120, index + 21);
  if (surroundingReturns.some(value => Math.abs(value) > 0.15)) return null;
  const ma20 = windowMean(rolling.closePrefix, index, 20);
  const ma60 = windowMean(rolling.closePrefix, index, 60);
  const priorMa20 = windowMean(rolling.closePrefix, index - 5, 20);
  const priorMa60 = windowMean(rolling.closePrefix, index - 5, 60);
  const averageVolume20 = windowMean(rolling.volumePrefix, index, 20);
  const recent20 = history.slice(index - 19, index + 1);
  const prior20 = history.slice(index - 20, index);
  const dailyReturns20 = rolling.returns.slice(index - 19, index + 1).map(value => value * 100);
  const trueRanges = recent20.slice(1).map((row, offset) => {
    const priorClose = recent20[offset].close;
    return Math.max(
      row.high - row.low,
      Math.abs(row.high - priorClose),
      Math.abs(row.low - priorClose)
    );
  });
  const priceChanges = [];
  const volumeChanges = [];
  for (let cursor = index - 18; cursor <= index; cursor += 1) {
    priceChanges.push(rolling.returns[cursor]);
    volumeChanges.push(history[cursor].volume / Math.max(1, history[cursor - 1].volume) - 1);
  }
  const high20 = Math.max(...prior20.map(row => row.high));
  const low20 = Math.min(...prior20.map(row => row.low));
  const bodyHigh = Math.max(day.open, day.close);
  const bodyLow = Math.min(day.open, day.close);
  const dayRange = Math.max(day.high - day.low, day.close * 0.001);
  let consecutiveUp = 0;
  let consecutiveDown = 0;
  for (let cursor = index; cursor >= Math.max(0, index - 10); cursor -= 1) {
    const row = history[cursor];
    if (row.close > row.open && !consecutiveDown) consecutiveUp += 1;
    else if (row.close < row.open && !consecutiveUp) consecutiveDown += 1;
    else break;
  }
  const theme = primaryTheme(stock);
  const themeRow = context.themeReturns.get(`${day.date}|${theme}`);
  const return20 = pct(day.close, history[index - 20].close);
  const transactionValue = day.close * day.volume;
  const forwardReturns = {};
  const forwardNetReturns = {};
  for (const horizon of HORIZONS) {
    const futureClose = history[index + horizon].close;
    forwardReturns[horizon] = pct(futureClose, day.close);
    forwardNetReturns[horizon] = transactionCostAdjustedReturn(day.close, futureClose);
  }
  const futureBars = history.slice(index + 1, index + 21).map(row => ({
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    price: row.close
  }));
  return {
    symbol: stock.symbol,
    name: stock.name,
    market: stock.market,
    theme,
    date: day.date,
    close: day.close,
    nextOpen: history[index + 1].open,
    nextDate: history[index + 1].date,
    futureBars,
    day,
    prior,
    history,
    historyIndex: index,
    ma20,
    ma60,
    averageVolume20,
    priorHigh20: high20,
    priorLow20: low20,
    factors: {
      return5: pct(day.close, history[index - 5].close),
      return20,
      return60: pct(day.close, history[index - 60].close),
      return120: pct(day.close, history[index - 120].close),
      relativeMarket20: return20 - (market.mom20 || 0),
      relativeTheme20: return20 - (themeRow?.average || 0),
      distanceMa20: pct(day.close, ma20),
      distanceMa60: pct(day.close, ma60),
      ma20Slope: pct(ma20, priorMa20),
      ma60Slope: pct(ma60, priorMa60),
      ma20AboveMa60: ma20 > ma60,
      atrPct: mean(trueRanges.slice(-14)) / day.close * 100,
      volatility20: standardDeviation(dailyReturns20),
      maximumDailyLoss20: Math.min(...dailyReturns20),
      gapPct: pct(day.open, prior.close),
      rangePosition20: (day.close - low20) / Math.max(day.close * 0.01, high20 - low20),
      volumeRatio20: averageVolume20 ? day.volume / averageVolume20 : null,
      transactionValue,
      transactionValuePercentile: percentile(context.tradeValueByDate.get(day.date), transactionValue),
      priceVolumeSynchronization: correlation(priceChanges, volumeChanges),
      breakout20: day.close > high20,
      nearLow20: day.close <= low20 * 1.03,
      longLowerWick: (bodyLow - day.low) / dayRange >= 0.4,
      longUpperWick: (day.high - bodyHigh) / dayRange >= 0.4,
      consecutiveUp,
      consecutiveDown,
      regime: market.regime,
      marketReturn20: market.mom20,
      marketAboveMa60: market.close > market.ma60,
      marketVolatilityPercentile: context.marketVolatilityPercentile.get(day.date)
    },
    forwardReturns,
    forwardNetReturns
  };
}

export const FACTOR_DEFINITIONS = Object.freeze([
  ['return5', '5 日報酬', 'continuous'],
  ['return20', '20 日報酬', 'continuous'],
  ['return60', '60 日報酬', 'continuous'],
  ['return120', '120 日報酬', 'continuous'],
  ['relativeMarket20', '相對大盤 20 日強度', 'continuous'],
  ['relativeTheme20', '相對族群 20 日強度', 'continuous'],
  ['distanceMa20', '收盤價相對 MA20 乖離', 'continuous'],
  ['distanceMa60', '收盤價相對 MA60 乖離', 'continuous'],
  ['ma20Slope', 'MA20 斜率', 'continuous'],
  ['ma60Slope', 'MA60 斜率', 'continuous'],
  ['ma20AboveMa60', 'MA20 高於 MA60', 'binary'],
  ['atrPct', 'ATR 百分比', 'continuous'],
  ['volatility20', '20 日波動', 'continuous'],
  ['maximumDailyLoss20', '近 20 日最大單日跌幅', 'continuous'],
  ['gapPct', '跳空幅度', 'continuous'],
  ['rangePosition20', '近 20 日高低區間位置', 'continuous'],
  ['volumeRatio20', '成交量相對 20 日均量', 'continuous'],
  ['transactionValue', '成交值', 'continuous'],
  ['transactionValuePercentile', '成交值分位數', 'continuous'],
  ['priceVolumeSynchronization', '量價同步程度', 'continuous'],
  ['breakout20', '突破 20 日高點', 'binary'],
  ['nearLow20', '接近 20 日低點', 'binary'],
  ['longLowerWick', '長下影線', 'binary'],
  ['longUpperWick', '長上影線', 'binary'],
  ['consecutiveUp', '連續紅 K 數', 'continuous'],
  ['consecutiveDown', '連續黑 K 數', 'continuous'],
  ['regime', '市場狀態', 'categorical'],
  ['marketReturn20', '大盤 20 日報酬', 'continuous'],
  ['marketAboveMa60', '大盤位於 MA60 之上', 'binary'],
  ['marketVolatilityPercentile', '大盤波動分位', 'continuous']
].map(([id, label, type]) => ({ id, label, type })));

export async function loadResearchContext() {
  const [backtest, market] = await Promise.all([
    fs.readFile(BACKTEST_INPUT, 'utf8').then(JSON.parse),
    fs.readFile(MARKET_INPUT, 'utf8').then(JSON.parse)
  ]);
  const ohlcv = await loadOhlcvDataset(backtest, {
    startDate: '2015-06-01',
    endDate: market.benchmark.at(-1).date
  });
  const regimes = buildMarketRegimes(market.benchmark || []);
  const marketByDate = new Map(regimes.map(row => [row.date, row]));
  const themeReturns = new Map();
  const tradeValueByDate = new Map();

  for (const stockRow of ohlcv.stocks) {
    const { stock, history } = stockRow;
    const theme = primaryTheme(stock);
    for (let index = 120; index < history.length; index += 1) {
      const day = history[index];
      const themeKey = `${day.date}|${theme}`;
      const themeRow = themeReturns.get(themeKey) || { sum: 0, count: 0 };
      themeRow.sum += pct(day.close, history[index - 20].close);
      themeRow.count += 1;
      themeReturns.set(themeKey, themeRow);
      const values = tradeValueByDate.get(day.date) || [];
      values.push(day.close * day.volume);
      tradeValueByDate.set(day.date, values);
    }
  }
  for (const [key, row] of themeReturns) {
    themeReturns.set(key, { ...row, average: row.sum / row.count });
  }
  for (const values of tradeValueByDate.values()) values.sort((a, b) => a - b);
  const priorMarketVolatility = [];
  const marketVolatilityPercentile = new Map();
  for (const row of regimes) {
    if (!Number.isFinite(row.vol20)) {
      marketVolatilityPercentile.set(row.date, null);
      continue;
    }
    marketVolatilityPercentile.set(
      row.date,
      percentile(priorMarketVolatility.length ? priorMarketVolatility : [row.vol20], row.vol20)
    );
    let low = 0;
    let high = priorMarketVolatility.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (priorMarketVolatility[middle] <= row.vol20) low = middle + 1;
      else high = middle;
    }
    priorMarketVolatility.splice(low, 0, row.vol20);
  }
  return {
    ohlcv,
    marketHistory: market.benchmark || [],
    regimes,
    marketByDate,
    themeReturns,
    tradeValueByDate,
    marketVolatilityPercentile,
    startDate: regimes.find(row => row.ma200)?.date,
    endDate: regimes.at(-1)?.date,
    survivorshipBiasWarning: ohlcv.sourceUniverseBiasWarning !== false
  };
}

export function iterateObservations(context, callback, options = {}) {
  let count = 0;
  for (const stockRow of context.ohlcv.stocks) {
    if (options.symbols && !options.symbols.has(stockRow.stock.symbol)) continue;
    const rolling = rollingData(stockRow.history);
    for (let index = 120; index + 20 < stockRow.history.length; index += 1) {
      const date = stockRow.history[index].date;
      if (options.startDate && date < options.startDate) continue;
      if (options.endDate && date > options.endDate) break;
      const observation = buildObservation(context, stockRow, rolling, index);
      if (!observation) continue;
      callback(observation);
      count += 1;
    }
  }
  return count;
}

function createAccumulator() {
  return {
    count: 0,
    sum: 0,
    sumSquare: 0,
    wins: 0,
    gains: 0,
    losses: 0,
    minimum: Infinity,
    netSum: 0,
    medianSample: []
  };
}

function updateAccumulator(accumulator, value, netValue) {
  if (!Number.isFinite(value) || !Number.isFinite(netValue)) return;
  accumulator.count += 1;
  accumulator.sum += value;
  accumulator.sumSquare += value ** 2;
  accumulator.wins += value > 0 ? 1 : 0;
  if (value > 0) accumulator.gains += value;
  else accumulator.losses += value;
  accumulator.minimum = Math.min(accumulator.minimum, value);
  accumulator.netSum += netValue;
  if (accumulator.medianSample.length < 20_000) accumulator.medianSample.push(value);
  else {
    const replacement = Math.floor(deterministicScore(`${accumulator.count}|${value}`) * accumulator.count);
    if (replacement < accumulator.medianSample.length) accumulator.medianSample[replacement] = value;
  }
}

function finishAccumulator(accumulator) {
  if (!accumulator.count) return null;
  const average = accumulator.sum / accumulator.count;
  const variance = Math.max(0, accumulator.sumSquare / accumulator.count - average ** 2);
  const deviation = Math.sqrt(variance);
  const netAverage = accumulator.netSum / accumulator.count;
  return {
    sampleSize: accumulator.count,
    averageReturnPct: round(average),
    medianReturnPct: round(median(accumulator.medianSample)),
    winRatePct: round(accumulator.wins / accumulator.count * 100),
    profitFactor: accumulator.losses
      ? round(accumulator.gains / Math.abs(accumulator.losses))
      : accumulator.gains > 0 ? null : 0,
    maximumLossPct: round(accumulator.minimum),
    standardDeviationPct: round(deviation),
    tStatistic: deviation ? round(average / (deviation / Math.sqrt(accumulator.count))) : null,
    costAdjustedAverageReturnPct: round(netAverage),
    positiveAfterCosts: netAverage > 0
  };
}

export function analyzeSingleFactors(context, options = {}) {
  const suppliedThresholds = options.quantileThresholds || null;
  const samplers = new Map(FACTOR_DEFINITIONS
    .filter(factor => factor.type === 'continuous')
    .map(factor => [factor.id, []]));
  let sampleCursor = 0;
  let observations = 0;
  if (!suppliedThresholds) {
    observations = iterateObservations(context, observation => {
      sampleCursor += 1;
      for (const [factorId, values] of samplers) {
        const value = observation.factors[factorId];
        if (!Number.isFinite(value)) continue;
        if (values.length < 100_000) values.push(value);
        else {
          const replacement = Math.floor(
            deterministicScore(`${factorId}|${sampleCursor}|${observation.symbol}`) * sampleCursor
          );
          if (replacement < values.length) values[replacement] = value;
        }
      }
    }, options);
  }
  const cutsByFactor = suppliedThresholds
    ? new Map(Object.entries(suppliedThresholds))
    : new Map([...samplers].map(([factorId, values]) => [
      factorId,
      thresholds(values, 5)
    ]));
  const aggregates = new Map();
  const aggregationCount = iterateObservations(context, observation => {
    for (const factor of FACTOR_DEFINITIONS) {
      const value = observation.factors[factor.id];
      const group = factor.type === 'continuous'
        ? quantileGroup(value, cutsByFactor.get(factor.id))
        : factor.type === 'binary'
          ? (value ? '是' : '否')
          : String(value);
      if (!group) continue;
      for (const horizon of HORIZONS) {
        const key = `${factor.id}|${group}|${horizon}`;
        const accumulator = aggregates.get(key) || createAccumulator();
        updateAccumulator(
          accumulator,
          observation.forwardReturns[horizon],
          observation.forwardNetReturns[horizon]
        );
        aggregates.set(key, accumulator);
      }
    }
  }, options);
  if (suppliedThresholds) observations = aggregationCount;
  const factors = FACTOR_DEFINITIONS.map(factor => ({
    ...factor,
    quantileThresholds: factor.type === 'continuous'
      ? cutsByFactor.get(factor.id).map(value => round(value))
      : null,
    groups: [...new Set([...aggregates.keys()]
      .filter(key => key.startsWith(`${factor.id}|`))
      .map(key => key.split('|')[1]))].map(group => ({
        group,
        horizons: Object.fromEntries(HORIZONS.map(horizon => [
          horizon,
          finishAccumulator(aggregates.get(`${factor.id}|${group}|${horizon}`))
        ]))
      }))
  }));
  return { observations, horizons: HORIZONS, factors };
}

export function buildSignalMaps(context, definitions, options = {}) {
  const maps = Object.fromEntries(definitions.map(definition => [definition.id, new Map()]));
  iterateObservations(context, observation => {
    if (observation.factors.transactionValue < (options.minimumTradeValue ?? 20_000_000)) return;
    for (const definition of definitions) {
      if (!definition.filter(observation)) continue;
      addTopCandidate(maps[definition.id], observation.date, {
        signalDate: observation.date,
        entryDate: observation.nextDate,
        entryPrice: observation.nextOpen,
        symbol: observation.symbol,
        name: observation.name,
        market: observation.market,
        regime: observation.factors.regime,
        atrPct: observation.factors.atrPct,
        score: definition.score(observation),
        futureBars: observation.futureBars
      }, options.dailyLimit ?? 8);
    }
  }, options);
  return maps;
}

function monthlyRows(curve, trades, initialCapital) {
  const endByMonth = new Map();
  for (const row of curve) endByMonth.set(row.date.slice(0, 7), row);
  const tradesByMonth = new Map();
  for (const trade of trades) {
    const month = trade.exitDate.slice(0, 7);
    tradesByMonth.set(month, (tradesByMonth.get(month) || 0) + 1);
  }
  const months = [...endByMonth.keys()].sort();
  let previousEquity = initialCapital;
  return months.map(month => {
    const endingEquity = endByMonth.get(month).equity;
    const equityReturnPct = pct(endingEquity, previousEquity);
    previousEquity = endingEquity;
    return {
      month,
      equityReturnPct: round(equityReturnPct),
      endingEquity,
      trades: tradesByMonth.get(month) || 0
    };
  });
}

export function summarizeCurveAndTrades(curve, trades, initialCapital, startDate, endDate) {
  const endingEquity = curve.at(-1)?.equity ?? initialCapital;
  const monthly = monthlyRows(curve, trades, initialCapital);
  const years = Math.max(1 / 12, (Date.parse(endDate) - Date.parse(startDate)) / 31_557_600_000);
  const annualizedReturnPct = (endingEquity / initialCapital) ** (1 / years) * 100 - 100;
  let peak = initialCapital;
  let maximumDrawdownPct = 0;
  const dailyReturns = [];
  for (const row of curve) {
    peak = Math.max(peak, row.equity);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, pct(row.equity, peak));
    if (Number.isFinite(row.dailyReturnPct)) dailyReturns.push(row.dailyReturnPct);
  }
  const gains = trades
    .filter(trade => trade.realizedPnl > 0)
    .reduce((sum, trade) => sum + trade.realizedPnl, 0);
  const losses = Math.abs(trades
    .filter(trade => trade.realizedPnl <= 0)
    .reduce((sum, trade) => sum + trade.realizedPnl, 0));
  const dailyDeviation = standardDeviation(dailyReturns);
  const symbolCounts = Object.groupBy
    ? Object.groupBy(trades, trade => trade.symbol)
    : trades.reduce((groups, trade) => {
      (groups[trade.symbol] ||= []).push(trade);
      return groups;
    }, {});
  const maximumSymbolTrades = Math.max(0, ...Object.values(symbolCounts).map(rows => rows.length));
  return {
    startDate,
    endDate,
    endingEquity: round(endingEquity, 0),
    annualizedReturnPct: round(annualizedReturnPct),
    averageMonthlyEquityReturnPct: round(mean(monthly.map(row => row.equityReturnPct)) || 0),
    maximumDrawdownPct: round(maximumDrawdownPct),
    negativeMonths: monthly.filter(row => row.equityReturnPct < 0).length,
    winRatePct: round(trades.filter(trade => trade.realizedPnl > 0).length
      / Math.max(1, trades.length) * 100),
    profitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    sharpeLike: dailyDeviation
      ? round((mean(dailyReturns) / dailyDeviation) * Math.sqrt(252))
      : 0,
    trades: trades.length,
    concentrationPct: round(maximumSymbolTrades / Math.max(1, trades.length) * 100),
    monthly
  };
}

export function summarizePerformance(portfolio, startDate, endDate) {
  return summarizeCurveAndTrades(
    portfolio.equityCurve,
    portfolio.closedTrades,
    portfolio.initialCapital,
    startDate,
    endDate
  );
}

export function simulateSignalMap(context, signalMap, options = {}) {
  const startDate = options.startDate || context.startDate;
  const endDate = options.endDate || context.endDate;
  const dates = context.marketHistory
    .map(row => row.date)
    .filter(date => date >= startDate && date <= endDate);
  const entries = new Map();
  for (const [signalDate, candidates] of signalMap) {
    if (signalDate < startDate || signalDate > endDate) continue;
    for (const candidate of candidates) {
      if (candidate.entryDate > endDate) continue;
      const rows = entries.get(candidate.entryDate) || [];
      rows.push(candidate);
      entries.set(candidate.entryDate, rows);
    }
  }
  const portfolio = createPortfolio({
    initialCapital: options.initialCapital ?? 1_000_000,
    settlementDays: 2,
    maxOpenPositions: options.maxOpenPositions ?? 6,
    riskControls: true,
    riskRules: options.riskRules
  });
  for (let dayIndex = 0; dayIndex < dates.length; dayIndex += 1) {
    const date = dates[dayIndex];
    const regime = context.marketByDate.get(date)?.regime;
    settleCash(portfolio, dayIndex);
    beginPortfolioDay(portfolio, date, dayIndex, regime);
    for (const position of [...portfolio.positions]) {
      const bar = position.bars.find(row => row.date === date);
      if (!bar) continue;
      markPosition(portfolio, position.tradeId, bar.price);
      const heldDays = dayIndex - position.entryDayIndex + 1;
      const trailingStop = trailingStopPrice(
        position.entryPrice,
        Math.max(position.peakPrice, bar.high ?? bar.price),
        position.trailingStopRule
      );
      if (bar.forcedExit) {
        closePosition(portfolio, position, {
          date,
          price: bar.forcedExit.price ?? bar.open ?? bar.price,
          reason: bar.forcedExit.reason,
          type: bar.forcedExit.type || 'rule_exit'
        }, dayIndex);
        continue;
      }
      const exit = simulateExit({
        day: bar,
        stopLoss: position.stopLoss,
        takeProfit: position.takeProfit,
        trailingStop,
        peakPrice: position.peakPrice
      });
      if (exit?.price) {
        closePosition(portfolio, position, { ...exit, date }, dayIndex);
      } else if (heldDays >= (position.maxHoldingDays ?? options.holdingDays ?? 5) || bar === position.bars.at(-1)) {
        closePosition(portfolio, position, {
          date,
          price: bar.price,
          reason: '研究固定持有期結束',
          type: 'holding_period'
        }, dayIndex);
      }
    }
    const exposureLimitPct = portfolio.riskRules.exposureLimits[regime] ?? 0;
    for (const position of [...portfolio.positions].sort((a, b) => b.markValue - a.markValue)) {
      if (portfolioExposure(portfolio) <= portfolioEquity(portfolio) * exposureLimitPct / 100) break;
      const bar = position.bars.find(row => row.date === date);
      if (!bar) continue;
      closePosition(portfolio, position, {
        date,
        price: bar.price,
        reason: `總曝險超過 ${exposureLimitPct}% 上限`,
        type: 'exposure_reduction'
      }, dayIndex);
    }
    const dayEntries = [...(entries.get(date) || [])].sort((a, b) => b.score - a.score);
    for (const candidate of dayEntries) {
      const nextDay = candidate.futureBars[0];
      const fill = simulateEntry({ mode: 'next_open_market', nextDay });
      if (!fill) continue;
      const stopDistancePct = candidate.stopDistancePct
        ?? Math.min(8, Math.max(3, candidate.atrPct * 2));
      const rewardRisk = candidate.rewardRisk ?? 2;
      openPosition(portfolio, {
        tradeId: `${candidate.symbol}-${candidate.signalDate}-${options.strategyId || '研究'}`,
        symbol: candidate.symbol,
        name: candidate.name,
        signalDate: candidate.signalDate,
        entryDate: candidate.entryDate,
        entryPrice: fill.price,
        stopLoss: fill.price * (1 - stopDistancePct / 100),
        takeProfit: rewardRisk ? fill.price * (1 + stopDistancePct * rewardRisk / 100) : null,
        positionPct: candidate.positionPct ?? 9,
        strategy: options.strategyId || '研究策略',
        regime,
        bars: candidate.futureBars,
        maxHoldingDays: candidate.maxHoldingDays,
        trailingStopRule: candidate.trailingStopRule,
        setup: candidate.setup,
        trigger: candidate.trigger,
        invalidation: candidate.invalidation,
        exitPlan: candidate.exitPlan,
        reason: candidate.reason,
        orderIntent: candidate.orderIntent
      }, dayIndex, {
        positionPct: candidate.positionPct ?? 9,
        accountRiskPct: candidate.accountRiskPct ?? options.accountRiskPct ?? 0.5,
        regime
      });
    }
    recordEquity(portfolio, date, { dayIndex, regime });
  }
  const finalDate = dates.at(-1);
  const finalIndex = dates.length - 1;
  beginPortfolioDay(portfolio, finalDate, finalIndex, context.marketByDate.get(finalDate)?.regime);
  for (const position of [...portfolio.positions]) {
    closePosition(portfolio, position, {
      date: finalDate,
      price: position.markPrice,
      reason: '研究區間結束',
      type: 'end_of_test'
    }, finalIndex);
  }
  portfolio.equityCurve.pop();
  portfolio.previousEquity = portfolio.equityCurve.at(-1)?.equity ?? portfolio.initialCapital;
  recordEquity(portfolio, finalDate, {
    dayIndex: finalIndex,
    regime: context.marketByDate.get(finalDate)?.regime
  });
  return {
    summary: summarizePerformance(portfolio, startDate, endDate),
    trades: portfolio.closedTrades,
    equityCurve: portfolio.equityCurve,
    riskEvents: portfolio.riskEvents
  };
}

export const RESEARCH_COMBINATIONS = Object.freeze([
  {
    id: 'relative_strength_high_value',
    label: '高相對強度 + 高成交值',
    filter: row => row.factors.relativeMarket20 >= 3
      && row.factors.transactionValuePercentile >= 0.8,
    score: row => row.factors.relativeMarket20 + row.factors.transactionValuePercentile * 10
  },
  {
    id: 'relative_strength_low_atr',
    label: '高相對強度 + 低 ATR',
    filter: row => row.factors.relativeMarket20 >= 3 && row.factors.atrPct <= 3,
    score: row => row.factors.relativeMarket20 - row.factors.atrPct
  },
  {
    id: 'high_value_rising_ma20',
    label: '高成交值 + MA20 上彎',
    filter: row => row.factors.transactionValuePercentile >= 0.8 && row.factors.ma20Slope > 0,
    score: row => row.factors.transactionValuePercentile * 10 + row.factors.ma20Slope
  },
  {
    id: 'momentum60_pullback5',
    label: '60 日動能強 + 5 日短線回檔',
    filter: row => row.factors.return60 >= 8
      && row.factors.return5 >= -6
      && row.factors.return5 <= 0,
    score: row => row.factors.return60 - Math.abs(row.factors.return5)
  },
  {
    id: 'bull_market_relative_strength',
    label: '大盤多頭 + 個股相對強',
    filter: row => row.factors.marketAboveMa60
      && row.factors.marketReturn20 > 0
      && row.factors.relativeMarket20 >= 2,
    score: row => row.factors.relativeMarket20 + row.factors.marketReturn20
  },
  {
    id: 'range_near_low',
    label: '大盤震盪 + 靠近區間下緣',
    filter: row => row.factors.regime === 'RANGE_BOUND'
      && row.factors.rangePosition20 <= 0.25,
    score: row => 1 - row.factors.rangePosition20
  },
  {
    id: 'exclude_large_gap',
    label: '排除跳空過大',
    filter: row => Math.abs(row.factors.gapPct) <= 3
      && row.factors.relativeMarket20 > 0,
    score: row => row.factors.relativeMarket20 - Math.abs(row.factors.gapPct)
  },
  {
    id: 'exclude_low_value',
    label: '排除成交值太低',
    filter: row => row.factors.transactionValuePercentile >= 0.6
      && row.factors.relativeMarket20 > 0,
    score: row => row.factors.relativeMarket20 + row.factors.transactionValuePercentile
  },
  {
    id: 'exclude_high_atr',
    label: '排除 ATR 過高',
    filter: row => row.factors.atrPct <= 4 && row.factors.relativeMarket20 > 0,
    score: row => row.factors.relativeMarket20 - row.factors.atrPct
  },
  {
    id: 'exclude_far_ma20',
    label: '排除離 MA20 過遠',
    filter: row => Math.abs(row.factors.distanceMa20) <= 6
      && row.factors.relativeMarket20 > 0,
    score: row => row.factors.relativeMarket20 - Math.abs(row.factors.distanceMa20)
  }
]);

export function fixedBenchmarkDefinitions() {
  return [
    {
      id: 'random_selection',
      label: '隨機選股',
      filter: row => row.factors.transactionValue >= 20_000_000,
      score: row => deterministicScore(`${row.date}|${row.symbol}`)
    },
    {
      id: 'low_volatility',
      label: '低波動股票',
      filter: row => row.factors.transactionValue >= 20_000_000
        && Number.isFinite(row.factors.atrPct),
      score: row => 20 - row.factors.atrPct
    },
    {
      id: 'high_transaction_value',
      label: '高成交值股票',
      filter: row => row.factors.transactionValuePercentile >= 0.8,
      score: row => row.factors.transactionValuePercentile
    }
  ];
}

export function foldWindows(startDate, endDate, trainMonths = 36, validationMonths = 12) {
  const addMonths = (dateText, count) => {
    const date = new Date(`${dateText.slice(0, 7)}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + count);
    return date.toISOString().slice(0, 10);
  };
  const dayBefore = dateText => {
    const date = new Date(`${dateText}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  };
  const rows = [];
  let trainStart = `${startDate.slice(0, 7)}-01`;
  while (true) {
    const validationStart = addMonths(trainStart, trainMonths);
    if (validationStart > endDate) break;
    const validationEndExclusive = addMonths(validationStart, validationMonths);
    rows.push({
      trainStart,
      trainEnd: dayBefore(validationStart),
      validationStart,
      validationEnd: dayBefore(validationEndExclusive) > endDate
        ? endDate
        : dayBefore(validationEndExclusive)
    });
    if (validationEndExclusive > endDate) break;
    trainStart = addMonths(trainStart, validationMonths);
  }
  return rows;
}

export { HORIZONS, deterministicScore, mean, pct, round };
