import { readFile, writeFile } from 'node:fs/promises';
import {
  netReturnPct as sharedNetReturnPct,
  simulateEntry,
  simulateExit
} from './lib/execution-simulator.mjs';

const STRATEGY_FILE = new URL('./generate-data.mjs', import.meta.url);
const OUTPUT = new URL('../data/trade-mode-backtest.json', import.meta.url);
const RANGE = process.env.TRADE_MODE_RANGE || '2y';
const FULL_UNIVERSE = process.env.TRADE_MODE_FULL_UNIVERSE !== '0';
const SYMBOLS_PER_MARKET = Number(process.env.TRADE_MODE_SYMBOLS_PER_MARKET || 80);
const CONCURRENCY = Number(process.env.TRADE_MODE_CONCURRENCY || 5);
const USER_AGENT = 'fortune-hunter-trade-mode-backtest/2.1';

const BUY_SIGNAL = '\u8cb7\u5165\u5019\u9078';

const BUY_FEE_PCT = Number(process.env.TRADE_MODE_BUY_FEE_PCT || 0.1425);
const SELL_FEE_PCT = Number(process.env.TRADE_MODE_SELL_FEE_PCT || 0.1425);
const SELL_TAX_PCT = Number(process.env.TRADE_MODE_SELL_TAX_PCT || 0.3);
const BUY_SLIPPAGE_PCT = Number(process.env.TRADE_MODE_BUY_SLIPPAGE_PCT || 0.15);
const SELL_SLIPPAGE_PCT = Number(process.env.TRADE_MODE_SELL_SLIPPAGE_PCT || 0.15);

const MIN_PRICE = Number(process.env.TRADE_MODE_MIN_PRICE || 15);
const MIN_AVG20_TRADE_VALUE = Number(process.env.TRADE_MODE_MIN_AVG20_TRADE_VALUE || 30000000);
const MIN_AVG20_VOLUME = Number(process.env.TRADE_MODE_MIN_AVG20_VOLUME || 1000);
const MIN_STD20 = Number(process.env.TRADE_MODE_MIN_STD20 || 2);
const MAX_STD20 = Number(process.env.TRADE_MODE_MAX_STD20 || 8.5);
const MAX_GAP_UP_PCT = Number(process.env.TRADE_MODE_MAX_GAP_UP_PCT || 8);
const MAX_DAY_RANGE_PCT = Number(process.env.TRADE_MODE_MAX_DAY_RANGE_PCT || 14);
const MAX_PLAN_RISK_PCT = Number(process.env.TRADE_MODE_MAX_PLAN_RISK_PCT || 99);
const MIN_INDUSTRY_TRADE_COUNT = Number(process.env.TRADE_MODE_MIN_INDUSTRY_TRADE_COUNT || 30);

const ENTRY_MODES = ['next_open_market', 'next_open_limit', 'pullback_entry', 'resistance_breakout'];
const EXIT_MODES = ['fixed_hold', 'stop_target', 'scale_trail'];

