export const MARKET_REGIMES = Object.freeze({
  BULL_TREND: 'BULL_TREND',
  BULL_PULLBACK: 'BULL_PULLBACK',
  RANGE_BOUND: 'RANGE_BOUND',
  BEAR_DEFENSE: 'BEAR_DEFENSE',
  HIGH_VOLATILITY: 'HIGH_VOLATILITY',
  THEME_MOMENTUM: 'THEME_MOMENTUM'
});

const average = (values, size) => values.length >= size
  ? values.slice(-size).reduce((sum, value) => sum + value, 0) / size
  : null;

const pct = (value, base) => Number.isFinite(value) && Number.isFinite(base) && base
  ? (value / base - 1) * 100
  : null;

const round = (value, digits = 4) => Number.isFinite(value)
  ? Number(value.toFixed(digits))
  : null;

function slope(series, size, lookback = 5) {
  if (series.length < size + lookback) return null;
  const current = average(series, size);
  const previous = average(series.slice(0, -lookback), size);
  return pct(current, previous);
}

function volatility(returns, size = 20) {
  if (returns.length < size) return null;
  const recent = returns.slice(-size);
  const mean = recent.reduce((sum, value) => sum + value, 0) / size;
  const variance = recent.reduce((sum, value) => sum + (value - mean) ** 2, 0) / size;
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

export function classifyMarketRegime(metrics, theme = {}) {
  const {
    close, ma20, ma60, ma120, ma200, ma20Slope, ma60Slope, mom5, mom20, vol20
  } = metrics;
  if (![ma20, ma60, ma120, ma200, mom5, mom20, vol20].every(Number.isFinite)) {
    return { regime: MARKET_REGIMES.RANGE_BOUND, reason: '長期均線資料尚未完整，暫列震盪盤' };
  }
  if (vol20 >= 32 || mom5 <= -8) {
    return { regime: MARKET_REGIMES.HIGH_VOLATILITY, reason: `20 日年化波動 ${round(vol20, 2)}%，5 日動能 ${round(mom5, 2)}%` };
  }
  if ((close < ma120 && close < ma200 && ma60Slope < 0) || mom20 <= -9) {
    return { regime: MARKET_REGIMES.BEAR_DEFENSE, reason: '價格位於中長期均線下方且中期趨勢轉弱' };
  }
  if ((theme.strength ?? 0) >= 1.5 && (theme.count ?? 0) >= 2 && close >= ma60 && mom5 > 0) {
    return { regime: MARKET_REGIMES.THEME_MOMENTUM, reason: `題材族群相對強度 ${round(theme.strength, 2)}%，樣本 ${theme.count} 檔` };
  }
  if (close > ma20 && ma20 > ma60 && ma60 > ma120 && ma120 >= ma200
    && ma20Slope > 0 && ma60Slope > 0 && mom20 > 0) {
    return { regime: MARKET_REGIMES.BULL_TREND, reason: '價格與 20/60/120/200 日均線多頭排列' };
  }
  if (close > ma60 && ma60Slope > 0 && mom20 > 0 && (close <= ma20 * 1.02 || mom5 < 0)) {
    return { regime: MARKET_REGIMES.BULL_PULLBACK, reason: '中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱' };
  }
  return { regime: MARKET_REGIMES.RANGE_BOUND, reason: '趨勢排列不完整，價格處於區間型態' };
}

export function buildMarketRegimes(history, options = {}) {
  const closes = [];
  const returns = [];
  const rows = [];
  for (const day of history) {
    const previous = closes.at(-1);
    closes.push(Number(day.close));
    if (previous) returns.push(Number(day.close) / previous - 1);
    const metrics = {
      date: day.date,
      close: Number(day.close),
      ma20: average(closes, 20),
      ma60: average(closes, 60),
      ma120: average(closes, 120),
      ma200: average(closes, 200),
      ma20Slope: slope(closes, 20),
      ma60Slope: slope(closes, 60),
      mom5: pct(closes.at(-1), closes.at(-6)),
      mom20: pct(closes.at(-1), closes.at(-21)),
      vol20: volatility(returns)
    };
    const theme = options.themeByDate?.get(day.date) || {};
    const classification = classifyMarketRegime(metrics, theme);
    rows.push({
      ...Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, key === 'date' ? value : round(value)])),
      ...classification
    });
  }
  return rows;
}

export function regimeMap(history, options = {}) {
  return new Map(buildMarketRegimes(history, options).map(row => [row.date, row]));
}
