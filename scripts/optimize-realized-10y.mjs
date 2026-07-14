import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  buyExecution as sharedBuyExecution,
  sellExecution as sharedSellExecution,
  simulateExit,
  trailingStopPrice
} from './lib/execution-simulator.mjs';

const INPUT = new URL(
  process.env.OPTIMIZE_REALIZED_INPUT || '../data/tw-backtest-10y.json',
  import.meta.url
);
const OUTPUT = new URL('../data/realized-strategy-search-10y.json', import.meta.url);
const DIAGNOSTIC_OUTPUT = new URL('../data/realized-strategy-diagnostics-10y.json', import.meta.url);
const MARKET_HISTORY = new URL('../data/market-regime-history-10y.json', import.meta.url);
const SEARCH_LEDGER = new URL('../data/strategy-search-ledger-10y.json', import.meta.url);
const EXPOSURE_FRONTIER_OUTPUT = new URL('../data/realized-exposure-frontier-10y.json', import.meta.url);
const STOCK_META_OUTPUT = new URL('../data/research/stock-meta-selector-v1.json', import.meta.url);
const STOCK_VARIANT_DIAGNOSTIC_OUTPUT = new URL(
  '../data/research/stock-variant-trade-diagnostics-v1.json',
  import.meta.url
);
const ETF_HISTORY = new URL('../data/research/deployable-etf-rotation-history.json', import.meta.url);
const LEVERAGED_ETF_HISTORY = new URL('../data/research/deployable-etf-history.json', import.meta.url);
const ROLLING_SELECTION_MODE = process.env.ROLLING_SELECTION_MODE || 'highest_average';
const QUICK = process.argv.includes('--quick');
const TESTS = Number(process.env.OPTIMIZE_REALIZED_TESTS || (QUICK ? 2000 : 12000));
const BROAD_TESTS = Number(process.env.OPTIMIZE_REALIZED_BROAD_TESTS || (QUICK ? 500 : 2000));
const REFINE_TESTS = Number(process.env.OPTIMIZE_REALIZED_REFINE_TESTS || (QUICK ? 2000 : 16000));
const REFINE_ONLY = process.argv.includes('--refine-only');
const CAPITAL_ONLY = process.argv.includes('--capital-only');
const INDICATORS_ONLY = process.argv.includes('--indicators-only');
const RISK_ONLY = process.argv.includes('--risk-only');
const EXITS_ONLY = process.argv.includes('--exits-only');
const CORE_WEAK_ONLY = process.argv.includes('--core-weak-only');
const STRONG_CORE_FRONTIER_ONLY = process.argv.includes('--strong-core-frontier-only');
const SELECTED_ALPHA_ONLY = process.argv.includes('--selected-alpha-only');
const ALPHA_RANKING_ONLY = process.argv.includes('--alpha-ranking-only');
const ALPHA_RISK_FRONTIER_ONLY = process.argv.includes('--alpha-risk-frontier-only');
const ALPHA_BREADTH_ONLY = process.argv.includes('--alpha-breadth-only');
const BREADTH_RISK_ONLY = process.argv.includes('--breadth-risk-only');
const BREADTH_EXIT_ONLY = process.argv.includes('--breadth-exit-only');
const MARKET_BAND_ONLY = process.argv.includes('--market-band-only');
const MONTHLY_PYRAMID_ONLY = process.argv.includes('--monthly-pyramid-only');
const STOCK_OBJECTIVE = process.argv.find(argument => argument.startsWith('--stock-objective='))
  ?.split('=')[1] || process.env.STOCK_OBJECTIVE;
const PROFIT5_REFINEMENT_ONLY = process.argv.includes('--profit5-refine-only')
  || CORE_WEAK_ONLY
  || STRONG_CORE_FRONTIER_ONLY
  || SELECTED_ALPHA_ONLY
  || ALPHA_RANKING_ONLY
  || ALPHA_RISK_FRONTIER_ONLY
  || ALPHA_BREADTH_ONLY
  || BREADTH_RISK_ONLY
  || BREADTH_EXIT_ONLY
  || MARKET_BAND_ONLY
  || MONTHLY_PYRAMID_ONLY;
const SEARCH_SPACE_VERSION = 5;
const RESULT_LOGIC_VERSION = 2;
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
const ETF_INITIAL_COST_PCT = BUY_FEE_PCT + BUY_SLIPPAGE_PCT;
const ETF_COSTS = Object.freeze({
  buyFeePct: BUY_FEE_PCT,
  sellFeePct: SELL_FEE_PCT,
  sellTaxPct: 0.1,
  buySlippagePct: BUY_SLIPPAGE_PCT,
  sellSlippagePct: SELL_SLIPPAGE_PCT,
  minimumFee: MIN_FEE,
  boardLotShares: LOT
});

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
  return sharedBuyExecution(price, quantity, {
    buyFeePct: BUY_FEE_PCT,
    buySlippagePct: BUY_SLIPPAGE_PCT,
    minimumFee: MIN_FEE,
    boardLotShares: LOT
  });
}

