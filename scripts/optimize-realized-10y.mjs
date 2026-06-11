import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const INPUT = new URL('../data/tw-backtest-10y.json', import.meta.url);
const OUTPUT = new URL('../data/realized-strategy-search-10y.json', import.meta.url);
const DIAGNOSTIC_OUTPUT = new URL('../data/realized-strategy-diagnostics-10y.json', import.meta.url);
const MARKET_HISTORY = new URL('../data/market-regime-history-10y.json', import.meta.url);
const SEARCH_LEDGER = new URL('../data/strategy-search-ledger-10y.json', import.meta.url);
const QUICK = process.argv.includes('--quick');
const TESTS = Number(process.env.OPTIMIZE_REALIZED_TESTS || (QUICK ? 2000 : 12000));
const BROAD_TESTS = Number(process.env.OPTIMIZE_REALIZED_BROAD_TESTS || (QUICK ? 500 : 2000));
const REFINE_TESTS = Number(process.env.OPTIMIZE_REALIZED_REFINE_TESTS || (QUICK ? 2000 : 16000));
const REFINE_ONLY = process.argv.includes('--refine-only');
const CAPITAL_ONLY = process.argv.includes('--capital-only');
const INDICATORS_ONLY = process.argv.includes('--indicators-only');
const RISK_ONLY = process.argv.includes('--risk-only');
const EXITS_ONLY = process.argv.includes('--exits-only');
const SEARCH_SPACE_VERSION = 3;
const BUY_SIGNAL = '買入候選';
const WAIT_SIGNAL = '等待進場';
const INITIAL_CAPITAL = 1_000_000;
const BUY_FEE_PCT = 0.1425;
const SELL_FEE_PCT = 0.1425;
const SELL_TAX_PCT = 0.3;
const BUY_SLIPPAGE_PCT = 0.15;
const SELL_SLIPPAGE_PCT = 0.15;
const MIN_FEE = 20;
const MIN_ORDER_VALUE = 20_000;
const LOT = 1000;
const SETTLEMENT_DAYS = 2;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableValue(value[key])])
  );
}

function hash(value) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function monthKeys(startDate, endDate) {
  const [startYear, startMonth] = startDate.split('-').map(Number);
  const [endYear, endMonth] = endDate.split('-').map(Number);
  const rows = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    rows.push(`${year}-${String(month).padStart(2, '0')}`);
    if (++month === 13) {
      year += 1;
      month = 1;
    }
  }
  return rows;
}

function orderFee(price, quantity, rate) {
  const fee = shares => shares
    ? Math.max(MIN_FEE, Math.ceil(price * shares * rate / 100))
    : 0;
  const boardShares = Math.floor(quantity / LOT) * LOT;
  return fee(boardShares) + fee(quantity - boardShares);
}

function buyExecution(price, quantity) {
  const fillPrice = price * (1 + BUY_SLIPPAGE_PCT / 100);
  const tradeValue = fillPrice * quantity;
  const fee = orderFee(fillPrice, quantity, BUY_FEE_PCT);
  return { tradeValue, fee, total: tradeValue + fee };
}

function sellExecution(price, quantity) {
  const fillPrice = price * (1 - SELL_SLIPPAGE_PCT / 100);
  const tradeValue = fillPrice * quantity;
  const fee = orderFee(fillPrice, quantity, SELL_FEE_PCT);
  const tax = Math.ceil(tradeValue * SELL_TAX_PCT / 100);
  return { net: tradeValue - fee - tax };
}

function affordableQuantity(trade, cashBudget, riskBudget) {
  let low = 0;
  let high = Math.max(0, Math.floor(cashBudget / trade.entryPrice));
  while (low < high) {
    const quantity = Math.ceil((low + high) / 2);
    const buy = buyExecution(trade.entryPrice, quantity);
    const stop = sellExecution(trade.stopLoss, quantity);
    if (buy.total <= cashBudget && buy.total - stop.net <= riskBudget) low = quantity;
    else high = quantity - 1;
  }
  return low && buyExecution(trade.entryPrice, low).tradeValue >= MIN_ORDER_VALUE ? low : 0;
}

function confirmations(trade) {
  return [
    trade.marketMovePct >= 0.25,
    trade.themeMovePct >= 0.25,
    trade.globalCompositePct >= 0,
    trade.asiaCompositePct >= 0,
    trade.gapUpPct >= 0.5
  ].filter(Boolean).length;
}

function rewardRisk(trade) {
  const risk = trade.entryPrice - trade.stopLoss;
  return risk > 0 ? (trade.targetFast - trade.entryPrice) / risk : 0;
}

function themesOf(trade) {
  if (Array.isArray(trade.themes)) return trade.themes;
  return String(trade.themes || '')
    .split(/[、,|/]/)
    .map(theme => theme.trim())
    .filter(Boolean);
}

function isBlackSwan(regime, config) {
  if (!regime || (config.blackSwanMode ?? 'none') === 'none') return false;
  return regime.mom1 <= config.blackSwanDayDropPct
    || regime.mom5 <= config.blackSwanFiveDayDropPct
    || regime.vol20 >= config.blackSwanVol20Pct;
}

function passes(trade, config) {
  if (config.buyOnly && trade.signal !== BUY_SIGNAL) return false;
  if (trade.signalScore < config.minScore) return false;
  const required = trade.signal === BUY_SIGNAL ? config.buyConfirmations : config.watchConfirmations;
  if (confirmations(trade) < required) return false;
  if (trade.gapUpPct < config.minGap || trade.gapUpPct > config.maxGap) return false;
  if (trade.std20Pct < config.minStd || trade.std20Pct > config.maxStd) return false;
  if (trade.avg20TradeValue < config.minTradeValue) return false;
  if (trade.maxRange20Pct > config.maxRange) return false;
  if (trade.rsi14 < config.minRsi || trade.rsi14 > config.maxRsi) return false;
  if (trade.chasePct > config.maxChasePct) return false;
  if (rewardRisk(trade) < config.minRewardRisk) return false;
  if (trade.marketMovePct < config.marketFloor) return false;
  if (trade.themeMovePct < config.themeFloor) return false;
  if (trade.globalCompositePct < config.globalFloor) return false;
  if (trade.asiaCompositePct < config.asiaFloor) return false;
  if (config.requireMa20Rising && !trade.ma20Rising) return false;
  if (config.excludeHighVolumeDistribution && trade.highVolumeDistribution) return false;
  if (trade.distanceToMa20Pct < (config.minDistanceToMa20Pct ?? -100)) return false;
  if (trade.distanceToMa20Pct > (config.maxDistanceToMa20Pct ?? 100)) return false;
  if (trade.volumeRatio1To20 < (config.minVolumeRatio1To20 ?? 0)) return false;
  if (trade.volumeRatio1To20 > (config.maxVolumeRatio1To20 ?? 100)) return false;
  if (trade.intradayMomentum20Pct < (config.minIntradayMomentum20Pct ?? -100)) return false;
  if (trade.overnightMomentum20Pct > (config.maxOvernightMomentum20Pct ?? 100)) return false;
  if (trade.nearYearHigh < (config.minNearYearHigh ?? 0)) return false;
  if (trade.nearYearHigh > (config.maxNearYearHigh ?? 100)) return false;
  if (trade.atr14Pct < (config.minAtr14Pct ?? 0)) return false;
  if (trade.atr14Pct > (config.maxAtr14Pct ?? 100)) return false;
  if (trade.bollingerPercentB < (config.minBollingerPercentB ?? -100)) return false;
  if (trade.bollingerPercentB > (config.maxBollingerPercentB ?? 100)) return false;
  if (trade.bollingerBandwidthPct < (config.minBollingerBandwidthPct ?? 0)) return false;
  if (trade.bollingerBandwidthPct > (config.maxBollingerBandwidthPct ?? 100)) return false;
  if (trade.volatilityCompression5To20 > (config.maxVolatilityCompression ?? 100)) return false;
  if (trade.stochastic14 < (config.minStochastic14 ?? 0)) return false;
  if (trade.stochastic14 > (config.maxStochastic14 ?? 100)) return false;
  if (config.requireDirectionalTrend && !trade.directionalTrendUp) return false;
  if (config.requireDonchianBreakout && !trade.donchian20Breakout) return false;
  if (config.priceVolumeMode === 'exclude_flat_down'
    && trade.priceVolumeState === 'flat_volume_down') return false;
  if (config.priceVolumeMode === 'momentum_only'
    && !['price_up_volume_up', 'neutral'].includes(trade.priceVolumeState)) return false;
  if (config.priceVolumeMode === 'price_volume_up'
    && trade.priceVolumeState !== 'price_up_volume_up') return false;
  if (config.regimeMode !== 'none') {
    const regime = trade.marketRegime;
    if (!regime) return false;
    const belowTrend = regime.close < regime[`ma${config.regimeSlowMa}`];
    const weakMomentum = regime[`mom${config.regimeMomentumDays}`]
      <= config.regimeMomentumThreshold;
    if (config.regimeMode === 'avoid_both' && belowTrend && weakMomentum) return false;
    if (config.regimeMode === 'require_above_ma' && belowTrend) return false;
    if (config.regimeMode === 'require_momentum' && weakMomentum) return false;
    if (config.regimeMode === 'require_up_continuation') {
      if (belowTrend || regime.mom5 <= 0 || regime.mom20 <= 0) return false;
    }
  }
  if ((config.blackSwanMode ?? 'none') !== 'none' && !trade.marketRegime) return false;
  if (isBlackSwan(trade.marketRegime, config)) return false;
  return true;
}

