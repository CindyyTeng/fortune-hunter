import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'scripts', 'generate-data.mjs');
const yearsArg = process.argv.find(arg => arg.startsWith('--years='));
const BACKTEST_YEARS = Number(yearsArg?.split('=')[1] || process.env.BACKTEST_YEARS || 10);
const OUTPUT_LABEL = `${BACKTEST_YEARS}y`;
const OUTPUT_JSON = path.join(ROOT, 'data', `tw-backtest-${OUTPUT_LABEL}.json`);
const OUTPUT_XLSX = path.join(ROOT, 'data', `tw-backtest-${OUTPUT_LABEL}.xlsx`);
const OUTPUT_MOBILE_MD = path.join(ROOT, 'data', `tw-backtest-${OUTPUT_LABEL}-mobile.md`);
const OUTPUT_MOBILE_CSV = path.join(ROOT, 'data', `tw-backtest-${OUTPUT_LABEL}-mobile.csv`);
const OUTPUT_MOBILE_HTML = path.join(ROOT, 'data', `tw-backtest-${OUTPUT_LABEL}-mobile.html`);
const RANGE = process.env.BACKTEST_RANGE || OUTPUT_LABEL;
const HISTORY_RANGE = process.env.BACKTEST_HISTORY_RANGE || `${BACKTEST_YEARS + 1}y-period`;
const FULL_UNIVERSE = process.env.BACKTEST_FULL_UNIVERSE !== '0';
const SYMBOLS_PER_MARKET = Number(process.env.BACKTEST_SYMBOLS_PER_MARKET || 180);
const CONCURRENCY = Number(process.env.BACKTEST_CONCURRENCY || 5);
const USER_AGENT = 'fortune-hunter-full-backtest/2.0';

const BUY_SIGNAL = '買入候選';
const WATCH_SIGNAL = '偏多觀察';
const CANDIDATE_MIN_SCORE = Number(process.env.BACKTEST_CANDIDATE_MIN_SCORE || 45);
const CANDIDATE_MIN_PRICE = Number(process.env.BACKTEST_CANDIDATE_MIN_PRICE || 5);
const CANDIDATE_MIN_TRADE_VALUE = Number(process.env.BACKTEST_CANDIDATE_MIN_TRADE_VALUE || 20000000);
const CANDIDATE_MIN_VOLUME = Number(process.env.BACKTEST_CANDIDATE_MIN_VOLUME || 100);
const CANDIDATE_MIN_STD_PCT = Number(process.env.BACKTEST_CANDIDATE_MIN_STD_PCT || 0.5);
const CANDIDATE_MAX_STD_PCT = Number(process.env.BACKTEST_CANDIDATE_MAX_STD_PCT || 15);
const CANDIDATE_MAX_RANGE_PCT = Number(process.env.BACKTEST_CANDIDATE_MAX_RANGE_PCT || 30);
const CANDIDATE_MAX_GAP_PCT = Number(process.env.BACKTEST_CANDIDATE_MAX_GAP_PCT || 12);
const CANDIDATE_FORWARD_DAYS = Number(process.env.BACKTEST_CANDIDATE_FORWARD_DAYS || 10);
const ENTRY_MODE = process.env.BACKTEST_ENTRY_MODE || 'intraday_breakout';
const EXIT_MODE = process.env.BACKTEST_EXIT_MODE || 'fixed_hold_stop';
const BUY_FEE_PCT = Number(process.env.BACKTEST_BUY_FEE_PCT || 0.1425);
const SELL_FEE_PCT = Number(process.env.BACKTEST_SELL_FEE_PCT || 0.1425);
const SELL_TAX_PCT = Number(process.env.BACKTEST_SELL_TAX_PCT || 0.3);
const BUY_SLIPPAGE_PCT = Number(process.env.BACKTEST_BUY_SLIPPAGE_PCT || 0.15);
const SELL_SLIPPAGE_PCT = Number(process.env.BACKTEST_SELL_SLIPPAGE_PCT || 0.15);
const MIN_BROKER_FEE = Number(process.env.BACKTEST_MIN_BROKER_FEE || 20);
const MIN_ORDER_VALUE = Number(process.env.BACKTEST_MIN_ORDER_VALUE || 20000);
const BOARD_LOT_SHARES = Number(process.env.BACKTEST_BOARD_LOT_SHARES || 1000);
const SETTLEMENT_DAYS = Number(process.env.BACKTEST_SETTLEMENT_DAYS || 2);
const BREAKOUT_BUFFER_PCT = Number(process.env.BACKTEST_BREAKOUT_BUFFER_PCT || 0.5);
const MAX_GAP_UP_PCT = Number(process.env.BACKTEST_MAX_GAP_UP_PCT || 8);
const MAX_CHASE_PCT = Number(process.env.BACKTEST_MAX_CHASE_PCT || 6);
const NO_FOLLOW_THROUGH_DAYS = Number(process.env.BACKTEST_NO_FOLLOW_THROUGH_DAYS || 2);
const MIN_FOLLOW_THROUGH_MFE_PCT = Number(process.env.BACKTEST_MIN_FOLLOW_THROUGH_MFE_PCT || 1.5);
const COOLDOWN_DAYS = Number(process.env.BACKTEST_COOLDOWN_DAYS || 5);
const MARKET_HEADWIND_PCT = Number(process.env.BACKTEST_MARKET_HEADWIND_PCT || -1.2);
const THEME_HEADWIND_PCT = Number(process.env.BACKTEST_THEME_HEADWIND_PCT || -1.5);
const MIN_PRICE = Number(process.env.BACKTEST_MIN_PRICE || 15);
const MIN_AVG20_TRADE_VALUE = Number(process.env.BACKTEST_MIN_AVG20_TRADE_VALUE || 100000000);
const MIN_AVG20_VOLUME = Number(process.env.BACKTEST_MIN_AVG20_VOLUME || 1000);
const MIN_STD20_PCT = Number(process.env.BACKTEST_MIN_STD20_PCT || 2);
const MAX_STD20_PCT = Number(process.env.BACKTEST_MAX_STD20_PCT || 8.5);
const MAX_DAY_RANGE_PCT = Number(process.env.BACKTEST_MAX_DAY_RANGE_PCT || 14);
const MIN_MOMENTUM_126_21 = Number(process.env.BACKTEST_MIN_MOMENTUM_126_21 || -30);
const MIN_NEAR_YEAR_HIGH = Number(process.env.BACKTEST_MIN_NEAR_YEAR_HIGH || 0.45);
const MIN_INTENT_FACTOR_60 = Number(process.env.BACKTEST_MIN_INTENT_FACTOR_60 || -0.1);
const STRICT_MIN_TRADE_VALUE = Number(process.env.BACKTEST_STRICT_MIN_TRADE_VALUE || 300000000);
const OTC_STRICT_MIN_TRADE_VALUE = Number(process.env.BACKTEST_OTC_STRICT_MIN_TRADE_VALUE || 500000000);
const STRICT_MAX_STD20 = Number(process.env.BACKTEST_STRICT_MAX_STD20 || 0.035);
const OTC_STRICT_MAX_STD20 = Number(process.env.BACKTEST_OTC_STRICT_MAX_STD20 || 0.03);
const STRICT_MIN_SCORE = Number(process.env.BACKTEST_STRICT_MIN_SCORE || 88);
const STRICT_MIN_RSI = Number(process.env.BACKTEST_STRICT_MIN_RSI || 50);
const STRICT_MAX_RSI = Number(process.env.BACKTEST_STRICT_MAX_RSI || 74);
const MIN_ENTRY_RSI = Number(process.env.BACKTEST_MIN_ENTRY_RSI || 60);
const STRICT_MAX_GAP_UP_PCT = Number(process.env.BACKTEST_STRICT_MAX_GAP_UP_PCT || 5);
const STRICT_MAX_CHASE_PCT = Number(process.env.BACKTEST_STRICT_MAX_CHASE_PCT || 4);
const HOLD_DAYS_OVERRIDE = Number(process.env.BACKTEST_HOLD_DAYS_OVERRIDE || 5);
const INITIAL_CAPITAL = Number(process.env.BACKTEST_INITIAL_CAPITAL || 1000000);
const POSITION_PCT = Number(process.env.BACKTEST_POSITION_PCT || 44);
const ACCOUNT_RISK_CAP_PCT = Number(process.env.BACKTEST_ACCOUNT_RISK_CAP_PCT || 2);
const MAX_OPEN_POSITIONS = Number(process.env.BACKTEST_MAX_OPEN_POSITIONS || 8);
const TARGET_MONTHLY_RETURN_PCT = Number(process.env.BACKTEST_TARGET_MONTHLY_RETURN_PCT || 10);
const BUY_CONFIRMATIONS = Number(process.env.BACKTEST_BUY_CONFIRMATIONS || 2);
const EXPLORATION_CONFIRMATIONS = Number(process.env.BACKTEST_EXPLORATION_CONFIRMATIONS || 4);
const MARKET_CRASH_PCT = Number(process.env.BACKTEST_MARKET_CRASH_PCT || -1);
const THEME_CRASH_PCT = Number(process.env.BACKTEST_THEME_CRASH_PCT || -1);
const MARKET_CAUTION_PCT = Number(process.env.BACKTEST_MARKET_CAUTION_PCT || -0.5);
const THEME_CAUTION_PCT = Number(process.env.BACKTEST_THEME_CAUTION_PCT || -0.5);
const GLOBAL_CRASH_PCT = Number(process.env.BACKTEST_GLOBAL_CRASH_PCT || -1.5);
const GLOBAL_CAUTION_PCT = Number(process.env.BACKTEST_GLOBAL_CAUTION_PCT || -0.8);
const ASIA_CRASH_PCT = Number(process.env.BACKTEST_ASIA_CRASH_PCT || -1.2);
const ASIA_CAUTION_PCT = Number(process.env.BACKTEST_ASIA_CAUTION_PCT || -0.6);
const DEFENSIVE_POSITION_PCT = Number(process.env.BACKTEST_DEFENSIVE_POSITION_PCT || 20);
const CAUTION_POSITION_PCT = Number(process.env.BACKTEST_CAUTION_POSITION_PCT || 0);
const EXPLORATORY_POSITION_PCT = Number(process.env.BACKTEST_EXPLORATORY_POSITION_PCT || 20);
const MIN_EXPLORATORY_SCORE = Number(process.env.BACKTEST_MIN_EXPLORATORY_SCORE || 70);
const TRAIL_TRIGGER_PCT = Number(process.env.BACKTEST_TRAIL_TRIGGER_PCT || 3);
const TRAIL_GIVEBACK_PCT = Number(process.env.BACKTEST_TRAIL_GIVEBACK_PCT || 5);
const TRAIL_LOCK_PCT = Number(process.env.BACKTEST_TRAIL_LOCK_PCT || 1);
const STRONG_TAILWIND_BOOST = Number(process.env.BACKTEST_STRONG_TAILWIND_BOOST || 1.5);