const LABELS = {
  listed: '\u4e0a\u5e02',
  otc: '\u4e0a\u6ac3',
  unclassified: '\u672a\u5206\u985e',
  insufficient20: '\u6b77\u53f2\u8cc7\u6599\u4e0d\u8db3 20 \u65e5',
  lowPrice: `\u80a1\u50f9\u4f4e\u65bc NT$${MIN_PRICE}`,
  lowTradeValue: `\u8fd1 20 \u65e5\u5e73\u5747\u6210\u4ea4\u503c\u4f4e\u65bc ${MIN_AVG20_TRADE_VALUE}`,
  lowVolume: `\u8fd1 20 \u65e5\u5e73\u5747\u6210\u4ea4\u91cf\u4f4e\u65bc ${MIN_AVG20_VOLUME}`,
  lowStd: `\u8fd1 20 \u65e5\u6ce2\u52d5\u4f4e\u65bc ${MIN_STD20}`,
  highStd: `\u8fd1 20 \u65e5\u6ce2\u52d5\u9ad8\u65bc ${MAX_STD20}`,
  highRange: `\u8fd1 20 \u65e5\u55ae\u65e5\u632f\u5e45\u9ad8\u65bc ${MAX_DAY_RANGE_PCT}%`,
  highGap: `\u9694\u65e5\u8df3\u7a7a\u9ad8\u958b\u8d85\u904e ${MAX_GAP_UP_PCT}%`,
  highPlanRisk: `\u8a08\u756b\u505c\u640d\u8ddd\u96e2\u9ad8\u65bc ${MAX_PLAN_RISK_PCT}%`,
  nextOpenMarket: '\u9694\u65e5\u958b\u76e4\u5e02\u50f9\u9032\u5834',
  nextOpenLimit: '\u9694\u65e5\u958b\u76e4\u9650\u50f9\u6210\u4ea4',
  pullbackEntry: '\u9694\u65e5\u56de\u6e2c\u5efa\u8b70\u5340\u9593\u9032\u5834',
  resistanceBreakout: '\u7a81\u7834\u8fd1 25 \u65e5\u58d3\u529b\u5f8c\u8ffd\u50f9\u9032\u5834',
  holdExit: '\u6301\u6709\u5929\u6578\u5230\u671f\u6536\u76e4\u51fa\u5834',
  stopExit: '\u8dcc\u7834\u505c\u640d\u50f9\u51fa\u5834',
  targetExit: '\u9054\u7b2c\u4e8c\u505c\u5229\u50f9\u5168\u6578\u51fa\u5834',
  ma5Exit: '\u7b2c\u4e00\u505c\u5229\u5f8c\u8dcc\u7834 5 \u65e5\u7dda\u51fa\u5834'
};

const INDUSTRY_NAMES = {
  '01': '\u6c34\u6ce5\u5de5\u696d',
  '02': '\u98df\u54c1\u5de5\u696d',
  '03': '\u5851\u81a0\u5de5\u696d',
  '04': '\u7d21\u7e54\u7e96\u7dad',
  '05': '\u96fb\u6a5f\u6a5f\u68b0',
  '06': '\u96fb\u5668\u96fb\u7e9c',
  '08': '\u73bb\u7483\u9676\u74f7',
  '09': '\u9020\u7d19\u5de5\u696d',
  '10': '\u92fc\u9435\u5de5\u696d',
  '11': '\u6a61\u81a0\u5de5\u696d',
  '12': '\u6c7d\u8eca\u5de5\u696d',
  '14': '\u5efa\u6750\u71df\u9020',
  '15': '\u822a\u904b\u696d',
  '16': '\u89c0\u5149\u9910\u65c5',
  '17': '\u91d1\u878d\u4fdd\u96aa',
  '18': '\u8cbf\u6613\u767e\u8ca8',
  '20': '\u5176\u4ed6',
  '21': '\u5316\u5b78\u5de5\u696d',
  '22': '\u751f\u6280\u91ab\u7642\u696d',
  '23': '\u6cb9\u96fb\u71c3\u6c23\u696d',
  '24': '\u534a\u5c0e\u9ad4\u696d',
  '25': '\u96fb\u8166\u53ca\u9031\u908a\u8a2d\u5099\u696d',
  '26': '\u5149\u96fb\u696d',
  '27': '\u901a\u4fe1\u7db2\u8def\u696d',
  '28': '\u96fb\u5b50\u96f6\u7d44\u4ef6\u696d',
  '29': '\u96fb\u5b50\u901a\u8def\u696d',
  '30': '\u8cc7\u8a0a\u670d\u52d9\u696d',
  '31': '\u5176\u4ed6\u96fb\u5b50\u696d',
  '32': '\u6587\u5316\u5275\u610f\u696d',
  '33': '\u8fb2\u696d\u79d1\u6280\u696d',
  '34': '\u96fb\u5b50\u5546\u52d9',
  '35': '\u7da0\u80fd\u74b0\u4fdd',
  '36': '\u6578\u4f4d\u96f2\u7aef',
  '37': '\u904b\u52d5\u4f11\u9592',
  '38': '\u5c45\u5bb6\u751f\u6d3b',
  '80': '\u7ba1\u7406\u80a1\u7968',
  '91': '\u5b58\u8a17\u61d1\u8b49'
};

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function pct(now, then) {
  return then ? ((now - then) / then) * 100 : null;
}

