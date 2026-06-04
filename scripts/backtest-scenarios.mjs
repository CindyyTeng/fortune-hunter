import { readFile, writeFile } from 'node:fs/promises';

const STRATEGY_FILE = new URL('./generate-data.mjs', import.meta.url);
const OUTPUT_JSON = new URL('../data/scenario-backtest.json', import.meta.url);
const OUTPUT_MD = new URL('../SCENARIO_STRATEGY_DIAGNOSTICS.md', import.meta.url);
const RANGE = process.env.SCENARIO_RANGE || '2y';
const FULL_UNIVERSE = process.env.SCENARIO_FULL_UNIVERSE !== '0';
const SYMBOLS_PER_MARKET = Number(process.env.SCENARIO_SYMBOLS_PER_MARKET || 80);
const CONCURRENCY = Number(process.env.SCENARIO_CONCURRENCY || 5);
const USER_AGENT = 'fortune-hunter-scenario-backtest/1.0';

const BUY_SIGNAL = '\u8cb7\u5165\u5019\u9078';
const MARKET_LISTED = '\u4e0a\u5e02';
const MARKET_OTC = '\u4e0a\u6ac3';
const UNCLASSIFIED = '\u672a\u5206\u985e';

const BUY_FEE_PCT = Number(process.env.SCENARIO_BUY_FEE_PCT || 0.1425);
const SELL_FEE_PCT = Number(process.env.SCENARIO_SELL_FEE_PCT || 0.1425);
const SELL_TAX_PCT = Number(process.env.SCENARIO_SELL_TAX_PCT || 0.3);
const BUY_SLIPPAGE_PCT = Number(process.env.SCENARIO_BUY_SLIPPAGE_PCT || 0.15);
const SELL_SLIPPAGE_PCT = Number(process.env.SCENARIO_SELL_SLIPPAGE_PCT || 0.15);

const MIN_PRICE = Number(process.env.SCENARIO_MIN_PRICE || 15);
const MIN_AVG20_TRADE_VALUE = Number(process.env.SCENARIO_MIN_AVG20_TRADE_VALUE || 30000000);
const MIN_STD20 = Number(process.env.SCENARIO_MIN_STD20 || 2);
const MAX_STD20 = Number(process.env.SCENARIO_MAX_STD20 || 8.5);
const MAX_DAY_RANGE_PCT = Number(process.env.SCENARIO_MAX_DAY_RANGE_PCT || 14);
const MIN_SEGMENT_TRADES = Number(process.env.SCENARIO_MIN_SEGMENT_TRADES || 8);

const BREAKOUT_BUFFERS = [0.3, 0.5, 1];
const HOLD_DAYS = [3, 5, 7, 10];
const STOP_MODES = ['intraday_stop', 'close_stop', 'no_stop'];
const MAX_GAP_UPS = [3, 5, 8, 99];
const ADAPTIVE_RULES = [
  {
    key: 'adaptive_v1_loss_guard',
    label: '改良版：避開 RSI<50、高波動低流動性，依上市/上櫃調整持有天數',
    breakoutBufferPct: 0.5,
    maxGapUpPct: 5,
    stopMode: 'no_stop',
    minRsi: 50,
    maxRsi: 78,
    minScore: 0
  },
  {
    key: 'adaptive_v2_strict_momentum',
    label: '嚴格動能版：RSI 50-74、分數至少 85、突破 1% 才進場',
    breakoutBufferPct: 1,
    maxGapUpPct: 5,
    stopMode: 'no_stop',
    minRsi: 50,
    maxRsi: 74,
    minScore: 85,
    maxStd20: 5
  },
  {
    key: 'adaptive_v3_segment_rules',
    label: '分群規則版：上櫃短抱 5 天、低波動突破 1%、其餘 7 天控風險',
    breakoutBufferPct: null,
    maxGapUpPct: null,
    stopMode: 'no_stop',
    minRsi: 50,
    maxRsi: 74,
    minScore: 85,
    maxStd20: 5.5
  }
];

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
  '38': '\u5c45\u5bb6\u751f\u6d3b'
};

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function pct(now, then) {
  return then ? ((now - then) / then) * 100 : null;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(values) {
  if (!values.length) return null;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length);
}

function moneyNumbersFrom(text) {
  return [...String(text || '').matchAll(/NT\$\s*([\d.]+)/g)].map(match => Number(match[1]));
}