const GLOBAL_SYMBOLS = {
  sp500: '^GSPC',
  nasdaq: '^IXIC',
  dow: '^DJI',
  sox: '^SOX',
  nikkei: '^N225',
  kospi: '^KS11',
  kosdaq: '^KQ11'
};

function pct(now, then) {
  return then ? ((now - then) / then) * 100 : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function average(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

function standardDeviation(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((sum, value) => sum + value, 0) / period;
  return Math.sqrt(slice.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period);
}

function technicalFactors(history, signalIndex) {
  const visible = history.slice(0, signalIndex + 1);
  if (visible.length < 40) return {};
  const day = visible.at(-1);
  const previous = visible.at(-2);
  const closes = visible.map(row => row.close);
  const volumes = visible.map(row => row.volume);
  const ma20 = average(closes, 20);
  const stdClose20 = standardDeviation(closes, 20);
  const previousMa20 = average(closes.slice(0, -1), 20);
  const ma20FiveDaysAgo = average(closes.slice(0, -5), 20);
  const avgVolume20 = average(volumes, 20);
  const avgVolume5 = average(volumes, 5);
  const previousAvgVolume20 = average(volumes.slice(0, -1), 20);
  const return5Pct = pct(day.close, visible.at(-6)?.close);
  const return20Pct = pct(day.close, visible.at(-21)?.close);
  const volumeRatio1To20 = avgVolume20 ? day.volume / avgVolume20 : null;
  const volumeRatio5To20 = avgVolume20 ? avgVolume5 / avgVolume20 : null;
  const previousVolumeRatio = previousAvgVolume20
    ? previous.volume / previousAvgVolume20
    : null;
  const ma20Slope5Pct = pct(ma20, ma20FiveDaysAgo);
  const distanceToMa20Pct = pct(day.close, ma20);
  const candleRange = day.high - day.low;
  const upperWickRatio = candleRange > 0
    ? (day.high - Math.max(day.open, day.close)) / candleRange
    : 0;
  const recentHigh20 = Math.max(...visible.slice(-20).map(row => row.high));
  const priorHigh20 = Math.max(...visible.slice(-21, -1).map(row => row.high));
  const recentLow20 = Math.min(...visible.slice(-20).map(row => row.low));
  const recent20 = visible.slice(-20);
  const trueRanges = visible.slice(-20).map((row, index, rows) => {
    const previousClose = index
      ? rows[index - 1].close
      : visible.at(-21)?.close ?? row.close;
    return Math.max(
      row.high - row.low,
      Math.abs(row.high - previousClose),
      Math.abs(row.low - previousClose)
    );
  });
  const atr14 = average(trueRanges, 14);
  const bollingerUpper = ma20 + 2 * stdClose20;
  const bollingerLower = ma20 - 2 * stdClose20;
  const bollingerRange = bollingerUpper - bollingerLower;
  const stochastic14High = Math.max(...visible.slice(-14).map(row => row.high));
  const stochastic14Low = Math.min(...visible.slice(-14).map(row => row.low));
  const stochastic14 = stochastic14High === stochastic14Low
    ? 50
    : (day.close - stochastic14Low) / (stochastic14High - stochastic14Low) * 100;
  const returns = closes.slice(-21).slice(1).map((close, index) => (
    pct(close, closes.at(-21 + index)) / 100
  ));
  const stdReturn5 = standardDeviation(returns, 5);
  const stdReturn20 = standardDeviation(returns, 20);
  let plusDm = 0;
  let minusDm = 0;
  let tr14 = 0;
  for (let index = visible.length - 14; index < visible.length; index += 1) {
    const row = visible[index];
    const prior = visible[index - 1];
    const up = row.high - prior.high;
    const down = prior.low - row.low;
    plusDm += up > down && up > 0 ? up : 0;
    minusDm += down > up && down > 0 ? down : 0;
    tr14 += Math.max(
      row.high - row.low,
      Math.abs(row.high - prior.close),
      Math.abs(row.low - prior.close)
    );
  }
  const plusDi14 = tr14 ? plusDm / tr14 * 100 : 0;
  const minusDi14 = tr14 ? minusDm / tr14 * 100 : 0;
  const dx14 = plusDi14 + minusDi14
    ? Math.abs(plusDi14 - minusDi14) / (plusDi14 + minusDi14) * 100
    : 0;
  const intradayMomentum20Pct = (Math.exp(recent20.reduce(
    (sum, row) => sum + Math.log(row.close / row.open),
    0
  )) - 1) * 100;
  const overnightMomentum20Pct = (Math.exp(recent20.reduce((sum, row, index) => {
    const previousClose = visible[visible.length - recent20.length + index - 1]?.close;
    return previousClose ? sum + Math.log(row.open / previousClose) : sum;
  }, 0)) - 1) * 100;
  const nearHigh20 = day.close >= recentHigh20 * 0.95;
  const ma20Rising = ma20Slope5Pct > 0;
  const crossAboveMa20 = previous.close <= previousMa20 && day.close > ma20;
  const falseBreakdownReclaim = ma20Rising && day.low < ma20 && day.close > ma20;
  const supportBounce = ma20Rising
    && day.low <= ma20 * 1.02
    && day.close > ma20
    && day.close > day.open;
  let priceVolumeState = 'neutral';
  if (return5Pct >= 2 && volumeRatio5To20 >= 1.15) priceVolumeState = 'price_up_volume_up';
  else if (return5Pct >= 2 && volumeRatio5To20 <= 0.85) priceVolumeState = 'price_up_volume_down';
  else if (return5Pct <= -2 && volumeRatio5To20 >= 1.15) priceVolumeState = 'price_down_volume_up';
  else if (return5Pct <= -2 && volumeRatio5To20 <= 0.85) priceVolumeState = 'price_down_volume_down';
  else if (Math.abs(return5Pct) < 2 && volumeRatio5To20 >= 1.15) priceVolumeState = 'flat_volume_up';
  else if (Math.abs(return5Pct) < 2 && volumeRatio5To20 <= 0.85) priceVolumeState = 'flat_volume_down';

  return {
    return5Pct: round(return5Pct),
    return20Pct: round(return20Pct),
    volumeRatio1To20: round(volumeRatio1To20, 3),
    volumeRatio5To20: round(volumeRatio5To20, 3),
    previousVolumeRatio: round(previousVolumeRatio, 3),
    priceVolumeState,
    ma20: round(ma20),
    ma20Slope5Pct: round(ma20Slope5Pct),
    distanceToMa20Pct: round(distanceToMa20Pct),
    ma20Rising,
    crossAboveMa20,
    falseBreakdownReclaim,
    supportBounce,
    overextendedAboveMa20: distanceToMa20Pct >= 8,
    highVolumeDistribution: nearHigh20
      && day.close < day.open
      && volumeRatio1To20 >= 1.5
      && upperWickRatio >= 0.25,
    upperWickRatio: round(upperWickRatio, 3),
    intradayMomentum20Pct: round(intradayMomentum20Pct),
    overnightMomentum20Pct: round(overnightMomentum20Pct),
    intradayMinusOvernight20Pct: round(intradayMomentum20Pct - overnightMomentum20Pct),
    atr14Pct: round(atr14 / day.close * 100),
    bollingerPercentB: round(bollingerRange ? (day.close - bollingerLower) / bollingerRange : 0.5, 3),
    bollingerBandwidthPct: round(bollingerRange / ma20 * 100),
    bollingerUpperBreakout: day.close > bollingerUpper,
    volatilityCompression5To20: round(stdReturn20 ? stdReturn5 / stdReturn20 : null, 3),
    stochastic14: round(stochastic14),
    plusDi14: round(plusDi14),
    minusDi14: round(minusDi14),
    dx14: round(dx14),
    directionalTrendUp: plusDi14 > minusDi14 && dx14 >= 20,
    donchian20Breakout: day.close > priorHigh20,
    donchian20Position: round(
      recentHigh20 === recentLow20 ? 0.5 : (day.close - recentLow20) / (recentHigh20 - recentLow20),
      3
    )
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function parseMoney(text) {
  return [...String(text || '').matchAll(/NT\$\s*([\d.]+)/g)].map(match => Number(match[1]));
}

function parseHoldDays(text) {
  const match = String(text || '').match(/(\d+)\s*個交易日/);
  return match ? Number(match[1]) : 7;
}

function taipeiDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

function todayTaipeiText() {
  const { year, month, day } = taipeiDateParts();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function yearsAgoTaipeiText(years = BACKTEST_YEARS) {
  const { year, month, day } = taipeiDateParts();
  return `${year - years}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      ...options,
      headers: { 'user-agent': USER_AGENT, ...(options.headers || {}) }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYahooHistory(symbol) {
  const historyStart = process.env.BACKTEST_HISTORY_START_DATE
    || yearsAgoTaipeiText(BACKTEST_YEARS + 1);
  const period1 = Math.floor(Date.parse(`${historyStart}T00:00:00Z`) / 1000);
  const period2 = Math.floor(Date.now() / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&includePrePost=false&events=div%2Csplits`;
  const json = await fetchJson(url);
  const result = json.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!result?.timestamp?.length || !quote) throw new Error(`history parse failed: ${symbol}`);
  return result.timestamp.map((timestamp, index) => ({
    date: new Date(timestamp * 1000).toISOString().slice(0, 10),
    open: quote.open[index],
    high: quote.high[index],
    low: quote.low[index],
    close: quote.close[index],
    volume: quote.volume[index]
  })).filter(day => [day.open, day.high, day.low, day.close, day.volume].every(Number.isFinite));
}

async function loadStrategyCore() {
  let source = await fs.readFile(SOURCE_PATH, 'utf8');
  source = source.replaceAll('import.meta.url', 'importMetaUrl');
  source = source.replace(/\nmain\(\)\.catch\([\s\S]*$/, '\n');
  const factory = new Function('importMetaUrl', `${source}
return { fetchTwseUniverse, fetchTpexUniverse, analyzeWindow, mapLimit };`);
  return factory(pathToFileURL(SOURCE_PATH).href);
}

function planFromAnalysis(analysis) {
  const takeProfitPrices = parseMoney(analysis.plan?.takeProfit);
  const stopPrices = parseMoney(analysis.plan?.stopLoss);
  const holdDays = HOLD_DAYS_OVERRIDE || parseHoldDays(analysis.plan?.horizon);
  return {
    holdDays,
    midDays: Math.max(3, Math.ceil(holdDays / 2)),
    stop: stopPrices[0] || analysis.latestPrice * 0.95,
    targetFast: takeProfitPrices[0] || analysis.latestPrice * 1.05,
    targetFull: takeProfitPrices[1] || analysis.latestPrice * 1.08,
    resistance: Number(analysis.metrics?.resistance) || null
  };
}

function netReturnPct(entryPrice, exitPrice) {
  const netEntry = entryPrice * (1 + (BUY_FEE_PCT + BUY_SLIPPAGE_PCT) / 100);
  const netExit = exitPrice * (1 - (SELL_FEE_PCT + SELL_TAX_PCT + SELL_SLIPPAGE_PCT) / 100);
  return pct(netExit, netEntry);
}

function orderFee(price, quantity, feePct) {
  const feeFor = shares => shares > 0
    ? Math.max(MIN_BROKER_FEE, Math.ceil(price * shares * feePct / 100))
    : 0;
  const boardShares = Math.floor(quantity / BOARD_LOT_SHARES) * BOARD_LOT_SHARES;
  const oddShares = quantity - boardShares;
  return feeFor(boardShares) + feeFor(oddShares);
}

function buyExecution(price, quantity) {
  const fillPrice = price * (1 + BUY_SLIPPAGE_PCT / 100);
  const tradeValue = fillPrice * quantity;
  const fee = orderFee(fillPrice, quantity, BUY_FEE_PCT);
  return {
    fillPrice,
    tradeValue,
    fee,
    total: tradeValue + fee
  };
}

function sellExecution(price, quantity) {
  const fillPrice = price * (1 - SELL_SLIPPAGE_PCT / 100);
  const tradeValue = fillPrice * quantity;
  const fee = orderFee(fillPrice, quantity, SELL_FEE_PCT);
  const tax = Math.ceil(tradeValue * SELL_TAX_PCT / 100);
  return {
    fillPrice,
    tradeValue,
    fee,
    tax,
    net: tradeValue - fee - tax
  };
}

function affordableQuantity(entryPrice, stopPrice, cashBudget, riskBudget) {
  let low = 0;
  let high = Math.max(0, Math.floor(cashBudget / entryPrice));
  while (low < high) {
    const quantity = Math.ceil((low + high) / 2);
    const buy = buyExecution(entryPrice, quantity);
    const stop = sellExecution(stopPrice, quantity);
    const risk = buy.total - stop.net;
    if (buy.total <= cashBudget && risk <= riskBudget) low = quantity;
    else high = quantity - 1;
  }
  return low > 0 && buyExecution(entryPrice, low).tradeValue >= MIN_ORDER_VALUE ? low : 0;
}

function monthKey(dateText) {
  return String(dateText || '').slice(0, 7);
}

function monthKeys(startDate, endDate) {
  const [startYear, startMonth] = startDate.split('-').map(Number);
  const [endYear, endMonth] = endDate.split('-').map(Number);
  const keys = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    keys.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month === 13) {
      year += 1;
      month = 1;
    }
  }
  return keys;
}

function inferThemes(stock) {
  const name = stock.name || '';
  const code = stock.code || '';
  const themes = [];
  if (/金|銀行|證券|保險/.test(name)) themes.push('finance');
  if (/記憶體|DRAM|快閃|模組|儲存|威剛|創見|群聯|南亞科|華邦電|旺宏|十銓|品安/.test(name)
    || ['2408', '2344', '2337', '3260', '2451', '8299', '4967', '8088'].includes(code)) themes.push('memory');
  if (/被動|電阻|電容|MLCC|國巨|華新科|禾伸堂|凱美|信昌電|鈺邦|蜜望實/.test(name)
    || ['2327', '2492', '3026', '2375', '6173', '6449', '8043'].includes(code)) themes.push('passive');
  if (/半導體|IC|晶|矽|封測|電子|材料|設備|再生晶圓|萬潤|世禾|信紘科|崇越電|辛耘|帆宣|弘塑|中砂|志聖/.test(name)
    || ['2330', '2303', '2454', '3034', '3711', '3443', '6415', '8299', '6187', '3551', '3583'].includes(code)) themes.push('semiconductor');
  if (/伺服器|AI|網通|資料中心|電源|台達電|光寶|廣達|緯創/.test(name)
    || ['2308', '2317', '2382', '3231', '6669', '3017', '2356', '2376', '2357', '2383', '4938'].includes(code)) themes.push('ai-hardware');
  if (/電機|重電|電纜|電線|變壓器|電力|儲能|充電|電源|中興電|華城|亞力|士電|大同|東元/.test(name)
    || ['1513', '1519', '1503', '1504', '2308', '2371', '1605', '1609', '1611', '1529'].includes(code)) themes.push('power');
  if (!themes.length) themes.push('general');
  return themes;
}

function themeLabel(theme) {
  const labels = {
    finance: '金融',
    memory: '記憶體',
    passive: '被動元件',
    semiconductor: '半導體',
    'ai-hardware': 'AI硬體',
    power: '重電電力',
    general: '一般'
  };
  return labels[theme] || theme;
}

function pushGroup(map, key, value) {
  if (!Number.isFinite(value)) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function buildTailwindMaps(items) {
  const marketRaw = new Map();
  const themeRaw = new Map();
  for (const item of items) {
    const themes = inferThemes(item.stock);
    for (let i = 1; i < item.history.length; i += 1) {
      const day = item.history[i];
      const prev = item.history[i - 1];
      const change = pct(day.close, prev.close);
      pushGroup(marketRaw, `${day.date}|${item.stock.market}`, change);
      for (const theme of themes) pushGroup(themeRaw, `${day.date}|${theme}`, change);
    }
  }
  const averageMap = raw => new Map([...raw.entries()].map(([key, values]) => [
    key,
    values.reduce((sum, value) => sum + value, 0) / values.length
  ]));
  return { market: averageMap(marketRaw), theme: averageMap(themeRaw) };
}

async function buildGlobalRiskMap() {
  const histories = {};
  await Promise.all(Object.entries(GLOBAL_SYMBOLS).map(async ([key, symbol]) => {
    try {
      histories[key] = await fetchYahooHistory(symbol);
    } catch (error) {
      histories[key] = [];
    }
  }));
  const byDate = new Map();
  const push = (date, key, value) => {
    if (!Number.isFinite(value)) return;
    if (!byDate.has(date)) byDate.set(date, {});
    byDate.get(date)[key] = value;
  };
  for (const [key, history] of Object.entries(histories)) {
    for (let i = 1; i < history.length; i += 1) {
      push(history[i].date, key, pct(history[i].close, history[i - 1].close));
    }
  }
  const map = new Map();
  for (const [date, row] of byDate.entries()) {
    const usComposite = round(
      (row.sp500 || 0) * 0.35
        + (row.nasdaq || 0) * 0.3
        + (row.dow || 0) * 0.15
        + (row.sox || 0) * 0.2,
      2
    );
    const asiaComposite = round(
      (row.nikkei || 0) * 0.45
        + (row.kospi || 0) * 0.35
        + (row.kosdaq || 0) * 0.2,
      2
    );
    const techComposite = round((row.nasdaq || 0) * 0.45 + (row.sox || 0) * 0.55, 2);
    map.set(date, {
      ...row,
      usComposite,
      asiaComposite,
      techComposite,
      globalComposite: round(usComposite * 0.6 + asiaComposite * 0.4, 2)
    });
  }
  return map;
}

function tailwindFor(stock, signalDate, maps) {
  const themes = inferThemes(stock);
  const marketMove = maps.market.get(`${signalDate}|${stock.market}`);
  const themeMoves = themes.map(theme => maps.theme.get(`${signalDate}|${theme}`)).filter(Number.isFinite);
  const themeMove = themeMoves.length ? themeMoves.reduce((sum, value) => sum + value, 0) / themeMoves.length : null;
  const marketHeadwind = Number.isFinite(marketMove) && marketMove < MARKET_HEADWIND_PCT;
  const themeHeadwind = Number.isFinite(themeMove) && themeMove < THEME_HEADWIND_PCT;
  return {
    themes: themes.map(themeLabel).join(','),
    marketMove: round(marketMove),
    themeMove: round(themeMove),
    isHeadwind: marketHeadwind || themeHeadwind,
    global: maps.global?.get(signalDate) || null
  };
}

function passesFormalQuality(trade) {
  return trade.entryPrice >= MIN_PRICE
    && trade.rsi14 >= MIN_ENTRY_RSI
    && trade.avg20TradeValue >= MIN_AVG20_TRADE_VALUE
    && trade.avg20Volume >= MIN_AVG20_VOLUME
    && trade.std20Pct >= MIN_STD20_PCT
    && trade.std20Pct <= MAX_STD20_PCT
    && trade.maxRange20Pct <= MAX_DAY_RANGE_PCT
    && trade.gapUpPct <= MAX_GAP_UP_PCT;
}

function tradeRiskMode(trade) {
  if (![BUY_SIGNAL, WATCH_SIGNAL].includes(trade.signal)) {
    return { mode: '非正式訊號空手', positionPct: 0, reason: '研究候選尚未形成正式買入或偏多觀察訊號。' };
  }
  if (!passesFormalQuality(trade)) {
    return { mode: '品質濾網空手', positionPct: 0, reason: '未通過正式價格、動能、流動性、波動或跳空門檻。' };
  }
  const confirmations = [
    trade.marketMovePct >= 0.25,
    trade.themeMovePct >= 0.25,
    trade.globalCompositePct >= 0,
    trade.asiaCompositePct >= 0,
    trade.gapUpPct >= 0.5
  ].filter(Boolean).length;
  const requiredConfirmations = trade.signal === BUY_SIGNAL
    ? BUY_CONFIRMATIONS
    : EXPLORATION_CONFIRMATIONS;
  if (confirmations < requiredConfirmations) {
    return {
      mode: trade.signal === BUY_SIGNAL ? '買入訊號空手' : '觀察訊號空手',
      positionPct: 0,
      reason: `市場、族群、海外與開盤確認僅 ${confirmations}/5，未達 ${requiredConfirmations} 項，不勉強進場。`
    };
  }
  if (trade.globalCompositePct <= GLOBAL_CRASH_PCT || trade.asiaCompositePct <= ASIA_CRASH_PCT) {
    return {
      mode: '全球急跌防守',
      positionPct: 0,
      reason: `美股/日韓綜合轉弱：全球 ${trade.globalCompositePct ?? '-'}%、亞洲 ${trade.asiaCompositePct ?? '-'}%，暫停開新倉。`
    };
  }
  if (trade.marketMovePct <= MARKET_CRASH_PCT || trade.themeMovePct <= THEME_CRASH_PCT) {
    return {
      mode: '急跌防守',
      positionPct: 0,
      reason: `同市場 ${trade.marketMovePct ?? '-'}%、同族群 ${trade.themeMovePct ?? '-'}%，觸發大盤/族群急跌防守。`
    };
  }
  if (trade.gapUpPct < 0) {
    return {
      mode: '負跳空空手',
      positionPct: CAUTION_POSITION_PCT,
      reason: '隔日負跳空，突破缺乏開盤確認，暫停開新倉。'
    };
  }
  let positionPct = trade.signal !== BUY_SIGNAL ? EXPLORATORY_POSITION_PCT
    : trade.strictRisk ? DEFENSIVE_POSITION_PCT
      : POSITION_PCT;
  const strongTailwind = trade.marketMovePct >= 1
    && trade.themeMovePct >= 1
    && trade.globalCompositePct > GLOBAL_CRASH_PCT
    && trade.asiaCompositePct > ASIA_CRASH_PCT;
  if (strongTailwind) positionPct = Math.min(60, positionPct * STRONG_TAILWIND_BOOST);
  const stopDistancePct = ((trade.entryPrice - trade.stopLoss) / trade.entryPrice) * 100;
  if (!Number.isFinite(stopDistancePct) || stopDistancePct <= 0) {
    return {
      mode: '停損無效空手',
      positionPct: 0,
      reason: '無法用有效停損價計算單筆風險，因此不建立部位。'
    };
  }
  const plannedPositionPct = positionPct;
  positionPct = Math.min(positionPct, ACCOUNT_RISK_CAP_PCT * 100 / stopDistancePct);
  const riskText = positionPct < plannedPositionPct
    ? `依停損距離 ${round(stopDistancePct)}%，部位降至 ${round(positionPct)}%，使帳戶風險不超過 ${ACCOUNT_RISK_CAP_PCT}%。`
    : `依停損距離估算，帳戶風險不超過 ${ACCOUNT_RISK_CAP_PCT}%。`;
  if (trade.signal !== BUY_SIGNAL) {
    return {
      mode: strongTailwind ? '順風探索加碼' : '零股探索',
      positionPct,
      reason: strongTailwind
        ? `大盤與族群同步強勢，探索部位上限提高；${riskText}`
        : `偏多觀察通過執行濾網；${riskText}`
    };
  }
  if (trade.strictRisk) {
    return {
      mode: strongTailwind ? '嚴格風險順風部位' : '嚴格風險降部位',
      positionPct,
      reason: strongTailwind
        ? `嚴格風險標的遇到大盤與族群同步強勢；${riskText}`
        : `低流動性、高波動或上櫃風險較高；${riskText}`
    };
  }
  return {
    mode: strongTailwind ? '順風標準加碼' : '標準部位',
    positionPct,
    reason: strongTailwind
      ? `大盤與族群同步上漲至少 1%；${riskText}`
      : riskText
  };
}

function simulateTrade(history, stock, signalIndex, analysis, entryIndex, tailwind = null) {
  const signalDay = history[signalIndex];
  const entryDay = history[entryIndex];
  const plan = planFromAnalysis(analysis);
  const factors = technicalFactors(history, signalIndex);
  const recent20 = history.slice(Math.max(0, signalIndex - 20), signalIndex);
  if (recent20.length < 20) return null;
  const maxRange20 = Math.max(...recent20.map(day => pct(day.high, day.low) || 0));
  const std20Pct = analysis.metrics?.std20 === null || analysis.metrics?.std20 === undefined
    ? null
    : analysis.metrics.std20 * 100;
  if (signalDay.close < CANDIDATE_MIN_PRICE) return null;
  if (analysis.metrics?.avg20TradeValue !== null && analysis.metrics.avg20TradeValue < CANDIDATE_MIN_TRADE_VALUE) return null;
  if (analysis.metrics?.volume20d !== null && analysis.metrics.volume20d < CANDIDATE_MIN_VOLUME) return null;
  if (std20Pct !== null && std20Pct < CANDIDATE_MIN_STD_PCT) return null;
  if (std20Pct !== null && std20Pct > CANDIDATE_MAX_STD_PCT) return null;
  if (maxRange20 > CANDIDATE_MAX_RANGE_PCT) return null;
  const strictRisk = (analysis.metrics?.avg20TradeValue !== null && analysis.metrics.avg20TradeValue < STRICT_MIN_TRADE_VALUE)
    || (analysis.metrics?.std20 !== null && analysis.metrics.std20 >= STRICT_MAX_STD20)
    || (stock.market === '上櫃' && (
      (analysis.metrics?.avg20TradeValue !== null && analysis.metrics.avg20TradeValue < OTC_STRICT_MIN_TRADE_VALUE)
      || (analysis.metrics?.std20 !== null && analysis.metrics.std20 >= OTC_STRICT_MAX_STD20)
    ));
  const trigger = plan.resistance ? plan.resistance * (1 + BREAKOUT_BUFFER_PCT / 100) : entryDay.open;
  const gapUpPct = pct(entryDay.open, signalDay.close) || 0;
  const entryPrice = ENTRY_MODE === 'close_confirm'
    ? entryDay.close
    : ENTRY_MODE === 'next_open'
      ? entryDay.open
      : Math.max(entryDay.open, trigger);
  const chasePct = pct(entryPrice, trigger) || 0;
  if (ENTRY_MODE === 'close_confirm' && entryDay.close < trigger) return null;
  if (ENTRY_MODE === 'close_confirm' && entryDay.close < entryDay.open) return null;
  if (ENTRY_MODE === 'intraday_breakout' && entryDay.high < trigger) return null;
  if (gapUpPct > CANDIDATE_MAX_GAP_PCT) return null;
  const endIndex = Math.min(entryIndex + plan.holdDays, history.length - 1);
  if (EXIT_MODE === 'fixed_hold' || EXIT_MODE === 'fixed_hold_stop') {
    let exitIndex = endIndex;
    let exitReason = `固定持有 ${plan.holdDays} 天`;
    let peakCloseReturnPct = -Infinity;
    if (EXIT_MODE === 'fixed_hold_stop' && plan.stop) {
      for (let i = entryIndex; i <= endIndex; i += 1) {
        if (history[i].low <= plan.stop) {
          exitIndex = i;
          exitReason = '跌破停損提前出場';
          break;
        }
        const closeReturnPct = netReturnPct(entryPrice, history[i].close);
        peakCloseReturnPct = Math.max(peakCloseReturnPct, closeReturnPct);
        const trailFloorPct = Math.max(TRAIL_LOCK_PCT, peakCloseReturnPct - TRAIL_GIVEBACK_PCT);
        if (i < endIndex && peakCloseReturnPct >= TRAIL_TRIGGER_PCT && closeReturnPct <= trailFloorPct) {
          exitIndex = i;
          exitReason = '收盤移動停利';
          break;
        }
      }
    }
    const exitDay = history[exitIndex];
    const exitPrice = exitReason === '跌破停損提前出場'
      ? Math.min(exitDay.open, plan.stop)
      : exitDay.close;
    const future = history.slice(entryIndex, exitIndex + 1);
    const forward = history.slice(
      entryIndex,
      Math.min(entryIndex + CANDIDATE_FORWARD_DAYS, history.length - 1) + 1
    );
    return {
      tradeId: `${stock.code}-${signalDay.date}`,
      symbol: stock.code,
      name: stock.name,
      market: stock.market,
      signalDate: signalDay.date,
      entryDate: entryDay.date,
      entryPrice: round(entryPrice),
      exitDate: exitDay.date,
      exitPrice: round(exitPrice),
      exitReason,
      netReturnPct: round(netReturnPct(entryPrice, exitPrice)),
      grossMfePct: round(pct(Math.max(...future.map(day => day.high)), entryPrice)),
      grossMaePct: round(pct(Math.min(...future.map(day => day.low)), entryPrice)),
      holdingDays: exitIndex - entryIndex + 1,
      plannedHoldDays: plan.holdDays,
      signalScore: analysis.score,
      signal: analysis.signal,
      sellWarningLevel: analysis.sellWarning?.level,
      themes: tailwind?.themes || '',
      marketMovePct: tailwind?.marketMove,
      themeMovePct: tailwind?.themeMove,
      usCompositePct: tailwind?.global?.usComposite,
      asiaCompositePct: tailwind?.global?.asiaComposite,
      techCompositePct: tailwind?.global?.techComposite,
      globalCompositePct: tailwind?.global?.globalComposite,
      nikkeiPct: round(tailwind?.global?.nikkei),
      kospiPct: round(tailwind?.global?.kospi),
      kosdaqPct: round(tailwind?.global?.kosdaq),
      strictRisk,
      riskMode: null,
      riskModeReason: null,
      rsi14: analysis.metrics?.rsi14,
      std20: analysis.metrics?.std20,
      std20Pct: round(std20Pct),
      maxRange20Pct: round(maxRange20),
      avg20TradeValue: analysis.metrics?.avg20TradeValue,
      avg20Volume: analysis.metrics?.volume20d,
      momentum126_21: analysis.metrics?.momentum126_21,
      nearYearHigh: analysis.metrics?.nearYearHigh,
      intentFactor60: analysis.metrics?.intentFactor60,
      ...factors,
      resistance: round(plan.resistance),
      triggerPrice: round(trigger),
      gapUpPct: round(gapUpPct),
      chasePct: round(chasePct),
      stopLoss: round(plan.stop),
      targetFast: round(plan.targetFast),
      targetFull: round(plan.targetFull),
      markPrices: future.map(day => ({
        date: day.date,
        price: round(day.close),
        high: round(day.high),
        low: round(day.low)
      })),
      forwardPrices: forward.map(day => ({
        date: day.date,
        open: round(day.open),
        price: round(day.close),
        high: round(day.high),
        low: round(day.low)
      })),
      partialExits: `${exitDay.date} ${exitReason} 100% @ ${round(exitPrice)}`,
      reasons: analysis.reasons.slice(0, 5).join(' | '),
      risks: analysis.risks.slice(0, 5).join(' | ')
    };
  }
  const closeSeries = history.slice(0, entryIndex + 1).map(day => day.close);
  let belowMa5Days = 0;
  let remainingWeight = 1;
  let realizedReturn = 0;
  let finalExitIndex = endIndex;
  let exitReason = `hold_${plan.holdDays}d`;
  let maxHigh = entryDay.high;
  let minLow = entryDay.low;
  const partialExits = [];

  const sell = (dayIndex, weight, price, reason) => {
    realizedReturn += (netReturnPct(entryPrice, price) || 0) * weight;
    remainingWeight = round(remainingWeight - weight, 6);
    finalExitIndex = dayIndex;
    exitReason = reason;
    partialExits.push({
      date: history[dayIndex].date,
      price: round(price),
      weightPct: round(weight * 100),
      reason,
      netReturnPct: round(netReturnPct(entryPrice, price))
    });
  };

  for (let i = entryIndex; i <= endIndex; i += 1) {
    const day = history[i];
    if (i > entryIndex) closeSeries.push(day.close);
    maxHigh = Math.max(maxHigh, day.high);
    minLow = Math.min(minLow, day.low);

    if (remainingWeight > 0 && plan.stop && day.low <= plan.stop) {
      sell(i, remainingWeight, Math.min(day.open, plan.stop), '停損');
      break;
    }
    if (remainingWeight === 1 && i - entryIndex + 1 >= plan.midDays && day.high >= plan.targetFast) {
      sell(i, 0.5, plan.targetFast, '先停利一半');
    }
    if (remainingWeight > 0 && day.high >= plan.targetFull) {
      sell(i, remainingWeight, plan.targetFull, '全部停利');
      break;
    }

    if (remainingWeight > 0
      && i - entryIndex + 1 >= NO_FOLLOW_THROUGH_DAYS
      && pct(maxHigh, entryPrice) < MIN_FOLLOW_THROUGH_MFE_PCT) {
      sell(i, remainingWeight, day.close, '兩天內未出現續航');
      break;
    }

    const ma5 = average(closeSeries, 5);
    if (ma5 && day.close < ma5) belowMa5Days += 1;
    else belowMa5Days = 0;

    if (remainingWeight > 0 && belowMa5Days >= 2) {
      sell(i, remainingWeight, day.close, '連續兩天收破 5 日線');
      break;
    }
    if (remainingWeight > 0 && i === endIndex) {
      sell(i, remainingWeight, day.close, `持有 ${plan.holdDays} 天到期`);
    }
  }

  return {
    tradeId: `${stock.code}-${signalDay.date}`,
    symbol: stock.code,
    name: stock.name,
    market: stock.market,
    signalDate: signalDay.date,
    entryDate: entryDay.date,
    entryPrice: round(entryPrice),
    exitDate: history[finalExitIndex]?.date || null,
    exitPrice: partialExits.at(-1)?.price || null,
    exitReason,
    netReturnPct: round(realizedReturn),
    grossMfePct: round(pct(maxHigh, entryPrice)),
    grossMaePct: round(pct(minLow, entryPrice)),
    holdingDays: finalExitIndex - entryIndex + 1,
    plannedHoldDays: plan.holdDays,
    signalScore: analysis.score,
    signal: analysis.signal,
    sellWarningLevel: analysis.sellWarning?.level,
    themes: tailwind?.themes || '',
    marketMovePct: tailwind?.marketMove,
    themeMovePct: tailwind?.themeMove,
    usCompositePct: tailwind?.global?.usComposite,
    asiaCompositePct: tailwind?.global?.asiaComposite,
    techCompositePct: tailwind?.global?.techComposite,
    globalCompositePct: tailwind?.global?.globalComposite,
    nikkeiPct: round(tailwind?.global?.nikkei),
    kospiPct: round(tailwind?.global?.kospi),
    kosdaqPct: round(tailwind?.global?.kosdaq),
    strictRisk,
    riskMode: null,
    riskModeReason: null,
    rsi14: analysis.metrics?.rsi14,
    std20: analysis.metrics?.std20,
    std20Pct: round(std20Pct),
    maxRange20Pct: round(maxRange20),
    avg20TradeValue: analysis.metrics?.avg20TradeValue,
    avg20Volume: analysis.metrics?.volume20d,
    momentum126_21: analysis.metrics?.momentum126_21,
    nearYearHigh: analysis.metrics?.nearYearHigh,
    intentFactor60: analysis.metrics?.intentFactor60,
    ...factors,
    resistance: round(plan.resistance),
    triggerPrice: round(trigger),
    gapUpPct: round(gapUpPct),
    chasePct: round(chasePct),
    stopLoss: round(plan.stop),
    targetFast: round(plan.targetFast),
    targetFull: round(plan.targetFull),
    markPrices: history.slice(entryIndex, finalExitIndex + 1).map(day => ({
      date: day.date,
      price: round(day.close)
    })),
    partialExits: partialExits.map(item => `${item.date} ${item.reason} ${item.weightPct}% @ ${item.price}`).join(' | '),
    reasons: analysis.reasons.slice(0, 5).join(' | '),
    risks: analysis.risks.slice(0, 5).join(' | ')
  };
}

function backtestStock(history, stock, analyzeWindow, startDate, tailwindMaps) {
  const trades = [];
  const startIndex = Math.max(80, history.findIndex(day => day.date >= startDate));
  let cooldownUntil = -1;
  for (let i = startIndex; i < history.length - 2; i += 1) {
    if (i <= cooldownUntil) continue;
    const analysis = analyzeWindow(history.slice(0, i + 1), stock, null, false);
    if (analysis.score < CANDIDATE_MIN_SCORE) continue;
    const tailwind = tailwindFor(stock, history[i].date, tailwindMaps);
    const trade = simulateTrade(history, stock, i, analysis, i + 1, tailwind);
    if (!trade) continue;
    trades.push(trade);
    if ([BUY_SIGNAL, WATCH_SIGNAL].includes(trade.signal) && passesFormalQuality(trade)) {
      const exitIndex = history.findIndex(day => day.date === trade.exitDate);
      cooldownUntil = Math.max(i + COOLDOWN_DAYS, exitIndex);
    }
  }
  return trades;
}

function simulatePortfolio(trades, startDate, endDate, tradingDates = []) {
  const days = new Map();
  const dayOf = date => {
    if (!days.has(date)) days.set(date, { entries: [], exits: [], marks: [] });
    return days.get(date);
  };
  for (const date of tradingDates) dayOf(date);
  for (const trade of trades) {
    dayOf(trade.entryDate).entries.push(trade);
    dayOf(trade.exitDate).exits.push(trade);
    for (const mark of trade.markPrices || []) {
      dayOf(mark.date).marks.push({ tradeId: trade.tradeId, price: mark.price });
    }
  }

  const dates = [...days.keys()].sort();
  const months = monthKeys(startDate, endDate);
  const monthly = new Map(months.map(month => [month, {
    month,
    startCapital: 0,
    endCapital: 0,
    realizedPnl: 0,
    returnPct: 0,
    tradesOpened: 0,
    tradesClosed: 0,
    hitTarget: false
  }]));
  let availableCash = INITIAL_CAPITAL;
  let unsettled = [];
  let open = [];
  let equity = INITIAL_CAPITAL;
  let peak = INITIAL_CAPITAL;
  let maxDrawdownPct = 0;
  let minimumAvailableCash = INITIAL_CAPITAL;
  let skippedTrades = 0;
  let settlementBlockedTrades = 0;
  const cooldownUntilBySymbol = new Map();
  const executed = [];

  for (let dayIndex = 0; dayIndex < dates.length; dayIndex += 1) {
    const date = dates[dayIndex];
    const day = days.get(date);
    const row = monthly.get(monthKey(date));
    const settledToday = unsettled.filter(item => item.releaseIndex <= dayIndex);
    if (settledToday.length) {
      availableCash += settledToday.reduce((sum, item) => sum + item.amount, 0);
      unsettled = unsettled.filter(item => item.releaseIndex > dayIndex);
    }

    for (const trade of day.exits.sort((a, b) => a.symbol.localeCompare(b.symbol))) {
      const position = open.find(item => item.trade.tradeId === trade.tradeId);
      if (!position) continue;
      open = open.filter(item => item.trade.tradeId !== trade.tradeId);
      cooldownUntilBySymbol.set(trade.symbol, dayIndex + COOLDOWN_DAYS);
      const sell = sellExecution(trade.exitPrice, position.quantity);
      const realizedPnl = sell.net - position.buy.total;
      unsettled.push({ releaseIndex: dayIndex + SETTLEMENT_DAYS, amount: sell.net });

      trade.quantity = position.quantity;
      trade.boardLots = Math.floor(position.quantity / BOARD_LOT_SHARES);
      trade.oddLotShares = position.quantity % BOARD_LOT_SHARES;
      trade.executedEntryPrice = round(position.buy.fillPrice);
      trade.executedExitPrice = round(sell.fillPrice);
      trade.buyFee = position.buy.fee;
      trade.sellFee = sell.fee;
      trade.sellTax = sell.tax;
      trade.positionCapital = round(position.buy.total, 0);
      trade.positionPct = round(position.buy.total / position.entryEquity * 100, 2);
      trade.accountRiskPct = round(position.accountRisk / position.entryEquity * 100, 2);
      trade.realizedPnl = round(realizedPnl, 0);
      trade.netReturnPct = round(realizedPnl / position.buy.total * 100);
      trade.accountReturnPct = round(realizedPnl / position.entryEquity * 100, 2);
      executed.push(trade);
      if (row) {
        row.tradesClosed += 1;
        row.realizedPnl += realizedPnl;
      }
    }

    equity = availableCash
      + unsettled.reduce((sum, item) => sum + item.amount, 0)
      + open.reduce((sum, item) => sum + item.markValue, 0);
    for (const trade of day.entries.sort((a, b) => (
      b.gapUpPct - a.gapUpPct
      || b.signalScore - a.signalScore
      || a.symbol.localeCompare(b.symbol)
    ))) {
      const risk = tradeRiskMode(trade);
      if (risk.positionPct <= 0) {
        skippedTrades += 1;
        trade.riskMode = risk.mode;
        trade.riskModeReason = risk.reason;
        continue;
      }
      if (open.length >= MAX_OPEN_POSITIONS) {
        skippedTrades += 1;
        continue;
      }
      if (open.some(position => position.trade.symbol === trade.symbol)
        || dayIndex <= (cooldownUntilBySymbol.get(trade.symbol) ?? -1)) {
        skippedTrades += 1;
        continue;
      }
      const desiredBudget = equity * risk.positionPct / 100;
      const allocationBudget = Math.min(availableCash, desiredBudget);
      const accountRiskBudget = equity * ACCOUNT_RISK_CAP_PCT / 100;
      const quantity = affordableQuantity(
        trade.entryPrice,
        trade.stopLoss,
        allocationBudget,
        accountRiskBudget
      );
      if (quantity <= 0) {
        skippedTrades += 1;
        if (availableCash < desiredBudget) settlementBlockedTrades += 1;
        continue;
      }
      const buy = buyExecution(trade.entryPrice, quantity);
      const stop = sellExecution(trade.stopLoss, quantity);
      trade.riskMode = risk.mode;
      trade.riskModeReason = risk.reason;
      availableCash -= buy.total;
      minimumAvailableCash = Math.min(minimumAvailableCash, availableCash);
      open.push({
        trade,
        quantity,
        buy,
        accountRisk: buy.total - stop.net,
        entryEquity: equity,
        markValue: sellExecution(trade.entryPrice, quantity).net
      });
      if (row) row.tradesOpened += 1;
      equity = availableCash
        + unsettled.reduce((sum, item) => sum + item.amount, 0)
        + open.reduce((sum, item) => sum + item.markValue, 0);
    }

    for (const mark of day.marks) {
      const position = open.find(item => item.trade.tradeId === mark.tradeId);
      if (!position) continue;
      position.markValue = sellExecution(mark.price, position.quantity).net;
    }
    equity = availableCash
      + unsettled.reduce((sum, item) => sum + item.amount, 0)
      + open.reduce((sum, item) => sum + item.markValue, 0);
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.min(maxDrawdownPct, pct(equity, peak) || 0);
  }

  let realizedCapital = INITIAL_CAPITAL;
  for (const row of monthly.values()) {
    row.startCapital = round(realizedCapital, 0);
    row.realizedPnl = round(row.realizedPnl, 0);
    realizedCapital += row.realizedPnl;
    row.endCapital = round(realizedCapital, 0);
    row.returnPct = row.startCapital ? round(row.realizedPnl / row.startCapital * 100) : 0;
    row.hitTarget = row.returnPct >= TARGET_MONTHLY_RETURN_PCT;
  }
  const rows = [...monthly.values()];
  const returns = rows.map(row => row.returnPct).filter(Number.isFinite);
  equity = availableCash
    + unsettled.reduce((sum, item) => sum + item.amount, 0)
    + open.reduce((sum, item) => sum + item.markValue, 0);

  return {
    settings: {
      initialCapital: INITIAL_CAPITAL,
      positionPct: POSITION_PCT,
      accountRiskCapPct: ACCOUNT_RISK_CAP_PCT,
      maxOpenPositions: MAX_OPEN_POSITIONS,
      targetMonthlyReturnPct: TARGET_MONTHLY_RETURN_PCT,
      performanceBasis: 'monthly_realized_net_pnl',
      boardLotShares: BOARD_LOT_SHARES,
      minimumBrokerFee: MIN_BROKER_FEE,
      minimumOrderValue: MIN_ORDER_VALUE,
      settlementDays: SETTLEMENT_DAYS,
      entryPriority: 'opening_gap_desc_then_score',
      marketCrashPct: MARKET_CRASH_PCT,
      themeCrashPct: THEME_CRASH_PCT,
      marketCautionPct: MARKET_CAUTION_PCT,
      themeCautionPct: THEME_CAUTION_PCT,
      defensivePositionPct: DEFENSIVE_POSITION_PCT,
      cautionPositionPct: CAUTION_POSITION_PCT,
      exploratoryPositionPct: EXPLORATORY_POSITION_PCT,
      minExploratoryScore: MIN_EXPLORATORY_SCORE,
      trailTriggerPct: TRAIL_TRIGGER_PCT,
      trailGivebackPct: TRAIL_GIVEBACK_PCT,
      trailLockPct: TRAIL_LOCK_PCT,
      strongTailwindBoost: STRONG_TAILWIND_BOOST
    },
    overview: {
      finalCapital: round(realizedCapital, 0),
      finalAccountEquity: round(equity, 0),
      portfolioReturnPct: round(pct(realizedCapital, INITIAL_CAPITAL)),
      avgMonthlyReturnPct: round(returns.reduce((sum, value) => sum + value, 0) / Math.max(1, returns.length)),
      medianMonthlyReturnPct: round(median(returns) || 0),
      targetMonthlyReturnPct: TARGET_MONTHLY_RETURN_PCT,
      months: rows.length,
      monthsHitTarget: rows.filter(row => row.hitTarget).length,
      monthsBelowZero: rows.filter(row => row.returnPct < 0).length,
      bestMonthPct: returns.length ? round(Math.max(...returns)) : null,
      worstMonthPct: returns.length ? round(Math.min(...returns)) : null,
      maxDrawdownPct: round(maxDrawdownPct),
      executedTrades: executed.length,
      skippedTrades,
      settlementBlockedTrades,
      minimumAvailableCash: round(minimumAvailableCash, 0),
      endingUnsettledReceivables: round(unsettled.reduce((sum, item) => sum + item.amount, 0), 0),
      endingOpenPositions: open.length
    },
    monthly: rows,
    executedTrades: executed
  };
}

function summarize(trades, portfolio, scanned, startDate, endDate, warnings) {
  const wins = trades.filter(trade => trade.netReturnPct > 0);
  const losses = trades.filter(trade => trade.netReturnPct <= 0);
  const profit = wins.reduce((sum, trade) => sum + trade.netReturnPct, 0);
  const loss = Math.abs(losses.reduce((sum, trade) => sum + trade.netReturnPct, 0));
  const bySymbol = new Map();
  for (const trade of trades) {
    if (!bySymbol.has(trade.symbol)) bySymbol.set(trade.symbol, []);
    bySymbol.get(trade.symbol).push(trade);
  }
  const stockSummary = [...bySymbol.entries()].map(([symbol, rows]) => ({
    symbol,
    name: rows[0].name,
    market: rows[0].market,
    trades: rows.length,
    winRatePct: round(rows.filter(row => row.netReturnPct > 0).length / rows.length * 100),
    avgReturnPct: round(rows.reduce((sum, row) => sum + row.netReturnPct, 0) / rows.length),
    totalReturnPct: round(rows.reduce((sum, row) => sum + row.netReturnPct, 0)),
    bestTradePct: round(Math.max(...rows.map(row => row.netReturnPct))),
    worstTradePct: round(Math.min(...rows.map(row => row.netReturnPct)))
  })).sort((a, b) => b.totalReturnPct - a.totalReturnPct);

  return {
    overview: {
      startDate,
      endDate,
      scannedSymbols: scanned,
      totalTrades: trades.length,
      winners: wins.length,
      losers: losses.length,
      winRatePct: trades.length ? round(wins.length / trades.length * 100) : 0,
      avgNetReturnPct: round(trades.reduce((sum, trade) => sum + trade.netReturnPct, 0) / Math.max(1, trades.length)),
      medianNetReturnPct: round(median(trades.map(trade => trade.netReturnPct)) || 0),
      totalNetReturnPct: round(trades.reduce((sum, trade) => sum + trade.netReturnPct, 0)),
      profitFactor: loss ? round(profit / loss) : null,
      avgHoldingDays: round(trades.reduce((sum, trade) => sum + trade.holdingDays, 0) / Math.max(1, trades.length), 1),
      bestTradePct: trades.length ? round(Math.max(...trades.map(trade => trade.netReturnPct))) : null,
      worstTradePct: trades.length ? round(Math.min(...trades.map(trade => trade.netReturnPct))) : null,
      avgMfePct: round(trades.reduce((sum, trade) => sum + trade.grossMfePct, 0) / Math.max(1, trades.length)),
      avgMaePct: round(trades.reduce((sum, trade) => sum + trade.grossMaePct, 0) / Math.max(1, trades.length)),
      initialCapital: portfolio.settings.initialCapital,
      positionPct: portfolio.settings.positionPct,
      maxOpenPositions: portfolio.settings.maxOpenPositions,
      finalCapital: portfolio.overview.finalCapital,
      finalAccountEquity: portfolio.overview.finalAccountEquity,
      portfolioReturnPct: portfolio.overview.portfolioReturnPct,
      avgMonthlyReturnPct: portfolio.overview.avgMonthlyReturnPct,
      medianMonthlyReturnPct: portfolio.overview.medianMonthlyReturnPct,
      targetMonthlyReturnPct: portfolio.overview.targetMonthlyReturnPct,
      monthsHitTarget: portfolio.overview.monthsHitTarget,
      monthsBelowZero: portfolio.overview.monthsBelowZero,
      bestMonthPct: portfolio.overview.bestMonthPct,
      worstMonthPct: portfolio.overview.worstMonthPct,
      maxPortfolioDrawdownPct: portfolio.overview.maxDrawdownPct,
      executedTrades: portfolio.overview.executedTrades,
      skippedTradesByCapitalRule: portfolio.overview.skippedTrades,
      settlementBlockedTrades: portfolio.overview.settlementBlockedTrades,
      minimumAvailableCash: portfolio.overview.minimumAvailableCash,
      warnings: warnings.slice(0, 30)
    },
    stockSummary
  };
}

function translateOverviewKey(key) {
  const map = {
    startDate: '回測開始日期',
    endDate: '回測結束日期',
    scannedSymbols: '掃描股票數',
    totalTrades: '總交易數',
    winners: '獲利筆數',
    losers: '虧損筆數',
    winRatePct: '勝率(%)',
    avgNetReturnPct: '平均淨報酬(%)',
    medianNetReturnPct: '中位數淨報酬(%)',
    totalNetReturnPct: '總淨報酬加總(%)',
    profitFactor: '獲利因子',
    avgHoldingDays: '平均持有天數',
    bestTradePct: '最佳單筆報酬(%)',
    worstTradePct: '最差單筆報酬(%)',
    avgMfePct: '平均最大浮盈(%)',
    avgMaePct: '平均最大回撤(%)',
    initialCapital: '回測初始資金',
    positionPct: '單筆投入資金比例(%)',
    maxOpenPositions: '最多同時持股數',
    finalCapital: '期末已實現資本',
    finalAccountEquity: '期末帳戶權益',
    portfolioReturnPct: '已實現資金總報酬(%)',
    avgMonthlyReturnPct: '平均月已實現報酬(%)',
    medianMonthlyReturnPct: '中位數月已實現報酬(%)',
    targetMonthlyReturnPct: '目標月報酬(%)',
    monthsHitTarget: '達標月份數',
    monthsBelowZero: '虧損月份數',
    bestMonthPct: '最佳月份報酬(%)',
    worstMonthPct: '最差月份報酬(%)',
    maxPortfolioDrawdownPct: '資金最大回撤(%)',
    executedTrades: '實際執行交易數',
    skippedTradesByCapitalRule: '因資金/持股上限跳過交易數',
    settlementBlockedTrades: '因未交割資金略過交易數',
    minimumAvailableCash: '最低可用現金',
    warnings: '警告'
  };
  return map[key] || key;
}

function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function colName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function makeSheetXml(rows) {
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map((value, colIndex) => {
      const ref = `${colName(colIndex)}${rowIndex + 1}`;
      if (value === null || value === undefined || value === '') return `<c r="${ref}"/>`;
      if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
}

function makeWorkbookXml(sheetNames) {
  const sheets = sheetNames.map((name, index) => `<sheet name="${xmlEscape(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`;
}

function makeWorkbookRelsXml(sheetCount) {
  const rels = Array.from({ length: sheetCount }, (_, index) => (
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  )).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

function crc32(buffer) {
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function writeStoredZip(filePath, entries) {
  const buffers = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll('\\', '/'));
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    buffers.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }
  const centralSize = central.reduce((sum, buffer) => sum + buffer.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  await fs.writeFile(filePath, Buffer.concat([...buffers, ...central, end]));
}

async function writeWorkbook(outputPath, payload) {
  const sheetNames = ['總覽', '每月績效', '交易明細', '股票統計'];
  const summaryRows = [
    ['指標', '數值'],
    ...Object.entries(payload.summary.overview).map(([key, value]) => [translateOverviewKey(key), Array.isArray(value) ? value.join(' | ') : value])
  ];
  const monthlyColumns = [
    ['month', '月份'],
    ['startCapital', '月初已實現資本'],
    ['endCapital', '月底已實現資本'],
    ['realizedPnl', '當月已實現淨損益'],
    ['returnPct', '當月已實現報酬(%)'],
    ['tradesOpened', '新進場筆數'],
    ['tradesClosed', '出場筆數'],
    ['hitTarget', '是否達月報酬10%']
  ];
  const monthlyRows = [
    monthlyColumns.map(([, label]) => label),
    ...payload.portfolio.monthly.map(row => monthlyColumns.map(([key]) => key === 'hitTarget' ? (row[key] ? '是' : '否') : row[key]))
  ];
  const tradeColumns = [
    ['tradeId', '交易編號'],
    ['symbol', '股票代號'],
    ['name', '股票名稱'],
    ['market', '市場'],
    ['signalDate', '訊號日期'],
    ['entryDate', '進場日期'],
    ['entryPrice', '進場價格'],
    ['exitDate', '出場日期'],
    ['exitPrice', '出場價格'],
    ['exitReason', '出場原因'],
    ['quantity', '成交股數'],
    ['boardLots', '整股張數'],
    ['oddLotShares', '零股股數'],
    ['executedEntryPrice', '含滑價買進價'],
    ['executedExitPrice', '含滑價賣出價'],
    ['buyFee', '買進手續費'],
    ['sellFee', '賣出手續費'],
    ['sellTax', '證券交易稅'],
    ['realizedPnl', '已實現淨損益'],
    ['positionCapital', '投入資金'],
    ['positionPct', '單筆資金比例(%)'],
    ['accountRiskPct', '停損時帳戶風險(%)'],
    ['accountReturnPct', '對帳戶貢獻(%)'],
    ['riskMode', '資金風險模式'],
    ['riskModeReason', '資金風險原因'],
    ['netReturnPct', '淨報酬(%)'],
    ['grossMfePct', '最大浮盈(%)'],
    ['grossMaePct', '最大回撤(%)'],
    ['holdingDays', '實際持有天數'],
    ['plannedHoldDays', '計畫持有天數'],
    ['signalScore', '訊號分數'],
    ['sellWarningLevel', '賣出警告等級'],
    ['themes', '族群'],
    ['marketMovePct', '同市場當日平均漲跌(%)'],
    ['themeMovePct', '同族群當日平均漲跌(%)'],
    ['usCompositePct', '美股綜合漲跌(%)'],
    ['asiaCompositePct', '日韓綜合漲跌(%)'],
    ['techCompositePct', '科技/費半綜合漲跌(%)'],
    ['globalCompositePct', '全球風險綜合漲跌(%)'],
    ['nikkeiPct', '日經漲跌(%)'],
    ['kospiPct', 'KOSPI漲跌(%)'],
    ['kosdaqPct', 'KOSDAQ漲跌(%)'],
    ['strictRisk', '是否套用嚴格規則'],
    ['rsi14', 'RSI(14)'],
    ['std20', '20日波動'],
    ['std20Pct', '20日波動(%)'],
    ['maxRange20Pct', '20日最大單日振幅(%)'],
    ['avg20TradeValue', '20日均成交值'],
    ['avg20Volume', '20日均量'],
    ['resistance', '壓力價'],
    ['triggerPrice', '突破確認價'],
    ['gapUpPct', '開盤跳空(%)'],
    ['chasePct', '追價幅度(%)'],
    ['stopLoss', '停損價'],
    ['targetFast', '第一停利價'],
    ['targetFull', '第二停利價'],
    ['partialExits', '分批出場紀錄'],
    ['reasons', '進場理由'],
    ['risks', '風險原因']
  ];
  const tradeRows = [tradeColumns.map(([, label]) => label), ...payload.trades.map(trade => tradeColumns.map(([key]) => trade[key]))];
  const stockColumns = [
    ['symbol', '股票代號'],
    ['name', '股票名稱'],
    ['market', '市場'],
    ['trades', '交易筆數'],
    ['winRatePct', '勝率(%)'],
    ['avgReturnPct', '平均報酬(%)'],
    ['totalReturnPct', '總報酬加總(%)'],
    ['bestTradePct', '最佳單筆(%)'],
    ['worstTradePct', '最差單筆(%)']
  ];
  const stockRows = [stockColumns.map(([, label]) => label), ...payload.summary.stockSummary.map(row => stockColumns.map(([key]) => row[key]))];
  const entries = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetNames.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: makeWorkbookXml(sheetNames) },
    { name: 'xl/_rels/workbook.xml.rels', data: makeWorkbookRelsXml(sheetNames.length) },
    { name: 'xl/worksheets/sheet1.xml', data: makeSheetXml(summaryRows) },
    { name: 'xl/worksheets/sheet2.xml', data: makeSheetXml(monthlyRows) },
    { name: 'xl/worksheets/sheet3.xml', data: makeSheetXml(tradeRows) },
    { name: 'xl/worksheets/sheet4.xml', data: makeSheetXml(stockRows) }
  ];
  await writeStoredZip(outputPath, entries);
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

async function writeMobileFiles(payload) {
  const overview = payload.summary.overview;
  const monthlyRows = payload.portfolio.monthly.map(row => `
      <tr>
        <td>${row.month}</td>
        <td class="num">${row.startCapital.toLocaleString('zh-TW')}</td>
        <td class="num">${row.endCapital.toLocaleString('zh-TW')}</td>
        <td class="num ${row.returnPct >= 0 ? 'pos' : 'neg'}">${row.returnPct}%</td>
        <td class="num">${row.tradesOpened}</td>
        <td class="num">${row.tradesClosed}</td>
      </tr>`).join('');
  const topTrades = payload.trades.slice(0, 7).map(trade => `
      <article class="trade">
        <div class="trade-head">
          <strong>${trade.symbol} ${trade.name}</strong>
          <span class="tag">${trade.signal}</span>
        </div>
        <div class="trade-meta">
          <span>分數 ${trade.signalScore}/100</span>
          <span>${trade.riskMode}</span>
          <span>${trade.netReturnPct}%</span>
        </div>
      </article>`).join('');
  const mobileMd = [
    '# Fortune Hunter 回測手機摘要',
    '',
    `區間：${overview.startDate} ~ ${overview.endDate}`,
    `掃描：${overview.scannedSymbols} 檔`,
    `交易：${overview.executedTrades} 筆`,
    `勝率：${overview.winRatePct}%`,
    `平均月報酬：${overview.avgMonthlyReturnPct}%`,
    `最大回撤：${overview.maxPortfolioDrawdownPct}%`,
    `最差月份：${overview.worstMonthPct}%`,
    `目標月報酬：${overview.targetMonthlyReturnPct}%`,
    '',
    '## 月績效',
    '',
    '| 月份 | 月報酬 | 新進場 | 出場 |',
    '|---|---:|---:|---:|',
    ...payload.portfolio.monthly.map(row => `| ${row.month} | ${row.returnPct}% | ${row.tradesOpened} | ${row.tradesClosed} |`),
    '',
    '## 目前網站候選',
    '',
    ...payload.trades.slice(0, 7).map(trade => `- ${trade.symbol} ${trade.name}：${trade.signal} / ${trade.riskMode} / ${trade.netReturnPct}%`)
  ].join('\n');

  const csvRows = [
    ['月份', '月初資金', '月底資金', '月報酬(%)', '新進場筆數', '出場筆數', '是否達月報酬10%'],
    ...payload.portfolio.monthly.map(row => [
      row.month,
      row.startCapital,
      row.endCapital,
      row.returnPct,
      row.tradesOpened,
      row.tradesClosed,
      row.hitTarget ? '是' : '否'
    ])
  ];
  const csvText = csvRows.map(row => row.map(csvCell).join(',')).join('\n');
  const mobileHtml = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Fortune Hunter 手機回測報表</title>
<style>
:root{--bg:#f6f3ef;--card:#fff;--ink:#23181b;--muted:#6b6570;--brand:#b4233f;--line:rgba(35,24,27,.12);--shadow:0 14px 34px rgba(35,24,27,.08)}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif;background:linear-gradient(180deg,#fcfaf8 0%,#f2ebe6 100%);color:var(--ink)}
.wrap{max-width:980px;margin:0 auto;padding:16px}
.hero{background:linear-gradient(135deg,#1f2933,#7f1630);color:#fff;padding:18px;border-radius:18px;box-shadow:var(--shadow)}
.hero h1{margin:0;font-size:30px}
.hero p{margin:8px 0 0;color:#f8dfe3;line-height:1.7}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0}
.stat,.panel,.trade{background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow)}
.stat{padding:12px}
.stat b{display:block;font-size:22px}
.stat span{color:var(--muted);font-size:12px}
.panel{padding:12px;margin-top:10px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:10px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{position:sticky;top:0;background:#fff}
.num{text-align:right;font-variant-numeric:tabular-nums}
.pos{color:#0e7a5e;font-weight:700}
.neg{color:#b4233f;font-weight:700}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.chip{display:inline-flex;padding:6px 10px;border-radius:999px;background:#f6e4e8;color:#5f1d2f;font-size:12px;font-weight:700}
.trade{padding:12px;margin-bottom:10px}
.trade-head{display:flex;justify-content:space-between;gap:10px;align-items:center}
.trade-meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--muted);font-size:12px;margin-top:8px}
.tag{padding:4px 8px;border-radius:999px;background:#fff4e7;border:1px solid rgba(201,130,25,.25);font-size:12px;font-weight:700}
.small{color:var(--muted);font-size:12px;line-height:1.7}
@media (max-width:640px){.grid{grid-template-columns:1fr}table{font-size:12px}.wrap{padding:10px}.hero h1{font-size:24px}}
</style>
</head>
<body>
<main class="wrap">
  <section class="hero">
    <h1>Fortune Hunter 手機回測報表</h1>
    <p>區間 ${overview.startDate} ～ ${overview.endDate}，平均月報酬 ${overview.avgMonthlyReturnPct}% ，最大回撤 ${overview.maxPortfolioDrawdownPct}% 。</p>
    <div class="chips">
      <span class="chip">交易 ${overview.executedTrades} 筆</span>
      <span class="chip">勝率 ${overview.winRatePct}%</span>
      <span class="chip">目標 ${overview.targetMonthlyReturnPct}%</span>
      <span class="chip">回測暖機 ${payload.historyRange}</span>
    </div>
  </section>
  <section class="grid">
    <div class="stat"><b>${overview.avgMonthlyReturnPct}%</b><span>平均月報酬</span></div>
    <div class="stat"><b>${overview.maxPortfolioDrawdownPct}%</b><span>最大回撤</span></div>
    <div class="stat"><b>${overview.bestMonthPct}%</b><span>最佳月份</span></div>
    <div class="stat"><b>${overview.worstMonthPct}%</b><span>最差月份</span></div>
  </section>
  <section class="panel">
    <h2>月績效</h2>
    <div style="overflow:auto">
      <table>
        <thead><tr><th>月份</th><th class="num">月初資金</th><th class="num">月底資金</th><th class="num">月報酬</th><th class="num">新進場</th><th class="num">出場</th></tr></thead>
        <tbody>${monthlyRows}</tbody>
      </table>
    </div>
  </section>
  <section class="panel">
    <h2>前 7 檔候選</h2>
    ${topTrades}
  </section>
  <section class="panel">
    <h2>操作提醒</h2>
    <div class="small">這份報表是手機優先的閱讀版，不需要 Excel App。若要看完整明細，建議回到桌機開 xlsx；若只想快速確認績效與月報，這個 HTML 就夠了。</div>
  </section>
</main>
</body>
</html>`;
  await fs.writeFile(OUTPUT_MOBILE_MD, `${mobileMd}\n`, 'utf8');
  await fs.writeFile(OUTPUT_MOBILE_CSV, `${csvText}\n`, 'utf8');
  await fs.writeFile(OUTPUT_MOBILE_HTML, `${mobileHtml}\n`, 'utf8');
}

async function main() {
  const core = await loadStrategyCore();
  const startDate = process.env.BACKTEST_START_DATE || yearsAgoTaipeiText();
  const endDate = todayTaipeiText();
  const warnings = [];
  const [twse, tpex] = await Promise.all([
    core.fetchTwseUniverse(),
    core.fetchTpexUniverse().catch(error => {
      warnings.push(`TPEx fetch failed: ${error.message}`);
      return [];
    })
  ]);
  const universe = FULL_UNIVERSE
    ? [...twse, ...tpex]
    : [...twse.slice(0, SYMBOLS_PER_MARKET), ...tpex.slice(0, SYMBOLS_PER_MARKET)];
  const pool = universe.sort((a, b) => b.tradeValue - a.tradeValue);
  const historyResults = await core.mapLimit(pool, CONCURRENCY, async stock => {
    const history = await fetchYahooHistory(stock.yahooSymbol);
    return { stock, history };
  });
  const validHistoryResults = historyResults.filter(item => item.history.length >= 120);
  if (validHistoryResults.length < pool.length) {
    warnings.push(`有效日線 ${validHistoryResults.length}/${pool.length} 檔；其餘資料不足或抓取失敗。`);
  }
  const tradingDates = [...new Set(validHistoryResults.flatMap(item => (
    item.history
      .filter(day => day.date >= startDate && day.date <= endDate)
      .map(day => day.date)
  )))].sort();
  const tailwindMaps = {
    ...buildTailwindMaps(validHistoryResults),
    global: await buildGlobalRiskMap()
  };
  const results = validHistoryResults.map(item => ({
    stock: item.stock,
    trades: backtestStock(item.history, item.stock, core.analyzeWindow, startDate, tailwindMaps)
  }));
  const trades = results.flatMap(result => result.trades)
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.symbol.localeCompare(b.symbol));
  const portfolio = simulatePortfolio(trades, startDate, endDate, tradingDates);
  const summary = summarize(portfolio.executedTrades, portfolio, pool.length, startDate, endDate, warnings);
  const executedTrades = portfolio.executedTrades.map(trade => ({ ...trade }));
  for (const trade of trades) {
    delete trade.markPrices;
    delete trade.partialExits;
    delete trade.reasons;
    delete trade.risks;
    delete trade.grossMfePct;
    delete trade.grossMaePct;
    delete trade.netReturnPct;
    delete trade.riskMode;
    delete trade.riskModeReason;
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    startDate,
    endDate,
    range: RANGE,
    historyRange: HISTORY_RANGE,
    fullUniverse: FULL_UNIVERSE,
    assumptions: {
      signal: BUY_SIGNAL,
      entryMode: ENTRY_MODE,
      exitMode: EXIT_MODE,
      entry: `next trading day breakout above resistance + ${BREAKOUT_BUFFER_PCT}%`,
      entryPriority: 'opening_gap_desc_then_score',
      maxGapUpPct: MAX_GAP_UP_PCT,
      maxChasePct: MAX_CHASE_PCT,
      noFollowThroughDays: NO_FOLLOW_THROUGH_DAYS,
      minFollowThroughMfePct: MIN_FOLLOW_THROUGH_MFE_PCT,
      marketHeadwindPct: MARKET_HEADWIND_PCT,
      themeHeadwindPct: THEME_HEADWIND_PCT,
      minPrice: MIN_PRICE,
      minAvg20TradeValue: MIN_AVG20_TRADE_VALUE,
      minAvg20Volume: MIN_AVG20_VOLUME,
      minStd20Pct: MIN_STD20_PCT,
      maxStd20Pct: MAX_STD20_PCT,
      maxDayRangePct: MAX_DAY_RANGE_PCT,
      minMomentum126_21: MIN_MOMENTUM_126_21,
      minNearYearHigh: MIN_NEAR_YEAR_HIGH,
      minIntentFactor60: MIN_INTENT_FACTOR_60,
      strictMinTradeValue: STRICT_MIN_TRADE_VALUE,
      otcStrictMinTradeValue: OTC_STRICT_MIN_TRADE_VALUE,
      strictMaxStd20: STRICT_MAX_STD20,
      otcStrictMaxStd20: OTC_STRICT_MAX_STD20,
      strictMinScore: STRICT_MIN_SCORE,
      strictMinRsi: STRICT_MIN_RSI,
      strictMaxRsi: STRICT_MAX_RSI,
      minEntryRsi: MIN_ENTRY_RSI,
      trailTriggerPct: TRAIL_TRIGGER_PCT,
      trailGivebackPct: TRAIL_GIVEBACK_PCT,
      trailLockPct: TRAIL_LOCK_PCT,
      strongTailwindBoost: STRONG_TAILWIND_BOOST,
      buyConfirmations: BUY_CONFIRMATIONS,
      explorationConfirmations: EXPLORATION_CONFIRMATIONS,
      buyFeePct: BUY_FEE_PCT,
      sellFeePct: SELL_FEE_PCT,
      sellTaxPct: SELL_TAX_PCT,
      buySlippagePct: BUY_SLIPPAGE_PCT,
      sellSlippagePct: SELL_SLIPPAGE_PCT,
      minimumBrokerFee: MIN_BROKER_FEE,
      minimumOrderValue: MIN_ORDER_VALUE,
      boardLotShares: BOARD_LOT_SHARES,
      settlementDays: SETTLEMENT_DAYS,
      performanceBasis: 'monthly_realized_net_pnl',
      cooldownDays: COOLDOWN_DAYS,
      initialCapital: INITIAL_CAPITAL,
      positionPct: POSITION_PCT,
      accountRiskCapPct: ACCOUNT_RISK_CAP_PCT,
      defensivePositionPct: DEFENSIVE_POSITION_PCT,
      exploratoryPositionPct: EXPLORATORY_POSITION_PCT,
      maxOpenPositions: MAX_OPEN_POSITIONS,
      targetMonthlyReturnPct: TARGET_MONTHLY_RETURN_PCT
    },
    summary,
    portfolio,
    candidateTrades: trades,
    trades: executedTrades
  };
  await fs.writeFile(OUTPUT_JSON, `${JSON.stringify(payload)}\n`, 'utf8');
  let outputXlsx = OUTPUT_XLSX;
  try {
    await writeWorkbook(outputXlsx, payload);
  } catch (error) {
    if (error.code !== 'EBUSY') throw error;
    const stamp = new Date().toISOString().replaceAll(':', '').replace(/\.\d{3}Z$/, 'Z');
    outputXlsx = path.join(ROOT, 'data', `tw-backtest-${OUTPUT_LABEL}-${stamp}.xlsx`);
    await writeWorkbook(outputXlsx, payload);
  }
  await writeMobileFiles(payload);
  console.log(JSON.stringify({
    outputJson: OUTPUT_JSON,
    outputXlsx,
    outputMobileMd: OUTPUT_MOBILE_MD,
    outputMobileCsv: OUTPUT_MOBILE_CSV,
    outputMobileHtml: OUTPUT_MOBILE_HTML,
    scanned: pool.length,
    candidateTrades: trades.length,
    executedTrades: portfolio.executedTrades.length,
    startDate,
    endDate,
    summary: summary.overview
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
