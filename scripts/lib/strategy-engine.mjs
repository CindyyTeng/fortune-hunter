import { MARKET_REGIMES } from './market-regime.mjs';

const finite = value => Number.isFinite(Number(value));
const clamp = (number, min, max) => Math.max(min, Math.min(max, number));
const pct = (now, then) => finite(now) && finite(then) && Number(then)
  ? (Number(now) / Number(then) - 1) * 100
  : null;
const average = values => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : null;

function stddev(values) {
  if (!values.length) return null;
  const mean = average(values);
  return Math.sqrt(average(values.map(value => (value - mean) ** 2)));
}

function rsi(closes, period = 14) {
  if (closes.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = closes.length - period; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  if (!losses) return 100;
  const relativeStrength = gains / losses;
  return 100 - 100 / (1 + relativeStrength);
}

function snapshot({ history, index, stock, regime, themeStrength = 0, themeStrengthRank = null }) {
  if (index < 200 || index >= history.length - 1) return null;
  const visible = history.slice(0, index + 1);
  const latest = visible.at(-1);
  const previous = visible.at(-2);
  const recent5 = visible.slice(-5);
  const recent20 = visible.slice(-20);
  const recent60 = visible.slice(-60);
  const closes = visible.map(day => day.close);
  const close20 = recent20.map(day => day.close);
  const returns20 = close20.slice(1).map((close, offset) => pct(close, close20[offset]));
  const ma5 = average(recent5.map(day => day.close));
  const ma20 = average(close20);
  const ma60 = average(recent60.map(day => day.close));
  const priorMa20 = average(visible.slice(-25, -5).map(day => day.close));
  const avgVolume20 = average(recent20.map(day => day.volume));
  const avgTradeValue20 = average(recent20.map(day => day.close * day.volume));
  const resistance = Math.max(...visible.slice(-21, -1).map(day => day.high));
  const support = Math.min(...visible.slice(-21, -1).map(day => day.low));
  const range = Math.max(resistance - support, latest.close * 0.01);
  const trueRanges = recent20.slice(1).map((day, offset) => {
    const priorClose = recent20[offset].close;
    return Math.max(day.high - day.low, Math.abs(day.high - priorClose), Math.abs(day.low - priorClose));
  });
  const atr14 = average(trueRanges.slice(-14));
  const bodyHigh = Math.max(latest.open, latest.close);
  const bodyLow = Math.min(latest.open, latest.close);
  const dayRange = Math.max(latest.high - latest.low, latest.close * 0.001);
  return {
    symbol: stock.symbol,
    name: stock.name,
    market: stock.market,
    themes: stock.themes || [],
    signalDate: latest.date,
    latest,
    previous,
    ma5,
    ma20,
    ma60,
    ma20SlopePct: pct(ma20, priorMa20),
    return1Pct: pct(latest.close, previous.close),
    return3Pct: pct(latest.close, visible.at(-4)?.close),
    return5Pct: pct(latest.close, visible.at(-6)?.close),
    return20Pct: pct(latest.close, visible.at(-21)?.close),
    std20Pct: stddev(returns20),
    rsi14: rsi(closes),
    avgVolume20,
    avgTradeValue20,
    volumeRatio: avgVolume20 ? latest.volume / avgVolume20 : null,
    resistance,
    support,
    rangePosition: (latest.close - support) / range,
    distanceToMa20Pct: pct(latest.close, ma20),
    distanceToMa60Pct: pct(latest.close, ma60),
    lowerWickRatio: (bodyLow - latest.low) / dayRange,
    upperWickRatio: (latest.high - bodyHigh) / dayRange,
    atr14Pct: atr14 ? atr14 / latest.close * 100 : null,
    marketMom5: regime?.mom5 ?? 0,
    marketMom20: regime?.mom20 ?? 0,
    relativeStrength20: (pct(latest.close, visible.at(-21)?.close) ?? 0) - (regime?.mom20 ?? 0),
    themeStrength,
    themeStrengthRank,
    history,
    index
  };
}

function candidate(base, strategy, score, reason) {
  return {
    ...base,
    strategy: strategy.name,
    score: Math.round(clamp(score, 0, 100)),
    screenReason: reason,
    forwardPrices: base.history.slice(base.index + 1, base.index + 16).map(day => ({
      date: day.date,
      open: day.open,
      high: day.high,
      low: day.low,
      price: day.close
    }))
  };
}

function family(name, regimes, rules) {
  return Object.freeze({ name, regimes, ...rules });
}

export const breakoutMomentumStrategy = family('breakoutMomentumStrategy', [
  MARKET_REGIMES.BULL_TREND,
  MARKET_REGIMES.THEME_MOMENTUM
], {
  screen(input, context = {}) {
    const row = snapshot(input);
    if (!row) return null;
    const volumeFloor = context.minVolumeRatio ?? 1.15;
    const nearBreakout = row.latest.close >= row.resistance * 0.985;
    if (!nearBreakout || row.volumeRatio < volumeFloor || row.relativeStrength20 < 1) return null;
    if (row.rsi14 < 52 || row.rsi14 > 78 || row.distanceToMa20Pct > 16) return null;
    const score = 55 + row.relativeStrength20 * 1.5 + (row.volumeRatio - 1) * 18
      + row.themeStrength * 3 - Math.max(0, row.distanceToMa20Pct - 8);
    if (score < (context.minScore ?? 68)) return null;
    return candidate(row, breakoutMomentumStrategy, score, '接近前高、量能放大且個股相對大盤強勢');
  },
  entry(row) {
    return { mode: 'resistance_breakout', triggerPrice: row.resistance * 1.003 };
  },
  exit(row, position) {
    return {
      stopLoss: position?.stopLoss ?? breakoutMomentumStrategy.stopLoss(row),
      takeProfit: breakoutMomentumStrategy.takeProfit(row),
      trailingRule: { triggerPct: 5, givebackPct: 4, lockPct: 1.5 }
    };
  },
  positionSizing: (row, context = {}) => clamp((context.basePositionPct ?? 22)
    * (row.themeStrength > 1.5 ? 1.15 : 1), 8, 28),
  maxHoldingDays: row => row.std20Pct >= 4.5 ? 7 : 10,
  stopLoss: row => Math.max(row.ma20 * 0.98, row.latest.close - row.atr14Pct / 100 * row.latest.close * 2),
  takeProfit: row => row.latest.close + (row.latest.close - breakoutMomentumStrategy.stopLoss(row)) * 2.4
});

export const pullbackTrendStrategy = family('pullbackTrendStrategy', [MARKET_REGIMES.BULL_PULLBACK], {
  screen(input, context = {}) {
    const row = snapshot(input);
    if (!row) return null;
    const trend = row.ma20 > row.ma60 && row.ma20SlopePct > 0 && row.return20Pct > 2;
    const pullback = row.distanceToMa20Pct >= -2.5 && row.distanceToMa20Pct <= 3
      && row.latest.low <= row.ma20 * 1.015;
    const contraction = row.volumeRatio <= 1.05;
    const stabilizing = row.latest.close > row.latest.open || row.latest.close > row.previous.close;
    if (!trend || !pullback || !contraction || !stabilizing || row.rsi14 < 42 || row.rsi14 > 66) return null;
    const score = 60 + row.relativeStrength20 + Math.max(0, 3 - Math.abs(row.distanceToMa20Pct)) * 4
      + (1.05 - row.volumeRatio) * 12;
    if (score < (context.minScore ?? 60)) return null;
    return candidate(row, pullbackTrendStrategy, score, '中期多頭、回測 MA20、量縮且收盤止穩；不要求突破新高');
  },
  entry(row) {
    return {
      mode: 'pullback_entry',
      pullbackPrice: Math.max(row.ma20, row.latest.close * 0.99),
      pullbackFloor: pullbackTrendStrategy.stopLoss(row)
    };
  },
  exit(row, position) {
    return {
      stopLoss: position?.stopLoss ?? pullbackTrendStrategy.stopLoss(row),
      takeProfit: pullbackTrendStrategy.takeProfit(row),
      trailingRule: { triggerPct: 4, givebackPct: 3.5, lockPct: 1 }
    };
  },
  positionSizing: (row, context = {}) => clamp(context.basePositionPct ?? 20, 8, 24),
  maxHoldingDays: row => row.std20Pct > 4.5 ? 5 : 7,
  stopLoss: row => Math.min(row.support * 0.995, row.ma20 * 0.97),
  takeProfit: row => Math.min(row.resistance, row.latest.close + (row.latest.close - pullbackTrendStrategy.stopLoss(row)) * 2)
});

export const rangeReversionStrategy = family('rangeReversionStrategy', [MARKET_REGIMES.RANGE_BOUND], {
  screen(input, context = {}) {
    const row = snapshot(input);
    if (!row) return null;
    const nearSupport = row.rangePosition <= 0.32 || row.latest.low <= row.support * 1.02;
    const notTrendingDown = row.ma20SlopePct > -1.2 && row.latest.close >= row.ma60 * 0.9;
    const stabilizing = row.lowerWickRatio >= 0.22 || row.latest.close > row.previous.close;
    const risk = row.latest.close - rangeReversionStrategy.stopLoss(row);
    const reward = rangeReversionStrategy.takeProfit(row) - row.latest.close;
    if (!nearSupport || !notTrendingDown || !stabilizing || risk <= 0 || reward / risk < 1.5) return null;
    if (row.rsi14 < 30 || row.rsi14 > 56 || row.volumeRatio > 1.8) return null;
    const score = 58 + (0.32 - row.rangePosition) * 45 + row.lowerWickRatio * 12 + reward / risk * 3;
    if (score < (context.minScore ?? 56)) return null;
    return candidate(row, rangeReversionStrategy, score, '價格位於區間下緣或支撐附近，止穩且風險報酬足夠');
  },
  entry(row) {
    return {
      mode: 'next_open_limit',
      limitPrice: row.latest.close * 1.005,
      limitFloor: rangeReversionStrategy.stopLoss(row)
    };
  },
  exit(row, position) {
    return {
      stopLoss: position?.stopLoss ?? rangeReversionStrategy.stopLoss(row),
      takeProfit: rangeReversionStrategy.takeProfit(row)
    };
  },
  positionSizing: (row, context = {}) => clamp(context.basePositionPct ?? 16, 6, 20),
  maxHoldingDays: () => 5,
  stopLoss: row => row.support * 0.985,
  takeProfit: row => row.support + (row.resistance - row.support) * 0.82
});

export const oversoldReboundStrategy = family('oversoldReboundStrategy', [
  MARKET_REGIMES.BULL_PULLBACK,
  MARKET_REGIMES.RANGE_BOUND
], {
  screen(input, context = {}) {
    const row = snapshot(input);
    if (!row) return null;
    const selloff = row.return5Pct <= -6 || row.rsi14 <= 31;
    const capitulation = row.volumeRatio >= 1.25 && row.lowerWickRatio >= 0.28;
    const reversal = row.latest.close > row.latest.open && row.latest.close > row.previous.close;
    if (!selloff || !capitulation || !reversal || row.return20Pct < -25) return null;
    const score = 58 + Math.abs(Math.min(0, row.return5Pct)) * 1.5
      + row.lowerWickRatio * 18 + Math.min(12, (row.volumeRatio - 1) * 8);
    if (score < (context.minScore ?? 58)) return null;
    return candidate(row, oversoldReboundStrategy, score, '短線急跌、放量下影線且當日轉強；不依賴舊買入訊號');
  },
  entry(row) {
    return {
      mode: 'next_open_limit',
      limitPrice: row.latest.close * 1.015,
      limitFloor: oversoldReboundStrategy.stopLoss(row)
    };
  },
  exit(row, position) {
    return {
      stopLoss: position?.stopLoss ?? oversoldReboundStrategy.stopLoss(row),
      takeProfit: oversoldReboundStrategy.takeProfit(row)
    };
  },
  positionSizing: (row, context = {}) => clamp(context.basePositionPct ?? 10, 4, 12),
  maxHoldingDays: () => 3,
  stopLoss: row => row.latest.low * 0.985,
  takeProfit: row => Math.min(row.ma20, row.latest.close * 1.06)
});

export const cashDefenseStrategy = family('cashDefenseStrategy', [
  MARKET_REGIMES.BEAR_DEFENSE,
  MARKET_REGIMES.HIGH_VOLATILITY
], {
  screen: () => null,
  entry: () => null,
  exit(row, position) {
    return {
      stopLoss: position?.stopLoss ?? cashDefenseStrategy.stopLoss(row),
      reduceExposure: true
    };
  },
  positionSizing: () => 0,
  maxHoldingDays: () => 0,
  stopLoss: row => row?.latest?.close ? row.latest.close * 0.97 : 0,
  takeProfit: row => row?.latest?.close ?? 0
});

export const STRATEGIES = Object.freeze({
  breakoutMomentumStrategy,
  pullbackTrendStrategy,
  rangeReversionStrategy,
  oversoldReboundStrategy,
  cashDefenseStrategy
});

export const ACTIVE_STRATEGIES = Object.freeze([
  breakoutMomentumStrategy,
  pullbackTrendStrategy,
  rangeReversionStrategy,
  oversoldReboundStrategy
]);

export const DEFAULT_REGIME_STRATEGY_MAP = Object.freeze({
  [MARKET_REGIMES.BULL_TREND]: breakoutMomentumStrategy.name,
  [MARKET_REGIMES.THEME_MOMENTUM]: breakoutMomentumStrategy.name,
  [MARKET_REGIMES.BULL_PULLBACK]: pullbackTrendStrategy.name,
  [MARKET_REGIMES.RANGE_BOUND]: rangeReversionStrategy.name,
  [MARKET_REGIMES.BEAR_DEFENSE]: cashDefenseStrategy.name,
  [MARKET_REGIMES.HIGH_VOLATILITY]: cashDefenseStrategy.name
});

export function strategiesForRegime(regime, options = {}) {
  if ([MARKET_REGIMES.BEAR_DEFENSE, MARKET_REGIMES.HIGH_VOLATILITY].includes(regime)) {
    return [cashDefenseStrategy];
  }
  const map = { ...DEFAULT_REGIME_STRATEGY_MAP, ...(options.regimeStrategyMap || {}) };
  const primary = STRATEGIES[map[regime]] || cashDefenseStrategy;
  const rows = [primary];
  if (options.allowOversold !== false
    && oversoldReboundStrategy.regimes.includes(regime)
    && primary !== oversoldReboundStrategy) {
    rows.push(oversoldReboundStrategy);
  }
  return rows;
}

export function strategyFor(regime, candidate, options = {}) {
  return strategiesForRegime(regime, options)
    .find(strategy => strategy.name === candidate?.strategy)
    || strategiesForRegime(regime, options)[0];
}