function average(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values) {
  if (!values.length) return null;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function moneyNumbersFrom(text) {
  return [...String(text || '').matchAll(/NT\$\s*([\d.]+)/g)].map(match => Number(match[1]));
}

function tradePlanOf(analysis) {
  const entry = moneyNumbersFrom(analysis.plan?.entry);
  const targets = moneyNumbersFrom(analysis.plan?.takeProfit);
  const stops = moneyNumbersFrom(analysis.plan?.stopLoss);
  const horizon = String(analysis.plan?.horizon || '').match(/\d+/)?.[0];
  return {
    entryLow: entry[0],
    entryHigh: entry[1],
    targetFast: targets[0],
    targetFull: targets[1],
    stop: stops[0],
    holdDays: Number(horizon || 7)
  };
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
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${RANGE}&interval=1d&includePrePost=false&events=div%2Csplits`;
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

function decodeIndustry(code) {
  const normalized = String(code || '').trim();
  if (!normalized) return LABELS.unclassified;
  return INDUSTRY_NAMES[normalized] || normalized;
}

async function fetchIndustryMaps() {
  const listedPromise = fetchJson('https://openapi.twse.com.tw/v1/opendata/t187ap03_L')
    .then(rows => new Map(rows.map(row => [
      String(row['公司代號'] || '').trim(),
      decodeIndustry(String(row['產業別'] || row['產業類別'] || '').trim())
    ]).filter(([code]) => /^\d{4}$/.test(code))))
    .catch(() => new Map());

  const otcPromise = fetchJson('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O')
    .then(rows => new Map(rows.map(row => [
      String(row['SecuritiesCompanyCode'] || row['公司代號'] || '').trim(),
      decodeIndustry(String(row['Industry'] || row['產業別'] || row['產業類別'] || row['SecuritiesIndustryCode'] || '').trim())
    ]).filter(([code]) => /^\d{4}$/.test(code))))
    .catch(() => new Map());

  const [listed, otc] = await Promise.all([listedPromise, otcPromise]);
  return { listed, otc };
}

async function loadStrategyCore() {
  let source = await readFile(STRATEGY_FILE, 'utf8');
  source = source.replaceAll('import.meta.url', 'importMetaUrl');
  source = source.replace(/\nmain\(\)\.catch\([\s\S]*$/, '\n');
  source += '\nreturn { fetchTwseUniverse, fetchTpexUniverse, analyzeWindow, mapLimit };';
  const factory = new Function('importMetaUrl', source);
  return factory(STRATEGY_FILE.href);
}

function normalizeMarketLabel(raw) {
  if (String(raw).includes('\u4e0a\u5e02')) return LABELS.listed;
  if (String(raw).includes('\u4e0a\u6ac3')) return LABELS.otc;
  return String(raw || '');
}

function enrichUniverse(stocks, marketLabel, industryMap) {
  return stocks.map(stock => ({
    ...stock,
    market: marketLabel,
    industry: industryMap.get(stock.code) || LABELS.unclassified
  }));
}

function entryForMode(mode, signalDay, nextDay, plan, analysis) {
  const fill = simulateEntry({
    mode,
    signalDay,
    nextDay,
    triggerPrice: Number(analysis.metrics?.resistance) * 1.005,
    limitPrice: Math.min(plan.entryHigh, signalDay.close * 1.012),
    limitFloor: plan.entryLow,
    pullbackPrice: plan.entryHigh,
    pullbackFloor: plan.entryLow
  });
  if (!fill) return null;
  const labels = {
    next_open_market: LABELS.nextOpenMarket,
    next_open_limit: LABELS.nextOpenLimit,
    pullback_entry: LABELS.pullbackEntry,
    resistance_breakout: LABELS.resistanceBreakout
  };
  return { price: fill.price, reason: labels[mode] || fill.reason };
}

function exitFixedHold(history, entryIndex, entryPrice, plan) {
  const exitIndex = Math.min(entryIndex + plan.holdDays, history.length - 1);
  const exitDay = history[exitIndex];
  return {
    exitDate: exitDay.date,
    exitPrice: exitDay.close,
    exitReason: LABELS.holdExit,
    returnPct: pct(exitDay.close, entryPrice),
    holdingDays: exitIndex - entryIndex,
    exitIndex
  };
}

function exitStopTarget(history, entryIndex, entryPrice, plan) {
  const exitIndexEnd = Math.min(entryIndex + plan.holdDays, history.length - 1);
  for (let i = entryIndex; i <= exitIndexEnd; i++) {
    const day = history[i];
    const fill = simulateExit({ day, stopLoss: plan.stop, takeProfit: plan.targetFull });
    if (fill?.price) {
      return {
        exitDate: day.date,
        exitPrice: fill.price,
        exitReason: fill.type === 'stop_loss' ? LABELS.stopExit : LABELS.targetExit,
        returnPct: pct(fill.price, entryPrice),
        holdingDays: i - entryIndex,
        exitIndex: i
      };
    }
  }
  return exitFixedHold(history, entryIndex, entryPrice, plan);
}

function exitScaleTrail(history, entryIndex, entryPrice, plan) {
  const exitIndexEnd = Math.min(entryIndex + plan.holdDays, history.length - 1);
  const closes = history.slice(0, entryIndex).map(day => day.close);
  let remaining = 1;
  let weightedReturn = 0;
  let halfSold = false;

  for (let i = entryIndex; i <= exitIndexEnd; i++) {
    const day = history[i];
    closes.push(day.close);
    const ma5 = average(closes, 5);

    const stopFill = simulateExit({ day, stopLoss: plan.stop });
    if (stopFill?.price) {
      weightedReturn += pct(stopFill.price, entryPrice) * remaining;
      return { exitDate: day.date, exitPrice: stopFill.price, exitReason: LABELS.stopExit, returnPct: weightedReturn, holdingDays: i - entryIndex, exitIndex: i };
    }

    const fastTarget = !halfSold
      ? simulateExit({ day, takeProfit: plan.targetFast })
      : null;
    if (fastTarget?.type === 'take_profit') {
      weightedReturn += pct(fastTarget.price, entryPrice) * 0.5;
      remaining = 0.5;
      halfSold = true;
    }

    const fullTarget = remaining > 0
      ? simulateExit({ day, takeProfit: plan.targetFull })
      : null;
    if (fullTarget?.type === 'take_profit') {
      weightedReturn += pct(fullTarget.price, entryPrice) * remaining;
      return { exitDate: day.date, exitPrice: fullTarget.price, exitReason: LABELS.targetExit, returnPct: weightedReturn, holdingDays: i - entryIndex, exitIndex: i };
    }

    if (halfSold && remaining > 0 && ma5 && day.close < ma5) {
      weightedReturn += pct(day.close, entryPrice) * remaining;
      return { exitDate: day.date, exitPrice: day.close, exitReason: LABELS.ma5Exit, returnPct: weightedReturn, holdingDays: i - entryIndex, exitIndex: i };
    }
  }

  const exitDay = history[exitIndexEnd];
  weightedReturn += pct(exitDay.close, entryPrice) * remaining;
  return { exitDate: exitDay.date, exitPrice: exitDay.close, exitReason: LABELS.holdExit, returnPct: weightedReturn, holdingDays: exitIndexEnd - entryIndex, exitIndex: exitIndexEnd };
}

function exitForMode(mode, history, entryIndex, entryPrice, plan) {
  if (mode === 'fixed_hold') return exitFixedHold(history, entryIndex, entryPrice, plan);
  if (mode === 'stop_target') return exitStopTarget(history, entryIndex, entryPrice, plan);
  if (mode === 'scale_trail') return exitScaleTrail(history, entryIndex, entryPrice, plan);
  throw new Error(`unknown exit mode: ${mode}`);
}

function maxAdverseExcursion(history, entryIndex, exitIndex, entryPrice) {
  const lows = history.slice(entryIndex, exitIndex + 1).map(day => day.low);
  return pct(Math.min(...lows), entryPrice);
}

function maxFavorableExcursion(history, entryIndex, exitIndex, entryPrice) {
  const highs = history.slice(entryIndex, exitIndex + 1).map(day => day.high);
  return pct(Math.max(...highs), entryPrice);
}

function applyCosts(entryPrice, exitPrice) {
  return sharedNetReturnPct(entryPrice, exitPrice, {
    buyFeePct: BUY_FEE_PCT,
    sellFeePct: SELL_FEE_PCT,
    sellTaxPct: SELL_TAX_PCT,
    buySlippagePct: BUY_SLIPPAGE_PCT,
    sellSlippagePct: SELL_SLIPPAGE_PCT
  });
}

function riskStats(history, index) {
  const slice = history.slice(Math.max(0, index - 20), index);
  if (slice.length < 20) return null;
  const closes = slice.map(day => day.close);
  const tradeValues = slice.map(day => day.close * day.volume);
  const ranges = slice.map(day => pct(day.high, day.low));
  const dayReturns = closes.map((close, i) => (i === 0 ? null : pct(close, closes[i - 1]))).filter(Number.isFinite);
  return {
    avg20TradeValue: mean(tradeValues),
    avg20Volume: mean(slice.map(day => day.volume)),
    std20: stddev(dayReturns),
    maxRange20: Math.max(...ranges)
  };
}

function filterReasons(history, signalIndex, signalDay, nextDay, plan) {
  const stats = riskStats(history, signalIndex);
  const reasons = [];
  if (!stats) reasons.push(LABELS.insufficient20);
  if (signalDay.close < MIN_PRICE) reasons.push(LABELS.lowPrice);
  if (stats?.avg20TradeValue < MIN_AVG20_TRADE_VALUE) reasons.push(LABELS.lowTradeValue);
  if (stats?.avg20Volume < MIN_AVG20_VOLUME) reasons.push(LABELS.lowVolume);
  if (stats?.std20 < MIN_STD20) reasons.push(LABELS.lowStd);
  if (stats?.std20 > MAX_STD20) reasons.push(LABELS.highStd);
  if (stats?.maxRange20 > MAX_DAY_RANGE_PCT) reasons.push(LABELS.highRange);
  const gapUpPct = nextDay ? pct(nextDay.open, signalDay.close) : null;
  if (gapUpPct > MAX_GAP_UP_PCT) reasons.push(LABELS.highGap);
  const planRiskPct = plan?.entryHigh && plan?.stop ? Math.abs(pct(plan.stop, plan.entryHigh)) : null;
  if (planRiskPct > MAX_PLAN_RISK_PCT) reasons.push(LABELS.highPlanRisk);
  return { reasons, stats, planRiskPct, passed: reasons.length === 0 };
}

function simulateModes(history, stock, analyzeWindow) {
  const trades = [];
  const filterCounts = new Map();
  let cooldownUntil = -1;

  for (let i = 80; i < history.length - 12; i++) {
    if (i <= cooldownUntil) continue;
    const signalDay = history[i];
    const nextDay = history[i + 1];
    const analysis = analyzeWindow(history.slice(0, i + 1), stock, null, false);
    if (analysis.signal !== BUY_SIGNAL) continue;

    const plan = tradePlanOf(analysis);
    if (!plan.entryLow || !plan.entryHigh || !plan.stop || !plan.targetFast || !plan.targetFull) continue;

    const filters = filterReasons(history, i, signalDay, nextDay, plan);
    if (!filters.passed) {
      for (const reason of filters.reasons) {
        filterCounts.set(reason, (filterCounts.get(reason) || 0) + 1);
      }
      cooldownUntil = i + 5;
      continue;
    }

    for (const entryMode of ENTRY_MODES) {
      const entry = entryForMode(entryMode, signalDay, nextDay, plan, analysis);
      if (!entry) continue;

      for (const exitMode of EXIT_MODES) {
        const exit = exitForMode(exitMode, history, i + 1, entry.price, plan);
        trades.push({
          symbol: stock.code,
          name: stock.name,
          market: stock.market,
          industry: stock.industry || LABELS.unclassified,
          signalDate: signalDay.date,
          entryDate: nextDay.date,
          entryMode,
          exitMode,
          entryPrice: round(entry.price),
          entryReason: entry.reason,
          signalScore: analysis.score,
          exitDate: exit.exitDate,
          exitPrice: round(exit.exitPrice),
          exitReason: exit.exitReason,
          grossReturnPct: round(exit.returnPct),
          netReturnPct: round(applyCosts(entry.price, exit.exitPrice)),
          holdingDays: exit.holdingDays,
          maePct: round(maxAdverseExcursion(history, i + 1, exit.exitIndex, entry.price)),
          mfePct: round(maxFavorableExcursion(history, i + 1, exit.exitIndex, entry.price)),
          avg20TradeValue: round(filters.stats?.avg20TradeValue || 0, 0),
          avg20Volume: round(filters.stats?.avg20Volume || 0, 0),
          std20: round(filters.stats?.std20 || 0, 4),
          planRiskPct: round(filters.planRiskPct || 0, 2)
        });
      }
    }

    cooldownUntil = i + 5;
  }

  return {
    trades,
    filterCounts: Object.fromEntries([...filterCounts.entries()].sort((a, b) => b[1] - a[1]))
  };
}

function summarizeGroup(trades) {
  const wins = trades.filter(trade => trade.netReturnPct > 0);
  const avgNetReturn = mean(trades.map(trade => trade.netReturnPct)) || 0;
  const avgGrossReturn = mean(trades.map(trade => trade.grossReturnPct)) || 0;
  const avgMae = mean(trades.map(trade => trade.maePct)) || 0;
  const avgMfe = mean(trades.map(trade => trade.mfePct)) || 0;
  const profit = trades.filter(t => t.netReturnPct > 0).reduce((sum, trade) => sum + trade.netReturnPct, 0);
  const loss = Math.abs(trades.filter(t => t.netReturnPct <= 0).reduce((sum, trade) => sum + trade.netReturnPct, 0));
  return {
    trades: trades.length,
    winRatePct: round((wins.length / Math.max(1, trades.length)) * 100),
    avgNetReturnPct: round(avgNetReturn),
    avgGrossReturnPct: round(avgGrossReturn),
    totalNetReturnPct: round(trades.reduce((sum, trade) => sum + trade.netReturnPct, 0)),
    totalGrossReturnPct: round(trades.reduce((sum, trade) => sum + trade.grossReturnPct, 0)),
    bestTradePct: trades.length ? round(Math.max(...trades.map(trade => trade.netReturnPct))) : null,
    worstTradePct: trades.length ? round(Math.min(...trades.map(trade => trade.netReturnPct))) : null,
    avgMaePct: round(avgMae),
    avgMfePct: round(avgMfe),
    profitFactor: loss ? round(profit / loss) : null
  };
}

function modeSummary(trades) {
  const combo = new Map();
  for (const trade of trades) {
    const key = `${trade.entryMode} + ${trade.exitMode}`;
    if (!combo.has(key)) combo.set(key, []);
    combo.get(key).push(trade);
  }
  return [...combo.entries()]
    .map(([mode, rows]) => ({ mode, ...summarizeGroup(rows) }))
    .sort((a, b) => (b.avgNetReturnPct || 0) - (a.avgNetReturnPct || 0));
}

function segmentSummary(trades, field, minTrades = 1) {
  const groups = new Map();
  for (const trade of trades) {
    const key = trade[field] || LABELS.unclassified;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .filter(([, rows]) => rows.length >= minTrades)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([key, rows]) => [key, modeSummary(rows)])
  );
}

function yearlySummary(trades) {
  const groups = new Map();
  for (const trade of trades) {
    const year = trade.entryDate.slice(0, 4);
    if (!groups.has(year)) groups.set(year, []);
    groups.get(year).push(trade);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([year, rows]) => [year, modeSummary(rows)])
  );
}

async function main() {
  const core = await loadStrategyCore();
  const warnings = [];
  const [{ listed, otc }, twse, tpex] = await Promise.all([
    fetchIndustryMaps(),
    core.fetchTwseUniverse(),
    core.fetchTpexUniverse().catch(error => {
      warnings.push(`TPEx universe failed: ${error.message}`);
      return [];
    })
  ]);

  const universe = FULL_UNIVERSE
    ? [
        ...enrichUniverse(twse, LABELS.listed, listed),
        ...enrichUniverse(tpex, LABELS.otc, otc)
      ].sort((a, b) => b.tradeValue - a.tradeValue)
    : [
        ...enrichUniverse(twse.slice(0, SYMBOLS_PER_MARKET), LABELS.listed, listed),
        ...enrichUniverse(tpex.slice(0, SYMBOLS_PER_MARKET), LABELS.otc, otc)
      ].sort((a, b) => b.tradeValue - a.tradeValue);

  const results = await core.mapLimit(universe, CONCURRENCY, async stock => {
    const history = await fetchYahooHistory(stock.yahooSymbol);
    if (history.length < 120) throw new Error('history shorter than 120 bars');
    return simulateModes(history, { ...stock, market: normalizeMarketLabel(stock.market) }, core.analyzeWindow);
  });

  const trades = [];
  const rejectedSignals = new Map();
  for (const result of results) {
    trades.push(...result.trades);
    for (const [reason, count] of Object.entries(result.filterCounts)) {
      rejectedSignals.set(reason, (rejectedSignals.get(reason) || 0) + count);
    }
  }

  trades.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.symbol.localeCompare(b.symbol));

  const payload = {
    generatedAt: new Date().toISOString(),
    range: RANGE,
    assumptions: {
      buyFeePct: BUY_FEE_PCT,
      sellFeePct: SELL_FEE_PCT,
      sellTaxPct: SELL_TAX_PCT,
      buySlippagePct: BUY_SLIPPAGE_PCT,
      sellSlippagePct: SELL_SLIPPAGE_PCT
    },
    filters: {
      fullUniverse: FULL_UNIVERSE,
      symbolsPerMarket: FULL_UNIVERSE ? null : SYMBOLS_PER_MARKET,
      minPrice: MIN_PRICE,
      minAvg20TradeValue: MIN_AVG20_TRADE_VALUE,
      minAvg20Volume: MIN_AVG20_VOLUME,
      minStd20: MIN_STD20,
      maxStd20: MAX_STD20,
      maxGapUpPct: MAX_GAP_UP_PCT,
      maxDayRangePct: MAX_DAY_RANGE_PCT,
      maxPlanRiskPct: MAX_PLAN_RISK_PCT
    },
    scanned: universe.length,
    rejectedSignals: Object.fromEntries([...rejectedSignals.entries()].sort((a, b) => b[1] - a[1])),
    summary: {
      overall: modeSummary(trades),
      byYear: yearlySummary(trades),
      byMarket: segmentSummary(trades, 'market'),
      byIndustry: segmentSummary(trades, 'industry', MIN_INDUSTRY_TRADE_COUNT)
    },
    trades,
    warnings: warnings.slice(0, 20)
  };

  await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    output: OUTPUT.pathname,
    scanned: payload.scanned,
    trades: trades.length,
    bestMode: payload.summary.overall[0] || null,
    topRejectReason: Object.entries(payload.rejectedSignals)[0] || null
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