function sellExecution(price, quantity) {
  return sharedSellExecution(price, quantity, {
    sellFeePct: SELL_FEE_PCT,
    sellTaxPct: SELL_TAX_PCT,
    sellSlippagePct: SELL_SLIPPAGE_PCT,
    minimumFee: MIN_FEE,
    boardLotShares: LOT
  });
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
  if (config.conditionalRegimeStrategy) {
    const strongMarket = trade.marketRegime?.mom20 >= config.strongMarketMom20Pct;
    if (strongMarket) {
      return passes(trade, {
        ...config,
        conditionalRegimeStrategy: false,
        minNearYearHigh: config.strongMarketMinNearYearHigh
      });
    }
    return trade.signalScore >= config.weakMarketMinScore
      && trade.avg20TradeValue >= config.minTradeValue
      && trade.return5Pct >= config.weakMarketMinReturn5Pct
      && trade.volumeRatio1To20 <= config.weakMarketMaxVolumeRatio1To20
      && !isBlackSwan(trade.marketRegime, config);
  }
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
  if (trade.themeMovePct > (config.maxThemeMovePct ?? 100)) return false;
  if (trade.globalCompositePct < config.globalFloor) return false;
  if (trade.globalCompositePct > (config.maxGlobalCompositePct ?? 100)) return false;
  if (trade.asiaCompositePct < config.asiaFloor) return false;
  if (trade.asiaCompositePct > (config.maxAsiaCompositePct ?? 100)) return false;
  if (config.requireMa20Rising && !trade.ma20Rising) return false;
  if (config.excludeHighVolumeDistribution && trade.highVolumeDistribution) return false;
  if (trade.distanceToMa20Pct < (config.minDistanceToMa20Pct ?? -100)) return false;
  if (trade.distanceToMa20Pct > (config.maxDistanceToMa20Pct ?? 100)) return false;
  if (trade.volumeRatio1To20 < (config.minVolumeRatio1To20 ?? 0)) return false;
  if (trade.volumeRatio1To20 > (config.maxVolumeRatio1To20 ?? 100)) return false;
  if (trade.intradayMomentum20Pct < (config.minIntradayMomentum20Pct ?? -100)) return false;
  if (trade.intradayMomentum20Pct > (config.maxIntradayMomentum20Pct ?? 100)) return false;
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
  if (trade.upperWickRatio > (config.maxUpperWickRatio ?? 100)) return false;
  if (config.requireDirectionalTrend && !trade.directionalTrendUp) return false;
  if (config.requireDonchianBreakout && !trade.donchian20Breakout) return false;
  if (config.excludeDonchianBreakout && trade.donchian20Breakout) return false;
  if (config.priceVolumeMode === 'exclude_flat_down'
    && trade.priceVolumeState === 'flat_volume_down') return false;
  if (config.priceVolumeMode === 'exclude_weak_volume'
    && ['price_up_volume_down', 'flat_down_volume_up', 'flat_volume_down'].includes(trade.priceVolumeState)) {
    return false;
  }
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
  if (trade.marketRegime) {
    if (trade.marketRegime.mom1 < (config.minMarketMom1Pct ?? -100)) return false;
    if (trade.marketRegime.mom1 > (config.maxMarketMom1Pct ?? 100)) return false;
    if (trade.marketRegime.mom5 < (config.minMarketMom5Pct ?? -100)) return false;
    if (trade.marketRegime.mom5 > (config.maxMarketMom5Pct ?? 100)) return false;
    if (trade.marketRegime.mom20 < (config.minMarketMom20Pct ?? -100)) return false;
    if (trade.marketRegime.mom20 > (config.maxMarketMom20Pct ?? 100)) return false;
    if (trade.marketRegime.vol20 < (config.minMarketVol20Pct ?? 0)) return false;
    if (trade.marketRegime.vol20 > (config.maxMarketVol20Pct ?? 100)) return false;
  }
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
  if (config.targetMarketVolPct && trade.marketRegime?.vol20) {
    const volatilityMultiplier = config.targetMarketVolPct / trade.marketRegime.vol20;
    pct *= Math.max(
      config.minimumVolatilityMultiplier,
      Math.min(config.maximumVolatilityMultiplier, volatilityMultiplier)
    );
  }
  if (config.momentumCrashMultiplier !== undefined && trade.marketRegime) {
    const regime = trade.marketRegime;
    if (regime.mom20 <= config.momentumCrashMom20Pct
      && regime.mom5 >= config.momentumCrashReboundPct) {
      pct *= config.momentumCrashMultiplier;
    }
  }
  if (config.marketMomentumPositioning && trade.marketRegime) {
    const strong = trade.marketRegime.mom5 >= config.strongMarketMom5Pct
      && trade.marketRegime.mom20 >= config.strongMarketMom20Pct;
    pct *= strong
      ? config.strongMarketPositionMultiplier
      : config.weakMarketPositionMultiplier;
  }
  if (config.conditionalRegimeStrategy && trade.marketRegime) {
    pct = trade.marketRegime.mom20 >= config.strongMarketMom20Pct
      ? config.strongMarketPositionPct
      : config.weakMarketPositionPct;
  }
  if (config.marketBandPositioning && trade.marketRegime) {
    pct = trade.marketRegime.mom20 <= config.marketBandUpperMom20Pct
      ? config.marketBandCorePositionPct
      : config.marketBandHotPositionPct;
  }
  return Math.min(config.maxPositionPct, pct);
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

function executableCandidates(trades, entryMode) {
  if (entryMode !== 'close_confirm') return trades;
  return trades.flatMap(trade => {
    const nextBar = trade.forwardPrices?.[1];
    if (!nextBar?.open) return [];
    return [{
      ...trade,
      signalDate: trade.entryDate,
      entryDate: nextBar.date,
      entryPrice: nextBar.open,
      forwardPrices: trade.forwardPrices.slice(1),
      markPrices: trade.forwardPrices.slice(1).map(row => ({
        date: row.date,
        open: row.open,
        price: row.price,
        high: row.high,
        low: row.low
      })),
      executionTimingPolicy: '收盤確認後下一交易日開盤成交'
    }];
  });
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
  const takeProfit = rule.takeProfitPct
    ? trade.entryPrice * (1 + rule.takeProfitPct / 100)
    : null;
  const holdDays = rule.conditionalRegime
    ? trade.marketRegime?.mom20 >= rule.strongMarketMom20Pct
      ? rule.strongHoldDays
      : rule.weakHoldDays
    : rule.holdDays;
  const endIndex = Math.min(holdDays - 1, forward.length - 1);
  let exitIndex = endIndex;
  let exitPrice = forward[endIndex].price;
  let exitReason = `固定持有 ${holdDays} 天`;
  let maxHigh = trade.entryPrice;

  for (let index = 0; index <= endIndex; index += 1) {
    const day = forward[index];
    maxHigh = Math.max(maxHigh, day.high ?? day.price);
    const trailPrice = trailingStopPrice(trade.entryPrice, maxHigh, rule.trail);
    const executionExit = simulateExit({
      day,
      stopLoss,
      takeProfit,
      trailingStop: trailPrice,
      closeStop: rule.stopMode === 'close'
    });
    if (executionExit?.price) {
      exitIndex = index;
      exitPrice = executionExit.price;
      exitReason = '盤中停損';
      break;
    }
    if (rule.noFollow && index >= 1) {
      const maxAdvancePct = (maxHigh / trade.entryPrice - 1) * 100;
      if (maxAdvancePct < 1.5) {
        exitIndex = index;
        exitPrice = day.price;
        exitReason = '兩日無續航';
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
    if (mode === 'volumeRsiQuality') {
      return trade.signalScore
        + (trade.rsi14 || 0) * 0.5
        + Math.min(trade.volumeRatio1To20 || 0, 4) * 10
        - (trade.std20Pct || 0) * 5
        - Math.max((trade.stochastic14 || 0) - 80, 0);
    }
    if (mode === 'controlledBreakout') {
      return trade.signalScore
        + Math.min(trade.volumeRatio1To20 || 0, 4) * 8
        + Math.min(trade.distanceToMa20Pct || 0, 12) * 2
        - (trade.std20Pct || 0) * 4
        - Math.abs(trade.overnightMomentum20Pct || 0)
        - (trade.upperWickRatio || 0) * 20;
    }
    if (mode === 'intradayReversalQuality') {
      return trade.signalScore
        + Math.min(trade.volumeRatio1To20 || 0, 4) * 8
        - (trade.intradayMomentum20Pct || 0) * 1.5
        - (trade.std20Pct || 0) * 3;
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
  let accountRiskPeak = INITIAL_CAPITAL;
  let accountCooldownUntil = -1;
  let consecutiveLosses = 0;
  let lossStreakCooldownUntil = -1;
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
  const monthlyStartEquity = new Map([[activeMonth, INITIAL_CAPITAL]]);
  const monthlyEndEquity = new Map();
  const closedTrades = config.collectTrades ? [] : null;
  const dailyCurve = config.collectCurve ? [] : null;
  const closePosition = (position, exitPrice, exitDate, month, index, exitReason) => {
    open = open.filter(item => item.trade.tradeId !== position.trade.tradeId);
    cooldownUntilBySymbol.set(position.trade.symbol, index + 5);
    const sell = sellExecution(exitPrice, position.quantity);
    const pnl = sell.net - position.buy.total;
    consecutiveLosses = pnl < 0 ? consecutiveLosses + 1 : 0;
    if (config.consecutiveLossLimit
      && consecutiveLosses >= config.consecutiveLossLimit) {
      lossStreakCooldownUntil = index + (config.lossStreakCooldownDays || 10);
      consecutiveLosses = 0;
    }
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
      monthlyStartEquity.set(month, equity);
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
    if (index === accountCooldownUntil + 1) accountRiskPeak = equity;
    accountRiskPeak = Math.max(accountRiskPeak, equity);
    const accountDrawdownPct = (equity / accountRiskPeak - 1) * 100;
    if (config.accountDrawdownBrakePct
      && index > accountCooldownUntil
      && accountDrawdownPct <= config.accountDrawdownBrakePct) {
      accountCooldownUntil = index + (config.accountCooldownDays || 20);
      liquidateNextOpen = open.length > 0;
    }
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
        || index <= accountCooldownUntil
        || index <= lossStreakCooldownUntil
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
      let plannedPct = plannedPositionPct(trade, config);
      if (config.monthPerformancePositioning) {
        plannedPct *= monthReturnPct >= config.monthPerformanceTriggerPct
          ? config.positiveMonthPositionMultiplier
          : config.negativeMonthPositionMultiplier;
        plannedPct = Math.min(config.maxPositionPct, plannedPct);
      }
      const budget = Math.min(availableCash, equity * plannedPct / 100);
      let activeRiskPct = monthReturnPct < config.riskBoostAfterPct
        ? config.starterRiskPct
        : config.accountRiskPct;
      if (config.monthPerformancePositioning) {
        activeRiskPct *= monthReturnPct >= config.monthPerformanceTriggerPct
          ? config.positiveMonthRiskMultiplier
          : config.negativeMonthRiskMultiplier;
      }
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
    monthlyEndEquity.set(month, equity);
    if (dailyCurve) dailyCurve.push({ date, equity: round(equity, 0) });
  }

  let capital = INITIAL_CAPITAL;
  const monthly = months.map(month => {
    const pnl = monthlyPnl.get(month) || 0;
    const startCapital = capital;
    capital += pnl;
    const startEquity = monthlyStartEquity.get(month);
    const endEquity = monthlyEndEquity.get(month);
    const equityReturnPct = startEquity && endEquity
      ? (endEquity / startEquity - 1) * 100
      : 0;
    return {
      month,
      returnPct: round(equityReturnPct),
      realizedReturnPct: round(pnl / startCapital * 100),
      realizedPnl: round(pnl, 0),
      endingEquity: endEquity ? round(endEquity, 0) : null,
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
    finalCapital: round(equity, 0),
    realizedCapital: round(capital, 0),
    portfolioReturnPct: round((equity / INITIAL_CAPITAL - 1) * 100),
    maxDrawdownPct: round(maxDrawdownPct),
    trades,
    full: stats(complete),
    train: stats(train),
    test: stats(test)
  };
  if (closedTrades) result.closedTrades = closedTrades;
  if (dailyCurve) result.dailyCurve = dailyCurve;
  return result;
}

function compare(a, b) {
  if (STOCK_OBJECTIVE === 'profit5') {
    return profit5StockScore(b) - profit5StockScore(a);
  }
  if (STOCK_OBJECTIVE === 'deployable') {
    return deployableStockScore(b) - deployableStockScore(a);
  }
  return Math.min(b.train.hit / b.train.months, b.test.hit / b.test.months)
      - Math.min(a.train.hit / a.train.months, a.test.hit / a.test.months)
    || b.full.hit - a.full.hit
    || a.full.negative - b.full.negative
    || b.full.worst - a.full.worst
    || b.full.average - a.full.average
    || b.maxDrawdownPct - a.maxDrawdownPct;
}

function compareCashFirst(a, b) {
  if (STOCK_OBJECTIVE === 'profit5') {
    return profit5StockScore(b) - profit5StockScore(a);
  }
  if (STOCK_OBJECTIVE === 'deployable') {
    return deployableStockScore(b) - deployableStockScore(a);
  }
  return a.full.negative - b.full.negative
    || b.full.worst - a.full.worst
    || Math.min(b.train.hit / b.train.months, b.test.hit / b.test.months)
      - Math.min(a.train.hit / a.train.months, a.test.hit / a.test.months)
    || b.full.hit - a.full.hit
    || b.full.average - a.full.average
    || b.maxDrawdownPct - a.maxDrawdownPct;
}

function deployableStockScore(result) {
  const trades = result.trades || 0;
  const drawdown = result.maxDrawdownPct || -100;
  const tradePenalty = trades < 300 ? (300 - trades) * 0.08 : 0;
  const drawdownPenalty = drawdown < -20 ? Math.abs(drawdown + 20) * 0.55 : 0;
  const worstMonthPenalty = result.full.worst < -8 ? Math.abs(result.full.worst + 8) * 0.35 : 0;
  const consistency = Math.min(
    result.train.hit / Math.max(1, result.train.months),
    result.test.hit / Math.max(1, result.test.months)
  ) * 12;
  const negativeMonthPenalty = result.full.negative * 0.08;
  return result.test.average * 3
    + result.full.average
    + consistency
    + Math.min(trades, 600) / 120
    + drawdown * 0.08
    - tradePenalty
    - drawdownPenalty
    - worstMonthPenalty
    - negativeMonthPenalty;
}

function profit5StockScore(result) {
  const trades = result.trades || 0;
  const drawdown = result.maxDrawdownPct || -100;
  const tradePenalty = trades < 300 ? (300 - trades) * 0.12 : 0;
  const drawdownPenalty = drawdown < -20 ? Math.abs(drawdown + 20) * 1.2 : 0;
  const worstMonthPenalty = result.test.worst < -8 ? Math.abs(result.test.worst + 8) * 0.7 : 0;
  const negativeMonthPenalty = result.test.negative * 0.1 + result.full.negative * 0.03;
  const consistency = Math.min(
    result.train.average,
    result.test.average
  );
  return result.test.average * 7
    + result.full.average * 1.5
    + consistency * 2
    + Math.min(trades, 800) / 90
    + Math.max(drawdown, -25) * 0.08
    - tradePenalty
    - drawdownPenalty
    - worstMonthPenalty
    - negativeMonthPenalty;
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
    priceVolumeMode: pick(rand, ['none', 'none', 'exclude_flat_down', 'exclude_weak_volume', 'momentum_only', 'price_volume_up']),
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
    priceVolumeMode: pick(rand, ['none', 'exclude_flat_down', 'exclude_weak_volume', 'momentum_only', 'price_volume_up']),
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
                for (const priceVolumeMode of ['none', 'exclude_flat_down', 'exclude_weak_volume']) {
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
  const stockMomentumFilters = [
    {},
    {
      minMarketMom20Pct: 0.5,
      maxMarketMom20Pct: 4,
      minMarketVol20Pct: 10,
      maxMarketVol20Pct: 22,
      minStd: 1.8,
      minAtr14Pct: 2.5,
      minDistanceToMa20Pct: 5,
      maxDistanceToMa20Pct: 13,
      themeFloor: 0.25,
      maxThemeMovePct: 1.1,
      maxGlobalCompositePct: 0.8
    },
    {
      minMarketMom20Pct: 0.5,
      maxMarketMom20Pct: 7,
      minMarketMom1Pct: 0.2,
      maxMarketMom1Pct: 1.5,
      minAtr14Pct: 4,
      minBollingerBandwidthPct: 10,
      minStochastic14: 80,
      maxDistanceToMa20Pct: 16,
      maxAsiaCompositePct: 1.2
    },
    {
      minMarketMom20Pct: 0.8,
      maxMarketMom20Pct: 4,
      minBollingerPercentB: 0.9,
      maxBollingerPercentB: 1.25,
      minVolumeRatio1To20: 0.7,
      maxVolumeRatio1To20: 5,
      maxOvernightMomentum20Pct: 20,
      minNearYearHigh: 0.9
    },
    {
      minMarketMom20Pct: 0.8,
      maxMarketMom20Pct: 4,
      minAtr14Pct: 2.5,
      maxAtr14Pct: 8,
      minBollingerBandwidthPct: 10,
      maxBollingerBandwidthPct: 30,
      minDistanceToMa20Pct: 6,
      maxDistanceToMa20Pct: 14,
      priceVolumeMode: 'exclude_flat_down'
    }
  ];
  for (const indicators of indicatorSets) {
    for (const stockFilter of stockMomentumFilters) {
      for (const blackSwanMode of ['none', 'cash']) {
        for (const blackSwanDayDropPct of [-2, -3, -5]) {
          for (const blackSwanFiveDayDropPct of [-5, -8, -12]) {
            for (const blackSwanVol20Pct of [25, 35, 50]) {
              rows.push({
                ...base,
                ...indicators,
                ...stockFilter,
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
  for (const maxOpenPositions of [2, 3, 4, 5]) {
    for (const maxPositionsPerTheme of [1, 2]) {
      for (const accountRiskPct of [1, 1.5, 2]) {
        for (const monthlyEquityBrakePct of [null, -2, -3, -5]) {
          for (const accountDrawdownBrakePct of [null, -8, -12]) {
            rows.push({
              ...base,
              maxOpenPositions,
              maxPositionsPerTheme,
              accountRiskPct,
              starterRiskPct: accountRiskPct,
              monthlyEquityBrakePct,
              accountDrawdownBrakePct,
              accountCooldownDays: 15,
              collectTrades: false
            });
          }
        }
      }
    }
  }
  return rows;
}

function targetedProfitExpansionConfigs(base) {
  const rows = [];
  const overlays = [
    { minIntradayMomentum20Pct: 3, maxOvernightMomentum20Pct: 12, minNearYearHigh: 0.9 },
    { minIntradayMomentum20Pct: 6, maxOvernightMomentum20Pct: 10, minNearYearHigh: 0.97 },
    {
      minIntradayMomentum20Pct: 0,
      maxOvernightMomentum20Pct: 8,
      minNearYearHigh: 0.85,
      priceVolumeMode: 'momentum_only'
    }
  ];
  for (const overlay of overlays) {
    for (const rankMode of ['gap', 'intradayEdge']) {
      for (const standardPct of [40, 50]) {
        for (const maxOpenPositions of [5, 6, 8]) {
          for (const accountRiskPct of [1.5, 2]) {
            for (const monthlyEquityBrakePct of [null, -5]) {
              for (const accountDrawdownBrakePct of [null, -10]) {
                rows.push({
                  ...base,
                  ...overlay,
                  rankMode,
                  buyOnly: false,
                  minScore: Math.min(base.minScore ?? 65, 65),
                  buyConfirmations: 1,
                  watchConfirmations: 2,
                  minTradeValue: Math.max(30e6, base.minTradeValue || 30e6),
                  maxRange: Math.min(20, base.maxRange || 20),
                  standardPct,
                  defensivePct: Math.min(standardPct, 25),
                  exploratoryPct: Math.min(standardPct, 30),
                  maxPositionPct: Math.min(60, Math.max(standardPct, 50)),
                  accountRiskPct,
                  starterRiskPct: accountRiskPct,
                  maxOpenPositions,
                  monthlyEquityBrakePct,
                  accountDrawdownBrakePct,
                  accountCooldownDays: 15,
                  consecutiveLossLimit: 5,
                  lossStreakCooldownDays: 8,
                  lossBrakePct: null,
                  profitLockPct: null,
                  collectTrades: false
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

function targetedProfitRiskTradeoffConfigs(base) {
  const rows = [];
  const qualityOverlays = [
    {},
    { minIntradayMomentum20Pct: 3, maxOvernightMomentum20Pct: 12, minNearYearHigh: 0.9 },
    { minIntradayMomentum20Pct: 6, maxOvernightMomentum20Pct: 10, minNearYearHigh: 0.97 },
    { priceVolumeMode: 'exclude_flat_down', maxDistanceToMa20Pct: 16 },
    { minMarketMom20Pct: 0 },
    { minMarketMom20Pct: 0, maxMarketMom20Pct: 10 },
    { minMarketMom20Pct: -1, maxMarketMom20Pct: 8 },
    {
      minIntradayMomentum20Pct: 10,
      minNearYearHigh: 0.99,
      minAtr14Pct: 2,
      maxAtr14Pct: 8,
      priceVolumeMode: 'exclude_weak_volume'
    }
  ];
  for (const overlay of qualityOverlays) {
    for (const rankMode of ['technicalMomentum', 'riskAdjustedMomentum', 'breakoutQuality']) {
      for (const standardPct of [25, 30, 35]) {
        for (const maxOpenPositions of [4, 6]) {
          for (const accountRiskPct of [1.25, 1.5, 2]) {
            for (const monthlyEquityBrakePct of [null, -5]) {
              for (const accountDrawdownBrakePct of [null, -10]) {
                for (const blackSwanMode of ['none', 'cash']) {
                  rows.push({
                    ...base,
                    ...overlay,
                    buyOnly: false,
                    rankMode,
                    standardPct,
                    defensivePct: Math.min(standardPct, 30),
                    exploratoryPct: Math.min(standardPct, 30),
                    maxPositionPct: Math.min(standardPct, 40),
                    maxOpenPositions,
                    accountRiskPct,
                    starterRiskPct: accountRiskPct,
                    monthlyEquityBrakePct,
                    accountDrawdownBrakePct,
                    accountCooldownDays: 20,
                    consecutiveLossLimit: 4,
                    lossStreakCooldownDays: 10,
                    blackSwanMode,
                    blackSwanAction: 'exit_next_open',
                    blackSwanDayDropPct: -2,
                    blackSwanFiveDayDropPct: -5,
                    blackSwanVol20Pct: 35,
                    collectTrades: false
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

function targetedHighReturnBaseRiskConfigs(base) {
  const rows = [];
  for (const monthlyEquityBrakePct of [null, -4, -6, -8]) {
    for (const accountDrawdownBrakePct of [null, -12, -16, -20]) {
      for (const consecutiveLossLimit of [3, 4, 5]) {
        rows.push({
          ...base,
          monthlyEquityBrakePct,
          accountDrawdownBrakePct,
          accountCooldownDays: 15,
          consecutiveLossLimit,
          lossStreakCooldownDays: 8,
          collectTrades: false
        });
      }
    }
  }
  return rows;
}

function targetedHighReturnDrawdownLimiterConfigs(base) {
  const rows = [];
  const overlays = [
    {},
    { minVolumeRatio1To20: 0.7, maxVolumeRatio1To20: 5 },
    { maxOvernightMomentum20Pct: 12 },
    { priceVolumeMode: 'exclude_flat_down', maxUpperWickRatio: 0.7 }
  ];
  const exits = [
    base.exitRule,
    { holdDays: 10, trail: null, noFollow: false, stopLossPct: 5, stopMode: 'close' }
  ].filter(Boolean);
  for (const overlay of overlays) {
    for (const exitRule of exits) {
      for (const standardPct of [32, 40]) {
        for (const maxOpenPositions of [4, 6]) {
          for (const monthlyEquityBrakePct of [-4, -6]) {
            for (const accountDrawdownBrakePct of [-14, -18]) {
              for (const consecutiveLossLimit of [3, 4]) {
                rows.push({
                  ...base,
                  ...overlay,
                  exitRule,
                  standardPct,
                  defensivePct: Math.min(standardPct, 30),
                  exploratoryPct: Math.min(standardPct, 30),
                  maxPositionPct: Math.min(standardPct, 45),
                  maxOpenPositions,
                  accountRiskPct: 1.5,
                  starterRiskPct: 1.5,
                  monthlyEquityBrakePct,
                  accountDrawdownBrakePct,
                  accountCooldownDays: 20,
                  consecutiveLossLimit,
                  lossStreakCooldownDays: 12,
                  blackSwanMode: 'cash',
                  blackSwanAction: 'exit_next_open',
                  blackSwanDayDropPct: -2,
                  blackSwanFiveDayDropPct: -4,
                  blackSwanVol20Pct: 35,
                  collectTrades: false
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

function targetedStatAlphaConfigs(base) {
  const rows = [];
  const alphaFilters = [
    {
      minNearYearHigh: 0.99,
      minIntradayMomentum20Pct: 10,
      minAtr14Pct: 2,
      maxAtr14Pct: 8,
      priceVolumeMode: 'exclude_weak_volume'
    },
    {
      minNearYearHigh: 0.99,
      minIntradayMomentum20Pct: 10,
      minTradeValue: 100e6,
      priceVolumeMode: 'exclude_weak_volume'
    },
    {
      minNearYearHigh: 0.95,
      minIntradayMomentum20Pct: 10,
      minTradeValue: 300e6,
      maxUpperWickRatio: 0.6,
      minAtr14Pct: 2,
      maxAtr14Pct: 8
    },
    {
      minNearYearHigh: 0.99,
      minIntradayMomentum20Pct: 6,
      minAtr14Pct: 2,
      maxAtr14Pct: 8,
      requireMa20Rising: true,
      priceVolumeMode: 'exclude_weak_volume'
    }
  ];
  const exits = [
    { holdDays: 5, trail: null, noFollow: true, stopLossPct: 5, stopMode: 'close' },
    { holdDays: 7, trail: { triggerPct: 5, givebackPct: 4, lockPct: 1 }, noFollow: false, stopLossPct: 5, stopMode: 'close' },
    { holdDays: 10, trail: null, noFollow: false, stopLossPct: 10, stopMode: 'close' },
    { holdDays: 10, trail: { triggerPct: 8, givebackPct: 5, lockPct: 2 }, noFollow: false, stopLossPct: 'volatility', stopMode: 'close' }
  ];
  for (const filter of alphaFilters) {
    for (const exitRule of exits) {
      for (const rankMode of ['riskAdjustedMomentum', 'technicalMomentum', 'breakoutQuality']) {
        for (const standardPct of [25, 30, 35, 40]) {
          for (const maxOpenPositions of [4, 6, 8]) {
            for (const monthlyEquityBrakePct of [null, -5]) {
              rows.push({
                ...base,
                ...filter,
                buyOnly: false,
                minScore: 65,
                buyConfirmations: 1,
                watchConfirmations: 2,
                maxRange: 20,
                minRsi: 45,
                maxRsi: 95,
                excludeHighVolumeDistribution: true,
                rankMode,
                standardPct,
                defensivePct: Math.min(standardPct, 30),
                exploratoryPct: Math.min(standardPct, 30),
                maxPositionPct: Math.min(standardPct, 40),
                maxOpenPositions,
                accountRiskPct: 2,
                starterRiskPct: 2,
                monthlyEquityBrakePct,
                accountDrawdownBrakePct: null,
                blackSwanMode: 'cash',
                blackSwanAction: 'block',
                blackSwanDayDropPct: -2,
                blackSwanFiveDayDropPct: -4,
                blackSwanVol20Pct: 35,
                exitRule,
                collectTrades: false,
                researchVariant: 'profit5_stat_alpha_v1'
              });
            }
          }
        }
      }
    }
  }
  return rows;
}

function targetedHighTurnoverMomentumConfigs(base) {
  const rows = [];
  const filters = [
    {
      minScore: 65,
      minNearYearHigh: 0.95,
      minTradeValue: 30e6,
      marketFloor: -1,
      themeFloor: -1
    }
  ];
  const exits = [
    { holdDays: 10, trail: null, noFollow: false, stopLossPct: 10, stopMode: 'close' }
  ];
  for (const filter of filters) {
    for (const exitRule of exits) {
      for (const rankMode of ['score', 'riskAdjustedMomentum']) {
        for (const standardPct of [15, 20, 25]) {
          for (const maxOpenPositions of [8, 12]) {
            for (const monthlyEquityBrakePct of [null, -6]) {
              for (const accountDrawdownBrakePct of [null, -14]) {
                rows.push({
                  ...base,
                  ...filter,
                  buyOnly: false,
                  buyConfirmations: 1,
                  watchConfirmations: 2,
                  minGap: 0,
                  maxGap: 12,
                  minStd: 1.5,
                  maxStd: 10,
                  maxRange: 20,
                  maxChasePct: 100,
                  minRewardRisk: -99,
                  marketFloor: -1,
                  themeFloor: -1,
                  globalFloor: -1.5,
                  asiaFloor: -1.2,
                  rankMode,
                  standardPct,
                  defensivePct: Math.min(standardPct, 25),
                  exploratoryPct: Math.min(standardPct, 25),
                  maxPositionPct: Math.min(standardPct, 30),
                  maxOpenPositions,
                  accountRiskPct: 2,
                  starterRiskPct: 2,
                  monthlyEquityBrakePct,
                  accountDrawdownBrakePct,
                  accountCooldownDays: 15,
                  consecutiveLossLimit: 5,
                  lossStreakCooldownDays: 8,
                  blackSwanMode: 'cash',
                  blackSwanAction: 'block',
                  blackSwanDayDropPct: -2,
                  blackSwanFiveDayDropPct: -4,
                  blackSwanVol20Pct: 35,
                  exitRule,
                  collectTrades: false,
                  researchVariant: 'profit5_high_turnover_momentum_v1'
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

function targetedHighTurnoverRefinementConfigs(base) {
  const rows = [];
  const filters = [
    {},
    { maxRsi: 85 },
    { maxRsi: 85, maxVolumeRatio1To20: 5 },
    { priceVolumeMode: 'exclude_flat_down' },
    { minNearYearHigh: 0.97 },
    { maxVolumeRatio1To20: 2 },
    { minAtr14Pct: 4, maxAtr14Pct: 6 },
    { minNearYearHigh: 0.95, maxNearYearHigh: 0.99 },
    { minDistanceToMa20Pct: 0, maxDistanceToMa20Pct: 5 },
    { maxIntradayMomentum20Pct: 20, maxVolumeRatio1To20: 2 }
  ];
  const exits = [
    { holdDays: 5, trail: null, noFollow: false, stopLossPct: 7, stopMode: 'close', takeProfitPct: 9 },
    { holdDays: 10, trail: null, noFollow: false, stopLossPct: 10, stopMode: 'close' },
    { holdDays: 10, trail: { triggerPct: 8, givebackPct: 5, lockPct: 2 }, noFollow: false, stopLossPct: 8, stopMode: 'close' }
  ];
  for (const filter of filters) {
    for (const exitRule of exits) {
      for (const rankMode of ['score', 'riskAdjustedMomentum']) {
        for (const standardPct of [10, 15, 18]) {
          for (const maxOpenPositions of [8, 12]) {
            for (const blackSwanAction of ['block']) {
              rows.push({
                ...base,
                ...filter,
                buyOnly: false,
                minScore: 65,
                buyConfirmations: 1,
                watchConfirmations: 2,
                minTradeValue: Math.max(30e6, base.minTradeValue || 30e6),
                minNearYearHigh: filter.minNearYearHigh ?? base.minNearYearHigh ?? 0.95,
                maxRange: Math.min(20, base.maxRange || 20),
                excludeHighVolumeDistribution: true,
                rankMode,
                standardPct,
                defensivePct: standardPct,
                exploratoryPct: standardPct,
                maxPositionPct: standardPct,
                maxOpenPositions,
                accountRiskPct: 1.5,
                starterRiskPct: 1.5,
                monthlyEquityBrakePct: null,
                accountDrawdownBrakePct: null,
                consecutiveLossLimit: 5,
                lossStreakCooldownDays: 8,
                blackSwanMode: 'cash',
                blackSwanAction,
                blackSwanDayDropPct: -2,
                blackSwanFiveDayDropPct: -4,
                blackSwanVol20Pct: 35,
                exitRule,
                collectTrades: false,
                researchVariant: 'profit5_stock_turnover_refine_v1'
              });
            }
          }
        }
      }
    }
  }
  return rows;
}

function targetedAggressiveQualityStockConfigs(base) {
  const rows = [];
  const filters = [
    { maxVolumeRatio1To20: 2 },
    { minAtr14Pct: 4, maxAtr14Pct: 6 },
    { minNearYearHigh: 0.95, maxNearYearHigh: 0.99 },
    { minDistanceToMa20Pct: 0, maxDistanceToMa20Pct: 5 },
    { maxIntradayMomentum20Pct: 20, maxVolumeRatio1To20: 2 }
  ];
  const exits = [
    { holdDays: 7, trail: null, noFollow: false, stopLossPct: 8, stopMode: 'close', takeProfitPct: 12 },
    { holdDays: 10, trail: null, noFollow: false, stopLossPct: 10, stopMode: 'close' },
    { holdDays: 10, trail: { triggerPct: 8, givebackPct: 5, lockPct: 2 }, noFollow: false, stopLossPct: 8, stopMode: 'close' }
  ];
  for (const filter of filters) {
    for (const exitRule of exits) {
      for (const rankMode of ['score', 'riskAdjustedMomentum']) {
        for (const standardPct of [20, 25, 30]) {
          for (const maxOpenPositions of [6, 8]) {
            for (const monthlyEquityBrakePct of [-5, -8]) {
              rows.push({
                ...base,
                ...filter,
                buyOnly: false,
                minScore: 65,
                buyConfirmations: 1,
                watchConfirmations: 2,
                minTradeValue: Math.max(30e6, base.minTradeValue || 30e6),
                maxRange: Math.min(20, base.maxRange || 20),
                excludeHighVolumeDistribution: true,
                rankMode,
                standardPct,
                defensivePct: Math.min(standardPct, 20),
                exploratoryPct: Math.min(standardPct, 20),
                maxPositionPct: standardPct,
                maxOpenPositions,
                accountRiskPct: 1.5,
                starterRiskPct: 1.5,
                monthlyEquityBrakePct,
                accountDrawdownBrakePct: -18,
                accountCooldownDays: 20,
                consecutiveLossLimit: 4,
                lossStreakCooldownDays: 10,
                blackSwanMode: 'cash',
                blackSwanAction: 'block',
                blackSwanDayDropPct: -2,
                blackSwanFiveDayDropPct: -4,
                blackSwanVol20Pct: 35,
                exitRule,
                collectTrades: false,
                researchVariant: 'profit5_aggressive_quality_stock_v1'
              });
            }
          }
        }
      }
    }
  }
  return rows;
}

function targetedMarketRegimeAlphaConfigs(base) {
  const rows = [];
  const filters = [
    { minMarketMom5Pct: 1 },
    { minMarketMom5Pct: 1, minMarketMom20Pct: -3 },
    { minMarketMom5Pct: 1, minMarketMom20Pct: 0 },
    { minMarketMom5Pct: 1, minMarketMom20Pct: 1 },
    { minMarketMom5Pct: 1, maxRsi: 70 }
  ];
  const exits = [
    { holdDays: 7, trail: null, noFollow: false, stopLossPct: 7, stopMode: 'close', takeProfitPct: 12 },
    { holdDays: 10, trail: null, noFollow: false, stopLossPct: 10, stopMode: 'close' }
  ];
  for (const filter of filters) {
    for (const exitRule of exits) {
      for (const rankMode of ['score', 'riskAdjustedMomentum']) {
        for (const standardPct of [18, 25, 32]) {
          for (const maxOpenPositions of [4, 8]) {
            for (const accountRiskPct of [1.5, 2.5]) {
              for (const monthlyEquityBrakePct of [null]) {
                for (const accountDrawdownBrakePct of [null, -18]) {
                  rows.push({
                    ...base,
                    ...filter,
                    buyOnly: false,
                    minScore: 65,
                    buyConfirmations: 1,
                    watchConfirmations: 2,
                    minTradeValue: Math.max(30e6, base.minTradeValue || 30e6),
                    minNearYearHigh: Math.max(0.95, base.minNearYearHigh || 0),
                    maxRange: Math.min(20, base.maxRange || 20),
                    excludeHighVolumeDistribution: true,
                    rankMode,
                    standardPct,
                    defensivePct: standardPct,
                    exploratoryPct: standardPct,
                    maxPositionPct: standardPct,
                    maxOpenPositions,
                    accountRiskPct,
                    starterRiskPct: accountRiskPct,
                    monthlyEquityBrakePct,
                    accountDrawdownBrakePct,
                    accountCooldownDays: 20,
                    consecutiveLossLimit: 4,
                    lossStreakCooldownDays: 10,
                    blackSwanMode: 'cash',
                    blackSwanAction: 'block',
                    blackSwanDayDropPct: -2,
                    blackSwanFiveDayDropPct: -4,
                    blackSwanVol20Pct: 35,
                    exitRule,
                    collectTrades: false,
                    researchVariant: 'profit5_market_regime_alpha_v1'
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

function targetedStrongCoreFrontierConfigs(base) {
  const rows = [];
  const filters = [
    { minMarketMom5Pct: -100, minMarketMom20Pct: 1 },
    { minMarketMom5Pct: -100, minMarketMom20Pct: 2 },
    { minMarketMom5Pct: -100, minMarketMom20Pct: 3 },
    { minMarketMom5Pct: -100, minMarketMom20Pct: 4 },
    { minMarketMom5Pct: -100, minMarketMom20Pct: 5 }
  ];
  const exits = [
    { holdDays: 5, trail: null, noFollow: false, stopLossPct: 7, stopMode: 'close' },
    { holdDays: 7, trail: null, noFollow: false, stopLossPct: 7, stopMode: 'close' },
    { holdDays: 10, trail: null, noFollow: false, stopLossPct: 10, stopMode: 'close' },
    { holdDays: 15, trail: null, noFollow: false, stopLossPct: 10, stopMode: 'close' }
  ];
  for (const filter of filters) {
    for (const exitRule of exits) {
      for (const rankMode of ['score']) {
        for (const standardPct of [20, 25, 32, 40, 50, 60]) {
          for (const maxOpenPositions of [4, 8, 12]) {
            for (const accountRiskPct of [2, 2.5, 3, 4, 5]) {
              rows.push({
                ...base,
                ...filter,
                buyOnly: false,
                minScore: 65,
                buyConfirmations: 1,
                watchConfirmations: 2,
                minTradeValue: 30e6,
                minNearYearHigh: 0.95,
                maxRange: 20,
                excludeHighVolumeDistribution: true,
                rankMode,
                standardPct,
                defensivePct: standardPct,
                exploratoryPct: standardPct,
                maxPositionPct: standardPct,
                maxOpenPositions,
                accountRiskPct,
                starterRiskPct: accountRiskPct,
                monthlyEquityBrakePct: null,
                accountDrawdownBrakePct: null,
                consecutiveLossLimit: 5,
                lossStreakCooldownDays: 8,
                blackSwanMode: 'cash',
                blackSwanAction: 'block',
                blackSwanDayDropPct: -2,
                blackSwanFiveDayDropPct: -4,
                blackSwanVol20Pct: 35,
                exitRule,
                collectTrades: false,
                researchVariant: 'profit5_strong_stock_core_frontier_v2'
              });
            }
          }
        }
      }
    }
  }
  return rows;
}

function targetedSelectedTradeAlphaConfigs(base) {
  const factors = [
    { maxMarketMom20Pct: 5 },
    { maxStochastic14: 80 },
    { maxOvernightMomentum20Pct: 6 },
    { maxMarketVol20Pct: 15 },
    { minRsi: 65 },
    { minVolumeRatio1To20: 1.5 },
    { maxStd: 3 },
    { maxIntradayMomentum20Pct: 0 },
    { minMarketMom5Pct: 2 },
    { globalFloor: 0 },
    { maxThemeMovePct: 1 },
    { maxBollingerPercentB: 1 },
    { maxAtr14Pct: 4 },
    { minGap: 1 },
    { excludeDonchianBreakout: true }
  ];
  const profiles = [{}];
  for (const factor of factors) profiles.push(factor);
  for (let left = 0; left < factors.length; left += 1) {
    for (let right = left + 1; right < factors.length; right += 1) {
      profiles.push({ ...factors[left], ...factors[right] });
    }
  }
  const rows = [];
  for (const profile of profiles) {
    for (const standardPct of [20, 25, 32]) {
      for (const maxOpenPositions of [4, 8, 12]) {
        for (const accountRiskPct of [2, 2.5]) {
          for (const holdDays of [7, 10]) {
            rows.push({
              ...base,
              ...profile,
              buyOnly: false,
              minScore: 65,
              buyConfirmations: 1,
              watchConfirmations: 2,
              minTradeValue: 30e6,
              minNearYearHigh: 0.95,
              minMarketMom1Pct: -100,
              minMarketMom5Pct: profile.minMarketMom5Pct ?? -100,
              minMarketMom20Pct: 3,
              maxMarketMom20Pct: profile.maxMarketMom20Pct ?? 100,
              maxRange: 20,
              excludeHighVolumeDistribution: true,
              rankMode: 'score',
              standardPct,
              defensivePct: standardPct,
              exploratoryPct: standardPct,
              maxPositionPct: standardPct,
              maxOpenPositions,
              accountRiskPct,
              starterRiskPct: accountRiskPct,
              monthlyEquityBrakePct: null,
              accountDrawdownBrakePct: null,
              consecutiveLossLimit: 5,
              lossStreakCooldownDays: 8,
              blackSwanMode: 'cash',
              blackSwanAction: 'block',
              blackSwanDayDropPct: -2,
              blackSwanFiveDayDropPct: -4,
              blackSwanVol20Pct: 35,
              exitRule: {
                holdDays,
                trail: null,
                noFollow: false,
                stopLossPct: 10,
                stopMode: 'close'
              },
              collectTrades: false,
              researchVariant: 'profit5_selected_trade_alpha_v1'
            });
          }
        }
      }
    }
  }
  return rows;
}

function targetedAlphaRankingConfigs(base) {
  const profiles = [
    {},
    { maxThemeMovePct: 1 },
    { minVolumeRatio1To20: 1.5 },
    { minRsi: 65 },
    { maxStochastic14: 80 }
  ];
  const rows = [];
  for (const profile of profiles) {
    for (const rankMode of [
      'score',
      'volumeRsiQuality',
      'controlledBreakout',
      'intradayReversalQuality'
    ]) {
      for (const standardPct of [15, 20, 25, 32]) {
        for (const maxOpenPositions of [8, 12, 16]) {
          for (const accountRiskPct of [2, 2.5, 3]) {
            for (const holdDays of [7, 10]) {
              rows.push({
                ...base,
                ...profile,
                buyOnly: false,
                minScore: 65,
                buyConfirmations: 1,
                watchConfirmations: 2,
                minTradeValue: 30e6,
                minNearYearHigh: 0.95,
                minMarketMom1Pct: -100,
                minMarketMom5Pct: -100,
                minMarketMom20Pct: 3,
                maxMarketMom20Pct: 100,
                maxRange: 20,
                globalFloor: 0,
                excludeHighVolumeDistribution: true,
                rankMode,
                standardPct,
                defensivePct: standardPct,
                exploratoryPct: standardPct,
                maxPositionPct: standardPct,
                maxOpenPositions,
                accountRiskPct,
                starterRiskPct: accountRiskPct,
                monthlyEquityBrakePct: null,
                accountDrawdownBrakePct: null,
                consecutiveLossLimit: 5,
                lossStreakCooldownDays: 8,
                blackSwanMode: 'cash',
                blackSwanAction: 'block',
                blackSwanDayDropPct: -2,
                blackSwanFiveDayDropPct: -4,
                blackSwanVol20Pct: 35,
                exitRule: {
                  holdDays,
                  trail: null,
                  noFollow: false,
                  stopLossPct: 10,
                  stopMode: 'close'
                },
                collectTrades: false,
                researchVariant: 'profit5_stock_alpha_ranking_v1'
              });
            }
          }
        }
      }
    }
  }
  return rows;
}

function targetedAlphaRiskFrontierConfigs(base) {
  const rows = [];
  for (const profile of [{}, { maxThemeMovePct: 1 }]) {
    for (const rankMode of ['score', 'volumeRsiQuality']) {
      for (const standardPct of [25, 32, 40, 50, 60]) {
        for (const maxOpenPositions of [4, 8, 12]) {
          for (const accountRiskPct of [2.5, 3, 4, 5]) {
            rows.push({
              ...base,
              ...profile,
              buyOnly: false,
              minScore: 65,
              buyConfirmations: 1,
              watchConfirmations: 2,
              minTradeValue: 30e6,
              minNearYearHigh: 0.95,
              minMarketMom1Pct: -100,
              minMarketMom5Pct: -100,
              minMarketMom20Pct: 3,
              maxMarketMom20Pct: 100,
              maxRange: 20,
              globalFloor: 0,
              excludeHighVolumeDistribution: true,
              rankMode,
              standardPct,
              defensivePct: standardPct,
              exploratoryPct: standardPct,
              maxPositionPct: standardPct,
              maxOpenPositions,
              accountRiskPct,
              starterRiskPct: accountRiskPct,
              monthlyEquityBrakePct: null,
              accountDrawdownBrakePct: null,
              consecutiveLossLimit: 5,
              lossStreakCooldownDays: 8,
              blackSwanMode: 'cash',
              blackSwanAction: 'block',
              blackSwanDayDropPct: -2,
              blackSwanFiveDayDropPct: -4,
              blackSwanVol20Pct: 35,
              exitRule: {
                holdDays: 10,
                trail: null,
                noFollow: false,
                stopLossPct: 10,
                stopMode: 'close'
              },
              collectTrades: false,
              researchVariant: 'profit5_stock_alpha_risk_frontier_v1'
            });
          }
        }
      }
    }
  }
  return rows;
}

function targetedAlphaBreadthConfigs(base) {
  const rows = [];
  for (const minMarketMom20Pct of [-2, 0, 1, 2, 3]) {
    for (const minNearYearHigh of [0.9, 0.95]) {
      for (const globalFloor of [-1.5, 0]) {
        for (const rankMode of ['score', 'volumeRsiQuality']) {
          for (const standardPct of [10, 15, 20, 25]) {
            for (const maxOpenPositions of [8, 12, 16]) {
              for (const accountRiskPct of [1.5, 2, 2.5]) {
                for (const holdDays of [7, 10]) {
                  rows.push({
                    ...base,
                    buyOnly: false,
                    minScore: 65,
                    buyConfirmations: 1,
                    watchConfirmations: 2,
                    minTradeValue: 30e6,
                    minNearYearHigh,
                    minMarketMom1Pct: -100,
                    minMarketMom5Pct: -100,
                    minMarketMom20Pct,
                    maxMarketMom20Pct: 100,
                    maxRange: 20,
                    globalFloor,
                    excludeHighVolumeDistribution: true,
                    rankMode,
                    standardPct,
                    defensivePct: standardPct,
                    exploratoryPct: standardPct,
                    maxPositionPct: standardPct,
                    maxOpenPositions,
                    accountRiskPct,
                    starterRiskPct: accountRiskPct,
                    monthlyEquityBrakePct: null,
                    accountDrawdownBrakePct: null,
                    consecutiveLossLimit: 5,
                    lossStreakCooldownDays: 8,
                    blackSwanMode: 'cash',
                    blackSwanAction: 'block',
                    blackSwanDayDropPct: -2,
                    blackSwanFiveDayDropPct: -4,
                    blackSwanVol20Pct: 35,
                    exitRule: {
                      holdDays,
                      trail: null,
                      noFollow: false,
                      stopLossPct: 10,
                      stopMode: 'close'
                    },
                    collectTrades: false,
                    researchVariant: 'profit5_stock_alpha_breadth_v1'
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

function targetedBreadthRiskConfigs(base) {
  const rows = [];
  for (const standardPct of [15, 18, 20, 22, 25, 30, 35, 40]) {
    for (const maxOpenPositions of [8, 12]) {
      for (const accountRiskPct of [2, 2.5, 3, 3.5, 4, 5]) {
        for (const consecutiveLossLimit of [4, 5, 6]) {
          rows.push({
            ...base,
            buyOnly: false,
            minScore: 65,
            buyConfirmations: 1,
            watchConfirmations: 2,
            minTradeValue: 30e6,
            minNearYearHigh: 0.9,
            minMarketMom1Pct: -100,
            minMarketMom5Pct: -100,
            minMarketMom20Pct: 3,
            maxMarketMom20Pct: 100,
            maxRange: 20,
            globalFloor: -1.5,
            excludeHighVolumeDistribution: true,
            rankMode: 'volumeRsiQuality',
            standardPct,
            defensivePct: standardPct,
            exploratoryPct: standardPct,
            maxPositionPct: standardPct,
            maxOpenPositions,
            accountRiskPct,
            starterRiskPct: accountRiskPct,
            monthlyEquityBrakePct: null,
            accountDrawdownBrakePct: null,
            consecutiveLossLimit,
            lossStreakCooldownDays: 8,
            blackSwanMode: 'cash',
            blackSwanAction: 'block',
            blackSwanDayDropPct: -2,
            blackSwanFiveDayDropPct: -4,
            blackSwanVol20Pct: 35,
            exitRule: {
              holdDays: 10,
              trail: null,
              noFollow: false,
              stopLossPct: 10,
              stopMode: 'close'
            },
            collectTrades: false,
            researchVariant: 'profit5_stock_breadth_risk_v1'
          });
        }
      }
    }
  }
  return rows;
}

function targetedBreadthExitConfigs(base) {
  const rules = [];
  for (const holdDays of [5, 7, 10, 12, 15, 20]) {
    for (const stopLossPct of [3, 5, 7, 10, 'volatility']) {
      for (const stopMode of ['close', 'intraday']) {
        rules.push({ holdDays, trail: null, noFollow: false, stopLossPct, stopMode });
      }
    }
  }
  for (const holdDays of [10, 15, 20]) {
    for (const stopLossPct of [5, 7, 10]) {
      for (const takeProfitPct of [10, 15, 20]) {
        rules.push({
          holdDays,
          trail: null,
          noFollow: false,
          stopLossPct,
          stopMode: 'close',
          takeProfitPct
        });
      }
      for (const trail of [
        { triggerPct: 3, givebackPct: 5, lockPct: 1 },
        { triggerPct: 5, givebackPct: 4, lockPct: 1 },
        { triggerPct: 8, givebackPct: 5, lockPct: 2 }
      ]) {
        rules.push({ holdDays, trail, noFollow: false, stopLossPct, stopMode: 'close' });
      }
    }
  }
  return rules.map(exitRule => ({
    ...base,
    buyOnly: false,
    minScore: 65,
    buyConfirmations: 1,
    watchConfirmations: 2,
    minTradeValue: 30e6,
    minNearYearHigh: 0.9,
    minMarketMom1Pct: -100,
    minMarketMom5Pct: -100,
    minMarketMom20Pct: 3,
    maxMarketMom20Pct: 100,
    maxRange: 20,
    globalFloor: -1.5,
    excludeHighVolumeDistribution: true,
    rankMode: 'volumeRsiQuality',
    standardPct: 22,
    defensivePct: 22,
    exploratoryPct: 22,
    maxPositionPct: 22,
    maxOpenPositions: 8,
    accountRiskPct: 2,
    starterRiskPct: 2,
    monthlyEquityBrakePct: null,
    accountDrawdownBrakePct: null,
    consecutiveLossLimit: 6,
    lossStreakCooldownDays: 8,
    blackSwanMode: 'cash',
    blackSwanAction: 'block',
    blackSwanDayDropPct: -2,
    blackSwanFiveDayDropPct: -4,
    blackSwanVol20Pct: 35,
    exitRule,
    collectTrades: false,
    researchVariant: 'profit5_stock_breadth_exit_v1'
  }));
}

function targetedMarketBandConfigs(base) {
  const rows = [];
  for (const marketBandUpperMom20Pct of [4, 5, 6, 8]) {
    for (const marketBandCorePositionPct of [20, 22, 25, 30, 35]) {
      for (const marketBandHotPositionPct of [5, 10, 15, 20]) {
        for (const accountRiskPct of [2, 2.5, 3]) {
          rows.push({
            ...base,
            buyOnly: false,
            minScore: 65,
            buyConfirmations: 1,
            watchConfirmations: 2,
            minTradeValue: 30e6,
            minNearYearHigh: 0.9,
            minMarketMom1Pct: -100,
            minMarketMom5Pct: -100,
            minMarketMom20Pct: 3,
            maxMarketMom20Pct: 100,
            maxRange: 20,
            globalFloor: -1.5,
            excludeHighVolumeDistribution: true,
            rankMode: 'volumeRsiQuality',
            marketBandPositioning: true,
            marketBandUpperMom20Pct,
            marketBandCorePositionPct,
            marketBandHotPositionPct,
            standardPct: marketBandCorePositionPct,
            defensivePct: marketBandCorePositionPct,
            exploratoryPct: marketBandCorePositionPct,
            maxPositionPct: Math.max(marketBandCorePositionPct, marketBandHotPositionPct),
            maxOpenPositions: 8,
            accountRiskPct,
            starterRiskPct: accountRiskPct,
            monthlyEquityBrakePct: null,
            accountDrawdownBrakePct: null,
            consecutiveLossLimit: 6,
            lossStreakCooldownDays: 8,
            blackSwanMode: 'cash',
            blackSwanAction: 'block',
            blackSwanDayDropPct: -2,
            blackSwanFiveDayDropPct: -4,
            blackSwanVol20Pct: 35,
            exitRule: {
              holdDays: 10,
              trail: null,
              noFollow: false,
              stopLossPct: 10,
              stopMode: 'close'
            },
            collectTrades: false,
            researchVariant: 'profit5_stock_market_band_v1'
          });
        }
      }
    }
  }
  return rows;
}

function targetedMonthlyPyramidConfigs(base) {
  return [{
    ...base,
    buyOnly: false,
    minScore: 65,
    buyConfirmations: 1,
    watchConfirmations: 2,
    minTradeValue: 30e6,
    minNearYearHigh: 0.9,
    minMarketMom1Pct: -100,
    minMarketMom5Pct: -100,
    minMarketMom20Pct: 3,
    maxMarketMom20Pct: 100,
    maxRange: 20,
    globalFloor: -1.5,
    excludeHighVolumeDistribution: true,
    rankMode: 'volumeRsiQuality',
    standardPct: 22,
    defensivePct: 22,
    exploratoryPct: 22,
    maxPositionPct: 30,
    maxOpenPositions: 12,
    accountRiskPct: 2.5,
    starterRiskPct: 2.5,
    monthPerformancePositioning: true,
    monthPerformanceTriggerPct: 2,
    positiveMonthPositionMultiplier: 1.5,
    negativeMonthPositionMultiplier: 1,
    positiveMonthRiskMultiplier: 1.5,
    negativeMonthRiskMultiplier: 1,
    profitLockPct: 20,
    profitLockAction: 'block',
    monthPeakTriggerPct: null,
    monthGivebackPct: 4,
    monthDrawdownAction: 'block',
    monthlyEquityBrakePct: null,
    accountDrawdownBrakePct: null,
    accountCooldownDays: 20,
    consecutiveLossLimit: 6,
    lossStreakCooldownDays: 8,
    blackSwanMode: 'cash',
    blackSwanAction: 'block',
    blackSwanDayDropPct: -2,
    blackSwanFiveDayDropPct: -4,
    blackSwanVol20Pct: 35,
    exitRule: {
      holdDays: 10,
      trail: null,
      noFollow: false,
      stopLossPct: 10,
      stopMode: 'close'
    },
    collectTrades: false,
    researchVariant: 'profit5_stock_winner_continuation_v1'
  }];
}

function targetedMarketMomentumSizingConfigs(base) {
  const rows = [];
  const profiles = [
    { strongMarketMom5Pct: 1, strongMarketMom20Pct: -3, strongMarketPositionMultiplier: 2, weakMarketPositionMultiplier: 0.5 },
    { strongMarketMom5Pct: 1, strongMarketMom20Pct: 0, strongMarketPositionMultiplier: 2, weakMarketPositionMultiplier: 0.5 },
    { strongMarketMom5Pct: 1, strongMarketMom20Pct: 1, strongMarketPositionMultiplier: 2.5, weakMarketPositionMultiplier: 0.25 },
    { strongMarketMom5Pct: 0, strongMarketMom20Pct: 0, strongMarketPositionMultiplier: 1.75, weakMarketPositionMultiplier: 0.5 },
    { strongMarketMom5Pct: 2, strongMarketMom20Pct: 1, strongMarketPositionMultiplier: 2.5, weakMarketPositionMultiplier: 0.5 }
  ];
  for (const profile of profiles) {
    for (const standardPct of [12, 15, 18]) {
      for (const maxOpenPositions of [8, 12]) {
        for (const accountRiskPct of [1.5, 2, 2.5]) {
          for (const rankMode of ['score', 'riskAdjustedMomentum']) {
            for (const accountDrawdownBrakePct of [null, -18]) {
              rows.push({
                ...base,
                ...profile,
                marketMomentumPositioning: true,
                buyOnly: false,
                minScore: 65,
                buyConfirmations: 1,
                watchConfirmations: 2,
                minTradeValue: Math.max(30e6, base.minTradeValue || 30e6),
                minNearYearHigh: Math.max(0.95, base.minNearYearHigh || 0),
                maxRange: Math.min(20, base.maxRange || 20),
                excludeHighVolumeDistribution: true,
                rankMode,
                standardPct,
                defensivePct: standardPct,
                exploratoryPct: standardPct,
                maxPositionPct: 45,
                maxOpenPositions,
                accountRiskPct,
                starterRiskPct: accountRiskPct,
                monthlyEquityBrakePct: null,
                accountDrawdownBrakePct,
                accountCooldownDays: 20,
                consecutiveLossLimit: 5,
                lossStreakCooldownDays: 8,
                blackSwanMode: 'cash',
                blackSwanAction: 'block',
                blackSwanDayDropPct: -2,
                blackSwanFiveDayDropPct: -4,
                blackSwanVol20Pct: 35,
                exitRule: { holdDays: 10, trail: null, noFollow: false, stopLossPct: 10, stopMode: 'close' },
                collectTrades: false,
                researchVariant: 'profit5_market_momentum_sizing_v1'
              });
            }
          }
        }
      }
    }
  }
  return rows;
}

function targetedMarketMomentumSizingRefinementConfigs(base) {
  const rows = [];
  const thresholds = [
    { strongMarketMom5Pct: 0, strongMarketMom20Pct: 0 },
    { strongMarketMom5Pct: 1, strongMarketMom20Pct: -3 }
  ];
  for (const threshold of thresholds) {
    for (const strongMarketPositionMultiplier of [1.75, 2, 2.25]) {
      for (const weakMarketPositionMultiplier of [0.4, 0.5, 0.6]) {
        for (const standardPct of [18, 20, 22]) {
          for (const accountRiskPct of [2.5, 3]) {
            for (const maxPositionPct of [45, 55]) {
              rows.push({
                ...base,
                ...threshold,
                marketMomentumPositioning: true,
                strongMarketPositionMultiplier,
                weakMarketPositionMultiplier,
                buyOnly: false,
                minScore: 65,
                buyConfirmations: 1,
                watchConfirmations: 2,
                minTradeValue: Math.max(30e6, base.minTradeValue || 30e6),
                minNearYearHigh: Math.max(0.95, base.minNearYearHigh || 0),
                maxRange: Math.min(20, base.maxRange || 20),
                excludeHighVolumeDistribution: true,
                rankMode: 'riskAdjustedMomentum',
                standardPct,
                defensivePct: standardPct,
                exploratoryPct: standardPct,
                maxPositionPct,
                maxOpenPositions: 12,
                accountRiskPct,
                starterRiskPct: accountRiskPct,
                monthlyEquityBrakePct: null,
                accountDrawdownBrakePct: -18,
                accountCooldownDays: 20,
                consecutiveLossLimit: 5,
                lossStreakCooldownDays: 8,
                blackSwanMode: 'cash',
                blackSwanAction: 'block',
                blackSwanDayDropPct: -2,
                blackSwanFiveDayDropPct: -4,
                blackSwanVol20Pct: 35,
                exitRule: { holdDays: 10, trail: null, noFollow: false, stopLossPct: 10, stopMode: 'close' },
                collectTrades: false,
                researchVariant: 'profit5_market_momentum_sizing_refine_v1'
              });
            }
          }
        }
      }
    }
  }
  return rows;
}

function targetedStrongMarketCoreWithSmallWeakSleeveConfigs(base) {
  const rows = [];
  for (const standardPct of [10, 12, 15]) {
    for (const strongMarketPositionMultiplier of [2, 2.5, 3]) {
      for (const weakMarketPositionMultiplier of [0.2, 0.3, 0.4]) {
        for (const accountRiskPct of [2, 2.5, 3]) {
          for (const maxOpenPositions of [8, 12]) {
            for (const rankMode of ['score', 'riskAdjustedMomentum']) {
              rows.push({
                ...base,
                minMarketMom1Pct: -100,
                maxMarketMom1Pct: 100,
                minMarketMom5Pct: -100,
                maxMarketMom5Pct: 100,
                minMarketMom20Pct: -100,
                maxMarketMom20Pct: 100,
                marketMomentumPositioning: true,
                strongMarketMom5Pct: -100,
                strongMarketMom20Pct: 3,
                strongMarketPositionMultiplier,
                weakMarketPositionMultiplier,
                buyOnly: false,
                minScore: 65,
                buyConfirmations: 1,
                watchConfirmations: 2,
                minTradeValue: 30e6,
                minNearYearHigh: 0.95,
                maxNearYearHigh: 100,
                maxRange: 20,
                excludeHighVolumeDistribution: true,
                rankMode,
                standardPct,
                defensivePct: standardPct,
                exploratoryPct: standardPct,
                maxPositionPct: 40,
                maxOpenPositions,
                accountRiskPct,
                starterRiskPct: accountRiskPct,
                monthlyEquityBrakePct: null,
                accountDrawdownBrakePct: -18,
                accountCooldownDays: 20,
                consecutiveLossLimit: 5,
                lossStreakCooldownDays: 8,
                blackSwanMode: 'cash',
                blackSwanAction: 'block',
                blackSwanDayDropPct: -2,
                blackSwanFiveDayDropPct: -4,
                blackSwanVol20Pct: 35,
                exitRule: { holdDays: 10, trail: null, noFollow: false, stopLossPct: 10, stopMode: 'close' },
                collectTrades: false,
                researchVariant: 'profit5_strong_market_core_weak_sleeve_v1'
              });
            }
          }
        }
      }
    }
  }
  return rows;
}

function targetedConditionalStrongAndWeakAlphaConfigs(base) {
  const rows = [];
  for (const strongMarketPositionPct of [20, 25, 30]) {
    for (const weakMarketPositionPct of [5, 8, 10]) {
      for (const maxOpenPositions of [8, 12]) {
        for (const accountRiskPct of [2, 2.5, 3]) {
          for (const rankMode of ['score', 'riskAdjustedMomentum']) {
            for (const accountDrawdownBrakePct of [null, -18]) rows.push({
              ...base,
              minMarketMom1Pct: -100,
              maxMarketMom1Pct: 100,
              minMarketMom5Pct: -100,
              maxMarketMom5Pct: 100,
              minMarketMom20Pct: -100,
              maxMarketMom20Pct: 100,
              conditionalRegimeStrategy: true,
              conditionalRegimeLogicVersion: 3,
              strongMarketMom20Pct: 3,
              strongMarketMinNearYearHigh: 0.95,
              weakMarketMinScore: 65,
              weakMarketMinReturn5Pct: 3,
              weakMarketMaxVolumeRatio1To20: 0.8,
              strongMarketPositionPct,
              weakMarketPositionPct,
              marketMomentumPositioning: false,
              buyOnly: false,
              minScore: 65,
              buyConfirmations: 1,
              watchConfirmations: 2,
              minTradeValue: 30e6,
              minNearYearHigh: 0,
              maxNearYearHigh: 100,
              minVolumeRatio1To20: 0,
              maxVolumeRatio1To20: 100,
              maxRange: 20,
              excludeHighVolumeDistribution: true,
              rankMode,
              standardPct: strongMarketPositionPct,
              defensivePct: strongMarketPositionPct,
              exploratoryPct: strongMarketPositionPct,
              maxPositionPct: strongMarketPositionPct,
              maxOpenPositions,
              accountRiskPct,
              starterRiskPct: accountRiskPct,
              monthlyEquityBrakePct: null,
              accountDrawdownBrakePct,
              accountCooldownDays: 20,
              consecutiveLossLimit: 5,
              lossStreakCooldownDays: 8,
              blackSwanMode: 'cash',
              blackSwanAction: 'block',
              blackSwanDayDropPct: -2,
              blackSwanFiveDayDropPct: -4,
              blackSwanVol20Pct: 35,
              exitRule: {
                holdDays: 10,
                conditionalRegime: true,
                strongMarketMom20Pct: 3,
                strongHoldDays: 10,
                weakHoldDays: 5,
                trail: null,
                noFollow: false,
                stopLossPct: 10,
                stopMode: 'close'
              },
              collectTrades: false,
              researchVariant: 'profit5_conditional_strong_weak_alpha_v3'
            });
          }
        }
      }
    }
  }
  return rows;
}

function targetedBurstTakeProfitConfigs(base) {
  const rows = [];
  const filters = [
    {
      minScore: 65,
      minNearYearHigh: 0.9,
      minTradeValue: 30e6,
      maxRange: 20,
      minRsi: 45,
      maxRsi: 95
    },
    {
      minScore: 65,
      minNearYearHigh: 0.95,
      minIntradayMomentum20Pct: 3,
      minTradeValue: 30e6,
      priceVolumeMode: 'exclude_flat_down'
    },
    {
      minScore: 65,
      minNearYearHigh: 0.97,
      minIntradayMomentum20Pct: 6,
      maxOvernightMomentum20Pct: 12,
      priceVolumeMode: 'exclude_flat_down'
    }
  ];
  const exits = [
    { holdDays: 5, trail: null, noFollow: false, stopLossPct: 5, stopMode: 'close', takeProfitPct: 6 },
    { holdDays: 7, trail: null, noFollow: false, stopLossPct: 7, stopMode: 'close', takeProfitPct: 10 },
    { holdDays: 10, trail: { triggerPct: 8, givebackPct: 5, lockPct: 2 }, noFollow: false, stopLossPct: 7, stopMode: 'close', takeProfitPct: 14 }
  ];
  for (const filter of filters) {
    for (const exitRule of exits) {
      for (const rankMode of ['technicalMomentum', 'riskAdjustedMomentum', 'breakoutQuality']) {
        for (const standardPct of [24, 30, 36]) {
          for (const maxOpenPositions of [5, 8]) {
            rows.push({
              ...base,
              ...filter,
              buyOnly: false,
              buyConfirmations: 1,
              watchConfirmations: 2,
              minGap: 0,
              maxGap: 12,
              minStd: 1.5,
              maxStd: 10,
              maxChasePct: 100,
              minRewardRisk: -99,
              marketFloor: -1,
              themeFloor: -1,
              globalFloor: -1.5,
              asiaFloor: -1.2,
              rankMode,
              standardPct,
              defensivePct: Math.min(standardPct, 30),
              exploratoryPct: Math.min(standardPct, 30),
              maxPositionPct: Math.min(standardPct, 40),
              maxOpenPositions,
              accountRiskPct: 1.5,
              starterRiskPct: 1.5,
              monthlyEquityBrakePct: null,
              accountDrawdownBrakePct: null,
              consecutiveLossLimit: 5,
              lossStreakCooldownDays: 8,
              blackSwanMode: 'cash',
              blackSwanAction: 'block',
              blackSwanDayDropPct: -2,
              blackSwanFiveDayDropPct: -4,
              blackSwanVol20Pct: 35,
              exitRule,
              collectTrades: false,
              researchVariant: 'profit5_burst_take_profit_v1'
            });
          }
        }
      }
    }
  }
  return rows;
}

function targetedCashFirstLossCutConfigs(base) {
  const rows = [];
  const overlays = [
    { maxRsi: 80, maxVolumeRatio1To20: 5 },
    { maxRsi: 85, maxVolumeRatio1To20: 5 },
    { maxRsi: 80, minMarketMom5Pct: -1 },
    { maxVolumeRatio1To20: 3, minMarketMom5Pct: -1 },
    { minNearYearHigh: 1, maxVolumeRatio1To20: 5 },
    { minNearYearHigh: 1, maxRsi: 80 }
  ];
  const exits = [
    base.exitRule,
    { holdDays: 10, trail: null, noFollow: false, stopLossPct: 10, stopMode: 'close' },
    { holdDays: 7, trail: null, noFollow: false, stopLossPct: 7, stopMode: 'close' }
  ].filter(Boolean);
  for (const overlay of overlays) {
    for (const exitRule of exits) {
      for (const rankMode of ['riskAdjustedMomentum', 'technicalMomentum', 'breakoutQuality']) {
        for (const standardPct of [32, 40]) {
          for (const maxOpenPositions of [6, 8]) {
            for (const monthlyEquityBrakePct of [null, -5]) {
              rows.push({
                ...base,
                ...overlay,
                exitRule,
                rankMode,
                standardPct,
                defensivePct: Math.min(standardPct, 30),
                exploratoryPct: Math.min(standardPct, 30),
                maxPositionPct: Math.min(standardPct, 45),
                maxOpenPositions,
                monthlyEquityBrakePct,
                accountDrawdownBrakePct: null,
                accountCooldownDays: 15,
                consecutiveLossLimit: 5,
                lossStreakCooldownDays: 8,
                collectTrades: false,
                researchVariant: 'profit5_cash_first_loss_cut_v1'
              });
            }
          }
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
  if (STOCK_OBJECTIVE === 'deployable') {
    return deployableStockScore(b) - deployableStockScore(a);
  }
  return balancedScore(b) - balancedScore(a)
    || b.full.hit - a.full.hit
    || a.full.negative - b.full.negative
    || b.full.average - a.full.average;
}

function tradeQuality(result) {
  const rows = result.closedTrades || [];
  const wins = rows.filter(row => row.realizedPnl > 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.realizedPnl, 0);
  const grossLoss = Math.abs(rows
    .filter(row => row.realizedPnl < 0)
    .reduce((sum, row) => sum + row.realizedPnl, 0));
  const symbolPnl = new Map();
  for (const row of rows) {
    symbolPnl.set(row.symbol, (symbolPnl.get(row.symbol) || 0) + row.realizedPnl);
  }
  const positivePnl = [...symbolPnl.values()].filter(value => value > 0).sort((a, b) => b - a);
  return {
    winRatePct: rows.length ? round(wins.length / rows.length * 100) : 0,
    profitFactor: grossLoss ? round(grossProfit / grossLoss) : null,
    topFiveProfitContributionPct: grossProfit
      ? round(positivePnl.slice(0, 5).reduce((sum, value) => sum + value, 0) / grossProfit * 100)
      : 0
  };
}

function annualizedReturn(monthly) {
  const complete = monthly.slice(1, -1);
  const growth = complete.reduce((value, row) => value * (1 + row.returnPct / 100), 1);
  return complete.length ? round((growth ** (12 / complete.length) - 1) * 100) : 0;
}

function benchmarkStats(series, startDate, endDate) {
  const rows = series.filter(row => row.date >= startDate && row.date <= endDate);
  const monthlyCloses = new Map();
  for (const row of rows) monthlyCloses.set(row.date.slice(0, 7), row.close);
  const closes = [...monthlyCloses.values()];
  const monthlyReturns = closes.slice(1).map((close, index) => (
    (close / closes[index] - 1) * 100
  ));
  let peak = rows[0]?.close || 0;
  let maxDrawdownPct = 0;
  for (const row of rows) {
    peak = Math.max(peak, row.close);
    maxDrawdownPct = Math.min(maxDrawdownPct, (row.close / peak - 1) * 100);
  }
  const totalReturn = rows.length > 1 ? rows.at(-1).close / rows[0].close : 1;
  const years = rows.length > 1
    ? (Date.parse(rows.at(-1).date) - Date.parse(rows[0].date)) / (365.25 * 86400000)
    : 0;
  return {
    startDate: rows[0]?.date || null,
    endDate: rows.at(-1)?.date || null,
    months: monthlyReturns.length,
    averageMonthlyReturnPct: monthlyReturns.length
      ? round(monthlyReturns.reduce((sum, value) => sum + value, 0) / monthlyReturns.length)
      : 0,
    annualizedReturnPct: years ? round((totalReturn ** (1 / years) - 1) * 100) : 0,
    maxDrawdownPct: round(maxDrawdownPct)
  };
}

function exposureFrontierConfigs(base) {
  const rows = [];
  for (const positionPct of [10, 15, 20, 25, 30, 35]) {
    for (const accountRiskPct of [0.5, 0.75, 1, 1.25]) {
      for (const maxOpenPositions of [3, 4, 5]) {
        for (const monthlyEquityBrakePct of [null, -3, -5]) {
          for (const transitionPositionMultiplier of [0.25, 0.5, 0.75, 1]) {
            rows.push({
              ...base,
              standardPct: positionPct,
              defensivePct: positionPct,
              exploratoryPct: positionPct,
              maxPositionPct: positionPct,
              accountRiskPct,
              starterRiskPct: accountRiskPct,
              maxOpenPositions,
              monthlyEquityBrakePct,
              transitionPositionMultiplier,
              collectTrades: false
            });
          }
        }
      }
    }
  }
  return rows;
}

function riskConfig(config) {
  return {
    positionPct: config.standardPct,
    accountRiskPct: config.accountRiskPct,
    maxOpenPositions: config.maxOpenPositions,
    maxPositionsPerTheme: config.maxPositionsPerTheme,
    monthlyEquityBrakePct: config.monthlyEquityBrakePct,
    transitionPositionMultiplier: config.transitionPositionMultiplier,
    accountDrawdownBrakePct: config.accountDrawdownBrakePct,
    accountCooldownDays: config.accountCooldownDays,
    consecutiveLossLimit: config.consecutiveLossLimit,
    lossStreakCooldownDays: config.lossStreakCooldownDays,
    targetMarketVolPct: config.targetMarketVolPct,
    minimumVolatilityMultiplier: config.minimumVolatilityMultiplier,
    maximumVolatilityMultiplier: config.maximumVolatilityMultiplier,
    momentumCrashMom20Pct: config.momentumCrashMom20Pct,
    momentumCrashReboundPct: config.momentumCrashReboundPct,
    momentumCrashMultiplier: config.momentumCrashMultiplier,
    regimeMode: config.regimeMode,
    regimeSlowMa: config.regimeSlowMa,
    regimeMomentumDays: config.regimeMomentumDays,
    regimeMomentumThreshold: config.regimeMomentumThreshold,
    rankMode: config.rankMode
  };
}

function volatilityManagedConfigs(base) {
  const rows = [];
  for (const targetMarketVolPct of [12, 15, 18, 21, 24]) {
    for (const minimumVolatilityMultiplier of [0.25, 0.5]) {
      for (const maximumVolatilityMultiplier of [1, 1.25]) {
        for (const momentumCrashMom20Pct of [-3, -5]) {
          for (const momentumCrashReboundPct of [1, 2]) {
            for (const momentumCrashMultiplier of [0, 0.25, 0.5]) {
              rows.push({
                ...base,
                targetMarketVolPct,
                minimumVolatilityMultiplier,
                maximumVolatilityMultiplier,
                momentumCrashMom20Pct,
                momentumCrashReboundPct,
                momentumCrashMultiplier,
                collectTrades: false
              });
            }
          }
        }
      }
    }
  }
  return rows;
}

function rollingRegimeConfigs(base) {
  const regimes = [
    { regimeMode: 'none' },
    { regimeMode: 'require_above_ma', regimeSlowMa: 40 },
    { regimeMode: 'require_above_ma', regimeSlowMa: 60 },
    { regimeMode: 'require_up_continuation', regimeSlowMa: 40 },
    {
      regimeMode: 'avoid_both',
      regimeSlowMa: 40,
      regimeMomentumDays: 10,
      regimeMomentumThreshold: -1
    },
    {
      regimeMode: 'avoid_both',
      regimeSlowMa: 60,
      regimeMomentumDays: 20,
      regimeMomentumThreshold: 0
    }
  ];
  const capacities = [
    { maxOpenPositions: 3, positionPct: 30 },
    { maxOpenPositions: 4, positionPct: 25 },
    { maxOpenPositions: 5, positionPct: 20 }
  ];
  const rows = [];
  for (const regime of regimes) {
    for (const capacity of capacities) {
      for (const targetMarketVolPct of [18, 24]) {
        for (const maximumVolatilityMultiplier of [1, 1.25]) {
          for (const accountDrawdownBrakePct of [-8, -10]) {
            for (const crashRule of [[-3, 1, 0], [-5, 1, 0.25]]) {
            rows.push({
              ...base,
              ...regime,
              standardPct: capacity.positionPct,
              defensivePct: capacity.positionPct,
              exploratoryPct: capacity.positionPct,
              maxPositionPct: capacity.positionPct,
              maxOpenPositions: capacity.maxOpenPositions,
              targetMarketVolPct,
              minimumVolatilityMultiplier: 0.25,
              maximumVolatilityMultiplier,
              momentumCrashMom20Pct: crashRule[0],
              momentumCrashReboundPct: crashRule[1],
              momentumCrashMultiplier: crashRule[2],
              accountDrawdownBrakePct,
              accountCooldownDays: 10,
              monthlyEquityBrakePct: -5,
              collectTrades: false
            });
            }
          }
        }
      }
    }
  }
  return rows;
}

function shiftMonth(month, offset) {
  const [year, value] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, value - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function simulateRange(
  days,
  config,
  marketRegimes,
  startMonth,
  endMonth,
  collectTrades = false,
  collectCurve = false
) {
  const paddedMonths = monthKeys(
    `${shiftMonth(startMonth, -1)}-01`,
    `${shiftMonth(endMonth, 1)}-28`
  );
  const rangeDays = days.filter(([date]) => (
    date.slice(0, 7) >= startMonth && date.slice(0, 7) <= endMonth
  ));
  return simulate(rangeDays, paddedMonths, { ...config, collectTrades, collectCurve }, marketRegimes);
}

function allocationFrontier(foldCurves, marketRegimes) {
  return [70, 80, 90, 100].map(stockWeightPct => {
    const etf0050WeightPct = 100 - stockWeightPct;
    let equity = INITIAL_CAPITAL;
    let peak = INITIAL_CAPITAL;
    let maximumDrawdownPct = 0;
    const monthEnd = new Map();
    for (const curve of foldCurves) {
      const firstDate = curve[0]?.date;
      const lastDate = curve.at(-1)?.date;
      const firstClose = marketRegimes.get(firstDate)?.close;
      const stockByDate = new Map(curve.map(row => [row.date, row.equity]));
      const tradingDates = [...marketRegimes.keys()].filter(date => (
        date >= firstDate && date <= lastDate
      ));
      let previousFoldValue = INITIAL_CAPITAL;
      let stockEquity = INITIAL_CAPITAL;
      for (const date of tradingDates) {
        stockEquity = stockByDate.get(date) ?? stockEquity;
        const marketClose = marketRegimes.get(date)?.close;
        if (!firstClose || !marketClose) continue;
        const stockValue = stockEquity * stockWeightPct / 100;
        const etfValue = INITIAL_CAPITAL * etf0050WeightPct / 100
          * (1 - ETF_INITIAL_COST_PCT / 100)
          * marketClose / firstClose;
        const foldValue = stockValue + etfValue;
        equity *= foldValue / previousFoldValue;
        previousFoldValue = foldValue;
        peak = Math.max(peak, equity);
        maximumDrawdownPct = Math.min(maximumDrawdownPct, (equity / peak - 1) * 100);
        monthEnd.set(date.slice(0, 7), equity);
      }
    }
    let prior = INITIAL_CAPITAL;
    const monthly = [...monthEnd].map(([month, endingEquity]) => {
      const returnPct = (endingEquity / prior - 1) * 100;
      prior = endingEquity;
      return { month, returnPct };
    });
    const growth = monthly.reduce((value, row) => value * (1 + row.returnPct / 100), 1);
    return {
      stockWeightPct,
      etf0050WeightPct,
      months: monthly.length,
      averageMonthlyReturnPct: round(monthly.reduce((sum, row) => sum + row.returnPct, 0) / monthly.length),
      annualizedReturnPct: round((growth ** (12 / monthly.length) - 1) * 100),
      maximumDrawdownPct: round(maximumDrawdownPct),
      negativeMonths: monthly.filter(row => row.returnPct < 0).length
    };
  });
}

const TACTICAL_RULES = Object.freeze([
  { id: 'cash', name: '現金' },
  { id: '0050_trend', name: '0050 趨勢／現金', bull: '0050.TW', ma: 60, mom: 0, maxVol: 35 },
  { id: 'leveraged_trend', name: '正向槓桿趨勢／現金', bull: '00631L.TW', ma: 60, mom: 0, maxVol: 30 },
  { id: 'leveraged_strict', name: '正向槓桿強趨勢／現金', bull: '00631L.TW', ma: 120, mom: 3, maxVol: 25 },
  {
    id: 'leveraged_inverse',
    name: '正向槓桿／反向防守／現金',
    bull: '00631L.TW',
    bear: '00632R.TW',
    ma: 60,
    mom: 0,
    bearMom: -3,
    maxVol: 30
  }
]);

function tacticalTarget(rule, regime) {
  if (!regime || rule.id === 'cash') return null;
  if (regime.close >= regime[`ma${rule.ma}`]
    && regime.mom20 > rule.mom
    && regime.vol20 <= rule.maxVol) return rule.bull;
  if (rule.bear && regime.close < regime[`ma${rule.ma}`] && regime.mom20 < rule.bearMom) {
    return rule.bear;
  }
  return null;
}

function simulateTacticalSleeve(
  startDate,
  endDate,
  rule,
  marketRegimes,
  barsBySymbol,
  sleeveWeightPct
) {
  const dates = [...(barsBySymbol.get('0050.TW')?.keys() || [])]
    .filter(date => date >= startDate && date <= endDate);
  const initialCapital = INITIAL_CAPITAL * sleeveWeightPct / 100;
  let cash = initialCapital;
  let unsettled = [];
  let position = null;
  const curve = [];
  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    const released = unsettled.filter(item => item.releaseIndex <= index);
    cash += released.reduce((sum, item) => sum + item.amount, 0);
    unsettled = unsettled.filter(item => item.releaseIndex > index);
    const target = tacticalTarget(rule, marketRegimes.get(dates[index - 1]));
    if (position && position.symbol !== target) {
      const bar = barsBySymbol.get(position.symbol)?.get(date);
      if (bar) {
        const sell = sharedSellExecution(bar.open, position.quantity, ETF_COSTS);
        unsettled.push({ releaseIndex: index + SETTLEMENT_DAYS, amount: sell.net });
        position = null;
      }
    }
    if (!position && target && cash > 0) {
      const bar = barsBySymbol.get(target)?.get(date);
      if (bar) {
        let quantity = Math.floor(cash / (bar.open * (1 + BUY_SLIPPAGE_PCT / 100)));
        let buy = sharedBuyExecution(bar.open, quantity, ETF_COSTS);
        while (quantity > 0 && buy.total > cash) {
          quantity -= 1;
          buy = sharedBuyExecution(bar.open, quantity, ETF_COSTS);
        }
        if (quantity > 0) {
          cash -= buy.total;
          position = { symbol: target, quantity };
        }
      }
    }
    const bar = position ? barsBySymbol.get(position.symbol)?.get(date) : null;
    const positionValue = bar
      ? sharedSellExecution(bar.close, position.quantity, ETF_COSTS).net
      : 0;
    const equity = cash + unsettled.reduce((sum, item) => sum + item.amount, 0) + positionValue;
    curve.push({ date, equity: round(equity, 0) });
  }
  return curve;
}

function combineStockAndSleeve(stockCurve, sleeveCurve, stockWeightPct) {
  const stockByDate = new Map(stockCurve.map(row => [row.date, row.equity]));
  let stockEquity = INITIAL_CAPITAL;
  return sleeveCurve.map(row => {
    stockEquity = stockByDate.get(row.date) ?? stockEquity;
    return { date: row.date, equity: stockEquity * stockWeightPct / 100 + row.equity };
  });
}

function summarizeContinuousCurves(curves) {
  let equity = INITIAL_CAPITAL;
  let peak = INITIAL_CAPITAL;
  let maximumDrawdownPct = 0;
  const monthEnd = new Map();
  for (const curve of curves) {
    let previousFoldValue = INITIAL_CAPITAL;
    for (const row of curve) {
      equity *= row.equity / previousFoldValue;
      previousFoldValue = row.equity;
      peak = Math.max(peak, equity);
      maximumDrawdownPct = Math.min(maximumDrawdownPct, (equity / peak - 1) * 100);
      monthEnd.set(row.date.slice(0, 7), equity);
    }
  }
  let prior = INITIAL_CAPITAL;
  const monthly = [...monthEnd].map(([month, endingEquity]) => {
    const returnPct = (endingEquity / prior - 1) * 100;
    prior = endingEquity;
    return { month, returnPct };
  });
  const growth = monthly.reduce((value, row) => value * (1 + row.returnPct / 100), 1);
  return {
    months: monthly.length,
    averageMonthlyReturnPct: round(monthly.reduce((sum, row) => sum + row.returnPct, 0) / monthly.length),
    annualizedReturnPct: round((growth ** (12 / monthly.length) - 1) * 100),
    maximumDrawdownPct: round(maximumDrawdownPct),
    negativeMonths: monthly.filter(row => row.returnPct < 0).length
  };
}

function summarizeCurve(curve) {
  if (!curve.length) {
    return {
      months: 0,
      averageMonthlyReturnPct: 0,
      annualizedReturnPct: 0,
      maximumDrawdownPct: 0,
      negativeMonths: 0,
      worstMonthPct: 0,
      monthly: []
    };
  }
  let peak = curve[0].equity;
  let maximumDrawdownPct = 0;
  const monthEnd = new Map();
  for (const row of curve) {
    peak = Math.max(peak, row.equity);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, (row.equity / peak - 1) * 100);
    monthEnd.set(row.date.slice(0, 7), row.equity);
  }
  let prior = curve[0].equity;
  const monthly = [...monthEnd].map(([month, endingEquity]) => {
    const returnPct = (endingEquity / prior - 1) * 100;
    prior = endingEquity;
    return { month, returnPct: round(returnPct) };
  });
  const growth = monthly.reduce((value, row) => value * (1 + row.returnPct / 100), 1);
  return {
    months: monthly.length,
    averageMonthlyReturnPct: round(monthly.reduce((sum, row) => sum + row.returnPct, 0) / monthly.length),
    annualizedReturnPct: round((growth ** (12 / monthly.length) - 1) * 100),
    maximumDrawdownPct: round(maximumDrawdownPct),
    negativeMonths: monthly.filter(row => row.returnPct < 0).length,
    worstMonthPct: round(Math.min(...monthly.map(row => row.returnPct))),
    monthly
  };
}

function combineWeightedStockCurves(rows) {
  const dates = [...new Set(rows.flatMap(row => row.curve.map(point => point.date)))].sort();
  const state = rows.map(row => ({
    ...row,
    byDate: new Map(row.curve.map(point => [point.date, point.equity])),
    equity: INITIAL_CAPITAL
  }));
  return dates.map(date => {
    for (const row of state) row.equity = row.byDate.get(date) ?? row.equity;
    return {
      date,
      equity: round(state.reduce((sum, row) => sum + row.equity * row.weightPct / 100, 0), 0)
    };
  });
}

function strategyFamily(config) {
  return config.researchVariant || `${config.rankMode || 'unknown'}_${config.exitRule?.holdDays || 0}`;
}

function stockMetaConfigs(search) {
  const rows = [
    ...(search.top || []),
    ...(search.cashFirstTop || []),
    ...(search.balancedTop || []),
    ...(search.indicatorTop || [])
  ].filter(result => (
    result.config?.researchVariant?.startsWith('profit5_')
    && result.trades >= 250
    && result.maxDrawdownPct >= -25
    && result.test?.average > 0
  ));
  const byFamily = new Map();
  for (const result of rows.sort((a, b) => (
    b.test.average - a.test.average
    || b.maxDrawdownPct - a.maxDrawdownPct
  ))) {
    const family = strategyFamily(result.config);
    const configs = byFamily.get(family) || [];
    const configHash = hash({ ...result.config, collectTrades: undefined });
    if (!configs.some(row => row.configHash === configHash) && configs.length < 6) {
      configs.push({ configHash, config: { ...result.config, collectTrades: false } });
      byFamily.set(family, configs);
    }
  }
  return [...byFamily.values()].flat();
}

function stockMetaPortfolios(shortlist) {
  const rows = shortlist.map(item => ({
    id: `single_${item.id}`,
    sleeves: [{ ...item, weightPct: 100 }]
  }));
  for (let left = 0; left < shortlist.length; left += 1) {
    for (let right = left + 1; right < shortlist.length; right += 1) {
      if (shortlist[left].family === shortlist[right].family) continue;
      for (const weights of [[50, 50], [65, 35], [35, 65]]) {
        rows.push({
          id: `pair_${shortlist[left].id}_${weights[0]}_${shortlist[right].id}_${weights[1]}`,
          sleeves: [
            { ...shortlist[left], weightPct: weights[0] },
            { ...shortlist[right], weightPct: weights[1] }
          ]
        });
      }
    }
  }
  for (let first = 0; first < shortlist.length; first += 1) {
    for (let second = first + 1; second < shortlist.length; second += 1) {
      for (let third = second + 1; third < shortlist.length; third += 1) {
        const families = new Set([
          shortlist[first].family,
          shortlist[second].family,
          shortlist[third].family
        ]);
        if (families.size < 3) continue;
        rows.push({
          id: `triple_${shortlist[first].id}_${shortlist[second].id}_${shortlist[third].id}`,
          sleeves: [
            { ...shortlist[first], weightPct: 40 },
            { ...shortlist[second], weightPct: 30 },
            { ...shortlist[third], weightPct: 30 }
          ]
        });
      }
    }
  }
  return rows;
}

function stockMetaSelectionScore(metrics, sleeves) {
  const tradeEvidence = Math.min(sleeves.reduce((sum, row) => sum + row.trades, 0), 500) / 100;
  const concentrationPenalty = sleeves.length === 1 ? 1 : 0;
  return metrics.averageMonthlyReturnPct * 7
    + metrics.annualizedReturnPct * 0.12
    + metrics.maximumDrawdownPct * 0.22
    + metrics.worstMonthPct * 0.1
    - metrics.negativeMonths * 0.04
    + tradeEvidence
    - concentrationPenalty;
}

function concatenateValidationCurves(curves) {
  let equity = INITIAL_CAPITAL;
  const continuous = [];
  for (const curve of curves) {
    if (!curve.length) continue;
    const base = INITIAL_CAPITAL;
    for (const row of curve) continuous.push({
      date: row.date,
      equity: round(equity * row.equity / base, 0)
    });
    equity = continuous.at(-1).equity;
  }
  return continuous;
}

function stockMetaSelector(broadCandidates, search, marketRegimes) {
  const configs = stockMetaConfigs(search);
  const periods = [
    ['2014-05', '2018-10', '2018-11', '2020-04'],
    ['2015-11', '2020-04', '2020-05', '2021-10'],
    ['2017-05', '2021-10', '2021-11', '2023-04'],
    ['2018-11', '2023-04', '2023-05', '2024-10'],
    ['2020-05', '2024-10', '2024-11', '2026-04']
  ];
  const daysCache = new Map();
  const daysFor = config => {
    const exitKey = hash(config.exitRule || null);
    if (!daysCache.has(exitKey)) {
      daysCache.set(exitKey, config.exitRule
        ? buildDays(broadCandidates.map(trade => applyExitRule(trade, config.exitRule)))
        : buildDays(broadCandidates));
    }
    return daysCache.get(exitKey);
  };
  const folds = [];
  const validationCurves = [];
  let validationTrades = 0;
  for (const [trainStart, trainEnd, validationStart, validationEnd] of periods) {
    const trained = configs.map(({ configHash, config }) => {
      const result = simulateRange(daysFor(config), config, marketRegimes, trainStart, trainEnd, false, true);
      return {
        id: configHash.slice(0, 10),
        config,
        family: strategyFamily(config),
        trades: result.trades,
        curve: result.dailyCurve || [],
        metrics: summarizeCurve(result.dailyCurve || [])
      };
    }).filter(row => row.trades >= 80 && row.metrics.maximumDrawdownPct >= -25);
    const shortlist = [...trained]
      .sort((a, b) => stockMetaSelectionScore(b.metrics, [b]) - stockMetaSelectionScore(a.metrics, [a]))
      .filter((row, index, rows) => rows.findIndex(other => other.family === row.family) === index)
      .slice(0, 6);
    const portfolios = stockMetaPortfolios(shortlist).map(portfolio => {
      const curve = combineWeightedStockCurves(portfolio.sleeves);
      const metrics = summarizeCurve(curve);
      return {
        ...portfolio,
        curve,
        metrics,
        selectionScore: stockMetaSelectionScore(metrics, portfolio.sleeves)
      };
    });
    const selected = portfolios
      .filter(row => row.metrics.maximumDrawdownPct >= -22 && row.metrics.averageMonthlyReturnPct > 0)
      .sort((a, b) => b.selectionScore - a.selectionScore)[0];
    if (!selected) {
      const cashCurve = [...marketRegimes.keys()]
        .filter(date => date.slice(0, 7) >= validationStart && date.slice(0, 7) <= validationEnd)
        .map(date => ({ date, equity: INITIAL_CAPITAL }));
      validationCurves.push(cashCurve);
      folds.push({
        trainPeriod: `${trainStart}～${trainEnd}`,
        validationPeriod: `${validationStart}～${validationEnd}`,
        status: '訓練證據不足，驗證期持有現金'
      });
      continue;
    }
    const validationSleeves = selected.sleeves.map(sleeve => {
      const result = simulateRange(
        daysFor(sleeve.config),
        sleeve.config,
        marketRegimes,
        validationStart,
        validationEnd,
        true,
        true
      );
      validationTrades += result.trades;
      return {
        ...sleeve,
        trades: result.trades,
        curve: result.dailyCurve || []
      };
    });
    const validationCurve = combineWeightedStockCurves(validationSleeves);
    validationCurves.push(validationCurve);
    const validationMetrics = summarizeCurve(validationCurve);
    folds.push({
      trainPeriod: `${trainStart}～${trainEnd}`,
      validationPeriod: `${validationStart}～${validationEnd}`,
      status: '完成',
      selectedSleeves: selected.sleeves.map(sleeve => ({
        strategyFamily: sleeve.family,
        weightPct: sleeve.weightPct,
        trainTrades: sleeve.trades
      })),
      train: selected.metrics,
      validation: validationMetrics,
      validationTrades: validationSleeves.reduce((sum, row) => sum + row.trades, 0)
    });
  }
  const combinedCurve = concatenateValidationCurves(validationCurves);
  return {
    strategyId: 'stock_meta_selector_v1',
    universe: '台股個股；ETF 與 0050 不參與選股或交易',
    trainingMonthsPerFold: 54,
    validationMonthsPerFold: 18,
    validationPeriod: '2018-11～2026-04',
    validationMonths: 90,
    configsConsidered: configs.length,
    validationTrades,
    validation: summarizeCurve(combinedCurve),
    folds
  };
}

function selectTacticalRule(stockCurve, startDate, endDate, marketRegimes, barsBySymbol) {
  const candidates = [10, 20, 30].flatMap(sleeveWeightPct => TACTICAL_RULES.map(rule => {
    const sleeve = simulateTacticalSleeve(
      startDate,
      endDate,
      rule,
      marketRegimes,
      barsBySymbol,
      sleeveWeightPct
    );
    const curve = combineStockAndSleeve(stockCurve, sleeve, 100 - sleeveWeightPct);
    return { rule, sleeveWeightPct, curve, metrics: summarizeContinuousCurves([curve]) };
  }));
  return candidates.filter(row => (
    row.rule.id !== 'cash'
    && row.metrics.averageMonthlyReturnPct > candidates.find(candidate => (
      candidate.rule.id === 'cash' && candidate.sleeveWeightPct === row.sleeveWeightPct
    )).metrics.averageMonthlyReturnPct
    && row.metrics.maximumDrawdownPct > candidates.find(candidate => (
      candidate.rule.id === 'cash' && candidate.sleeveWeightPct === row.sleeveWeightPct
    )).metrics.maximumDrawdownPct
  )).sort((a, b) => b.metrics.averageMonthlyReturnPct - a.metrics.averageMonthlyReturnPct)[0]
    || candidates.find(row => row.rule.id === 'cash' && row.sleeveWeightPct === 10);
}

function rollingValidation(days, configs, marketRegimes, barsBySymbol) {
  const minimumTrainTrades = Number(process.env.ROLLING_MIN_TRAIN_TRADES || 80);
  const minimumSegmentTrades = Number(process.env.ROLLING_MIN_SEGMENT_TRADES || 15);
  const usesSegmentEvidence = [
    'subperiod_stability',
    'evidence_gated_return',
    'evidence_gated_loss_defense'
  ]
    .includes(ROLLING_SELECTION_MODE);
  const periods = process.env.ROLLING_EXTENDED === '1' ? [
    ['2014-05', '2018-10', '2018-11', '2020-04'],
    ['2015-11', '2020-04', '2020-05', '2021-10'],
    ['2017-05', '2021-10', '2021-11', '2023-04'],
    ['2018-11', '2023-04', '2023-05', '2024-10'],
    ['2020-05', '2024-10', '2024-11', '2026-04']
  ] : [
    ['2016-07', '2020-12', '2021-01', '2022-06'],
    ['2018-01', '2022-06', '2022-07', '2023-12'],
    ['2019-07', '2023-12', '2024-01', '2025-06'],
    ['2021-01', '2025-06', '2025-07', '2026-05']
  ];
  const folds = [];
  const closedTrades = [];
  const monthly = [];
  const foldCurves = [];
  const tacticalCurves = [];
  for (const [trainStart, trainEnd, validationStart, validationEnd] of periods) {
    const fullTrainRows = configs.map(config => (
      simulateRange(days, config, marketRegimes, trainStart, trainEnd)
    ));
    const lossDefenseRows = ['loss_cluster_defense', 'evidence_gated_loss_defense']
      .includes(ROLLING_SELECTION_MODE)
      ? fullTrainRows.filter(result => result.trades >= minimumTrainTrades && result.maxDrawdownPct >= -25)
        .sort((a, b) => b.full.average - a.full.average
          || b.maxDrawdownPct - a.maxDrawdownPct)
        .slice(0, 12)
        .flatMap(result => [
          result,
          simulateRange(days, {
            ...result.config,
            consecutiveLossLimit: 2,
            lossStreakCooldownDays: 5
          }, marketRegimes, trainStart, trainEnd),
          simulateRange(days, {
            ...result.config,
            consecutiveLossLimit: 3,
            lossStreakCooldownDays: 10
          }, marketRegimes, trainStart, trainEnd)
        ])
      : fullTrainRows;
    const shortlist = usesSegmentEvidence
      ? fullTrainRows.filter(result => result.trades >= minimumTrainTrades && result.maxDrawdownPct >= -25)
        .sort((a, b) => b.full.average - a.full.average
          || b.maxDrawdownPct - a.maxDrawdownPct)
        .slice(0, 24)
      : lossDefenseRows;
    const trainedRows = shortlist.map(result => {
      if (!usesSegmentEvidence) return result;
      const config = result.config;
      const segments = [0, 18, 36].map(offset => simulateRange(
        days,
        config,
        marketRegimes,
        shiftMonth(trainStart, offset),
        shiftMonth(trainStart, offset + 17)
      ));
      const averages = segments.map(segment => segment.full.average).sort((a, b) => a - b);
      return {
        ...result,
        stableSegments: segments.map(segment => ({
          averageMonthlyReturnPct: round(segment.full.average),
          maximumDrawdownPct: segment.maxDrawdownPct,
          trades: segment.trades
        })),
        stabilityScore: result.full.average * 0.5
          + averages[1]
          + averages[0] * 0.5
          + result.maxDrawdownPct * 0.05
      };
    });
    const trained = trainedRows.filter(result => (
      result.trades >= minimumTrainTrades
      && result.maxDrawdownPct >= -25
      && (!usesSegmentEvidence
        || result.stableSegments.every(segment => segment.trades >= minimumSegmentTrades))
    )).sort((a, b) => (
      ROLLING_SELECTION_MODE === 'subperiod_stability'
        ? b.stabilityScore - a.stabilityScore
        : b.full.average - a.full.average
    ) || b.maxDrawdownPct - a.maxDrawdownPct)[0];
    if (!trained) {
      const cashMonths = Array.from({ length: 18 }, (_, offset) => shiftMonth(validationStart, offset));
      monthly.push(...cashMonths.map(month => ({ month, returnPct: 0, realizedPnl: 0, trades: 0 })));
      const cashCurve = [...marketRegimes.keys()]
        .filter(date => date.slice(0, 7) >= validationStart && date.slice(0, 7) <= validationEnd)
        .map(date => ({ date, equity: INITIAL_CAPITAL }));
      foldCurves.push(cashCurve);
      tacticalCurves.push(cashCurve);
      folds.push({
        trainPeriod: `${trainStart}～${trainEnd}`,
        validationPeriod: `${validationStart}～${validationEnd}`,
        status: 'cash_insufficient_training_evidence',
        selectedRisk: null,
        train: null,
        trainMaxDrawdownPct: 0,
        validation: { months: 18, hit: 0, negative: 0, zero: 18, worst: 0, average: 0 },
        validationMaxDrawdownPct: 0,
        validationTrades: 0,
        validationQuality: { winRatePct: 0, profitFactor: null, topFiveProfitContributionPct: 0 },
        selectedTacticalRule: 'cash',
        selectedTacticalRuleName: '現金',
        selectedTacticalSleeveWeightPct: 100,
        trainTacticalMetrics: null
      });
      continue;
    }
    const trainedCurve = simulateRange(
      days,
      trained.config,
      marketRegimes,
      trainStart,
      trainEnd,
      false,
      true
    );
    const tactical = selectTacticalRule(
      trainedCurve.dailyCurve || [],
      `${trainStart}-01`,
      `${trainEnd}-31`,
      marketRegimes,
      barsBySymbol
    );
    const validation = simulateRange(
      days,
      trained.config,
      marketRegimes,
      validationStart,
      validationEnd,
      true,
      true
    );
    monthly.push(...validation.monthly.slice(1, -1));
    closedTrades.push(...(validation.closedTrades || []));
    foldCurves.push(validation.dailyCurve || []);
    const validationSleeve = simulateTacticalSleeve(
      `${validationStart}-01`,
      `${validationEnd}-31`,
      tactical.rule,
      marketRegimes,
      barsBySymbol,
      tactical.sleeveWeightPct
    );
    tacticalCurves.push(combineStockAndSleeve(
      validation.dailyCurve || [],
      validationSleeve,
      100 - tactical.sleeveWeightPct
    ));
    folds.push({
      trainPeriod: `${trainStart}～${trainEnd}`,
      validationPeriod: `${validationStart}～${validationEnd}`,
      selectedRisk: riskConfig(trained.config),
      train: trained.full,
      trainMaxDrawdownPct: trained.maxDrawdownPct,
      trainStableSegments: trained.stableSegments,
      trainStabilityScore: trained.stabilityScore === undefined
        ? undefined
        : round(trained.stabilityScore),
      validation: validation.full,
      validationMaxDrawdownPct: validation.maxDrawdownPct,
      validationTrades: validation.trades,
      validationQuality: tradeQuality(validation),
      selectedTacticalRule: tactical.rule.id,
      selectedTacticalRuleName: tactical.rule.name,
      selectedTacticalSleeveWeightPct: tactical.sleeveWeightPct,
      trainTacticalMetrics: tactical.metrics
    });
  }
  const allocations = allocationFrontier(foldCurves, marketRegimes);
  const stockOnlyAllocation = allocations.find(row => row.stockWeightPct === 100);
  const improvedAllocations = allocations.filter(row => (
    row.averageMonthlyReturnPct > 2.89
    && row.maximumDrawdownPct > stockOnlyAllocation.maximumDrawdownPct
  ));
  const selectedAllocation = [...(improvedAllocations.length ? improvedAllocations : allocations)]
    .sort((a, b) => b.averageMonthlyReturnPct - a.averageMonthlyReturnPct
      || b.maximumDrawdownPct - a.maximumDrawdownPct)[0];
  const tacticalAllocation = {
    ...summarizeContinuousCurves(tacticalCurves),
    selectedRules: folds.map(fold => ({
      validationPeriod: fold.validationPeriod,
      ruleId: fold.selectedTacticalRule,
      ruleName: fold.selectedTacticalRuleName,
      tacticalSleeveWeightPct: fold.selectedTacticalSleeveWeightPct,
      stockWeightPct: 100 - fold.selectedTacticalSleeveWeightPct
    }))
  };
  const tacticalImproved = tacticalAllocation.averageMonthlyReturnPct > selectedAllocation.averageMonthlyReturnPct
    && tacticalAllocation.maximumDrawdownPct > selectedAllocation.maximumDrawdownPct;
  const selectedPortfolio = tacticalImproved
    ? { type: 'tactical_sleeve', ...tacticalAllocation }
    : { type: 'static_0050', ...selectedAllocation };
  let combinedEquity = INITIAL_CAPITAL;
  let combinedPeak = INITIAL_CAPITAL;
  let combinedMaximumDrawdownPct = 0;
  for (const row of monthly) {
    combinedEquity *= 1 + row.returnPct / 100;
    combinedPeak = Math.max(combinedPeak, combinedEquity);
    combinedMaximumDrawdownPct = Math.min(
      combinedMaximumDrawdownPct,
      (combinedEquity / combinedPeak - 1) * 100
    );
  }
  const pseudoResult = { closedTrades };
  return {
    trainingMonthsPerFold: 54,
    plannedValidationMonthsPerFold: 18,
    minimumTrainTrades,
    minimumSegmentTrades,
    trainingSelectionMode: ROLLING_SELECTION_MODE,
    trainingSelectionObjective: ROLLING_SELECTION_MODE === 'subperiod_stability'
      ? '三個 18 個月子區間穩定度與整體回撤綜合分數'
      : ROLLING_SELECTION_MODE === 'evidence_gated_return'
        ? '三個子區間皆有足夠樣本後，選訓練期月均報酬最高策略；不足則持有現金'
      : ROLLING_SELECTION_MODE === 'evidence_gated_loss_defense'
        ? '子區間證據門檻通過後，由訓練期選擇連敗熔斷；不足則持有現金'
      : ROLLING_SELECTION_MODE === 'loss_cluster_defense'
        ? '月均報酬最高，並由訓練期選擇是否啟用連敗熔斷'
        : '月均總資產報酬最高且最大回撤不超過 25%',
    validationPeriod: `${folds[0]?.validationPeriod.split('～')[0]}～${folds.at(-1)?.validationPeriod.split('～')[1]}`,
    validationMonths: monthly.length,
    validationAverageMonthlyReturnPct: round(
      monthly.reduce((sum, row) => sum + row.returnPct, 0) / monthly.length
    ),
    validationAnnualizedReturnPct: annualizedReturn([
      { returnPct: 0 },
      ...monthly,
      { returnPct: 0 }
    ]),
    validationWorstFoldDrawdownPct: Math.min(...folds.map(fold => fold.validationMaxDrawdownPct)),
    validationMonthEndAndFoldMaximumDrawdownPct: round(Math.min(
      combinedMaximumDrawdownPct,
      ...folds.map(fold => fold.validationMaxDrawdownPct)
    )),
    validationCombinedMaximumDrawdownPct: stockOnlyAllocation.maximumDrawdownPct,
    validationTrades: closedTrades.length,
    validationQuality: tradeQuality(pseudoResult),
    allocationFrontier: allocations,
    selectedAllocation,
    tacticalAllocation,
    selectedPortfolio,
    monthly,
    folds
  };
}

async function main() {
  const payload = JSON.parse(await fs.readFile(INPUT, 'utf8'));
  const candidates = executableCandidates(
    payload.candidateTrades || [],
    payload.assumptions?.entryMode
  );
  const datasetSignature = hash({
    searchSpaceVersion: SEARCH_SPACE_VERSION,
    sourceGeneratedAt: payload.generatedAt,
    startDate: payload.startDate,
    endDate: payload.endDate,
    entryMode: payload.assumptions?.entryMode,
    candidates: candidates.length,
    executionTimingPolicy: payload.assumptions?.entryMode === 'close_confirm'
      ? '收盤確認後下一交易日開盤成交'
      : payload.assumptions?.entryMode
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
  const broadDaysByExitRule = new Map();
  const broadDaysForExitRule = exitRule => {
    if (!exitRule) return broadDays;
    const key = hash(exitRule);
    if (!broadDaysByExitRule.has(key)) {
      while (broadDaysByExitRule.size >= 2) {
        broadDaysByExitRule.delete(broadDaysByExitRule.keys().next().value);
      }
      broadDaysByExitRule.set(
        key,
        buildDays(broadCandidates.map(trade => applyExitRule(trade, exitRule)))
      );
    }
    return broadDaysByExitRule.get(key);
  };
  const tenDayDays = buildDays(broadCandidates.map(trade => applyExitRule(trade, {
    holdDays: 10,
    trail: null,
    noFollow: false
  })));
  if (process.argv.includes('--stock-meta-selector')) {
    const search = JSON.parse(await fs.readFile(OUTPUT, 'utf8'));
    const result = stockMetaSelector(broadCandidates, search, marketRegimes);
    const etfHistory = JSON.parse(await fs.readFile(ETF_HISTORY, 'utf8'));
    const benchmark = benchmarkStats(
      etfHistory.series['0050.TW'] || [],
      '2018-11-01',
      '2026-04-30'
    );
    const output = {
      generatedAt: new Date().toISOString(),
      sourceGeneratedAt: payload.generatedAt,
      resultLogicVersion: RESULT_LOGIC_VERSION,
      targetMonthlyReturnPct: 5,
      result,
      benchmark,
      passed: result.validation.averageMonthlyReturnPct >= 5
        && result.validation.maximumDrawdownPct >= -20
        && result.validationTrades >= 300,
      conclusion: result.validation.averageMonthlyReturnPct >= 5
        && result.validation.maximumDrawdownPct >= -20
        && result.validationTrades >= 300
        ? '通過月均 5%、最大回撤與交易樣本門檻；仍須紙上交易驗證。'
        : '尚未找到月均至少 5% 的可實盤個股策略。'
    };
    await fs.writeFile(STOCK_META_OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: STOCK_META_OUTPUT.pathname,
      targetMonthlyReturnPct: output.targetMonthlyReturnPct,
      validationPeriod: result.validationPeriod,
      validationMonths: result.validationMonths,
      configsConsidered: result.configsConsidered,
      validation: {
        averageMonthlyReturnPct: result.validation.averageMonthlyReturnPct,
        annualizedReturnPct: result.validation.annualizedReturnPct,
        maximumDrawdownPct: result.validation.maximumDrawdownPct,
        negativeMonths: result.validation.negativeMonths,
        trades: result.validationTrades
      },
      benchmark,
      passed: output.passed,
      conclusion: output.conclusion
    }, null, 2));
    return;
  }
  if (process.argv.includes('--exposure-frontier')) {
    const search = JSON.parse(await fs.readFile(OUTPUT, 'utf8'));
    const base = { ...search.bestBalanced.config };
    delete base.collectTrades;
    const sourceDays = buildDays(broadCandidates.map(trade => applyExitRule(trade, base.exitRule)));
    const evaluated = exposureFrontierConfigs(base).map(config => (
      simulate(sourceDays, months, config, marketRegimes)
    ));
    const eligible = evaluated.filter(result => (
      result.maxDrawdownPct >= -24
      && result.trades >= 250
      && result.test.average > 0
    ));
    const ranked = [...eligible].sort((a, b) => (
      b.test.average - a.test.average
      || b.full.average - a.full.average
      || b.maxDrawdownPct - a.maxDrawdownPct
    ));
    const returnLeader = ranked[0] || [...evaluated].sort((a, b) => (
      b.maxDrawdownPct - a.maxDrawdownPct || b.test.average - a.test.average
    ))[0];
    const safetyEvaluated = [null, -8, -10, -12, -15].flatMap(accountDrawdownBrakePct => (
      [10, 20, 40].map(accountCooldownDays => simulate(sourceDays, months, {
        ...returnLeader.config,
        accountDrawdownBrakePct,
        accountCooldownDays,
        collectTrades: false
      }, marketRegimes))
    ));
    const safetySelected = [...safetyEvaluated]
      .filter(result => result.maxDrawdownPct >= -20 && result.trades >= 250)
      .sort((a, b) => b.test.average - a.test.average || b.full.average - a.full.average)[0]
      || returnLeader;
    const volatilityEvaluated = volatilityManagedConfigs(safetySelected.config).map(config => (
      simulate(sourceDays, months, config, marketRegimes)
    ));
    const selected = [...volatilityEvaluated]
      .filter(result => (
        result.maxDrawdownPct > safetySelected.maxDrawdownPct
        && result.test.average > safetySelected.test.average
        && result.trades >= 250
      ))
      .sort((a, b) => b.test.average - a.test.average || b.maxDrawdownPct - a.maxDrawdownPct)[0]
      || safetySelected;
    const best = simulate(sourceDays, months, { ...selected.config, collectTrades: true }, marketRegimes);
    const validationMonths = monthKeys('2021-12-01', '2026-06-30');
    const validationDays = sourceDays.filter(([date]) => date >= '2021-12-01');
    const validation = simulate(
      validationDays,
      validationMonths,
      { ...selected.config, collectTrades: true },
      marketRegimes
    );
    const [etfHistory, leveragedEtfHistory] = await Promise.all([
      fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse),
      fs.readFile(LEVERAGED_ETF_HISTORY, 'utf8').then(JSON.parse)
    ]);
    const tacticalBars = new Map(
      ['0050.TW', '00631L.TW', '00632R.TW'].map(symbol => [
        symbol,
        new Map((leveragedEtfHistory.series[symbol] || []).map(row => [row.date, row]))
      ])
    );
    const benchmark = benchmarkStats(
      etfHistory.series['0050.TW'] || [],
      '2022-01-01',
      '2026-05-31'
    );
    const rolling = rollingValidation(
      sourceDays,
      rollingRegimeConfigs(safetySelected.config),
      marketRegimes,
      tacticalBars
    );
    const rollingBenchmark = benchmarkStats(
      etfHistory.series['0050.TW'] || [],
      process.env.ROLLING_EXTENDED === '1' ? '2018-11-01' : '2021-01-01',
      process.env.ROLLING_EXTENDED === '1' ? '2026-04-30' : '2026-05-31'
    );
    const { closedTrades: bestTrades, ...bestSummary } = best;
    const { closedTrades: validationTrades, ...validationSummary } = validation;
    const output = {
      generatedAt: new Date().toISOString(),
      sourceGeneratedAt: payload.generatedAt,
      period: {
        full: `${months[1]}～${months.at(-2)}`,
        training: `${months[1]}～2021-12`,
        validation: `2022-01～${months.at(-2)}`
      },
      testedCombinations: evaluated.length,
      testedSafetyCombinations: safetyEvaluated.length,
      testedVolatilityCombinations: volatilityEvaluated.length,
      eligibility: {
        maxDrawdownPct: -24,
        minimumTrades: 250,
        positiveValidationAverage: true
      },
      base: {
        full: search.bestBalanced.full,
        test: search.bestBalanced.test,
        maxDrawdownPct: search.bestBalanced.maxDrawdownPct,
        trades: search.bestBalanced.trades,
        risk: riskConfig(search.bestBalanced.config)
      },
      best: {
        ...bestSummary,
        quality: tradeQuality(best)
      },
      validation: {
        ...validationSummary,
        annualizedReturnPct: annualizedReturn(validation.monthly),
        quality: tradeQuality(validation)
      },
      benchmark,
      rollingValidation: rolling,
      rollingBenchmark,
      frontier: ranked.slice(0, 10).map(result => ({
        risk: riskConfig(result.config),
        full: result.full,
        train: result.train,
        test: result.test,
        maxDrawdownPct: result.maxDrawdownPct,
        trades: result.trades
      }))
    };
    await fs.writeFile(EXPOSURE_FRONTIER_OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: EXPOSURE_FRONTIER_OUTPUT.pathname,
      testedCombinations: output.testedCombinations,
      period: output.period,
      best: {
        full: best.full,
        train: best.train,
        validation: validation.full,
        validationAnnualizedReturnPct: output.validation.annualizedReturnPct,
        validationMaxDrawdownPct: validation.maxDrawdownPct,
        benchmark,
        maxDrawdownPct: best.maxDrawdownPct,
        trades: best.trades,
        quality: output.best.quality,
        validationQuality: output.validation.quality,
        validationTrades: validation.trades,
        rollingValidation: rolling,
        rollingBenchmark,
        positionPct: best.config.standardPct,
        accountRiskPct: best.config.accountRiskPct,
        maxOpenPositions: best.config.maxOpenPositions,
        monthlyEquityBrakePct: best.config.monthlyEquityBrakePct
      }
    }, null, 2));
    return;
  }
  const diagnoseVariantArg = process.argv.find(value => value.startsWith('--diagnose-variant='));
  if (diagnoseVariantArg) {
    const variant = diagnoseVariantArg.slice('--diagnose-variant='.length);
    const search = JSON.parse(await fs.readFile(OUTPUT, 'utf8'));
    const selected = search.variantFeasibleTop?.[variant]?.[0]
      || search.variantMonthlyTop?.[variant]?.[0]
      || search.variantTop?.[variant]?.[0];
    if (!selected) throw new Error(`找不到策略家族：${variant}`);
    const config = { ...selected.config, collectTrades: true };
    const sourceDays = config.exitRule
      ? buildDays(broadCandidates.map(trade => applyExitRule(trade, config.exitRule)))
      : broadDays;
    const result = simulate(sourceDays, months, config, marketRegimes);
    await fs.writeFile(STOCK_VARIANT_DIAGNOSTIC_OUTPUT, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      variant,
      result
    }, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: STOCK_VARIANT_DIAGNOSTIC_OUTPUT.pathname,
      variant,
      full: result.full,
      test: result.test,
      maxDrawdownPct: result.maxDrawdownPct,
      trades: result.trades
    }, null, 2));
    return;
  }
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
  let canReusePreviousResults = false;
  try {
    previousOutput = JSON.parse(await fs.readFile(OUTPUT, 'utf8'));
    canReusePreviousResults = previousOutput.datasetSignature === datasetSignature
      && previousOutput.inputEntryMode === payload.assumptions?.entryMode
      && previousOutput.resultLogicVersion === RESULT_LOGIC_VERSION;
    if (canReusePreviousResults) {
      const historical = [
        ...(previousOutput.top || []),
        ...(previousOutput.cashFirstTop || []),
        ...(previousOutput.balancedTop || []),
        ...(previousOutput.indicatorTop || []),
        ...Object.values(previousOutput.variantTop || {}).flat()
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
      && diagnostics.resultLogicVersion === RESULT_LOGIC_VERSION
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
    const normalizedConfig = {
      ...config,
      resultLogicVersion: RESULT_LOGIC_VERSION
    };
    const configHash = hash(normalizedConfig);
    if (!force && testedHashes.has(configHash)) {
      skippedDuplicates += 1;
      return null;
    }
    if (!testedHashes.has(configHash)) {
      testedHashes.add(configHash);
      newHashes.push(configHash);
    }
    const result = simulate(days, months, normalizedConfig, marketRegimes);
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
  const indicatorResults = canReusePreviousResults
    ? [...(previousOutput.indicatorTop || [])]
    : [];
  if (targetSeed && !PROFIT5_REFINEMENT_ONLY) {
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
    if (STOCK_OBJECTIVE === 'profit5' && !EXITS_ONLY) {
      for (const config of targetedProfitExpansionConfigs(cleanTargetSeed)) {
        evaluate(targetDays, config);
      }
      for (const config of targetedStatAlphaConfigs(cleanTargetSeed)) {
        const adjustedDays = config.exitRule
          ? buildDays(broadCandidates.map(trade => applyExitRule(trade, config.exitRule)))
          : targetDays;
        evaluate(adjustedDays, config);
      }
      for (const config of targetedHighTurnoverMomentumConfigs(cleanTargetSeed)) {
        const adjustedDays = config.exitRule
          ? buildDays(broadCandidates.map(trade => applyExitRule(trade, config.exitRule)))
          : targetDays;
        evaluate(adjustedDays, config);
      }
      for (const config of targetedBurstTakeProfitConfigs(cleanTargetSeed)) {
        const adjustedDays = config.exitRule
          ? buildDays(broadCandidates.map(trade => applyExitRule(trade, config.exitRule)))
          : targetDays;
        evaluate(adjustedDays, config);
      }
    }
    if (EXITS_ONLY) {
      for (const rule of targetedExitRules()) {
        const adjustedDays = buildDays(broadCandidates.map(trade => applyExitRule(trade, rule)));
        evaluate(adjustedDays, {
          ...cleanTargetSeed,
          exitRule: rule,
          researchVariant: STOCK_OBJECTIVE === 'profit5'
            ? 'profit5_target_exit_v2'
            : cleanTargetSeed.researchVariant,
          collectTrades: false
        });
      }
    }
  }
  if (STOCK_OBJECTIVE === 'profit5' && !PROFIT5_REFINEMENT_ONLY && previousOutput?.bestBalanced?.config) {
    const highReturnSeed = { ...previousOutput.bestBalanced.config };
    delete highReturnSeed.collectTrades;
    const tagHighReturnVariant = (config, kind) => ({
      ...config,
      researchVariant: `profit5_high_return_${kind}_v2`
    });
    const highReturnDays = highReturnSeed.exitRule
      ? buildDays(broadCandidates.map(trade => applyExitRule(trade, highReturnSeed.exitRule)))
      : broadDays;
    for (const config of targetedBlackSwanConfigs(highReturnSeed)) {
      evaluate(highReturnDays, tagHighReturnVariant(config, 'black_swan'));
    }
    for (const config of targetedPortfolioRiskConfigs(highReturnSeed)) {
      evaluate(highReturnDays, tagHighReturnVariant(config, 'portfolio_risk'));
    }
    for (const config of targetedProfitExpansionConfigs(highReturnSeed)) {
      evaluate(highReturnDays, tagHighReturnVariant(config, 'profit_expansion'));
    }
    for (const config of targetedProfitRiskTradeoffConfigs(highReturnSeed)) {
      evaluate(highReturnDays, tagHighReturnVariant(config, 'profit_risk_tradeoff'));
    }
    for (const config of targetedHighReturnBaseRiskConfigs(highReturnSeed)) {
      evaluate(highReturnDays, {
        ...config,
        researchVariant: 'profit5_high_return_base_risk_v3'
      });
    }
    for (const config of targetedHighReturnDrawdownLimiterConfigs(highReturnSeed)) {
      const adjustedDays = config.exitRule
        ? buildDays(broadCandidates.map(trade => applyExitRule(trade, config.exitRule)))
        : highReturnDays;
      evaluate(adjustedDays, {
        ...config,
        researchVariant: 'profit5_high_return_drawdown_limiter_v1'
      });
    }
    for (const config of targetedBurstTakeProfitConfigs(highReturnSeed)) {
      const adjustedDays = config.exitRule
        ? buildDays(broadCandidates.map(trade => applyExitRule(trade, config.exitRule)))
        : highReturnDays;
      evaluate(adjustedDays, {
        ...config,
        researchVariant: 'profit5_high_return_burst_take_profit_v1'
      });
    }
    if (EXITS_ONLY) {
      for (const rule of targetedExitRules()) {
        const adjustedDays = buildDays(broadCandidates.map(trade => applyExitRule(trade, rule)));
        evaluate(adjustedDays, tagHighReturnVariant({
          ...highReturnSeed,
          exitRule: rule,
          collectTrades: false
        }, 'exit'));
      }
    }
  }
  if (STOCK_OBJECTIVE === 'profit5' && !PROFIT5_REFINEMENT_ONLY && previousOutput?.bestCashFirst?.config) {
    const cashFirstSeed = { ...previousOutput.bestCashFirst.config };
    delete cashFirstSeed.collectTrades;
    for (const config of targetedCashFirstLossCutConfigs(cashFirstSeed)) {
      const adjustedDays = config.exitRule
        ? buildDays(broadCandidates.map(trade => applyExitRule(trade, config.exitRule)))
        : broadDays;
      evaluate(adjustedDays, config);
    }
  }
  const turnoverSeedSource = [
    ...(previousOutput?.variantTop?.profit5_high_turnover_momentum_v1 || []),
    ...(previousOutput?.top || [])
  ].find(result => result.config?.researchVariant === 'profit5_high_turnover_momentum_v1');
  if (STOCK_OBJECTIVE === 'profit5' && turnoverSeedSource?.config) {
    const turnoverSeed = { ...turnoverSeedSource.config };
    delete turnoverSeed.collectTrades;
    if (!CORE_WEAK_ONLY && !SELECTED_ALPHA_ONLY && !ALPHA_RANKING_ONLY
      && !ALPHA_RISK_FRONTIER_ONLY && !ALPHA_BREADTH_ONLY && !BREADTH_RISK_ONLY
      && !BREADTH_EXIT_ONLY && !MARKET_BAND_ONLY && !MONTHLY_PYRAMID_ONLY) {
      for (const config of targetedHighTurnoverRefinementConfigs(turnoverSeed)) {
        const adjustedDays = broadDaysForExitRule(config.exitRule);
        evaluate(adjustedDays, config);
      }
      for (const config of targetedAggressiveQualityStockConfigs(turnoverSeed)) {
        const adjustedDays = broadDaysForExitRule(config.exitRule);
        evaluate(adjustedDays, config);
      }
      for (const config of targetedMarketRegimeAlphaConfigs(turnoverSeed)) {
        const adjustedDays = broadDaysForExitRule(config.exitRule);
        evaluate(adjustedDays, config);
      }
      for (const config of targetedMarketMomentumSizingConfigs(turnoverSeed)) {
        const adjustedDays = broadDaysForExitRule(config.exitRule);
        evaluate(adjustedDays, config);
      }
      for (const config of targetedMarketMomentumSizingRefinementConfigs(turnoverSeed)) {
        const adjustedDays = broadDaysForExitRule(config.exitRule);
        evaluate(adjustedDays, config);
      }
    }
    if (!CORE_WEAK_ONLY && !SELECTED_ALPHA_ONLY && !ALPHA_RANKING_ONLY
      && !ALPHA_RISK_FRONTIER_ONLY && !ALPHA_BREADTH_ONLY && !BREADTH_RISK_ONLY
      && !BREADTH_EXIT_ONLY && !MARKET_BAND_ONLY && !MONTHLY_PYRAMID_ONLY) {
      for (const config of targetedStrongCoreFrontierConfigs(turnoverSeed)) {
        const adjustedDays = broadDaysForExitRule(config.exitRule);
        evaluate(adjustedDays, config, STRONG_CORE_FRONTIER_ONLY);
      }
    }
    if (!CORE_WEAK_ONLY && !STRONG_CORE_FRONTIER_ONLY && !ALPHA_RANKING_ONLY
      && !ALPHA_RISK_FRONTIER_ONLY && !ALPHA_BREADTH_ONLY && !BREADTH_RISK_ONLY
      && !BREADTH_EXIT_ONLY && !MARKET_BAND_ONLY && !MONTHLY_PYRAMID_ONLY) {
      for (const config of targetedSelectedTradeAlphaConfigs(turnoverSeed)) {
        const adjustedDays = broadDaysForExitRule(config.exitRule);
        evaluate(adjustedDays, config, SELECTED_ALPHA_ONLY);
      }
    }
    if (!CORE_WEAK_ONLY && !STRONG_CORE_FRONTIER_ONLY && !SELECTED_ALPHA_ONLY
      && !ALPHA_RISK_FRONTIER_ONLY && !ALPHA_BREADTH_ONLY && !BREADTH_RISK_ONLY
      && !BREADTH_EXIT_ONLY && !MARKET_BAND_ONLY && !MONTHLY_PYRAMID_ONLY) {
      for (const config of targetedAlphaRankingConfigs(turnoverSeed)) {
        const adjustedDays = broadDaysForExitRule(config.exitRule);
        evaluate(adjustedDays, config, ALPHA_RANKING_ONLY);
      }
    }
    if (!CORE_WEAK_ONLY && !STRONG_CORE_FRONTIER_ONLY && !SELECTED_ALPHA_ONLY
      && !ALPHA_RANKING_ONLY && !ALPHA_BREADTH_ONLY && !BREADTH_RISK_ONLY
      && !BREADTH_EXIT_ONLY && !MARKET_BAND_ONLY && !MONTHLY_PYRAMID_ONLY) {
      for (const config of targetedAlphaRiskFrontierConfigs(turnoverSeed)) {
        const adjustedDays = broadDaysForExitRule(config.exitRule);
        evaluate(adjustedDays, config, ALPHA_RISK_FRONTIER_ONLY);
      }
    }
    if (!CORE_WEAK_ONLY && !STRONG_CORE_FRONTIER_ONLY && !SELECTED_ALPHA_ONLY
      && !ALPHA_RANKING_ONLY && !ALPHA_RISK_FRONTIER_ONLY && !BREADTH_RISK_ONLY
      && !BREADTH_EXIT_ONLY && !MARKET_BAND_ONLY && !MONTHLY_PYRAMID_ONLY) {
      for (const config of targetedAlphaBreadthConfigs(turnoverSeed)) {
        const adjustedDays = broadDaysForExitRule(config.exitRule);
        evaluate(adjustedDays, config, ALPHA_BREADTH_ONLY);
      }
    }
    if (!CORE_WEAK_ONLY && !STRONG_CORE_FRONTIER_ONLY && !SELECTED_ALPHA_ONLY
      && !ALPHA_RANKING_ONLY && !ALPHA_RISK_FRONTIER_ONLY && !ALPHA_BREADTH_ONLY
      && !BREADTH_EXIT_ONLY && !MARKET_BAND_ONLY && !MONTHLY_PYRAMID_ONLY) {
      for (const config of targetedBreadthRiskConfigs(turnoverSeed)) {
        const adjustedDays = broadDaysForExitRule(config.exitRule);
        evaluate(adjustedDays, config, BREADTH_RISK_ONLY);
      }
    }
    if (!CORE_WEAK_ONLY && !STRONG_CORE_FRONTIER_ONLY && !SELECTED_ALPHA_ONLY
      && !ALPHA_RANKING_ONLY && !ALPHA_RISK_FRONTIER_ONLY && !ALPHA_BREADTH_ONLY
      && !BREADTH_RISK_ONLY && !MARKET_BAND_ONLY && !MONTHLY_PYRAMID_ONLY) {
      for (const config of targetedBreadthExitConfigs(turnoverSeed)) {
        const adjustedDays = broadDaysForExitRule(config.exitRule);
        evaluate(adjustedDays, config, BREADTH_EXIT_ONLY);
      }
    }
    if (!CORE_WEAK_ONLY && !STRONG_CORE_FRONTIER_ONLY && !SELECTED_ALPHA_ONLY
      && !ALPHA_RANKING_ONLY && !ALPHA_RISK_FRONTIER_ONLY && !ALPHA_BREADTH_ONLY
      && !BREADTH_RISK_ONLY && !BREADTH_EXIT_ONLY && !MONTHLY_PYRAMID_ONLY) {
      for (const config of targetedMarketBandConfigs(turnoverSeed)) {
        const adjustedDays = broadDaysForExitRule(config.exitRule);
        evaluate(adjustedDays, config, MARKET_BAND_ONLY);
      }
    }
    if (!CORE_WEAK_ONLY && !STRONG_CORE_FRONTIER_ONLY && !SELECTED_ALPHA_ONLY
      && !ALPHA_RANKING_ONLY && !ALPHA_RISK_FRONTIER_ONLY && !ALPHA_BREADTH_ONLY
      && !BREADTH_RISK_ONLY && !BREADTH_EXIT_ONLY && !MARKET_BAND_ONLY) {
      for (const config of targetedMonthlyPyramidConfigs(turnoverSeed)) {
        const adjustedDays = broadDaysForExitRule(config.exitRule);
        evaluate(adjustedDays, config, MONTHLY_PYRAMID_ONLY);
      }
    }
    if (!STRONG_CORE_FRONTIER_ONLY && !SELECTED_ALPHA_ONLY && !ALPHA_RANKING_ONLY
      && !ALPHA_RISK_FRONTIER_ONLY && !ALPHA_BREADTH_ONLY && !BREADTH_RISK_ONLY
      && !BREADTH_EXIT_ONLY && !MARKET_BAND_ONLY && !MONTHLY_PYRAMID_ONLY) {
      for (const config of targetedStrongMarketCoreWithSmallWeakSleeveConfigs(turnoverSeed)) {
        const adjustedDays = broadDaysForExitRule(config.exitRule);
        evaluate(adjustedDays, config);
      }
      for (const config of targetedConditionalStrongAndWeakAlphaConfigs(turnoverSeed)) {
        const adjustedDays = broadDaysForExitRule(config.exitRule);
        evaluate(adjustedDays, config, true);
      }
    }
  }
  if (!PROFIT5_REFINEMENT_ONLY && !CAPITAL_ONLY && !INDICATORS_ONLY && !RISK_ONLY && !EXITS_ONLY) {
    for (const config of targetedFactorConfigs(baselineConfig)) {
      evaluate(tenDayDays, config);
    }
  }
  for (let index = 0; index < (PROFIT5_REFINEMENT_ONLY || REFINE_ONLY || CAPITAL_ONLY || INDICATORS_ONLY || RISK_ONLY || EXITS_ONLY ? 0 : TESTS); index += 1) {
    evaluate(formalDays, randomConfig(rand));
  }
  for (let index = 0; index < (PROFIT5_REFINEMENT_ONLY || REFINE_ONLY || CAPITAL_ONLY || INDICATORS_ONLY || RISK_ONLY || EXITS_ONLY ? 0 : BROAD_TESTS); index += 1) {
    const config = randomConfig(rand);
    config.buyOnly = false;
    config.minScore = pick(rand, [65, 70]);
    evaluate(broadDays, config);
  }
  for (let index = 0; index < (PROFIT5_REFINEMENT_ONLY || CAPITAL_ONLY || INDICATORS_ONLY || RISK_ONLY || EXITS_ONLY ? 0 : REFINE_TESTS); index += 1) {
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
  if (!PROFIT5_REFINEMENT_ONLY && !CAPITAL_ONLY && !INDICATORS_ONLY && !RISK_ONLY && !EXITS_ONLY) {
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
  const variants = new Map();
  for (const result of combined) {
    const variant = result.config.researchVariant || '未分類';
    const rows = variants.get(variant) || [];
    if (rows.length < 5) {
      rows.push(result);
      variants.set(variant, rows);
    }
  }
  const variantNames = [...new Set(combined.map(result => (
    result.config.researchVariant || '未分類'
  )))];
  const variantMonthlyTop = Object.fromEntries(variantNames.map(variant => [
    variant,
    combined
      .filter(result => (result.config.researchVariant || '未分類') === variant)
      .sort((a, b) => b.test.average - a.test.average
        || b.full.average - a.full.average
        || b.maxDrawdownPct - a.maxDrawdownPct)
      .slice(0, 10)
  ]));
  const variantFeasibleTop = Object.fromEntries(variantNames.map(variant => [
    variant,
    combined
      .filter(result => (result.config.researchVariant || '未分類') === variant
        && result.maxDrawdownPct >= -20
        && result.trades >= 300)
      .sort((a, b) => b.test.average - a.test.average
        || b.full.average - a.full.average
        || b.trades - a.trades)
      .slice(0, 10)
  ]));
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
    resultLogicVersion: RESULT_LOGIC_VERSION,
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
    variantTop: Object.fromEntries(variants),
    variantMonthlyTop,
    variantFeasibleTop,
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

await main().catch(error => {
  console.error(error);
  process.exit(1);
});
