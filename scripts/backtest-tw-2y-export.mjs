import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'scripts', 'generate-data.mjs');
const OUTPUT_JSON = path.join(ROOT, 'data', 'tw-backtest-2y.json');
const OUTPUT_XLSX = path.join(ROOT, 'data', 'tw-backtest-2y.xlsx');
const RANGE = process.env.BACKTEST_RANGE || '2y';
const FULL_UNIVERSE = process.env.BACKTEST_FULL_UNIVERSE !== '0';
const SYMBOLS_PER_MARKET = Number(process.env.BACKTEST_SYMBOLS_PER_MARKET || 180);
const CONCURRENCY = Number(process.env.BACKTEST_CONCURRENCY || 5);
const USER_AGENT = 'fortune-hunter-full-backtest/2.0';

const BUY_SIGNAL = '買入候選';
const ENTRY_MODE = process.env.BACKTEST_ENTRY_MODE || 'intraday_breakout';
const EXIT_MODE = process.env.BACKTEST_EXIT_MODE || 'fixed_hold';
const BUY_FEE_PCT = Number(process.env.BACKTEST_BUY_FEE_PCT || 0.1425);
const SELL_FEE_PCT = Number(process.env.BACKTEST_SELL_FEE_PCT || 0.1425);
const SELL_TAX_PCT = Number(process.env.BACKTEST_SELL_TAX_PCT || 0.3);
const BUY_SLIPPAGE_PCT = Number(process.env.BACKTEST_BUY_SLIPPAGE_PCT || 0.15);
const SELL_SLIPPAGE_PCT = Number(process.env.BACKTEST_SELL_SLIPPAGE_PCT || 0.15);
const BREAKOUT_BUFFER_PCT = Number(process.env.BACKTEST_BREAKOUT_BUFFER_PCT || 0.5);
const MAX_GAP_UP_PCT = Number(process.env.BACKTEST_MAX_GAP_UP_PCT || 8);
const MAX_CHASE_PCT = Number(process.env.BACKTEST_MAX_CHASE_PCT || 6);
const NO_FOLLOW_THROUGH_DAYS = Number(process.env.BACKTEST_NO_FOLLOW_THROUGH_DAYS || 2);
const MIN_FOLLOW_THROUGH_MFE_PCT = Number(process.env.BACKTEST_MIN_FOLLOW_THROUGH_MFE_PCT || 1.5);
const COOLDOWN_DAYS = Number(process.env.BACKTEST_COOLDOWN_DAYS || 5);
const MARKET_HEADWIND_PCT = Number(process.env.BACKTEST_MARKET_HEADWIND_PCT || -0.5);
const THEME_HEADWIND_PCT = Number(process.env.BACKTEST_THEME_HEADWIND_PCT || -0.7);
const MIN_AVG20_TRADE_VALUE = Number(process.env.BACKTEST_MIN_AVG20_TRADE_VALUE || 50000000);
const MIN_MOMENTUM_126_21 = Number(process.env.BACKTEST_MIN_MOMENTUM_126_21 || -15);
const MIN_NEAR_YEAR_HIGH = Number(process.env.BACKTEST_MIN_NEAR_YEAR_HIGH || 0.6);
const MIN_INTENT_FACTOR_60 = Number(process.env.BACKTEST_MIN_INTENT_FACTOR_60 || -0.02);
const STRICT_MIN_TRADE_VALUE = Number(process.env.BACKTEST_STRICT_MIN_TRADE_VALUE || 300000000);
const OTC_STRICT_MIN_TRADE_VALUE = Number(process.env.BACKTEST_OTC_STRICT_MIN_TRADE_VALUE || 500000000);
const STRICT_MAX_STD20 = Number(process.env.BACKTEST_STRICT_MAX_STD20 || 0.035);
const OTC_STRICT_MAX_STD20 = Number(process.env.BACKTEST_OTC_STRICT_MAX_STD20 || 0.03);
const STRICT_MIN_SCORE = Number(process.env.BACKTEST_STRICT_MIN_SCORE || 88);
const STRICT_MIN_RSI = Number(process.env.BACKTEST_STRICT_MIN_RSI || 50);
const STRICT_MAX_RSI = Number(process.env.BACKTEST_STRICT_MAX_RSI || 74);
const STRICT_MAX_GAP_UP_PCT = Number(process.env.BACKTEST_STRICT_MAX_GAP_UP_PCT || 5);
const STRICT_MAX_CHASE_PCT = Number(process.env.BACKTEST_STRICT_MAX_CHASE_PCT || 4);
const HOLD_DAYS_OVERRIDE = Number(process.env.BACKTEST_HOLD_DAYS_OVERRIDE || 5);

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

