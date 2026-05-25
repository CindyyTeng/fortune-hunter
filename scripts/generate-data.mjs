const OUTPUT = new URL('../data/recommendations.json', import.meta.url);
const SYMBOLS_PER_MARKET = Number(process.env.SYMBOLS_PER_MARKET || 120);
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const USER_AGENT = 'fortune-hunter/2.1';
const HOLD_DAYS = 10;
const OVERNIGHT_SYMBOLS = {
  sp500: '^GSPC',
  nasdaq: '^IXIC',
  dow: '^DJI',
  sox: '^SOX'
};

const warnings = [];

function toNumber(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/[, %+]/g, '').replace('--', '').trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function pick(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && row[name] !== '') return row[name];
  }
  return undefined;
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  if (typeof options === 'number') {
    timeoutMs = options;
    options = {};
  }
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

async function fetchTwseUniverse() {
  const rows = await fetchJson('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');
  return rows.map(row => {
    const code = String(pick(row, ['Code', '證券代號', '股票代號']) || '').trim();
    const name = String(pick(row, ['Name', '證券名稱', '股票名稱']) || '').trim();
    const close = toNumber(pick(row, ['ClosingPrice', '收盤價']));
    const open = toNumber(pick(row, ['OpeningPrice', '開盤價']));
    const high = toNumber(pick(row, ['HighestPrice', '最高價']));
    const low = toNumber(pick(row, ['LowestPrice', '最低價']));
    const volume = toNumber(pick(row, ['TradeVolume', '成交股數'])) || 0;
    const tradeValue = toNumber(pick(row, ['TradeValue', '成交金額'])) || 0;
    const pe = toNumber(pick(row, ['PERatio', '本益比']));
    return { code, name, market: '上市', yahooSymbol: `${code}.TW`, close, open, high, low, volume, tradeValue, pe };
  }).filter(stock => /^\d{4}$/.test(stock.code) && !stock.code.startsWith('00') && stock.name && stock.close && stock.volume > 0)
    .sort((a, b) => b.tradeValue - a.tradeValue);
}

async function fetchTpexUniverse() {
  const body = new URLSearchParams({ response: 'json', date: '', type: 'AL' });
  const json = await fetchJson('https://www.tpex.org.tw/www/zh-tw/afterTrading/otc', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }
  });
  const rows = json.tables?.[0]?.data || [];
  return rows.map(row => {
    const code = String(row[0] || '').trim();
    const name = String(row[1] || '').trim();
    const close = toNumber(row[2]);
    const open = toNumber(row[4]);
    const high = toNumber(row[5]);
    const low = toNumber(row[6]);
    const volume = toNumber(row[7]) || 0;
    const tradeValue = toNumber(row[8]) || 0;
    return { code, name, market: '上櫃', yahooSymbol: `${code}.TWO`, close, open, high, low, volume, tradeValue, pe: null };
  }).filter(stock => /^\d{4}$/.test(stock.code) && !stock.code.startsWith('00') && stock.name && stock.close && stock.volume > 0)
    .sort((a, b) => b.tradeValue - a.tradeValue);
}