function tradePlanOf(analysis) {
  const stops = moneyNumbersFrom(analysis.plan?.stopLoss);
  return { stop: stops[0] || null };
}

function decodeIndustry(code) {
  const normalized = String(code || '').trim();
  return INDUSTRY_NAMES[normalized] || normalized || UNCLASSIFIED;
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

async function fetchIndustryMaps() {
  const twse = fetchJson('https://openapi.twse.com.tw/v1/opendata/t187ap03_L')
    .then(rows => new Map(rows.map(row => [
      String(row['\u516c\u53f8\u4ee3\u865f'] || '').trim(),
      decodeIndustry(row['\u7522\u696d\u5225'])
    ]).filter(([code]) => /^\d{4}$/.test(code))))
    .catch(() => new Map());
  const tpex = fetchJson('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O')
    .then(rows => new Map(rows.map(row => [
      String(row.SecuritiesCompanyCode || '').trim(),
      decodeIndustry(row.SecuritiesIndustryCode)
    ]).filter(([code]) => /^\d{4}$/.test(code))))
    .catch(() => new Map());
  const [listed, otc] = await Promise.all([twse, tpex]);
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

function enrichUniverse(stocks, market, industryMap) {
  return stocks.map(stock => ({
    ...stock,
    market,
    industry: industryMap.get(stock.code) || UNCLASSIFIED
  }));
}

function riskStats(history, index) {
  const slice = history.slice(Math.max(0, index - 20), index);
  if (slice.length < 20) return null;
  const closes = slice.map(day => day.close);
  const returns = closes.map((close, i) => i === 0 ? null : pct(close, closes[i - 1])).filter(Number.isFinite);
  return {
    avg20TradeValue: mean(slice.map(day => day.close * day.volume)),
    std20: stddev(returns),
    maxRange20: Math.max(...slice.map(day => pct(day.high, day.low)))
  };
}

function passBaseFilters(signalDay, nextDay, stats) {
  if (!stats) return false;
  if (signalDay.close < MIN_PRICE) return false;
  if (stats.avg20TradeValue < MIN_AVG20_TRADE_VALUE) return false;
  if (stats.std20 < MIN_STD20 || stats.std20 > MAX_STD20) return false;
  if (stats.maxRange20 > MAX_DAY_RANGE_PCT) return false;
  if (!nextDay) return false;
  return true;
}

function adaptiveParams(rule, stock, stats) {
  if (rule.key !== 'adaptive_v3_segment_rules') {
    return {
      breakoutBufferPct: rule.breakoutBufferPct,
      maxGapUpPct: rule.maxGapUpPct,
      holdDays: stock.market === MARKET_OTC ? 5 : stats.std20 >= 3.8 ? 5 : 7
    };
  }
  if (stock.market === MARKET_OTC) {
    return { breakoutBufferPct: 0.5, maxGapUpPct: 5, holdDays: 5 };
  }
  if (stats.std20 < 3) {
    return { breakoutBufferPct: 1, maxGapUpPct: 8, holdDays: 7 };
  }
  return { breakoutBufferPct: 0.5, maxGapUpPct: 5, holdDays: 7 };
}

function bucket(value, cuts, labels) {
  for (let i = 0; i < cuts.length; i++) {
    if (value < cuts[i]) return labels[i];
  }
  return labels.at(-1);
}

function applyCosts(entryPrice, exitPrice) {
  const netEntry = entryPrice * (1 + (BUY_FEE_PCT + BUY_SLIPPAGE_PCT) / 100);
  const netExit = exitPrice * (1 - (SELL_FEE_PCT + SELL_SLIPPAGE_PCT + SELL_TAX_PCT) / 100);
  return pct(netExit, netEntry);
}

function exitTrade(history, entryIndex, entryPrice, stop, holdDays, stopMode) {
  const endIndex = Math.min(entryIndex + holdDays, history.length - 1);
  for (let i = entryIndex; i <= endIndex; i++) {
    const day = history[i];
    if (stopMode === 'intraday_stop' && stop && day.low <= stop) {
      return { exitIndex: i, exitDate: day.date, exitPrice: stop, exitReason: 'intraday_stop' };
    }
    if (stopMode === 'close_stop' && stop && day.close <= stop) {
      return { exitIndex: i, exitDate: day.date, exitPrice: day.close, exitReason: 'close_stop' };
    }
  }
  const day = history[endIndex];
  return { exitIndex: endIndex, exitDate: day.date, exitPrice: day.close, exitReason: `hold_${holdDays}` };
}

function mae(history, entryIndex, exitIndex, entryPrice) {
  return pct(Math.min(...history.slice(entryIndex, exitIndex + 1).map(day => day.low)), entryPrice);
}

function mfe(history, entryIndex, exitIndex, entryPrice) {
  return pct(Math.max(...history.slice(entryIndex, exitIndex + 1).map(day => day.high)), entryPrice);
}

function simulateScenarioTrades(history, stock, analyzeWindow) {
  const trades = [];
  const adaptiveTrades = [];
  let signals = 0;

  for (let i = 80; i < history.length - 12; i += 1) {
    const signalDay = history[i];
    const nextDay = history[i + 1];
    const stats = riskStats(history, i);
    if (!passBaseFilters(signalDay, nextDay, stats)) continue;

    const analysis = analyzeWindow(history.slice(0, i + 1), stock, null, false);
    if (analysis.signal !== BUY_SIGNAL) continue;
    const resistance = Number(analysis.metrics?.resistance);
    const plan = tradePlanOf(analysis);
    if (!resistance || !plan.stop) continue;
    signals += 1;

    for (const rule of ADAPTIVE_RULES) {
      const rsi14 = analysis.metrics?.rsi14;
      const gapUpPct = pct(nextDay.open, signalDay.close) || 0;
      const highVolLowLiquidity = stats.std20 >= 5 && stats.avg20TradeValue < 100000000;
      if (rsi14 !== null && rsi14 < rule.minRsi) continue;
      if (rsi14 !== null && rsi14 > rule.maxRsi) continue;
      if (analysis.score < rule.minScore) continue;
      if (highVolLowLiquidity) continue;
      if (rule.maxStd20 && stats.std20 > rule.maxStd20) continue;

      const params = adaptiveParams(rule, stock, stats);
      if (gapUpPct > params.maxGapUpPct) continue;

      const trigger = resistance * (1 + params.breakoutBufferPct / 100);
      if (nextDay.high < trigger) continue;

      const entryPriceBase = nextDay.open > trigger ? nextDay.open : trigger;
      const exit = exitTrade(history, i + 1, entryPriceBase, plan.stop, params.holdDays, rule.stopMode);
      const netReturnPct = applyCosts(entryPriceBase, exit.exitPrice);
      adaptiveTrades.push({
        symbol: stock.code,
        name: stock.name,
        market: stock.market,
        industry: stock.industry,
        signalDate: signalDay.date,
        entryDate: nextDay.date,
        exitDate: exit.exitDate,
        signalScore: analysis.score,
        rsi14,
        std20: round(stats.std20, 4),
        avg20TradeValue: round(stats.avg20TradeValue, 0),
        gapUpPct: round(gapUpPct, 2),
        breakoutBufferPct: params.breakoutBufferPct,
        holdDays: params.holdDays,
        stopMode: rule.stopMode,
        maxGapUpPct: params.maxGapUpPct,
        entryPrice: round(entryPriceBase),
        exitPrice: round(exit.exitPrice),
        exitReason: exit.exitReason,
        netReturnPct: round(netReturnPct),
        maePct: round(mae(history, i + 1, exit.exitIndex, entryPriceBase)),
        mfePct: round(mfe(history, i + 1, exit.exitIndex, entryPriceBase)),
        volatilityBucket: bucket(stats.std20, [3, 5], ['2-3', '3-5', '>=5']),
        scoreBucket: bucket(analysis.score, [80, 90, 95, 100], ['<80', '80-89', '90-94', '95-99', '100']),
        rsiBucket: bucket(rsi14 ?? 0, [50, 60, 70], ['<50', '50-59', '60-69', '>=70']),
        liquidityBucket: bucket(stats.avg20TradeValue, [100000000, 500000000, 1000000000], ['<100m', '100m-500m', '500m-1b', '>=1b']),
        adaptiveRule: rule.key,
        adaptiveLabel: rule.label
      });
    }

    for (const bufferPct of BREAKOUT_BUFFERS) {
      const trigger = resistance * (1 + bufferPct / 100);
      if (nextDay.high < trigger) continue;

      const gapUpPct = pct(nextDay.open, signalDay.close) || 0;
      const entryPriceBase = nextDay.open > trigger ? nextDay.open : trigger;

      for (const maxGapUpPct of MAX_GAP_UPS) {
        if (maxGapUpPct < 99 && gapUpPct > maxGapUpPct) continue;
        for (const holdDays of HOLD_DAYS) {
          for (const stopMode of STOP_MODES) {
            const exit = exitTrade(history, i + 1, entryPriceBase, plan.stop, holdDays, stopMode);
            const netReturnPct = applyCosts(entryPriceBase, exit.exitPrice);
            trades.push({
              symbol: stock.code,
              name: stock.name,
              market: stock.market,
              industry: stock.industry,
              signalDate: signalDay.date,
              entryDate: nextDay.date,
              exitDate: exit.exitDate,
              signalScore: analysis.score,
              rsi14: analysis.metrics?.rsi14,
              std20: round(stats.std20, 4),
              avg20TradeValue: round(stats.avg20TradeValue, 0),
              gapUpPct: round(gapUpPct, 2),
              breakoutBufferPct: bufferPct,
              holdDays,
              stopMode,
              maxGapUpPct,
              entryPrice: round(entryPriceBase),
              exitPrice: round(exit.exitPrice),
              exitReason: exit.exitReason,
              netReturnPct: round(netReturnPct),
              maePct: round(mae(history, i + 1, exit.exitIndex, entryPriceBase)),
              mfePct: round(mfe(history, i + 1, exit.exitIndex, entryPriceBase)),
              volatilityBucket: bucket(stats.std20, [3, 5], ['2-3', '3-5', '>=5']),
              scoreBucket: bucket(analysis.score, [80, 90, 95, 100], ['<80', '80-89', '90-94', '95-99', '100']),
              rsiBucket: bucket(analysis.metrics?.rsi14 ?? 0, [50, 60, 70], ['<50', '50-59', '60-69', '>=70']),
              liquidityBucket: bucket(stats.avg20TradeValue, [100000000, 500000000, 1000000000], ['<100m', '100m-500m', '500m-1b', '>=1b'])
            });
          }
        }
      }
    }
  }

  return { trades, adaptiveTrades, signals };
}

function comboKey(row) {
  return `breakout_${row.breakoutBufferPct}% + hold_${row.holdDays}d + ${row.stopMode} + gap_${row.maxGapUpPct === 99 ? 'none' : `${row.maxGapUpPct}%`}`;
}

function summarize(rows) {
  const wins = rows.filter(row => row.netReturnPct > 0);
  const profit = wins.reduce((sum, row) => sum + row.netReturnPct, 0);
  const loss = Math.abs(rows.filter(row => row.netReturnPct <= 0).reduce((sum, row) => sum + row.netReturnPct, 0));
  return {
    trades: rows.length,
    winRatePct: round((wins.length / Math.max(1, rows.length)) * 100),
    avgNetReturnPct: round(mean(rows.map(row => row.netReturnPct)) || 0),
    medianNetReturnPct: round(median(rows.map(row => row.netReturnPct)) || 0),
    totalNetReturnPct: round(rows.reduce((sum, row) => sum + row.netReturnPct, 0)),
    worstTradePct: rows.length ? round(Math.min(...rows.map(row => row.netReturnPct))) : null,
    bestTradePct: rows.length ? round(Math.max(...rows.map(row => row.netReturnPct))) : null,
    avgMaePct: round(mean(rows.map(row => row.maePct)) || 0),
    avgMfePct: round(mean(rows.map(row => row.mfePct)) || 0),
    profitFactor: loss ? round(profit / loss) : null
  };
}

function rankCombos(rows, minTrades = MIN_SEGMENT_TRADES, limit = 20) {
  const groups = new Map();
  for (const row of rows) {
    const key = comboKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([combo, comboRows]) => ({ combo, ...summarize(comboRows) }))
    .filter(row => row.trades >= minTrades)
    .sort((a, b) => (b.profitFactor || 0) - (a.profitFactor || 0) || b.avgNetReturnPct - a.avgNetReturnPct)
    .slice(0, limit);
}

function rankRiskControlledCombos(rows, maxWorstLossPct = -15) {
  return rankCombos(rows, MIN_SEGMENT_TRADES, 200)
    .filter(row => row.worstTradePct !== null && row.worstTradePct >= maxWorstLossPct)
    .slice(0, 10);
}

function rowsForCombo(rows, combo) {
  return rows.filter(row => comboKey(row) === combo);
}

function lossSummary(rows, field) {
  const losses = rows.filter(row => row.netReturnPct < 0);
  const groups = new Map();
  for (const row of losses) {
    const key = row[field] || UNCLASSIFIED;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([key, groupRows]) => ({
      key,
      losses: groupRows.length,
      avgLossPct: round(mean(groupRows.map(row => row.netReturnPct)) || 0),
      worstTradePct: round(Math.min(...groupRows.map(row => row.netReturnPct))),
      avgMaePct: round(mean(groupRows.map(row => row.maePct)) || 0)
    }))
    .sort((a, b) => a.avgLossPct - b.avgLossPct || b.losses - a.losses)
    .slice(0, 12);
}

function topLosers(rows, limit = 12) {
  return [...rows]
    .sort((a, b) => a.netReturnPct - b.netReturnPct)
    .slice(0, limit)
    .map(row => ({
      symbol: row.symbol,
      name: row.name,
      market: row.market,
      industry: row.industry,
      signalDate: row.signalDate,
      entryDate: row.entryDate,
      signalScore: row.signalScore,
      rsi14: round(row.rsi14, 1),
      std20: row.std20,
      gapUpPct: row.gapUpPct,
      avg20TradeValue: row.avg20TradeValue,
      exitReason: row.exitReason,
      netReturnPct: row.netReturnPct,
      maePct: row.maePct,
      mfePct: row.mfePct,
      volatilityBucket: row.volatilityBucket,
      scoreBucket: row.scoreBucket,
      rsiBucket: row.rsiBucket,
      liquidityBucket: row.liquidityBucket
    }));
}

function diagnoseComboLosses(rows, combo) {
  const comboRows = rowsForCombo(rows, combo);
  return {
    combo,
    summary: summarize(comboRows),
    topLosers: topLosers(comboRows),
    byMarket: lossSummary(comboRows, 'market'),
    byIndustry: lossSummary(comboRows, 'industry'),
    byVolatility: lossSummary(comboRows, 'volatilityBucket'),
    byScore: lossSummary(comboRows, 'scoreBucket'),
    byRsi: lossSummary(comboRows, 'rsiBucket'),
    byLiquidity: lossSummary(comboRows, 'liquidityBucket')
  };
}

function rankAdaptiveRules(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.adaptiveRule || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([rule, ruleRows]) => ({
      rule,
      label: ruleRows[0]?.adaptiveLabel || rule,
      ...summarize(ruleRows)
    }))
    .filter(row => row.trades >= MIN_SEGMENT_TRADES)
    .sort((a, b) => (b.profitFactor || 0) - (a.profitFactor || 0) || b.avgNetReturnPct - a.avgNetReturnPct);
}

function filteredLeaderRows(rows) {
  const filters = [
    {
      filter: 'RSI >= 50',
      rows: rows.filter(row => row.rsi14 === null || row.rsi14 >= 50)
    },
    {
      filter: 'RSI 50-78 + 排除高波動低流動性',
      rows: rows.filter(row => (row.rsi14 === null || (row.rsi14 >= 50 && row.rsi14 <= 78))
        && !(row.std20 >= 5 && row.avg20TradeValue < 100000000))
    },
    {
      filter: 'RSI 50-74 + 分數 >= 85 + 排除高波動低流動性',
      rows: rows.filter(row => (row.rsi14 === null || (row.rsi14 >= 50 && row.rsi14 <= 74))
        && row.signalScore >= 85
        && !(row.std20 >= 5 && row.avg20TradeValue < 100000000))
    },
    {
      filter: 'RSI 50-74 + 分數 >= 85 + 波動 < 5',
      rows: rows.filter(row => (row.rsi14 === null || (row.rsi14 >= 50 && row.rsi14 <= 74))
        && row.signalScore >= 85
        && row.std20 < 5)
    }
  ];
  return filters
    .map(item => {
      const leader = rankCombos(item.rows, MIN_SEGMENT_TRADES, 1)[0];
      return leader ? { filter: item.filter, ...leader } : null;
    })
    .filter(Boolean);
}

function segmentLeaders(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const key = row[field] || UNCLASSIFIED;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .filter(([, groupRows]) => new Set(groupRows.map(comboKey)).size >= 2)
      .map(([segment, groupRows]) => [segment, rankCombos(groupRows, Math.max(5, Math.min(MIN_SEGMENT_TRADES, Math.floor(groupRows.length / 20))))[0] || null])
      .filter(([, leader]) => leader)
  );
}