function twoYearsAgoTaipeiText() {
  const { year, month, day } = taipeiDateParts();
  return `${year - 2}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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
    isHeadwind: marketHeadwind || themeHeadwind
  };
}

function simulateTrade(history, stock, signalIndex, analysis, entryIndex, tailwind = null) {
  const signalDay = history[signalIndex];
  const entryDay = history[entryIndex];
  const plan = planFromAnalysis(analysis);
  if (tailwind?.isHeadwind) return null;
  if (analysis.metrics?.avg20TradeValue !== null && analysis.metrics.avg20TradeValue < MIN_AVG20_TRADE_VALUE) return null;
  if (analysis.metrics?.momentum126_21 !== null && analysis.metrics.momentum126_21 <= MIN_MOMENTUM_126_21) return null;
  if (analysis.metrics?.nearYearHigh !== null && analysis.metrics.nearYearHigh < MIN_NEAR_YEAR_HIGH) return null;
  if (analysis.metrics?.intentFactor60 !== null && analysis.metrics.intentFactor60 < MIN_INTENT_FACTOR_60) return null;
  const strictRisk = (analysis.metrics?.avg20TradeValue !== null && analysis.metrics.avg20TradeValue < STRICT_MIN_TRADE_VALUE)
    || (analysis.metrics?.std20 !== null && analysis.metrics.std20 >= STRICT_MAX_STD20)
    || (stock.market === '上櫃' && (
      (analysis.metrics?.avg20TradeValue !== null && analysis.metrics.avg20TradeValue < OTC_STRICT_MIN_TRADE_VALUE)
      || (analysis.metrics?.std20 !== null && analysis.metrics.std20 >= OTC_STRICT_MAX_STD20)
    ));
  if (strictRisk) {
    if (analysis.score < STRICT_MIN_SCORE) return null;
    if (analysis.metrics?.rsi14 !== null && (analysis.metrics.rsi14 < STRICT_MIN_RSI || analysis.metrics.rsi14 > STRICT_MAX_RSI)) return null;
  }
  const trigger = plan.resistance ? plan.resistance * (1 + BREAKOUT_BUFFER_PCT / 100) : entryDay.open;
  const gapUpPct = pct(entryDay.open, signalDay.close) || 0;
  const entryPrice = ENTRY_MODE === 'close_confirm'
    ? entryDay.close
    : entryDay.open > trigger ? entryDay.open : trigger;
  const chasePct = pct(entryPrice, trigger) || 0;
  const maxGapUpPct = strictRisk ? Math.min(MAX_GAP_UP_PCT, STRICT_MAX_GAP_UP_PCT) : MAX_GAP_UP_PCT;
  const maxChasePct = strictRisk ? Math.min(MAX_CHASE_PCT, STRICT_MAX_CHASE_PCT) : MAX_CHASE_PCT;
  if (ENTRY_MODE === 'close_confirm' && entryDay.close < trigger) return null;
  if (ENTRY_MODE === 'close_confirm' && entryDay.close < entryDay.open) return null;
  if (ENTRY_MODE !== 'close_confirm' && entryDay.high < trigger) return null;
  if (gapUpPct > maxGapUpPct) return null;
  if (chasePct > maxChasePct) return null;

  const endIndex = Math.min(entryIndex + plan.holdDays, history.length - 1);
  if (EXIT_MODE === 'fixed_hold') {
    const exitDay = history[endIndex];
    const future = history.slice(entryIndex, endIndex + 1);
    return {
      tradeId: `${stock.code}-${signalDay.date}`,
      symbol: stock.code,
      name: stock.name,
      market: stock.market,
      signalDate: signalDay.date,
      entryDate: entryDay.date,
      entryPrice: round(entryPrice),
      exitDate: exitDay.date,
      exitPrice: round(exitDay.close),
      exitReason: `固定持有 ${plan.holdDays} 天`,
      netReturnPct: round(netReturnPct(entryPrice, exitDay.close)),
      grossMfePct: round(pct(Math.max(...future.map(day => day.high)), entryPrice)),
      grossMaePct: round(pct(Math.min(...future.map(day => day.low)), entryPrice)),
      holdingDays: endIndex - entryIndex + 1,
      plannedHoldDays: plan.holdDays,
      signalScore: analysis.score,
      signal: analysis.signal,
      sellWarningLevel: analysis.sellWarning?.level,
      themes: tailwind?.themes || '',
      marketMovePct: tailwind?.marketMove,
      themeMovePct: tailwind?.themeMove,
      strictRisk,
      rsi14: analysis.metrics?.rsi14,
      std20: analysis.metrics?.std20,
      avg20TradeValue: analysis.metrics?.avg20TradeValue,
      resistance: round(plan.resistance),
      triggerPrice: round(trigger),
      gapUpPct: round(gapUpPct),
      chasePct: round(chasePct),
      stopLoss: round(plan.stop),
      targetFast: round(plan.targetFast),
      targetFull: round(plan.targetFull),
      partialExits: `${exitDay.date} 固定持有到期 100% @ ${round(exitDay.close)}`,
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
      sell(i, remainingWeight, plan.stop, '停損');
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
    strictRisk,
    rsi14: analysis.metrics?.rsi14,
    std20: analysis.metrics?.std20,
    avg20TradeValue: analysis.metrics?.avg20TradeValue,
    resistance: round(plan.resistance),
    triggerPrice: round(trigger),
    gapUpPct: round(gapUpPct),
    chasePct: round(chasePct),
    stopLoss: round(plan.stop),
    targetFast: round(plan.targetFast),
    targetFull: round(plan.targetFull),
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
    if (analysis.signal !== BUY_SIGNAL) continue;
    const tailwind = tailwindFor(stock, history[i].date, tailwindMaps);
    const trade = simulateTrade(history, stock, i, analysis, i + 1, tailwind);
    if (!trade) continue;
    trades.push(trade);
    const exitIndex = history.findIndex(day => day.date === trade.exitDate);
    cooldownUntil = Math.max(i + COOLDOWN_DAYS, exitIndex);
  }
  return trades;
}

function summarize(trades, scanned, startDate, endDate, warnings) {
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
  const sheetNames = ['總覽', '交易明細', '股票統計'];
  const summaryRows = [
    ['指標', '數值'],
    ...Object.entries(payload.summary.overview).map(([key, value]) => [translateOverviewKey(key), Array.isArray(value) ? value.join(' | ') : value])
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
    ['strictRisk', '是否套用嚴格規則'],
    ['rsi14', 'RSI(14)'],
    ['std20', '20日波動'],
    ['avg20TradeValue', '20日均成交值'],
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
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: makeWorkbookXml(sheetNames) },
    { name: 'xl/_rels/workbook.xml.rels', data: makeWorkbookRelsXml(sheetNames.length) },
    { name: 'xl/worksheets/sheet1.xml', data: makeSheetXml(summaryRows) },
    { name: 'xl/worksheets/sheet2.xml', data: makeSheetXml(tradeRows) },
    { name: 'xl/worksheets/sheet3.xml', data: makeSheetXml(stockRows) }
  ];
  await writeStoredZip(outputPath, entries);
}

async function main() {
  const core = await loadStrategyCore();
  const startDate = process.env.BACKTEST_START_DATE || twoYearsAgoTaipeiText();
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
  const tailwindMaps = buildTailwindMaps(validHistoryResults);
  const results = validHistoryResults.map(item => ({
    stock: item.stock,
    trades: backtestStock(item.history, item.stock, core.analyzeWindow, startDate, tailwindMaps)
  }));
  const trades = results.flatMap(result => result.trades)
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.symbol.localeCompare(b.symbol));
  const summary = summarize(trades, pool.length, startDate, endDate, warnings);
  const payload = {
    generatedAt: new Date().toISOString(),
    startDate,
    endDate,
    range: RANGE,
    fullUniverse: FULL_UNIVERSE,
    assumptions: {
      signal: BUY_SIGNAL,
      entryMode: ENTRY_MODE,
      exitMode: EXIT_MODE,
      entry: `next trading day breakout above resistance + ${BREAKOUT_BUFFER_PCT}%`,
      maxGapUpPct: MAX_GAP_UP_PCT,
      maxChasePct: MAX_CHASE_PCT,
      noFollowThroughDays: NO_FOLLOW_THROUGH_DAYS,
      minFollowThroughMfePct: MIN_FOLLOW_THROUGH_MFE_PCT,
      marketHeadwindPct: MARKET_HEADWIND_PCT,
      themeHeadwindPct: THEME_HEADWIND_PCT,
      minAvg20TradeValue: MIN_AVG20_TRADE_VALUE,
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
      buyFeePct: BUY_FEE_PCT,
      sellFeePct: SELL_FEE_PCT,
      sellTaxPct: SELL_TAX_PCT,
      buySlippagePct: BUY_SLIPPAGE_PCT,
      sellSlippagePct: SELL_SLIPPAGE_PCT,
      cooldownDays: COOLDOWN_DAYS
    },
    summary,
    trades
  };
  await fs.writeFile(OUTPUT_JSON, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  let outputXlsx = OUTPUT_XLSX;
  try {
    await writeWorkbook(outputXlsx, payload);
  } catch (error) {
    if (error.code !== 'EBUSY') throw error;
    const stamp = new Date().toISOString().replaceAll(':', '').replace(/\.\d{3}Z$/, 'Z');
    outputXlsx = path.join(ROOT, 'data', `tw-backtest-2y-${stamp}.xlsx`);
    await writeWorkbook(outputXlsx, payload);
  }
  console.log(JSON.stringify({
    outputJson: OUTPUT_JSON,
    outputXlsx,
    scanned: pool.length,
    trades: trades.length,
    startDate,
    endDate,
    summary: summary.overview
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