async function fetchYahooHistory(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d&includePrePost=false&events=div%2Csplits`;
  const json = await fetchJson(url);
  const result = json.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error(`沒有 ${symbol} 歷史資料`);
  const quote = result.indicators?.quote?.[0];
  if (!quote) throw new Error(`沒有 ${symbol} K 線欄位`);
  return result.timestamp.map((timestamp, index) => ({
    date: new Date(timestamp * 1000).toISOString().slice(0, 10),
    open: quote.open[index],
    high: quote.high[index],
    low: quote.low[index],
    close: quote.close[index],
    volume: quote.volume[index]
  })).filter(day => [day.open, day.high, day.low, day.close].every(Number.isFinite));
}

function latestChange(history) {
  if (!history || history.length < 2) return null;
  return pct(history.at(-1).close, history.at(-2).close);
}

async function fetchOvernightContext() {
  const entries = await Promise.all(
    Object.entries(OVERNIGHT_SYMBOLS).map(async ([key, symbol]) => {
      const history = await fetchYahooHistory(symbol);
      return [key, {
        symbol,
        date: history.at(-1)?.date || null,
        close: round(history.at(-1)?.close),
        change: round(latestChange(history))
      }];
    })
  );

  const indices = Object.fromEntries(entries);
  const marketComposite = round(
    (indices.sp500?.change || 0) * 0.45
      + (indices.nasdaq?.change || 0) * 0.35
      + (indices.dow?.change || 0) * 0.2,
    2
  );
  const techComposite = round(
    (indices.nasdaq?.change || 0) * 0.45
      + (indices.sox?.change || 0) * 0.55,
    2
  );

  const bias = marketComposite <= -1.2
    ? 'risk-off'
    : marketComposite >= 1.2
      ? 'risk-on'
      : 'neutral';

  return {
    asOf: new Date().toISOString(),
    bias,
    marketComposite,
    techComposite,
    indices
  };
}

function average(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
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

function ema(values, period) {
  if (values.length < period) return null;
  const first = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const k = 2 / (period + 1);
  return values.slice(period).reduce((prev, value) => value * k + prev * (1 - k), first);
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function macd(values) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);
  if (fast === null || slow === null) return null;
  return fast - slow;
}

function pct(now, then) {
  return then ? ((now - then) / then) * 100 : 0;
}

function round(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pivotPoints(values, kind, lookback = 30) {
  const size = Math.min(lookback, values.length);
  const offset = values.length - size;
  const slice = values.slice(-size);
  const pivots = [];
  for (let i = 2; i < slice.length - 2; i++) {
    const value = slice[i];
    const window = slice.slice(i - 2, i + 3);
    const matched = kind === 'low' ? value === Math.min(...window) : value === Math.max(...window);
    if (!matched) continue;
    const index = offset + i;
    if (pivots.length && index - pivots.at(-1).index < 3) continue;
    pivots.push({ index, value });
  }
  return pivots;
}

function nearRatio(a, b) {
  const base = (a + b) / 2;
  return base ? Math.abs(a - b) / base : Infinity;
}

function detectPatterns(history, latest, ma5, ma20, ma60) {
  const closes = history.map(day => day.close);
  const highs = history.map(day => day.high);
  const lows = history.map(day => day.low);
  const bullish = [];
  const bearish = [];
  const watch = [];
  let score = 0;

  if (history.length < 30 || !ma20 || !ma60) {
    return { score: 0, bias: '資料不足', bullish, bearish, watch };
  }

  const recent15 = history.slice(-15);
  const recent20 = history.slice(-20);
  const range15 = (Math.max(...recent15.map(day => day.high)) - Math.min(...recent15.map(day => day.low))) / latest.close;
  const range20 = Math.max(...recent20.map(day => day.high)) - Math.min(...recent20.map(day => day.low));
  const range7 = Math.max(...highs.slice(-7)) - Math.min(...lows.slice(-7));
  const highPivots = pivotPoints(highs, 'high', 30);
  const lowPivots = pivotPoints(lows, 'low', 30);
  const avgHighEarly = mean(highs.slice(-20, -10));
  const avgHighLate = mean(highs.slice(-10));
  const avgLowEarly = mean(lows.slice(-20, -10));
  const avgLowLate = mean(lows.slice(-10));
  const pullbackStart = closes.at(-8);
  const trendStart = closes.at(-20);
  const preMove = trendStart ? pct(pullbackStart, trendStart) : null;
  const recentMove = pullbackStart ? pct(latest.close, pullbackStart) : null;

  if (lowPivots.length >= 2) {
    const [leftLow, rightLow] = lowPivots.slice(-2);
    const neckline = Math.max(...highs.slice(leftLow.index, rightLow.index + 1));
    if (rightLow.index - leftLow.index >= 4
      && nearRatio(leftLow.value, rightLow.value) <= 0.06
      && latest.close > neckline * 1.01
      && latest.close > ma20) {
      bullish.push('W底/雙底完成，價格已站上頸線。');
      score += 14;
    }
  }

  if (lowPivots.length >= 3) {
    const lows3 = lowPivots.slice(-3);
    const neckline = Math.max(...highs.slice(lows3[0].index, lows3[2].index + 1));
    if (lows3[1].value < lows3[0].value * 0.96
      && lows3[1].value < lows3[2].value * 0.96
      && nearRatio(lows3[0].value, lows3[2].value) <= 0.08
      && latest.close >= neckline * 0.99
      && latest.close > ma20) {
      bullish.push('頭肩底雛形明確，右肩完成後接近突破。');
      score += 12;
    }
  }

  if (highPivots.length >= 2 && lowPivots.length >= 2) {
    const highs2 = highPivots.slice(-2);
    const lows2 = lowPivots.slice(-2);
    const resistance = Math.max(...highs2.map(item => item.value));
    if (nearRatio(highs2[0].value, highs2[1].value) <= 0.04
      && lows2[1].value > lows2[0].value * 1.03
      && latest.close >= resistance * 0.98
      && ma20 > ma60) {
      bullish.push('上升三角形整理後接近突破，屬於偏強續攻型態。');
      score += 12;
    }
  }

  if (preMove !== null && recentMove !== null
    && preMove > 8
    && recentMove > -6 && recentMove < 4
    && range20 > 0
    && range7 / range20 < 0.55
    && Math.min(...lows.slice(-7)) > ma20 * 0.98) {
    bullish.push('上升旗形，急漲後以小幅整理消化賣壓。');
    score += 10;
  }

  if (highPivots.length >= 2 && lowPivots.length >= 2) {
    const highs2 = highPivots.slice(-2);
    const lows2 = lowPivots.slice(-2);
    const highMove = pct(highs2[1].value, highs2[0].value);
    const lowMove = pct(lows2[1].value, lows2[0].value);
    if (highMove < -4
      && lowMove < 0
      && Math.abs(lowMove) < Math.abs(highMove)
      && latest.close > (ma5 || ma20)
      && latest.close > mean(closes.slice(-3))) {
      bullish.push('下降楔形收斂，空方力道遞減。');
      score += 10;
    }
  }

  if (highPivots.length >= 2) {
    const [leftHigh, rightHigh] = highPivots.slice(-2);
    const neckline = Math.min(...lows.slice(leftHigh.index, rightHigh.index + 1));
    if (rightHigh.index - leftHigh.index >= 4
      && nearRatio(leftHigh.value, rightHigh.value) <= 0.06
      && latest.close < neckline * 0.99) {
      bearish.push('M頭/雙頂成立，頸線已失守。');
      score -= 14;
    }
  }

  if (highPivots.length >= 3) {
    const highs3 = highPivots.slice(-3);
    const peakMax = Math.max(...highs3.map(item => item.value));
    const peakMin = Math.min(...highs3.map(item => item.value));
    const neckline = Math.min(...lows.slice(highs3[0].index, highs3[2].index + 1));
    if (peakMin / peakMax >= 0.93 && latest.close < neckline * 0.99) {
      bearish.push('三重頂完成，反壓區反覆測試後轉弱。');
      score -= 16;
    }
  }

  if (preMove !== null && recentMove !== null
    && preMove < -8
    && recentMove > -3 && recentMove < 4
    && range20 > 0
    && range7 / range20 < 0.55
    && Math.max(...highs.slice(-7)) < ma20 * 1.03) {
    bearish.push('下跌旗形，反彈偏弱且仍在空方控制內。');
    score -= 10;
  }

  if (highPivots.length >= 2 && lowPivots.length >= 2) {
    const highs2 = highPivots.slice(-2);
    const lows2 = lowPivots.slice(-2);
    const highMove = pct(highs2[1].value, highs2[0].value);
    const lowMove = pct(lows2[1].value, lows2[0].value);
    if (highMove > 4
      && lowMove > highMove * 1.2
      && latest.close < (ma5 || ma20)) {
      bearish.push('上升楔形末端轉弱，追價風險偏高。');
      score -= 10;
    }
  }

  if (range15 < 0.08) watch.push('箱型盤整，先等帶量突破再追。');

  if (avgHighEarly && avgHighLate && avgLowEarly && avgLowLate
    && avgHighLate < avgHighEarly * 0.99
    && avgLowLate > avgLowEarly * 1.01
    && range20 / latest.close < 0.18) {
    watch.push('三角收斂，方向尚未表態。');
  }

  if (avgHighEarly && avgHighLate && avgLowEarly && avgLowLate) {
    const earlyWidth = avgHighEarly - avgLowEarly;
    const lateWidth = avgHighLate - avgLowLate;
    if (avgHighLate > avgHighEarly * 1.03
      && avgLowLate > avgLowEarly * 1.03
      && earlyWidth > 0
      && Math.abs(lateWidth - earlyWidth) / earlyWidth < 0.25) {
      watch.push('上升通道內推進，等回下緣或正式突破。');
    }
  }

  score = clamp(score, -24, 24);
  const bias = score >= 12 ? '偏多'
    : score <= -12 ? '偏空'
    : watch.length ? '等待'
    : '中性';

  return { score, bias, bullish, bearish, watch: watch.slice(0, 3) };
}

function buildSellWarning(latest, ma5, ma20, rsi14, ret20, std20, patterns) {
  let score = 0;
  const reasons = [];

  if (patterns.bearish.length) {
    score += 14 + Math.min(8, patterns.bearish.length * 3);
    reasons.push(...patterns.bearish);
  }
  if (ma5 && latest.close < ma5) {
    score += 5;
    reasons.push('收盤跌回 5 日線下方，短線轉弱。');
  }
  if (ma20 && latest.close < ma20) {
    score += 9;
    reasons.push('收盤跌回 20 日線下方，兩週節奏被破壞。');
  }
  if (rsi14 !== null && rsi14 > 74) {
    score += 6;
    reasons.push(`RSI ${rsi14.toFixed(1)} 過熱，若無續量容易轉弱。`);
  }
  if (ret20 !== null && ret20 > 18) {
    score += 6;
    reasons.push(`近 20 日已漲 ${ret20.toFixed(1)}%，短線容易獲利回吐。`);
  }
  if (std20 !== null && std20 > 0.035) {
    score += 4;
    reasons.push('20 日波動偏大，應縮短觀察與持有時間。');
  }

  const level = score >= 24 ? '高'
    : score >= 14 ? '中'
    : score >= 7 ? '低'
    : '無';

  const action = level === '高'
    ? '以保本或先減碼為主，只留少量觀察倉。'
    : level === '中'
      ? '只要再跌破 5 日線或隔天無法站回，就應先出場。'
      : level === '低'
        ? '維持短線紀律，5 到 10 個交易日內沒有續攻就先退。'
        : '沿 5 日線續抱，但最晚 10 個交易日內要完成表態。';

  return { score, level, reasons, action };
}

function buildPositionSizing(latestClose, stop, std20, sellWarning) {
  const stopPct = latestClose ? (latestClose - stop) / latestClose : 0.05;
  let riskBudgetPct = std20 !== null && std20 > 0.035 ? 0.7
    : std20 !== null && std20 > 0.025 ? 0.9
      : 1.2;

  if (sellWarning.level === '中') riskBudgetPct = Math.min(riskBudgetPct, 0.8);
  if (sellWarning.level === '高') riskBudgetPct = Math.min(riskBudgetPct, 0.6);

  const capitalPct = clamp((riskBudgetPct / Math.max(stopPct * 100, 2.5)) * 100, 8, 28);
  return {
    riskBudgetPct: round(riskBudgetPct, 1),
    capitalPct: Math.round(capitalPct),
    stopPct: round(stopPct * 100, 1),
    text: `單筆風險先控制在總資金 ${round(riskBudgetPct, 1)}%，以目前止損寬度約 ${round(stopPct * 100, 1)}% 計算，單檔資金先抓 ${Math.round(capitalPct)}% 左右。`
  };
}

function inferThemes(stock) {
  const name = stock.name || '';
  const code = stock.code || '';
  const themes = [];

  if (/金控|銀行|保險|證券|票券/.test(name)) themes.push('finance');
  if (/半導體|晶圓|矽|IC|晶片|封測|光罩|驅動/.test(name)
    || ['2330', '2303', '2454', '3034', '3711', '2344', '2379', '3443', '6415', '8299'].includes(code)) {
    themes.push('semiconductor');
  }
  if (/伺服器|電腦|主機板|顯卡|網通/.test(name)
    || ['2317', '2382', '3231', '6669', '3017', '2356', '2376', '2357', '2383', '4938'].includes(code)) {
    themes.push('ai-hardware');
  }
  if (!themes.length) themes.push('broad-market');

  return themes;
}

function buildOvernightImpact(stock, overnightContext) {
  if (!overnightContext) {
    return {
      score: 0,
      bias: 'neutral',
      reasons: [],
      risks: [],
      themes: inferThemes(stock)
    };
  }

  const themes = inferThemes(stock);
  const reasons = [];
  const risks = [];
  let score = 0;

  const marketMove = overnightContext.marketComposite;
  const techMove = overnightContext.techComposite;
  const soxMove = overnightContext.indices.sox?.change ?? null;
  const dowMove = overnightContext.indices.dow?.change ?? null;

  if (marketMove !== null) {
    if (marketMove <= -2) {
      score -= 12;
      risks.push(`昨夜美股整體偏弱，綜合變動 ${marketMove.toFixed(2)}%，台股隔日開盤承壓。`);
    } else if (marketMove <= -1) {
      score -= 7;
      risks.push(`昨夜美股轉弱，綜合變動 ${marketMove.toFixed(2)}%，不利隔日追價。`);
    } else if (marketMove >= 1.5) {
      score += 6;
      reasons.push(`昨夜美股整體偏強，綜合變動 ${marketMove.toFixed(2)}%，有利隔日開盤情緒。`);
    } else if (marketMove >= 0.8) {
      score += 3;
      reasons.push(`昨夜美股小幅偏強，綜合變動 ${marketMove.toFixed(2)}%，外部風險相對和緩。`);
    }
  }

  if (themes.includes('semiconductor') && soxMove !== null) {
    if (soxMove <= -2.5) {
      score -= 10;
      risks.push(`費半昨夜下跌 ${soxMove.toFixed(2)}%，半導體族群隔日容易先被調節。`);
    } else if (soxMove <= -1) {
      score -= 6;
      risks.push(`費半昨夜偏弱 ${soxMove.toFixed(2)}%，半導體族群開盤容易先受壓。`);
    } else if (soxMove >= 2) {
      score += 6;
      reasons.push(`費半昨夜上漲 ${soxMove.toFixed(2)}%，有利半導體族群隔日續強。`);
    } else if (soxMove >= 1) {
      score += 3;
      reasons.push(`費半昨夜偏強 ${soxMove.toFixed(2)}%，半導體族群情緒較佳。`);
    }
  }

  if (themes.includes('ai-hardware') && techMove !== null) {
    if (techMove <= -2) {
      score -= 8;
      risks.push(`美國科技股昨夜偏弱 ${techMove.toFixed(2)}%，AI 硬體族群隔日容易先震盪。`);
    } else if (techMove <= -1) {
      score -= 5;
      risks.push(`美國科技股昨夜轉弱 ${techMove.toFixed(2)}%，AI 硬體開盤不宜追高。`);
    } else if (techMove >= 1.8) {
      score += 5;
      reasons.push(`美國科技股昨夜偏強 ${techMove.toFixed(2)}%，AI 硬體族群開盤氣氛較有利。`);
    }
  }

  if (themes.includes('finance') && dowMove !== null) {
    if (dowMove <= -1.5) {
      score -= 5;
      risks.push(`道瓊昨夜下跌 ${dowMove.toFixed(2)}%，金融股隔日承接力可能轉弱。`);
    } else if (dowMove >= 1.2) {
      score += 3;
      reasons.push(`道瓊昨夜上漲 ${dowMove.toFixed(2)}%，金融股隔日情緒較穩。`);
    }
  }

  return {
    score,
    bias: score <= -6 ? 'headwind' : score >= 6 ? 'tailwind' : 'neutral',
    reasons: reasons.slice(0, 3),
    risks: risks.slice(0, 3),
    themes,
    marketComposite: marketMove,
    techComposite: techMove,
    soxChange: soxMove,
    dowChange: dowMove
  };
}

function analyzeWindow(history, stock, overnightContext = null, options = {}) {
  const includeOvernight = options.includeOvernight !== false;
  const closes = history.map(day => day.close);
  const volumes = history.map(day => day.volume || 0);
  const returns = closes.slice(1).map((value, idx) => (value - closes[idx]) / closes[idx]);
  const latest = history.at(-1);
  const ma5 = average(closes, 5);
  const ma20 = average(closes, 20);
  const ma60 = average(closes, 60);
  const rsi14 = rsi(closes, 14);
  const macdNow = macd(closes);
  const vol20 = average(volumes, 20);
  const ret5 = closes.length > 5 ? pct(latest.close, closes.at(-6)) : null;
  const ret10 = closes.length > 10 ? pct(latest.close, closes.at(-11)) : null;
  const ret20 = closes.length > 20 ? pct(latest.close, closes.at(-21)) : null;
  const ret60 = closes.length > 60 ? pct(latest.close, closes.at(-61)) : null;
  const returnAbs60 = returns.length >= 60 ? returns.slice(-60).reduce((sum, value) => sum + Math.abs(value), 0) : null;
  const intentFactor60 = returnAbs60 && ret60 !== null ? (ret60 / 100) / returnAbs60 : null;
  const std20 = returns.length >= 20 ? stddev(returns.slice(-20)) : null;
  const std60 = returns.length >= 60 ? stddev(returns.slice(-60)) : null;
  const min60 = closes.length >= 60 ? Math.min(...closes.slice(-60)) : null;
  const max60 = closes.length >= 60 ? Math.max(...closes.slice(-60)) : null;
  const rsv60 = min60 !== null && max60 !== null && max60 !== min60 ? (latest.close - min60) / (max60 - min60) : null;

  const gateTrend = ma20 && ma60 && latest.close > ma20 && ma20 > ma60;
  const gateVolume = latest.volume > 100000;
  const gateHeat = ret20 === null || ret20 < 18;

  let score = 0;
  const reasons = [];
  const risks = [];

  if (gateTrend) {
    score += 16;
    reasons.push('價格站上 20 日線，且 20 日線高於 60 日線，符合中短期多方架構。');
  } else {
    score -= 14;
    risks.push('價格未站穩 20 日線之上，不符合兩週內偏強節奏。');
  }
  if (ma5 && ma20 && latest.close >= ma5 && ma5 >= ma20) {
    score += 10;
    reasons.push('收盤守在 5 日線與 20 日線上方，短線買盤仍在。');
  } else if (ma5 && latest.close < ma5) {
    score -= 8;
    risks.push('收盤跌回 5 日線下方，短線續攻力道不足。');
  }
  if (gateVolume) {
    score += 6;
    reasons.push('成交量高於 10 萬股，具備基本流動性。');
  } else {
    score -= 10;
    risks.push('成交量偏低，短打時滑價風險偏高。');
  }
  if (!gateHeat) {
    score -= 14;
    risks.push(`近 20 日漲幅 ${ret20.toFixed(1)}% 偏大，兩週內追價風險高。`);
  } else if (ret10 !== null && ret10 > 0 && ret10 < 12) {
    score += 8;
    reasons.push(`近 10 日漲幅 ${ret10.toFixed(1)}%，仍屬可接受的短線推進。`);
  }
  if (intentFactor60 !== null) {
    if (intentFactor60 > 0.28) {
      score += 8;
      reasons.push(`價格意圖因子 ${intentFactor60.toFixed(3)} 偏強，走勢較乾淨。`);
    } else if (intentFactor60 < 0.08) {
      score -= 8;
      risks.push(`價格意圖因子 ${intentFactor60.toFixed(3)} 偏低，走勢容易震盪洗盤。`);
    }
  }
  if (rsv60 !== null) {
    if (rsv60 >= 0.72 && rsv60 <= 0.96) {
      score += 8;
      reasons.push(`60 日相對位置 ${rsv60.toFixed(2)}，介於強勢但未過度鈍化區間。`);
    } else if (rsv60 > 0.98) {
      score -= 6;
      risks.push(`60 日相對位置 ${rsv60.toFixed(2)} 太高，容易遇到短線獲利了結。`);
    }
  }
  if (std20 !== null && std60 !== null) {
    if (std20 < std60 * 0.95) {
      score += 8;
      reasons.push('短期波動低於長期波動，整理結構較乾淨。');
    } else if (std20 > std60 * 1.15) {
      score -= 6;
      risks.push('短期波動放大，短打必須縮小部位。');
    }
  }
  if (rsi14 !== null && rsi14 >= 48 && rsi14 <= 68) {
    score += 12;
    reasons.push(`RSI ${rsi14.toFixed(1)} 位於健康偏強區，適合中短線推進。`);
  } else if (rsi14 !== null && rsi14 > 74) {
    score -= 10;
    risks.push(`RSI ${rsi14.toFixed(1)} 過熱，應把操作週期壓得更短。`);
  } else if (rsi14 !== null && rsi14 < 42) {
    score -= 8;
    risks.push(`RSI ${rsi14.toFixed(1)} 偏弱，尚未形成短打優勢。`);
  }
  if (macdNow !== null && macdNow > 0) {
    score += 8;
    reasons.push('MACD 仍在零軸上方，短線動能未失真。');
  }
  if (vol20 && latest.volume > vol20 * 1.2) {
    score += 8;
    reasons.push('量能高於 20 日均量，突破成功率較佳。');
  }
  if (ma20 && latest.close >= ma20 * 0.99 && latest.close <= ma20 * 1.07) {
    score += 10;
    reasons.push('股價距離 20 日線不遠，短打風險報酬比更容易控制。');
  } else if (ma20 && latest.close > ma20 * 1.12) {
    score -= 10;
    risks.push('股價離 20 日線過遠，兩週內容易先拉回再說。');
  }
  if (stock.pe && stock.pe > 0 && stock.pe < 30) {
    score += 4;
    reasons.push(`本益比 ${stock.pe.toFixed(1)}，估值沒有明顯失控。`);
  } else if (stock.pe && stock.pe > 60) {
    score -= 6;
    risks.push(`本益比 ${stock.pe.toFixed(1)} 偏高，短線情緒退潮時會更脆弱。`);
  }

  const patterns = detectPatterns(history, latest, ma5, ma20, ma60);
  score += patterns.score;
  reasons.push(...patterns.bullish);
  risks.push(...patterns.bearish);

  const overnightImpact = includeOvernight ? buildOvernightImpact(stock, overnightContext) : null;
  if (overnightImpact) {
    score += overnightImpact.score;
    reasons.push(...overnightImpact.reasons);
    risks.push(...overnightImpact.risks);
  }

  const sellWarning = buildSellWarning(latest, ma5, ma20, rsi14, ret20, std20, patterns);
  if (overnightImpact && overnightImpact.score <= -6) {
    sellWarning.score += 6;
    sellWarning.level = sellWarning.score >= 24 ? '高'
      : sellWarning.score >= 14 ? '中'
      : sellWarning.score >= 7 ? '低'
      : '無';
    sellWarning.reasons.push('隔夜外盤偏空，隔日開盤續抱與追價都要更保守。');
    if (sellWarning.level === '高') {
      sellWarning.action = '隔夜外盤偏空且個股結構轉弱，應優先降低持股或等開盤反彈先調節。';
    } else if (sellWarning.level === '中') {
      sellWarning.action = '隔夜外盤轉弱，若開盤無法站回 5 日線，應先減碼再觀察。';
    }
  }
  score -= sellWarning.level === '高' ? 10 : sellWarning.level === '中' ? 6 : 0;

  score = clamp(Math.round(score), 0, 100);
  const stop = ma20 ? Math.min(latest.close * 0.95, ma20 * 0.985) : latest.close * 0.95;
  const riskPerShare = Math.max(latest.close - stop, latest.close * 0.025);
  const entryLow = ma5 && ma20 ? Math.max(stop, Math.min(ma5, ma20) * 0.995) : latest.close * 0.99;
  const entryHigh = latest.close * 1.012;
  const targetFast = latest.close + riskPerShare * 1.1;
  const targetFull = latest.close + riskPerShare * 1.7;
  const sizing = buildPositionSizing(latest.close, stop, std20, sellWarning);
  const hardPass = gateTrend && gateVolume && gateHeat && sellWarning.level !== '高';
  const signal = hardPass ? (score >= 74 ? '短線買入' : score >= 60 ? '短線觀察' : '暫不進場') : '暫不進場';

  return {
    score,
    signal,
    latestDate: latest.date,
    latestPrice: round(latest.close),
    change5d: round(ret5),
    change10d: round(ret10),
    change20d: round(ret20),
    change60d: round(ret60),
    metrics: {
      ma5: round(ma5),
      ma20: round(ma20),
      ma60: round(ma60),
      rsi14: round(rsi14, 1),
      macd: round(macdNow),
      volume20d: Math.round(vol20 || 0),
      std20: round(std20, 4),
      std60: round(std60, 4),
      rsv60: round(rsv60, 3),
      intentFactor60: round(intentFactor60, 4),
      patternScore: patterns.score,
      stopPct: sizing.stopPct
    },
    patterns,
    overnight: overnightImpact ? {
      bias: overnightImpact.bias,
      themes: overnightImpact.themes,
      marketComposite: round(overnightImpact.marketComposite, 2),
      techComposite: round(overnightImpact.techComposite, 2),
      soxChange: round(overnightImpact.soxChange, 2),
      dowChange: round(overnightImpact.dowChange, 2)
    } : null,
    sellWarning,
    reasons,
    risks,
    plan: {
      horizon: `以 ${HOLD_DAYS} 個交易日內完成為主，超過兩週仍沒有續攻就先退。`,
      entry: `分批區間 NT$ ${entryLow.toFixed(2)} - ${entryHigh.toFixed(2)}。優先等回測 5 日線/20 日線不破，或帶量突破最近壓力後再進。`,
      takeProfit: `5 個交易日先看 NT$ ${targetFast.toFixed(2)}，10 個交易日完整目標看 NT$ ${targetFull.toFixed(2)}。先到先減碼，不戀戰。`,
      stopLoss: `收盤跌破 NT$ ${stop.toFixed(2)} 就退出；若 2 天內站不回 5 日線，也視為短打失敗。`,
      exitWarning: sellWarning.action,
      positionSizing: sizing.text
    }
  };
}

function backtest(history, stock) {
  const hits = [];
  const start = Math.max(60, history.length - 75);
  let lastHit = -99;
  for (let i = start; i < history.length - 10; i++) {
    if (i - lastHit < 6) continue;
    const sample = history.slice(0, i + 1);
    const analysis = analyzeWindow(sample, stock, null, { includeOvernight: false });
    if (analysis.signal !== '短線買入') continue;
    const entry = history[i].close;
    const close3 = history[Math.min(i + 3, history.length - 1)].close;
    const close10 = history[Math.min(i + HOLD_DAYS, history.length - 1)].close;
    const future = history.slice(i + 1, Math.min(i + HOLD_DAYS + 1, history.length));
    const maxClose = Math.max(...future.map(day => day.close));
    const minClose = Math.min(...future.map(day => day.close));
    hits.push({
      date: history[i].date,
      signalScore: analysis.score,
      entryPrice: round(entry),
      return3d: round(pct(close3, entry)),
      return10d: round(pct(close10, entry)),
      maxGain10d: round(pct(maxClose, entry)),
      maxDrawdown10d: round(pct(minClose, entry))
    });
    lastHit = i;
    if (hits.length >= 3) break;
  }
  return hits;
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let index = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const item = items[index++];
      try {
        results.push(await worker(item));
      } catch (error) {
        warnings.push(`${item.code} ${item.name}: ${error.message}`);
      }
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const [twse, tpex] = await Promise.all([
    fetchTwseUniverse(),
    fetchTpexUniverse().catch(error => {
      warnings.push(`TPEx 上櫃資料取得失敗：${error.message}`);
      return [];
    })
  ]);

  const overnightContext = await fetchOvernightContext().catch(error => {
    warnings.push(`Overnight context fetch failed: ${error.message}`);
    return null;
  });

  const universe = [...twse, ...tpex].sort((a, b) => b.tradeValue - a.tradeValue);
  const pool = [...twse.slice(0, SYMBOLS_PER_MARKET), ...tpex.slice(0, SYMBOLS_PER_MARKET)]
    .sort((a, b) => b.tradeValue - a.tradeValue);

  const analyzed = await mapLimit(pool, CONCURRENCY, async stock => {
    const history = await fetchYahooHistory(stock.yahooSymbol);
    if (history.length < 70) throw new Error('歷史資料不足');
    const analysis = analyzeWindow(history, stock, overnightContext);
    return {
      code: stock.code,
      name: stock.name,
      market: stock.market,
      pe: stock.pe,
      tradeValue: stock.tradeValue,
      ...analysis,
      backtest: backtest(history, stock)
    };
  });

  const recommendations = analyzed
    .filter(item => item.signal !== '暫不進場')
    .sort((a, b) => b.score - a.score || b.tradeValue - a.tradeValue)
    .slice(0, 12);

  const data = {
    asOf: new Date().toISOString(),
    generatedAtTaipei: new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei',
      dateStyle: 'medium',
      timeStyle: 'medium'
    }).format(new Date()),
    source: 'TWSE OpenAPI、TPEx 公開日收盤 API、Yahoo Finance chart API；整合中短期型態選股、兩週內交易規劃與賣出警告邏輯，由 GitHub Actions 定時更新。',
    universeSize: universe.length,
    scanned: pool.length,
    scanStrategy: `以上市成交金額前 ${Math.min(twse.length, SYMBOLS_PER_MARKET)} 檔 + 上櫃成交金額前 ${Math.min(tpex.length, SYMBOLS_PER_MARKET)} 檔，尋找兩週內可操作的中短期型態。`,
    overnightContext,
    marketCoverage: {
      twse: twse.length,
      tpex: tpex.length
    },
    recommendations,
    warnings: warnings.slice(0, 20)
  };

  const fs = await import('node:fs/promises');
  await fs.writeFile(OUTPUT, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(`Generated ${recommendations.length} recommendations from ${pool.length}/${universe.length} symbols.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