function markdown(payload) {
  const lines = [];
  const add = line => lines.push(line);
  const table = (cols, rows) => {
    add(cols.join(' | '));
    add(cols.map(() => '---').join(' | '));
    for (const row of rows) add(cols.map(col => row[col] ?? '').join(' | '));
    add('');
  };

  add('# Scenario Strategy Diagnostics');
  add('');
  add(`Generated at: ${payload.generatedAt}`);
  add(`Scanned: ${payload.scanned}`);
  add(`Signals: ${payload.signals}`);
  add('');
  add('## Data Limitation');
  add('');
  add('- This uses daily K data. It cannot accurately test avoiding the first 5 minutes after open.');
  add('- First-5-minute logic needs intraday 1-minute or 5-minute historical data.');
  add('');
  add('## Overall Combo Leaders');
  add('');
  table(['combo', 'trades', 'winRatePct', 'avgNetReturnPct', 'medianNetReturnPct', 'profitFactor', 'worstTradePct'], payload.overallTop10);
  add('## Risk-Controlled Combo Leaders');
  add('');
  table(['combo', 'trades', 'winRatePct', 'avgNetReturnPct', 'medianNetReturnPct', 'profitFactor', 'worstTradePct'], payload.riskControlledTop10);
  add('## Adaptive Rule Test');
  add('');
  table(['rule', 'label', 'trades', 'winRatePct', 'avgNetReturnPct', 'medianNetReturnPct', 'profitFactor', 'worstTradePct'], payload.adaptiveRuleLeaders);
  add('## Filtered Combo Test');
  add('');
  table(['filter', 'combo', 'trades', 'winRatePct', 'avgNetReturnPct', 'medianNetReturnPct', 'profitFactor', 'worstTradePct'], payload.filteredComboLeaders);
  add('## Volatility Leaders');
  add('');
  table(['segment', 'combo', 'trades', 'winRatePct', 'avgNetReturnPct', 'profitFactor', 'worstTradePct'], Object.entries(payload.segmentLeaders.byVolatility).map(([segment, leader]) => ({ segment, ...leader })));
  add('## Market Leaders');
  add('');
  table(['segment', 'combo', 'trades', 'winRatePct', 'avgNetReturnPct', 'profitFactor', 'worstTradePct'], Object.entries(payload.segmentLeaders.byMarket).map(([segment, leader]) => ({ segment, ...leader })));
  add('## Score Leaders');
  add('');
  table(['segment', 'combo', 'trades', 'winRatePct', 'avgNetReturnPct', 'profitFactor', 'worstTradePct'], Object.entries(payload.segmentLeaders.byScore).map(([segment, leader]) => ({ segment, ...leader })));
  add('## Loss Diagnosis');
  add('');
  for (const item of payload.lossDiagnostics) {
    add(`### ${item.label}`);
    add('');
    add(`Combo: \`${item.combo}\``);
    add('');
    add('Top losers:');
    add('');
    table(['symbol', 'name', 'market', 'industry', 'entryDate', 'signalScore', 'rsi14', 'std20', 'gapUpPct', 'netReturnPct', 'maePct', 'mfePct'], item.topLosers);
    add('Worst loss groups by market:');
    add('');
    table(['key', 'losses', 'avgLossPct', 'worstTradePct', 'avgMaePct'], item.byMarket);
    add('Worst loss groups by score:');
    add('');
    table(['key', 'losses', 'avgLossPct', 'worstTradePct', 'avgMaePct'], item.byScore);
    add('Worst loss groups by RSI:');
    add('');
    table(['key', 'losses', 'avgLossPct', 'worstTradePct', 'avgMaePct'], item.byRsi);
  }
  add('## Decision Notes');
  add('');
  for (const note of payload.decisionNotes) add(`- ${note}`);
  add('');
  return `${lines.join('\n')}\n`;
}