function plannedPositionPct(trade, config) {
  let pct = trade.signal !== BUY_SIGNAL
    ? config.exploratoryPct
    : trade.strictRisk ? config.defensivePct : config.standardPct;
  if (trade.marketMovePct >= 1 && trade.themeMovePct >= 1) {
    pct = Math.min(config.maxPositionPct, pct * config.strongBoost);
  }
  if (rewardRisk(trade) >= config.edgeRewardRisk && trade.gapUpPct >= config.edgeGapPct) {
    pct = Math.min(config.maxPositionPct, pct * config.edgeBoost);
  }
  if (trade.gapUpPct >= config.momentumGapPct && trade.std20Pct >= config.momentumStdPct) {
    pct = Math.min(config.maxPositionPct, pct * config.momentumBoost);
  }
  if (config.transitionPositionMultiplier !== undefined && trade.marketRegime) {
    const regime = trade.marketRegime;
    const upContinuation = regime.close >= regime.ma40
      && regime.mom5 > 0
      && regime.mom20 > 0;
    if (!upContinuation) pct *= config.transitionPositionMultiplier;
  }
  return pct;
}

function buildDays(trades) {
  const days = new Map();
  const day = date => {
    if (!days.has(date)) days.set(date, { entries: [], exits: [], marks: [] });
    return days.get(date);
  };
  for (const trade of trades) {
    day(trade.entryDate).entries.push(trade);
    day(trade.exitDate).exits.push(trade);
    const marks = trade.markPrices || (trade.forwardPrices || [])
      .filter(mark => mark.date <= trade.exitDate);
    for (const mark of marks) {
      day(mark.date).marks.push({
        tradeId: trade.tradeId,
        price: mark.price,
        open: mark.open
      });
    }
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function buildMarketRegimes(history) {
  const closes = [];
  const returns = [];
  const regimes = new Map();
  for (const day of history) {
    const previousClose = closes.at(-1);
    closes.push(day.close);
    if (previousClose) returns.push(day.close / previousClose - 1);
    const row = { close: day.close };
    for (const size of [20, 40, 60, 120, 200]) {
      row[`ma${size}`] = average(closes, size);
    }
    for (const size of [1, 3, 5, 10, 20]) {
      const base = closes.at(-1 - size);
      row[`mom${size}`] = base ? (day.close / base - 1) * 100 : null;
    }
    if (returns.length >= 20) {
      const recent = returns.slice(-20);
      const mean = recent.reduce((sum, value) => sum + value, 0) / recent.length;
      row.vol20 = Math.sqrt(
        recent.reduce((sum, value) => sum + (value - mean) ** 2, 0) / recent.length
      ) * Math.sqrt(252) * 100;
    } else {
      row.vol20 = null;
    }
    regimes.set(day.date, row);
  }
  return regimes;
}

function average(values, size) {
  if (values.length < size) return null;
  return values.slice(-size).reduce((sum, value) => sum + value, 0) / size;
}

function exitRules() {
  const trails = [
    null,
    { triggerPct: 3, givebackPct: 5, lockPct: 1 },
    { triggerPct: 5, givebackPct: 4, lockPct: 1 },
    { triggerPct: 8, givebackPct: 5, lockPct: 2 }
  ];
  return [2, 3, 5, 7, 10].flatMap(holdDays => trails.flatMap(trail => (
    [false, true].flatMap(noFollow => (
      [null, 3, 5, 7, 10, 'volatility'].flatMap(stopLossPct => (
        (stopLossPct === null ? ['intraday'] : ['intraday', 'close']).map(stopMode => ({
          holdDays,
          trail,
          noFollow,
          stopLossPct,
          stopMode
        }))
      ))
    ))
  )));
}

function targetedExitRules() {
  const trails = [
    null,
    { triggerPct: 5, givebackPct: 4, lockPct: 1 },
    { triggerPct: 8, givebackPct: 5, lockPct: 2 }
  ];
  return [3, 5, 7, 10].flatMap(holdDays => trails.flatMap(trail => (
    [false, true].flatMap(noFollow => (
      [3, 5, 'volatility'].flatMap(stopLossPct => (
        ['intraday', 'close'].map(stopMode => ({
          holdDays,
          trail,
          noFollow,
          stopLossPct,
          stopMode
        }))
      ))
    ))
  )));
}

function applyExitRule(trade, rule) {
  const forward = trade.forwardPrices || trade.markPrices || [];
  if (!forward.length) return trade;
  const stopLossPct = rule.stopLossPct === 'volatility'
    ? Math.max(3, Math.min(10, (trade.std20Pct || 3) * 2.5))
    : rule.stopLossPct;
  const stopLoss = stopLossPct
    ? Math.max(trade.stopLoss, trade.entryPrice * (1 - stopLossPct / 100))
    : trade.stopLoss;
  const endIndex = Math.min(rule.holdDays - 1, forward.length - 1);
  let exitIndex = endIndex;
  let exitPrice = forward[endIndex].price;
  let exitReason = `固定持有 ${rule.holdDays} 天`;
  let peakClosePct = -Infinity;
  let maxHigh = trade.entryPrice;

  for (let index = 0; index <= endIndex; index += 1) {
    const day = forward[index];
    maxHigh = Math.max(maxHigh, day.high ?? day.price);
    const stopTriggered = rule.stopMode === 'close'
      ? day.price <= stopLoss
      : (day.low ?? day.price) <= stopLoss;
    if (stopTriggered) {
      exitIndex = index;
      exitPrice = rule.stopMode === 'close'
        ? day.price
        : (day.open ?? day.price) < stopLoss ? (day.open ?? day.price) : stopLoss;
      exitReason = '盤中停損';
      break;
    }
    const closeReturnPct = (day.price / trade.entryPrice - 1) * 100;
    peakClosePct = Math.max(peakClosePct, closeReturnPct);
    if (rule.noFollow && index >= 1) {
      const maxAdvancePct = (maxHigh / trade.entryPrice - 1) * 100;
      if (maxAdvancePct < 1.5) {
        exitIndex = index;
        exitPrice = day.price;
        exitReason = '兩日無續航';
        break;
      }
    }
    if (rule.trail && peakClosePct >= rule.trail.triggerPct) {
      const floor = Math.max(rule.trail.lockPct, peakClosePct - rule.trail.givebackPct);
      if (closeReturnPct <= floor) {
        exitIndex = index;
        exitPrice = day.price;
        exitReason = '收盤移動停利';
        break;
      }
    }
  }

  return {
    ...trade,
    exitDate: forward[exitIndex].date,
    exitPrice,
    exitReason,
    holdingDays: exitIndex + 1,
    stopLoss,
    markPrices: forward.slice(0, exitIndex + 1).map(day => ({
      date: day.date,
      open: day.open,
      price: day.price,
      high: day.high,
      low: day.low
    }))
  };
}

function rank(entries, mode) {
  const score = trade => {
    if (mode === 'score') return trade.signalScore;
    if (mode === 'confirmations') return confirmations(trade) * 20 + trade.signalScore;
    if (mode === 'liquidity') return Math.log10(trade.avg20TradeValue || 1) * 20 + trade.signalScore;
    if (mode === 'stability') return trade.signalScore - trade.std20Pct * 3 - trade.maxRange20Pct;
    if (mode === 'rewardRisk') return rewardRisk(trade) * 30 + trade.signalScore;
    if (mode === 'edge') return trade.gapUpPct * 20 + rewardRisk(trade) * 20 + trade.signalScore;
    if (mode === 'momentum') {
      return trade.gapUpPct * 20
        + trade.chasePct * 10
        + trade.std20Pct * 15
        + trade.signalScore;
    }
    if (mode === 'technicalMomentum') {
      return trade.signalScore
        + Math.min(trade.distanceToMa20Pct || 0, 20) * 3
        + Math.min(trade.volumeRatio1To20 || 0, 4) * 5
        - (trade.highVolumeDistribution ? 100 : 0);
    }
    if (mode === 'volatilityTrend') {
      return trade.signalScore
        + (trade.atr14Pct || 0) * 5
        + (trade.bollingerBandwidthPct || 0)
        + (trade.stochastic14 || 0) * 0.2
        + (trade.nearYearHigh || 0) * 20;
    }
    if (mode === 'breakoutQuality') {
      return trade.signalScore
        + (trade.donchian20Breakout ? 40 : 0)
        + (trade.directionalTrendUp ? 20 : 0)
        + (trade.bollingerPercentB || 0) * 15
        + Math.min(trade.volumeRatio1To20 || 0, 4) * 5;
    }
    if (mode === 'intradayEdge') {
      return trade.signalScore
        + (trade.intradayMinusOvernight20Pct || 0) * 2
        + (trade.nearYearHigh || 0) * 20;
    }
    if (mode === 'riskAdjustedMomentum') {
      return trade.signalScore
        + (trade.return20Pct || 0) / Math.max(trade.atr14Pct || 1, 1) * 10
        + (trade.nearYearHigh || 0) * 20;
    }
    return trade.gapUpPct * 20 + confirmations(trade) * 5 + trade.signalScore;
  };
  return [...entries].sort((a, b) => score(b) - score(a) || a.symbol.localeCompare(b.symbol));
}

function simulate(allDays, months, config, marketRegimes = new Map()) {
  let availableCash = INITIAL_CAPITAL;
  let unsettled = [];
  let open = [];
  let equity = INITIAL_CAPITAL;
  let peak = INITIAL_CAPITAL;
  let maxDrawdownPct = 0;
  let trades = 0;
  let realizedCapital = INITIAL_CAPITAL;
  let activeMonth = months[0];
  let monthStartCapital = INITIAL_CAPITAL;
  let monthStartEquity = INITIAL_CAPITAL;
  let monthPeakReturnPct = 0;
  let monthTradingHalted = false;
  let liquidateNextOpen = false;
  const cooldownUntilBySymbol = new Map();
  const monthlyPnl = new Map(months.map(month => [month, 0]));
  const monthlyTrades = new Map(months.map(month => [month, 0]));
  const closedTrades = config.collectTrades ? [] : null;
  const closePosition = (position, exitPrice, exitDate, month, index, exitReason) => {
    open = open.filter(item => item.trade.tradeId !== position.trade.tradeId);
    cooldownUntilBySymbol.set(position.trade.symbol, index + 5);
    const sell = sellExecution(exitPrice, position.quantity);
    const pnl = sell.net - position.buy.total;
    realizedCapital += pnl;
    unsettled.push({ releaseIndex: index + SETTLEMENT_DAYS, amount: sell.net });
    monthlyPnl.set(month, (monthlyPnl.get(month) || 0) + pnl);
    monthlyTrades.set(month, (monthlyTrades.get(month) || 0) + 1);
    trades += 1;
    if (closedTrades) {
      closedTrades.push({
        tradeId: position.trade.tradeId,
        symbol: position.trade.symbol,
        name: position.trade.name,
        signal: position.trade.signal,
        signalScore: position.trade.signalScore,
        signalDate: position.trade.signalDate,
        entryDate: position.trade.entryDate,
        exitDate,
        exitReason,
        holdingDays: position.trade.holdingDays,
        plannedHoldDays: position.trade.plannedHoldDays,
        quantity: position.quantity,
        entryPrice: position.trade.entryPrice,
        exitPrice,
        realizedPnl: round(pnl, 0),
        accountReturnPct: round(pnl / position.entryEquity * 100),
        tradeReturnPct: round(pnl / position.buy.total * 100),
        gapUpPct: position.trade.gapUpPct,
        rsi14: position.trade.rsi14,
        std20Pct: position.trade.std20Pct,
        marketMovePct: position.trade.marketMovePct,
        themeMovePct: position.trade.themeMovePct,
        globalCompositePct: position.trade.globalCompositePct,
        asiaCompositePct: position.trade.asiaCompositePct,
        rewardRisk: round(rewardRisk(position.trade)),
        atr14Pct: position.trade.atr14Pct,
        bollingerPercentB: position.trade.bollingerPercentB,
        bollingerBandwidthPct: position.trade.bollingerBandwidthPct,
        stochastic14: position.trade.stochastic14,
        directionalTrendUp: position.trade.directionalTrendUp,
        donchian20Breakout: position.trade.donchian20Breakout,
        nearYearHigh: position.trade.nearYearHigh,
        distanceToMa20Pct: position.trade.distanceToMa20Pct,
        volumeRatio1To20: position.trade.volumeRatio1To20,
        intradayMomentum20Pct: position.trade.intradayMomentum20Pct,
        overnightMomentum20Pct: position.trade.overnightMomentum20Pct,
        marketMom1Pct: position.trade.marketRegime?.mom1,
        marketMom5Pct: position.trade.marketRegime?.mom5,
        marketMom20Pct: position.trade.marketRegime?.mom20,
        marketVol20Pct: position.trade.marketRegime?.vol20,
        marketAboveMa40: position.trade.marketRegime
          ? position.trade.marketRegime.close >= position.trade.marketRegime.ma40
          : null
      });
    }
  };

  for (let index = 0; index < allDays.length; index += 1) {
    const [date, day] = allDays[index];
    const month = date.slice(0, 7);
    if (month !== activeMonth) {
      activeMonth = month;
      monthStartCapital = realizedCapital;
      monthStartEquity = equity;
      monthPeakReturnPct = 0;
      monthTradingHalted = false;
    }
    const released = unsettled.filter(item => item.releaseIndex <= index);
    availableCash += released.reduce((sum, item) => sum + item.amount, 0);
    unsettled = unsettled.filter(item => item.releaseIndex > index);
    const marksByTradeId = new Map(day.marks.map(mark => [mark.tradeId, mark]));
    const blackSwanToday = isBlackSwan(marketRegimes.get(date), config);

    if (liquidateNextOpen) {
      for (const position of [...open]) {
        const mark = marksByTradeId.get(position.trade.tradeId);
        if (mark) {
          closePosition(
            position,
            mark.open ?? mark.price,
            date,
            month,
            index,
            '月度風控次日開盤退出'
          );
        }
      }
      if (!open.length) liquidateNextOpen = false;
    }

    for (const trade of day.exits) {
      const position = open.find(item => item.trade.tradeId === trade.tradeId);
      if (!position) continue;
      closePosition(position, trade.exitPrice, date, month, index, trade.exitReason);
    }

    for (const mark of day.marks) {
      const position = open.find(item => item.trade.tradeId === mark.tradeId);
      if (position) {
        position.markPrice = mark.price;
        position.markValue = sellExecution(mark.price, position.quantity).net;
      }
    }

    equity = availableCash
      + unsettled.reduce((sum, item) => sum + item.amount, 0)
      + open.reduce((sum, item) => sum + item.markValue, 0);
    const monthReturnPct = (monthlyPnl.get(month) || 0) / monthStartCapital * 100;
    const monthEquityReturnPct = (equity / monthStartEquity - 1) * 100;
    monthPeakReturnPct = Math.max(monthPeakReturnPct, monthReturnPct);
    const profitLocked = config.profitLockPct !== null
      && monthReturnPct >= config.profitLockPct;
    const lossBraked = config.lossBrakePct !== null
      && monthReturnPct <= config.lossBrakePct;
    const drawdownLocked = config.monthPeakTriggerPct !== null
      && monthPeakReturnPct >= config.monthPeakTriggerPct
      && monthReturnPct <= monthPeakReturnPct - config.monthGivebackPct;
    if (blackSwanToday && config.blackSwanAction === 'exit_next_open') {
      liquidateNextOpen = open.length > 0;
    }
    if (config.monthlyEquityBrakePct !== null
      && config.monthlyEquityBrakePct !== undefined
      && monthEquityReturnPct <= config.monthlyEquityBrakePct) {
      monthTradingHalted = true;
      liquidateNextOpen = open.length > 0;
    }
    if ((profitLocked && config.profitLockAction === 'exit_next_open')
      || (lossBraked && config.lossBrakeAction === 'exit_next_open')
      || (drawdownLocked && config.monthDrawdownAction === 'exit_next_open')) {
      liquidateNextOpen = open.length > 0;
    }
    for (const trade of rank(day.entries, config.rankMode)) {
      if (open.length >= config.maxOpenPositions || !passes(trade, config)) continue;
      if (profitLocked
        || lossBraked
        || drawdownLocked
        || blackSwanToday
        || monthTradingHalted
        || liquidateNextOpen) continue;
      if (monthReturnPct < 0 && (
        rewardRisk(trade) < config.recoveryMinRewardRisk
        || trade.gapUpPct < config.recoveryMinGapPct
      )) continue;
      if (open.some(position => position.trade.symbol === trade.symbol)
        || index <= (cooldownUntilBySymbol.get(trade.symbol) ?? -1)) continue;
      if (config.maxPositionsPerTheme) {
        const themes = themesOf(trade);
        const themeConcentration = themes.some(theme => open.filter(position => (
          themesOf(position.trade).includes(theme)
        )).length >= config.maxPositionsPerTheme);
        if (themeConcentration) continue;
      }
      const plannedPct = plannedPositionPct(trade, config);
      const budget = Math.min(availableCash, equity * plannedPct / 100);
      const activeRiskPct = monthReturnPct < config.riskBoostAfterPct
        ? config.starterRiskPct
        : config.accountRiskPct;
      const quantity = affordableQuantity(trade, budget, equity * activeRiskPct / 100);
      if (!quantity) continue;
      const buy = buyExecution(trade.entryPrice, quantity);
      availableCash -= buy.total;
      open.push({
        trade,
        quantity,
        buy,
        entryEquity: equity,
        markPrice: trade.entryPrice,
        markValue: sellExecution(trade.entryPrice, quantity).net
      });
      equity = availableCash
        + unsettled.reduce((sum, item) => sum + item.amount, 0)
        + open.reduce((sum, item) => sum + item.markValue, 0);
    }

    equity = availableCash
      + unsettled.reduce((sum, item) => sum + item.amount, 0)
      + open.reduce((sum, item) => sum + item.markValue, 0);
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.min(maxDrawdownPct, (equity / peak - 1) * 100);
  }

  let capital = INITIAL_CAPITAL;
  const monthly = months.map(month => {
    const pnl = monthlyPnl.get(month) || 0;
    const startCapital = capital;
    capital += pnl;
    return {
      month,
      returnPct: round(pnl / startCapital * 100),
      realizedPnl: round(pnl, 0),
      trades: monthlyTrades.get(month) || 0
    };
  });
  const complete = monthly.slice(1, -1);
  const train = complete.filter(row => row.month <= '2021-12');
  const test = complete.filter(row => row.month >= '2022-01');
  const stats = rows => ({
    months: rows.length,
    hit: rows.filter(row => row.returnPct >= 10).length,
    negative: rows.filter(row => row.returnPct < 0).length,
    zero: rows.filter(row => row.trades === 0).length,
    worst: Math.min(...rows.map(row => row.returnPct)),
    average: rows.reduce((sum, row) => sum + row.returnPct, 0) / rows.length
  });
  const result = {
    config,
    monthly,
    finalCapital: round(capital, 0),
    portfolioReturnPct: round((capital / INITIAL_CAPITAL - 1) * 100),
    maxDrawdownPct: round(maxDrawdownPct),
    trades,
    full: stats(complete),
    train: stats(train),
    test: stats(test)
  };
  if (closedTrades) result.closedTrades = closedTrades;
  return result;
}

function compare(a, b) {
  return Math.min(b.train.hit / b.train.months, b.test.hit / b.test.months)
      - Math.min(a.train.hit / a.train.months, a.test.hit / a.test.months)
    || b.full.hit - a.full.hit
    || a.full.negative - b.full.negative
    || b.full.worst - a.full.worst
    || b.full.average - a.full.average
    || b.maxDrawdownPct - a.maxDrawdownPct;
}

function compareCashFirst(a, b) {
  return a.full.negative - b.full.negative
    || b.full.worst - a.full.worst
    || Math.min(b.train.hit / b.train.months, b.test.hit / b.test.months)
      - Math.min(a.train.hit / a.train.months, a.test.hit / a.test.months)
    || b.full.hit - a.full.hit
    || b.full.average - a.full.average
    || b.maxDrawdownPct - a.maxDrawdownPct;
}

function random(seed = 20260609) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function pick(rand, values) {
  return values[Math.floor(rand() * values.length)];
}

function randomConfig(rand) {
  const standardPct = pick(rand, [20, 30, 40, 50, 60]);
  return {
    buyOnly: pick(rand, [false, false, true]),
    minScore: pick(rand, [70, 75, 80, 85, 88, 90, 92]),
    buyConfirmations: pick(rand, [1, 2, 3, 4]),
    watchConfirmations: pick(rand, [2, 3, 4, 5]),
    minGap: pick(rand, [0, 1, 2, 3, 4, 5, 6]),
    maxGap: pick(rand, [5, 8, 12]),
    minStd: pick(rand, [1.5, 2, 3, 4, 5]),
    maxStd: pick(rand, [5, 7, 8.5, 10]),
    minTradeValue: pick(rand, [30e6, 50e6, 100e6, 200e6, 300e6]),
    maxRange: pick(rand, [8, 10, 12, 14, 20]),
    minRsi: pick(rand, [45, 50, 55, 60, 65, 70]),
    maxRsi: pick(rand, [85, 90, 95, 100]),
    maxChasePct: pick(rand, [6, 8, 12, 20, 100]),
    minRewardRisk: pick(rand, [-99, -1, 0, 0.5, 1]),
    marketFloor: pick(rand, [-1, -0.5, 0, 0.25]),
    themeFloor: pick(rand, [-1, -0.5, 0, 0.25]),
    globalFloor: pick(rand, [-1.5, -0.8, -0.3, 0]),
    asiaFloor: pick(rand, [-1.2, -0.6, -0.2, 0]),
    requireMa20Rising: pick(rand, [false, false, true]),
    excludeHighVolumeDistribution: pick(rand, [false, true, true]),
    minDistanceToMa20Pct: pick(rand, [-100, 0, 3, 6, 8, 10]),
    maxDistanceToMa20Pct: pick(rand, [15, 20, 30, 100]),
    minVolumeRatio1To20: pick(rand, [0, 0.7, 1, 1.5, 2]),
    maxVolumeRatio1To20: pick(rand, [3, 5, 10, 100]),
    minIntradayMomentum20Pct: pick(rand, [-100, 0, 3, 6, 10]),
    maxOvernightMomentum20Pct: pick(rand, [0, 3, 6, 10, 100]),
    minNearYearHigh: pick(rand, [0, 0.7, 0.8, 0.9]),
    maxNearYearHigh: pick(rand, [0.95, 1, 100]),
    minAtr14Pct: pick(rand, [0, 2, 3, 4]),
    maxAtr14Pct: pick(rand, [4, 6, 8, 100]),
    minBollingerPercentB: pick(rand, [-100, 0.5, 0.8, 1]),
    maxBollingerPercentB: pick(rand, [1, 1.2, 1.5, 100]),
    minBollingerBandwidthPct: pick(rand, [0, 8, 15, 25]),
    maxBollingerBandwidthPct: pick(rand, [15, 25, 40, 100]),
    maxVolatilityCompression: pick(rand, [0.6, 0.9, 1.2, 100]),
    minStochastic14: pick(rand, [0, 50, 70, 80]),
    maxStochastic14: pick(rand, [80, 90, 100]),
    requireDirectionalTrend: pick(rand, [false, false, true]),
    requireDonchianBreakout: pick(rand, [false, false, true]),
    priceVolumeMode: pick(rand, ['none', 'none', 'exclude_flat_down', 'momentum_only', 'price_volume_up']),
    regimeMode: pick(rand, ['none', 'none', 'avoid_both', 'require_above_ma', 'require_momentum', 'require_up_continuation']),
    regimeSlowMa: pick(rand, [20, 40, 60, 120, 200]),
    regimeMomentumDays: pick(rand, [1, 3, 5, 10, 20]),
    regimeMomentumThreshold: pick(rand, [0, -1, -2, -3]),
    standardPct,
    defensivePct: pick(rand, [10, 15, 20, 25, 30]),
    exploratoryPct: pick(rand, [5, 10, 15, 20, 25]),
    maxPositionPct: Math.max(standardPct, pick(rand, [40, 50, 60])),
    strongBoost: pick(rand, [1, 1.25, 1.5]),
    edgeRewardRisk: pick(rand, [2, 2.5, 3]),
    edgeGapPct: pick(rand, [1.5, 2, 2.5, 3]),
    edgeBoost: pick(rand, [1, 1.25, 1.5, 2]),
    momentumGapPct: pick(rand, [3, 4, 5, 6]),
    momentumStdPct: pick(rand, [3, 4, 5]),
    momentumBoost: pick(rand, [1, 1.25, 1.5, 2]),
    accountRiskPct: pick(rand, [1, 1.25, 1.5, 1.75, 2]),
    maxOpenPositions: pick(rand, [2, 3, 4, 5, 6, 8]),
    rankMode: pick(rand, [
      'gap',
      'score',
      'confirmations',
      'liquidity',
      'stability',
      'rewardRisk',
      'edge',
      'momentum',
      'technicalMomentum'
    ]),
    profitLockPct: pick(rand, [null, 10, 10, 11, 12]),
    profitLockAction: pick(rand, ['block', 'exit_next_open']),
    lossBrakePct: pick(rand, [null, null, -0.5, -1, -2]),
    lossBrakeAction: 'exit_next_open',
    monthPeakTriggerPct: pick(rand, [null, 1, 2, 3, 5]),
    monthGivebackPct: pick(rand, [1, 1.5, 2, 3]),
    monthDrawdownAction: pick(rand, ['block', 'exit_next_open']),
    recoveryMinRewardRisk: pick(rand, [-99, -1, 0, 0.5]),
    recoveryMinGapPct: pick(rand, [0, 1.5, 2, 2.5]),
    starterRiskPct: pick(rand, [1, 1.5, 2]),
    riskBoostAfterPct: pick(rand, [0, 1, 2, 3])
  };
}

function refineConfig(rand, base) {
  return {
    ...base,
    buyOnly: false,
    minScore: pick(rand, [65, 70, 75]),
    buyConfirmations: pick(rand, [1, 2, 3]),
    watchConfirmations: pick(rand, [2, 3, 4]),
    minGap: pick(rand, [2, 3, 4, 5, 6]),
    maxGap: pick(rand, [8, 12]),
    minStd: pick(rand, [2, 3, 4, 5]),
    maxStd: pick(rand, [5, 6, 7, 8.5, 10]),
    minTradeValue: pick(rand, [20e6, 30e6, 50e6, 100e6]),
    maxRange: pick(rand, [10, 12, 14, 20]),
    minRsi: pick(rand, [45, 50, 55, 60, 65]),
    maxRsi: pick(rand, [90, 95, 100]),
    maxChasePct: pick(rand, [8, 12, 20, 100]),
    minRewardRisk: pick(rand, [-99, -1, 0, 0.5]),
    marketFloor: pick(rand, [-1, -0.5, 0]),
    themeFloor: pick(rand, [-1, -0.5, 0]),
    globalFloor: pick(rand, [-1.5, -0.8, -0.3]),
    asiaFloor: pick(rand, [-1.2, -0.6, -0.2]),
    requireMa20Rising: pick(rand, [false, false, true]),
    excludeHighVolumeDistribution: pick(rand, [true, true, false]),
    minDistanceToMa20Pct: pick(rand, [-100, 3, 6, 8, 10]),
    maxDistanceToMa20Pct: pick(rand, [15, 20, 30, 100]),
    minVolumeRatio1To20: pick(rand, [0, 0.7, 1, 1.5, 2]),
    maxVolumeRatio1To20: pick(rand, [3, 5, 10, 100]),
    minIntradayMomentum20Pct: pick(rand, [-100, 0, 3, 6, 10]),
    maxOvernightMomentum20Pct: pick(rand, [0, 3, 6, 10, 100]),
    minNearYearHigh: pick(rand, [0, 0.7, 0.8, 0.9]),
    maxNearYearHigh: pick(rand, [0.95, 1, 100]),
    minAtr14Pct: pick(rand, [0, 2, 3, 4]),
    maxAtr14Pct: pick(rand, [4, 6, 8, 100]),
    minBollingerPercentB: pick(rand, [-100, 0.5, 0.8, 1]),
    maxBollingerPercentB: pick(rand, [1, 1.2, 1.5, 100]),
    minBollingerBandwidthPct: pick(rand, [0, 8, 15, 25]),
    maxBollingerBandwidthPct: pick(rand, [15, 25, 40, 100]),
    maxVolatilityCompression: pick(rand, [0.6, 0.9, 1.2, 100]),
    minStochastic14: pick(rand, [0, 50, 70, 80]),
    maxStochastic14: pick(rand, [80, 90, 100]),
    requireDirectionalTrend: pick(rand, [false, false, true]),
    requireDonchianBreakout: pick(rand, [false, false, true]),
    priceVolumeMode: pick(rand, ['none', 'exclude_flat_down', 'momentum_only', 'price_volume_up']),
    regimeMode: pick(rand, ['none', 'none', 'avoid_both', 'require_up_continuation']),
    regimeSlowMa: pick(rand, [20, 40, 60, 120]),
    regimeMomentumDays: pick(rand, [3, 5, 10, 20]),
    regimeMomentumThreshold: pick(rand, [0, -1, -2]),
    standardPct: pick(rand, [15, 20, 25, 30]),
    defensivePct: pick(rand, [10, 15, 20]),
    exploratoryPct: pick(rand, [20, 25, 30, 35]),
    maxPositionPct: pick(rand, [40, 50, 60]),
    strongBoost: pick(rand, [1, 1.25, 1.5]),
    edgeRewardRisk: pick(rand, [2, 2.5, 3]),
    edgeGapPct: pick(rand, [1.5, 2, 2.5]),
    edgeBoost: pick(rand, [1, 1.25, 1.5, 2]),
    momentumGapPct: pick(rand, [3, 4, 5, 6]),
    momentumStdPct: pick(rand, [3, 4, 5]),
    momentumBoost: pick(rand, [1, 1.25, 1.5, 2]),
    accountRiskPct: pick(rand, [1.5, 1.75, 2]),
    maxOpenPositions: pick(rand, [2, 3, 4]),
    rankMode: pick(rand, ['momentum', 'technicalMomentum', 'gap', 'confirmations', 'stability']),
    profitLockPct: pick(rand, [10, 11, 12]),
    profitLockAction: pick(rand, ['block', 'exit_next_open']),
    lossBrakePct: pick(rand, [null, -0.5, -1]),
    lossBrakeAction: 'exit_next_open',
    monthPeakTriggerPct: pick(rand, [null, 1, 2, 3, 5]),
    monthGivebackPct: pick(rand, [0.5, 1, 1.5, 2, 3]),
    monthDrawdownAction: pick(rand, ['block', 'exit_next_open']),
    recoveryMinRewardRisk: pick(rand, [-99, -1, 0, 0.5]),
    recoveryMinGapPct: pick(rand, [0, 1.25, 1.5, 1.75, 2, 2.5]),
    starterRiskPct: pick(rand, [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]),
    riskBoostAfterPct: pick(rand, [0, 0.5, 1, 2, 3])
  };
}

function targetedFactorConfigs(base) {
  const rows = [];
  for (const minIntradayMomentum20Pct of [-100, 6, 10]) {
    for (const minNearYearHigh of [0, 0.9, 0.97]) {
      for (const maxOvernightMomentum20Pct of [3, 10, 100]) {
        for (const regimeMode of ['none', 'require_up_continuation']) {
          for (const minScore of [65, 75]) {
            for (const minGap of [0, 2]) {
              for (const rankMode of ['gap', 'technicalMomentum']) {
                for (const priceVolumeMode of ['none', 'exclude_flat_down']) {
                  rows.push({
                    ...base,
                    buyOnly: false,
                    minScore,
                    buyConfirmations: 1,
                    watchConfirmations: 2,
                    minGap,
                    maxGap: 12,
                    minStd: 1.5,
                    maxStd: 10,
                    minTradeValue: 30e6,
                    maxRange: 20,
                    minRsi: 45,
                    maxRsi: 95,
                    maxChasePct: 100,
                    minRewardRisk: -99,
                    marketFloor: -1,
                    themeFloor: -1,
                    globalFloor: -1.5,
                    asiaFloor: -1.2,
                    minIntradayMomentum20Pct,
                    maxOvernightMomentum20Pct,
                    minNearYearHigh,
                    maxNearYearHigh: 100,
                    priceVolumeMode,
                    regimeMode,
                    rankMode,
                    standardPct: 40,
                    defensivePct: 20,
                    exploratoryPct: 25,
                    maxPositionPct: 60,
                    accountRiskPct: 2,
                    maxOpenPositions: 6,
                    profitLockPct: null,
                    lossBrakePct: null,
                    monthPeakTriggerPct: null,
                    exitRule: { holdDays: 10, trail: null, noFollow: false }
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return rows;
}

function targetedCapitalConfigs(base) {
  const rows = [];
  for (const standardPct of [20, 30, 40, 60]) {
    for (const accountRiskPct of [1, 1.5, 2]) {
      for (const maxOpenPositions of [2, 4, 6]) {
        for (const lossBrakePct of [null, -1, -2, -5]) {
          for (const profitLockPct of [null, 10]) {
            for (const transitionPositionMultiplier of [0, 0.25, 0.5, 1]) {
              rows.push({
                ...base,
                collectTrades: false,
                standardPct,
                defensivePct: Math.min(standardPct, 40),
                exploratoryPct: Math.min(standardPct, 40),
                maxPositionPct: 100,
                accountRiskPct,
                starterRiskPct: accountRiskPct,
                maxOpenPositions,
                lossBrakePct,
                lossBrakeAction: 'exit_next_open',
                profitLockPct,
                profitLockAction: 'block',
                regimeMode: 'none',
                transitionPositionMultiplier
              });
            }
          }
        }
      }
    }
  }
  return rows;
}

function targetedIndicatorConfigs(base) {
  const rows = [];
  const indicatorSets = [
    {},
    { requireDonchianBreakout: true },
    { requireDirectionalTrend: true },
    { minBollingerPercentB: 1 },
    { minBollingerPercentB: 0.8, maxBollingerPercentB: 1.2 },
    { maxVolatilityCompression: 0.9 },
    { minAtr14Pct: 2, maxAtr14Pct: 6 },
    { minAtr14Pct: 4 },
    { minAtr14Pct: 6 },
    { minBollingerBandwidthPct: 15 },
    { minBollingerBandwidthPct: 25 },
    { minAtr14Pct: 6, minBollingerBandwidthPct: 25 },
    { minStochastic14: 70, maxStochastic14: 100 },
    { minAtr14Pct: 4, minStochastic14: 70, maxStochastic14: 100 },
    { minAtr14Pct: 4, minBollingerBandwidthPct: 15 },
    { minBollingerBandwidthPct: 15, minStochastic14: 70, maxStochastic14: 100 },
    {
      minAtr14Pct: 4,
      minBollingerBandwidthPct: 15,
      minStochastic14: 70,
      maxStochastic14: 100
    },
    { minAtr14Pct: 4, requireDonchianBreakout: true },
    { minAtr14Pct: 4, requireDirectionalTrend: true },
    { requireDonchianBreakout: true, requireDirectionalTrend: true },
    { minBollingerPercentB: 1, maxVolatilityCompression: 0.9 }
  ];
  for (const indicators of indicatorSets) {
    for (const blackSwanMode of ['none', 'cash']) {
      for (const blackSwanDayDropPct of [-2, -3, -5]) {
        for (const blackSwanFiveDayDropPct of [-5, -8, -12]) {
          for (const blackSwanVol20Pct of [25, 35, 50]) {
            rows.push({
              ...base,
              ...indicators,
              collectTrades: false,
              blackSwanMode,
              blackSwanDayDropPct,
              blackSwanFiveDayDropPct,
              blackSwanVol20Pct
            });
          }
        }
      }
    }
  }
  return rows;
}

function targetedRankConfigs(base) {
  const rows = [];
  const overlays = [
    {},
    { minBollingerBandwidthPct: 15, minStochastic14: 70, maxStochastic14: 100 },
    { minAtr14Pct: 4 },
    {
      minAtr14Pct: 4,
      minBollingerBandwidthPct: 15,
      minStochastic14: 70,
      maxStochastic14: 100
    }
  ];
  for (const overlay of overlays) {
    for (const rankMode of [
      'technicalMomentum',
      'volatilityTrend',
      'breakoutQuality',
      'intradayEdge',
      'riskAdjustedMomentum'
    ]) {
      for (const maxOpenPositions of [2, 4, 6]) {
        for (const accountRiskPct of [1, 1.5, 2]) {
          rows.push({
            ...base,
            ...overlay,
            rankMode,
            maxOpenPositions,
            accountRiskPct,
            starterRiskPct: accountRiskPct,
            collectTrades: false
          });
        }
      }
    }
  }
  return rows;
}

function targetedBlackSwanConfigs(base) {
  const rows = [];
  for (const blackSwanDayDropPct of [-1.5, -2, -3]) {
    for (const blackSwanFiveDayDropPct of [-4, -5, -8]) {
      for (const blackSwanVol20Pct of [25, 35, 50]) {
        for (const blackSwanAction of ['block', 'exit_next_open']) {
          rows.push({
            ...base,
            blackSwanMode: 'cash',
            blackSwanAction,
            blackSwanDayDropPct,
            blackSwanFiveDayDropPct,
            blackSwanVol20Pct,
            collectTrades: false
          });
        }
      }
    }
  }
  return rows;
}

function targetedPortfolioRiskConfigs(base) {
  const rows = [];
  for (const maxOpenPositions of [2, 3, 4]) {
    for (const maxPositionsPerTheme of [1, 2]) {
      for (const accountRiskPct of [1, 1.5, 2]) {
        for (const monthlyEquityBrakePct of [null, -2, -3, -5]) {
          rows.push({
            ...base,
            maxOpenPositions,
            maxPositionsPerTheme,
            accountRiskPct,
            starterRiskPct: accountRiskPct,
            monthlyEquityBrakePct,
            collectTrades: false
          });
        }
      }
    }
  }
  return rows;
}

function balancedScore(result) {
  return result.full.hit * 5
    - result.full.negative * 2
    + result.full.average
    + Math.min(
      result.train.hit / result.train.months,
      result.test.hit / result.test.months
    ) * 20;
}

function compareBalanced(a, b) {
  return balancedScore(b) - balancedScore(a)
    || b.full.hit - a.full.hit
    || a.full.negative - b.full.negative
    || b.full.average - a.full.average;
}

async function main() {
  const payload = JSON.parse(await fs.readFile(INPUT, 'utf8'));
  const candidates = payload.candidateTrades || [];
  const datasetSignature = hash({
    searchSpaceVersion: SEARCH_SPACE_VERSION,
    sourceGeneratedAt: payload.generatedAt,
    startDate: payload.startDate,
    endDate: payload.endDate,
    entryMode: payload.assumptions?.entryMode,
    candidates: candidates.length
  });
  let ledger = { version: 1, datasets: {} };
  try {
    ledger = JSON.parse(await fs.readFile(SEARCH_LEDGER, 'utf8'));
  } catch {
    // The first search creates the ledger.
  }
  const datasetLedger = ledger.datasets[datasetSignature] || {
    sourceGeneratedAt: payload.generatedAt,
    entryMode: payload.assumptions?.entryMode || null,
    startDate: payload.startDate,
    endDate: payload.endDate,
    candidates: candidates.length,
    hashes: [],
    runs: []
  };
  const testedHashes = new Set(datasetLedger.hashes);
  const newHashes = [];
  const marketPayload = JSON.parse(await fs.readFile(MARKET_HISTORY, 'utf8'));
  const marketRegimes = buildMarketRegimes(marketPayload.benchmark || []);
  for (const trade of candidates) trade.marketRegime = marketRegimes.get(trade.signalDate) || null;
  const months = monthKeys(payload.startDate, payload.endDate);
  const formalCandidates = candidates.filter(trade => trade.signal !== WAIT_SIGNAL);
  const broadCandidates = candidates.filter(trade => trade.signalScore >= 65);
  const formalDays = buildDays(formalCandidates);
  const broadDays = buildDays(broadCandidates);
  const tenDayDays = buildDays(broadCandidates.map(trade => applyExitRule(trade, {
    holdDays: 10,
    trail: null,
    noFollow: false
  })));
  if (process.argv.includes('--diagnose-best')) {
    const search = JSON.parse(await fs.readFile(OUTPUT, 'utf8'));
    const configs = {
      targetFirst: search.top[0].config,
      balanced: search.bestBalanced.config,
      cashFirst: search.bestCashFirst.config
    };
    const diagnostics = {};
    for (const [name, sourceConfig] of Object.entries(configs)) {
      const config = { ...sourceConfig, collectTrades: true };
      const sourceDays = config.exitRule
        ? buildDays(broadCandidates.map(trade => applyExitRule(trade, config.exitRule)))
        : broadDays;
      diagnostics[name] = simulate(sourceDays, months, config, marketRegimes);
    }
    await fs.writeFile(DIAGNOSTIC_OUTPUT, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      sourceGeneratedAt: payload.generatedAt,
      ...diagnostics
    }, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: DIAGNOSTIC_OUTPUT.pathname,
    targetFirst: {
      full: diagnostics.targetFirst.full,
      trades: diagnostics.targetFirst.trades
    },
    balanced: {
      full: diagnostics.balanced.full,
      trades: diagnostics.balanced.trades
    },
    cashFirst: {
        full: diagnostics.cashFirst.full,
        trades: diagnostics.cashFirst.trades
      }
    }, null, 2));
    return;
  }
  const baselineConfig = {
    buyOnly: false,
    minScore: 70,
    buyConfirmations: 2,
    watchConfirmations: 4,
    minGap: 0,
    maxGap: 8,
    minStd: 2,
    maxStd: 8.5,
    minTradeValue: 100e6,
    maxRange: 14,
    minRsi: 0,
    maxRsi: 100,
    maxChasePct: 100,
    minRewardRisk: 0,
    marketFloor: -1,
    themeFloor: -1,
    globalFloor: -1.5,
    asiaFloor: -1.2,
    requireMa20Rising: false,
    excludeHighVolumeDistribution: true,
    minDistanceToMa20Pct: -100,
    maxDistanceToMa20Pct: 100,
    minVolumeRatio1To20: 0,
    maxVolumeRatio1To20: 100,
    minIntradayMomentum20Pct: -100,
    maxOvernightMomentum20Pct: 100,
    minNearYearHigh: 0,
    maxNearYearHigh: 100,
    priceVolumeMode: 'exclude_flat_down',
    regimeMode: 'none',
    regimeSlowMa: 40,
    regimeMomentumDays: 10,
    regimeMomentumThreshold: -1,
    standardPct: 44,
    defensivePct: 20,
    exploratoryPct: 20,
    maxPositionPct: 60,
    strongBoost: 1.5,
    edgeRewardRisk: 3,
    edgeGapPct: 3,
    edgeBoost: 1,
    momentumGapPct: 5,
    momentumStdPct: 4,
    momentumBoost: 1,
    accountRiskPct: 2,
    maxOpenPositions: 8,
    rankMode: 'gap',
    profitLockPct: null,
    profitLockAction: 'block',
    lossBrakePct: null,
    lossBrakeAction: 'exit_next_open',
    monthPeakTriggerPct: null,
    monthGivebackPct: 2,
    monthDrawdownAction: 'block',
    recoveryMinRewardRisk: 0,
    recoveryMinGapPct: 0,
    starterRiskPct: 2,
    riskBoostAfterPct: 0
  };
  const rand = random(20260609 + datasetLedger.runs.length * 100003);
  const results = [];
  let previousOutput = null;
  try {
    previousOutput = JSON.parse(await fs.readFile(OUTPUT, 'utf8'));
    if (previousOutput.datasetSignature === datasetSignature
      && previousOutput.inputEntryMode === payload.assumptions?.entryMode) {
      const historical = [
        ...(previousOutput.top || []),
        ...(previousOutput.cashFirstTop || []),
        ...(previousOutput.balancedTop || []),
        ...(previousOutput.indicatorTop || [])
      ];
      for (const result of historical) {
        const clean = { ...result, config: { ...result.config } };
        delete clean.config.collectTrades;
        delete clean.closedTrades;
        if (!results.some(row => hash(row.config) === hash(clean.config))) results.push(clean);
      }
    }
  } catch {
    // No prior result exists for the current dataset.
  }
  try {
    const diagnostics = JSON.parse(await fs.readFile(DIAGNOSTIC_OUTPUT, 'utf8'));
    const rows = diagnostics.sourceGeneratedAt === payload.generatedAt
      ? [diagnostics.targetFirst, diagnostics.cashFirst].filter(Boolean)
      : [];
    for (const result of rows) {
      const clean = { ...result, config: { ...result.config } };
      delete clean.config.collectTrades;
      delete clean.closedTrades;
      if (!results.some(row => hash(row.config) === hash(clean.config))) results.push(clean);
    }
  } catch {
    // Diagnostics are optional historical best results.
  }
  let evaluated = 0;
  let skippedDuplicates = 0;
  const evaluate = (days, config, force = false) => {
    const configHash = hash(config);
    if (!force && testedHashes.has(configHash)) {
      skippedDuplicates += 1;
      return null;
    }
    if (!testedHashes.has(configHash)) {
      testedHashes.add(configHash);
      newHashes.push(configHash);
    }
    const result = simulate(days, months, config, marketRegimes);
    results.push(result);
    evaluated += 1;
    return result;
  };
  const baseline = evaluate(formalDays, baselineConfig, true);
  let refineSeed = baselineConfig;
  if (previousOutput?.inputEntryMode === payload.assumptions?.entryMode) {
      refineSeed = [...(previousOutput.top || []), ...(previousOutput.cashFirstTop || [])]
        .sort(compareBalanced)[0]?.config || baselineConfig;
  }
  const seedConfig = { ...refineSeed };
  delete seedConfig.exitRule;
  delete seedConfig.collectTrades;
  evaluate(broadDays, seedConfig, true);
  const riskSeed = previousOutput?.indicatorTop
    ?.filter(result => result.full.average >= 2)
    .sort((a, b) => a.full.negative - b.full.negative
      || b.maxDrawdownPct - a.maxDrawdownPct
      || b.full.hit - a.full.hit)[0]?.config;
  const targetSeed = (RISK_ONLY || EXITS_ONLY)
    ? previousOutput?.bestBalanced?.config || riskSeed
    : previousOutput?.top?.[0]?.config;
  const indicatorResults = previousOutput?.datasetSignature === datasetSignature
    ? [...(previousOutput.indicatorTop || [])]
    : [];
  if (targetSeed) {
    const cleanTargetSeed = { ...targetSeed };
    delete cleanTargetSeed.collectTrades;
    const targetDays = cleanTargetSeed.exitRule
      ? buildDays(broadCandidates.map(trade => applyExitRule(trade, cleanTargetSeed.exitRule)))
      : broadDays;
    if (!INDICATORS_ONLY && !EXITS_ONLY) {
      for (const config of targetedCapitalConfigs(cleanTargetSeed)) {
        evaluate(targetDays, config);
      }
    }
    if (!RISK_ONLY && !EXITS_ONLY) {
      for (const config of targetedIndicatorConfigs(cleanTargetSeed)) {
        const result = evaluate(targetDays, config);
        if (result) indicatorResults.push(result);
      }
      for (const config of targetedRankConfigs(cleanTargetSeed)) {
        const result = evaluate(targetDays, config);
        if (result) indicatorResults.push(result);
      }
    }
    if (!CAPITAL_ONLY && !INDICATORS_ONLY) {
      for (const config of targetedBlackSwanConfigs(cleanTargetSeed)) {
        evaluate(targetDays, config);
      }
    }
    if (RISK_ONLY) {
      for (const config of targetedPortfolioRiskConfigs(cleanTargetSeed)) {
        evaluate(targetDays, config);
      }
    }
    if (EXITS_ONLY) {
      for (const rule of targetedExitRules()) {
        const adjustedDays = buildDays(broadCandidates.map(trade => applyExitRule(trade, rule)));
        evaluate(adjustedDays, {
          ...cleanTargetSeed,
          exitRule: rule,
          collectTrades: false
        });
      }
    }
  }
  if (!CAPITAL_ONLY && !INDICATORS_ONLY && !RISK_ONLY && !EXITS_ONLY) {
    for (const config of targetedFactorConfigs(baselineConfig)) {
      evaluate(tenDayDays, config);
    }
  }
  for (let index = 0; index < (REFINE_ONLY || CAPITAL_ONLY || INDICATORS_ONLY || RISK_ONLY || EXITS_ONLY ? 0 : TESTS); index += 1) {
    evaluate(formalDays, randomConfig(rand));
  }
  for (let index = 0; index < (REFINE_ONLY || CAPITAL_ONLY || INDICATORS_ONLY || RISK_ONLY || EXITS_ONLY ? 0 : BROAD_TESTS); index += 1) {
    const config = randomConfig(rand);
    config.buyOnly = false;
    config.minScore = pick(rand, [65, 70]);
    evaluate(broadDays, config);
  }
  for (let index = 0; index < (CAPITAL_ONLY || INDICATORS_ONLY || RISK_ONLY || EXITS_ONLY ? 0 : REFINE_TESTS); index += 1) {
    evaluate(broadDays, refineConfig(rand, seedConfig));
  }
  results.sort(compare);
  const entryTop = [
    ...results.slice(0, 35),
    ...[...results].sort(compareCashFirst).slice(0, 35),
    ...[...results].sort(compareBalanced).slice(0, 35)
  ].filter((result, index, rows) => (
    rows.findIndex(other => JSON.stringify(other.config) === JSON.stringify(result.config)) === index
  ));
  const exitResults = [];
  if (!CAPITAL_ONLY && !INDICATORS_ONLY && !RISK_ONLY && !EXITS_ONLY) {
    for (const rule of exitRules()) {
      const adjustedDays = buildDays(broadCandidates.map(trade => applyExitRule(trade, rule)));
      for (const entryResult of entryTop) {
        const result = evaluate(adjustedDays, {
          ...entryResult.config,
          exitRule: rule
        });
        if (result) exitResults.push(result);
      }
    }
  }
  const combined = [...results].sort(compare);
  const noNegative = [...combined]
    .filter(result => result.full.negative === 0)
    .sort(compareCashFirst);
  const drawdownLimited = [...combined]
    .filter(result => result.maxDrawdownPct >= -10)
    .sort(compare);
  const output = {
    generatedAt: new Date().toISOString(),
    sourceGeneratedAt: payload.generatedAt,
    datasetSignature,
    inputEntryMode: payload.assumptions?.entryMode || null,
    requestedTests: evaluated + skippedDuplicates,
    evaluatedTests: evaluated,
    skippedDuplicateTests: skippedDuplicates,
    candidates: candidates.length,
    formalCandidates: formalCandidates.length,
    broadCandidates: broadCandidates.length,
    evaluationMonths: months.slice(1, -1).length,
    exitCombinations: exitResults.length,
    baseline,
    entryTop,
    bestNoNegative: noNegative[0] || null,
    bestDrawdownUnder10: drawdownLimited[0] || null,
    bestCashFirst: [...combined].sort(compareCashFirst)[0],
    bestBalanced: [...combined].sort(compareBalanced)[0],
    indicatorTop: [...indicatorResults].sort(compare).slice(0, 200),
    cashFirstTop: [...combined].sort(compareCashFirst).slice(0, 100),
    balancedTop: [...combined].sort(compareBalanced).slice(0, 100),
    top: combined.slice(0, 100)
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  datasetLedger.hashes.push(...newHashes);
  datasetLedger.runs.push({
    generatedAt: output.generatedAt,
    requestedTests: output.requestedTests,
    evaluatedTests: evaluated,
    skippedDuplicateTests: skippedDuplicates,
    best: output.top[0] ? {
      configHash: hash(output.top[0].config),
      hitMonths: output.top[0].full.hit,
      negativeMonths: output.top[0].full.negative,
      averageMonthlyPct: round(output.top[0].full.average),
      maxDrawdownPct: output.top[0].maxDrawdownPct,
      trades: output.top[0].trades
    } : null
  });
  ledger.datasets[datasetSignature] = datasetLedger;
  await fs.writeFile(SEARCH_LEDGER, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    output: OUTPUT.pathname,
    ledger: SEARCH_LEDGER.pathname,
    requestedTests: output.requestedTests,
    evaluatedTests: evaluated,
    skippedDuplicateTests: skippedDuplicates,
    candidates: candidates.length,
    baseline: {
      full: output.baseline.full,
      maxDrawdownPct: output.baseline.maxDrawdownPct,
      trades: output.baseline.trades
    },
    bestTarget: {
      config: output.top[0].config,
      full: output.top[0].full,
      train: output.top[0].train,
      test: output.top[0].test,
      maxDrawdownPct: output.top[0].maxDrawdownPct,
      trades: output.top[0].trades
    },
    bestBalanced: {
      config: output.bestBalanced.config,
      full: output.bestBalanced.full,
      train: output.bestBalanced.train,
      test: output.bestBalanced.test,
      maxDrawdownPct: output.bestBalanced.maxDrawdownPct,
      trades: output.bestBalanced.trades
    }
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