function buildDecisionNotes(payload) {
  const notes = [];
  const best = payload.overallTop10[0];
  const riskBest = payload.riskControlledTop10[0];
  if (best) {
    notes.push(`Best in-sample combo is ${best.combo}, with ${best.trades} trades, ${best.avgNetReturnPct}% average net return, and PF ${best.profitFactor}.`);
  }
  if (riskBest) {
    notes.push(`Best risk-controlled combo is ${riskBest.combo}, with worst trade ${riskBest.worstTradePct}% and PF ${riskBest.profitFactor}.`);
  }
  notes.push('Do not treat this as final automation logic yet; this is still in-sample optimization.');
  notes.push('Avoiding the first 5 minutes cannot be validated with current daily data, so it should remain a live/paper-trading guard until intraday history is added.');
  notes.push('Loss diagnosis should drive the next strategy edit; do not move to paper trading while worst-case loss groups are unresolved.');
  notes.push('2026-06 revision: candidate logic now blocks RSI below 50, RSI above 78, and high-volatility low-liquidity setups because the filtered test reduced worst loss from -20.34% to -12.76% while improving PF to 2.99.');
  notes.push('Next step is to edit the selection or execution rules based on the loss groups, then rerun historical backtests.');
  return notes;
}

async function main() {
  const core = await loadStrategyCore();
  const [{ listed, otc }, twse, tpex] = await Promise.all([
    fetchIndustryMaps(),
    core.fetchTwseUniverse(),
    core.fetchTpexUniverse()
  ]);
  const universe = FULL_UNIVERSE
    ? [...enrichUniverse(twse, MARKET_LISTED, listed), ...enrichUniverse(tpex, MARKET_OTC, otc)]
    : [...enrichUniverse(twse.slice(0, SYMBOLS_PER_MARKET), MARKET_LISTED, listed), ...enrichUniverse(tpex.slice(0, SYMBOLS_PER_MARKET), MARKET_OTC, otc)];

  const results = await core.mapLimit(universe.sort((a, b) => b.tradeValue - a.tradeValue), CONCURRENCY, async stock => {
    const history = await fetchYahooHistory(stock.yahooSymbol);
    if (history.length < 120) return { trades: [], signals: 0 };
    return simulateScenarioTrades(history, stock, core.analyzeWindow);
  });

  const trades = results.flatMap(result => result.trades);
  const adaptiveTrades = results.flatMap(result => result.adaptiveTrades || []);
  const signals = results.reduce((sum, result) => sum + result.signals, 0);
  const overallTop10 = rankCombos(trades).slice(0, 10);
  const riskControlledTop10 = rankRiskControlledCombos(trades);
  const adaptiveRuleLeaders = rankAdaptiveRules(adaptiveTrades);
  const filteredComboLeaders = filteredLeaderRows(trades);
  const payload = {
    generatedAt: new Date().toISOString(),
    range: RANGE,
    scanned: universe.length,
    signals,
    assumptions: {
      breakoutBuffers: BREAKOUT_BUFFERS,
      holdDays: HOLD_DAYS,
      stopModes: STOP_MODES,
      maxGapUps: MAX_GAP_UPS,
      buyFeePct: BUY_FEE_PCT,
      sellFeePct: SELL_FEE_PCT,
      sellTaxPct: SELL_TAX_PCT,
      buySlippagePct: BUY_SLIPPAGE_PCT,
      sellSlippagePct: SELL_SLIPPAGE_PCT,
      minStd20: MIN_STD20
    },
    overallTop10,
    riskControlledTop10,
    adaptiveRuleLeaders,
    filteredComboLeaders,
    segmentLeaders: {
      byVolatility: segmentLeaders(trades, 'volatilityBucket'),
      byMarket: segmentLeaders(trades, 'market'),
      byScore: segmentLeaders(trades, 'scoreBucket'),
      byRsi: segmentLeaders(trades, 'rsiBucket'),
      byLiquidity: segmentLeaders(trades, 'liquidityBucket'),
      byIndustry: segmentLeaders(trades, 'industry')
    },
    lossDiagnostics: [
      overallTop10[0] ? { label: 'Pure performance leader', ...diagnoseComboLosses(trades, overallTop10[0].combo) } : null,
      riskControlledTop10[0] ? { label: 'Risk-controlled leader', ...diagnoseComboLosses(trades, riskControlledTop10[0].combo) } : null
    ].filter(Boolean),
    decisionNotes: [],
    sampleTrades: trades.slice(0, 100)
  };
  payload.decisionNotes = buildDecisionNotes(payload);

  await writeFile(OUTPUT_JSON, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await writeFile(OUTPUT_MD, markdown(payload), 'utf8');
  console.log(JSON.stringify({
    outputJson: OUTPUT_JSON.pathname,
    outputMarkdown: OUTPUT_MD.pathname,
    scanned: payload.scanned,
    signals: payload.signals,
    best: payload.overallTop10[0] || null
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
