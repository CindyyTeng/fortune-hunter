const OUTPUT = new URL('../data/recommendations.json', import.meta.url);
const SYMBOLS_PER_MARKET = Number(process.env.SYMBOLS_PER_MARKET || 180);
const RECOMMENDATION_LIMIT = Number(process.env.RECOMMENDATION_LIMIT || 7);
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const USER_AGENT = 'fortune-hunter/2.1';
const HOLD_DAYS = 10;
const MOMENTUM_LOOKBACK_DAYS = 126;
const MOMENTUM_SKIP_DAYS = 21;
const OVERNIGHT_SYMBOLS = {
  sp500: '^GSPC',
  nasdaq: '^IXIC',
  dow: '^DJI',
  sox: '^SOX'
};
const OVERNIGHT_GROUPS = {
  taiwanSentiment: ['EWT', 'TSM', 'UMC'],
  memory: ['MU', 'WDC', 'STX'],
  passiveComponents: ['VSH', 'APH', 'TEL', 'GLW'],
  aiHardware: ['NVDA', 'AMD', 'AVGO', 'SMCI', 'DELL'],
  powerEquipment: ['ETN', 'PWR', 'GEV', 'VRT', 'HUBB']
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
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&includePrePost=false&events=div%2Csplits`;
  const json = await fetchJson(url);
  const result = json.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error(`無法取得 ${symbol} 歷史資料`);
  const quote = result.indicators?.quote?.[0];
  if (!quote) throw new Error(`無法解析 ${symbol} K 線資料`);
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
  const fetchChange = async symbol => {
    const history = await fetchYahooHistory(symbol);
    return {
      symbol,
      date: history.at(-1)?.date || null,
      close: round(history.at(-1)?.close),
      change: round(latestChange(history))
    };
  };
  const entries = await Promise.all(
    Object.entries(OVERNIGHT_SYMBOLS).map(async ([key, symbol]) => {
      return [key, await fetchChange(symbol)];
    })
  );

  const indices = Object.fromEntries(entries);
  const groupEntries = await Promise.all(
    Object.entries(OVERNIGHT_GROUPS).map(async ([key, symbols]) => {
      const quotes = (await Promise.all(
        symbols.map(symbol => fetchChange(symbol).catch(error => {
          warnings.push(`Overnight ${symbol}: ${error.message}`);
          return null;
        }))
      )).filter(Boolean);
      const changes = quotes.map(item => item.change).filter(Number.isFinite);
      return [key, {
        symbols,
        quotes,
        change: changes.length ? round(mean(changes), 2) : null
      }];
    })
  );
  const groups = Object.fromEntries(groupEntries);
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
  const taiwanComposite = round(
    (groups.taiwanSentiment?.change || 0) * 0.65
      + (indices.sox?.change || 0) * 0.2
      + (indices.nasdaq?.change || 0) * 0.15,
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
    taiwanComposite,
    groups,
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
      bullish.push('W 底（雙底）成形且突破頸線，屬偏多訊號。');
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
      bullish.push('疑似倒頭肩底，右肩完成後接近突破區。');
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
      bullish.push('上升三角形收斂，接近壓力位，留意放量突破。');
      score += 12;
    }
  }

  if (preMove !== null && recentMove !== null
    && preMove > 8
    && recentMove > -6 && recentMove < 4
    && range20 > 0
    && range7 / range20 < 0.55
    && Math.min(...lows.slice(-7)) > ma20 * 0.98) {
    bullish.push('上升旗形整理後延續上攻，屬趨勢中繼。');
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
      bullish.push('下降楔形突破，偏向跌深反彈或趨勢反轉。');
      score += 10;
    }
  }

  if (highPivots.length >= 2) {
    const [leftHigh, rightHigh] = highPivots.slice(-2);
    const neckline = Math.min(...lows.slice(leftHigh.index, rightHigh.index + 1));
    if (rightHigh.index - leftHigh.index >= 4
      && nearRatio(leftHigh.value, rightHigh.value) <= 0.06
      && latest.close < neckline * 0.99) {
      bearish.push('M 頭（雙頂）成形，頸線附近要嚴控風險。');
      score -= 14;
    }
  }

  if (highPivots.length >= 3) {
    const highs3 = highPivots.slice(-3);
    const peakMax = Math.max(...highs3.map(item => item.value));
    const peakMin = Math.min(...highs3.map(item => item.value));
    const neckline = Math.min(...lows.slice(highs3[0].index, highs3[2].index + 1));
    if (peakMin / peakMax >= 0.93 && latest.close < neckline * 0.99) {
      bearish.push('菱形頂震盪後轉弱，常見於高檔反轉。');
      score -= 16;
    }
  }

  if (preMove !== null && recentMove !== null
    && preMove < -8
    && recentMove > -3 && recentMove < 4
    && range20 > 0
    && range7 / range20 < 0.55
    && Math.max(...highs.slice(-7)) < ma20 * 1.03) {
    bearish.push('下跌旗形跌破下緣，屬續跌訊號。');
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
      bearish.push('上升楔形跌破，常見多頭末段轉弱。');
      score -= 10;
    }
  }

  if (range15 < 0.08) watch.push('箱型盤整偏窄，等待方向表態。');

  if (avgHighEarly && avgHighLate && avgLowEarly && avgLowLate
    && avgHighLate < avgHighEarly * 0.99
    && avgLowLate > avgLowEarly * 1.01
    && range20 / latest.close < 0.18) {
    watch.push('三角收斂接近末端，突破前先觀望。');
  }

  if (avgHighEarly && avgHighLate && avgLowEarly && avgLowLate) {
    const earlyWidth = avgHighEarly - avgLowEarly;
    const lateWidth = avgHighLate - avgLowLate;
    if (avgHighLate > avgHighEarly * 1.03
      && avgLowLate > avgLowEarly * 1.03
      && earlyWidth > 0
      && Math.abs(lateWidth - earlyWidth) / earlyWidth < 0.25) {
      watch.push('擴散三角波動放大，先等止穩或明確突破。');
    }
  }

  score = clamp(score, -24, 24);
  const bias = score >= 12 ? '偏多'
    : score <= -12 ? '偏空'
    : watch.length ? '等待'
    : '中性';

  return { score, bias, bullish, bearish, watch: watch.slice(0, 3) };
}

function analyzePriceActionSop(history, latest, ma5, ma10, ma20, vol20) {
  const closes = history.map(day => day.close);
  const highs = history.map(day => day.high);
  const recent = history.slice(-26, -1);
  const reasons = [];
  const risks = [];
  const warnings = [];
  let score = 0;

  const resistance = recent.length ? Math.max(...recent.map(day => day.high)) : null;
  const support = recent.length ? Math.min(...recent.slice(-20).map(day => day.low)) : null;
  const volumeRatio = vol20 ? latest.volume / vol20 : null;
  const strongBull = history.slice(-12, -1).reverse()
    .find(day => day.close > day.open && pct(day.close, day.open) >= 3 && (!vol20 || day.volume > vol20 * 1.1));
  const strongBear = history.slice(-12, -1).reverse()
    .find(day => day.open > day.close && pct(day.open, day.close) >= 3 && (!vol20 || day.volume > vol20 * 1.1));

  if (resistance && latest.close > resistance * 1.005 && latest.low >= resistance * 0.985) {
    score += 8;
    reasons.push('原壓力區被突破後沒有明顯跌回，符合壓力轉支撐觀察。');
  } else if (resistance && latest.high > resistance * 1.005 && latest.close < resistance) {
    score -= 7;
    risks.push('突破近 25 日壓力後收不住，留意假突破或上影線壓力。');
  } else if (resistance && latest.close >= resistance * 0.99 && latest.close <= resistance * 1.005) {
    score -= 5;
    risks.push('收盤貼近近 25 日壓力，上方空間不足，需等有效突破後再追。');
  }

  if (support && latest.close < support * 0.99) {
    score -= 12;
    risks.push('收盤跌破近 20 日支撐區，支撐轉壓力前不急著接。');
    warnings.push('支撐跌破後容易引發停損賣壓，反彈無法站回支撐應先退場。');
  }

  if (strongBull) {
    if (latest.close < strongBull.low * 0.995) {
      score -= 10;
      risks.push('跌破近期長紅低點，多方駐守區失守。');
      warnings.push('長紅低點失守，代表原先買盤防線被破壞。');
    } else if (latest.low <= strongBull.low * 1.02 && latest.close >= strongBull.low) {
      score += 6;
      reasons.push('回測近期長紅低點附近仍守住，短線防守點明確。');
    }
  }

  if (strongBear) {
    if (latest.close > strongBear.open * 1.005) {
      score += 6;
      reasons.push('站上近期長黑高點，空方壓力區被突破。');
    } else if (latest.high >= strongBear.open * 0.99 && latest.close < strongBear.open) {
      score -= 5;
      risks.push('接近近期長黑高點後仍壓回，空方壓力尚未解除。');
    }
  }

  const maDeduct = [
    closes.length > 5 && latest.close > closes.at(-6),
    closes.length > 10 && latest.close > closes.at(-11),
    closes.length > 20 && latest.close > closes.at(-21)
  ].filter(Boolean).length;
  if (maDeduct >= 2) {
    score += 6;
    reasons.push('收盤價高於多條均線扣抵值，有利 5/10/20 日線延續上揚。');
  } else {
    score -= 6;
    risks.push('收盤價未站上多數均線扣抵值，均線續揚力道不足。');
  }

  if (ma5 && ma10 && ma20) {
    const spread = Math.max(ma5, ma10, ma20) / Math.min(ma5, ma10, ma20) - 1;
    if (spread < 0.035 && latest.close > ma5 && latest.close > ma10 && latest.close > ma20 && maDeduct >= 2) {
      score += 8;
      reasons.push('均線糾結後向上發散，屬等待表態後的偏多訊號。');
    } else if (spread < 0.025) {
      risks.push('均線仍糾結，尚未明確表態前不宜重倉。');
    }
  }

  const prevMa5 = closes.length > 5 ? average(closes.slice(0, -1), 5) : null;
  const prevMa20 = closes.length > 20 ? average(closes.slice(0, -1), 20) : null;
  if (ma5 && prevMa5 && ma5 > prevMa5 && latest.low <= ma5 * 1.015 && latest.close >= ma5 && latest.close > latest.open) {
    score += 6;
    reasons.push('拉回上揚 5 日線有撐，符合順勢拉回觀察。');
  }
  if (ma20 && prevMa20 && ma20 >= prevMa20 && latest.low <= ma20 * 1.02 && latest.close >= ma20) {
    score += 5;
    reasons.push('20 日線附近守穩，中短期防守線明確。');
  }

  const ret20 = closes.length > 20 ? pct(latest.close, closes.at(-21)) : null;
  const high10 = highs.length >= 10 ? Math.max(...highs.slice(-10)) : null;
  const pullbackFromHigh = high10 ? pct(latest.close, high10) : null;
  if (ret20 !== null && pullbackFromHigh !== null && ret20 > 8 && pullbackFromHigh > -6) {
    score += 6;
    reasons.push('上漲段推進明確且拉回幅度不深，趨勢角度仍偏健康。');
  } else if (ret20 !== null && ret20 < -8 && ma5 && ma20 && ma5 < ma20) {
    score -= 8;
    risks.push('下跌段較明確且短均線在中均線下方，先避免逆勢摸底。');
  }

  if (volumeRatio !== null) {
    if (volumeRatio >= 1.5 && latest.close >= latest.open) {
      score += 5;
      reasons.push(`量比約 ${volumeRatio.toFixed(1)} 倍且收盤不弱，代表當日資金有表態。`);
    } else if (volumeRatio < 0.75 && latest.close > latest.open) {
      risks.push(`量比約 ${volumeRatio.toFixed(1)} 倍，量能不足時突破容易失真。`);
    }
  }

  const range = latest.high - latest.low;
  const upperWick = latest.high - Math.max(latest.open, latest.close);
  if (range > 0 && ret20 !== null && ret20 > 18 && vol20 && latest.volume > vol20 * 1.8
    && (upperWick / range > 0.35 || latest.close < latest.open)) {
    score -= 9;
    risks.push('高檔放量但留下壓回痕跡，可能接近短線竭盡點。');
    warnings.push('短線竭盡風險升高，若隔日無法續強應先減碼。');
  }

  const lowerWick = Math.min(latest.open, latest.close) - latest.low;
  if (range > 0 && ret20 !== null && ret20 < -10 && volumeRatio !== null && volumeRatio >= 1.5
    && lowerWick / range > 0.4 && latest.close > latest.open) {
    score += 4;
    reasons.push('跌深後放量留下長下影線，可能出現短線止穩力道。');
  }

  return {
    score: clamp(score, -24, 24),
    reasons,
    risks,
    warnings,
    maDeduct,
    volumeRatio: round(volumeRatio, 2),
    support: round(support),
    resistance: round(resistance)
  };
}

function buildSellWarning(latest, ma5, ma20, rsi14, ret5, ret20, std20, patterns, priceAction = null, volumeRatio = null, rsv60 = null) {
  let score = 0;
  const reasons = [];

  if (patterns.bearish.length) {
    score += 14 + Math.min(8, patterns.bearish.length * 3);
    reasons.push(...patterns.bearish);
  }
  if (priceAction?.warnings?.length) {
    score += 8 + Math.min(8, priceAction.warnings.length * 3);
    reasons.push(...priceAction.warnings);
  }
  if (ma5 && latest.close < ma5) {
    score += 7;
    reasons.push('價格跌破 5 日線，短線轉弱。');
  }
  if (ma5 && ma20 && ma5 < ma20 && latest.close <= ma20 * 1.04) {
    score += 7;
    reasons.push('5 日線仍低於 20 日線，較像反彈而非趨勢續攻。');
  }
  if (ma20 && latest.close < ma20) {
    score += 9;
    reasons.push('價格跌破 20 日線，中短期結構轉弱。');
  }
  if (rsi14 !== null && rsi14 < 45) {
    score += 7;
    reasons.push(`RSI ${rsi14.toFixed(1)} 偏弱，買盤強度不足。`);
  }
  if (rsi14 !== null && rsi14 > 74) {
    score += 6;
    reasons.push(`RSI ${rsi14.toFixed(1)} 過熱，追價風險增加。`);
  }
  if (ret5 !== null && ret5 > 6 && ret20 !== null && ret20 <= 0) {
    score += 8;
    reasons.push(`近 5 日反彈 ${ret5.toFixed(1)}%，但 20 日動能仍未轉正，容易是假反彈。`);
  }
  if (ret20 !== null && ret20 > 18) {
    score += 6;
    reasons.push(`近 20 日漲幅 ${ret20.toFixed(1)}% 偏熱，易震盪。`);
  }
  if (volumeRatio !== null && volumeRatio < 0.9 && latest.close >= latest.open) {
    score += 5;
    reasons.push(`反彈量比僅 ${volumeRatio.toFixed(1)} 倍，缺少放量確認。`);
  }
  if (rsv60 !== null && rsv60 > 0.97) {
    score += 7;
    reasons.push(`60 日相對位置 ${rsv60.toFixed(2)} 偏高，靠近短線高位。`);
  }
  if (std20 !== null && std20 > 0.035) {
    score += 4;
    reasons.push('20 日波動偏高，單日回撤風險提高。');
  }
  if (priceAction?.risks?.some(risk => risk.includes('假突破') || risk.includes('壓力'))) {
    score += 6;
    reasons.push('價格行為出現壓力或假突破風險。');
  }

  const level = score >= 24 ? '高'
    : score >= 14 ? '中'
    : score >= 7 ? '低'
    : '無';

  const action = level === '高'
    ? '優先保本：先減碼 50% 以上，跌破關鍵支撐時全面退場。'
    : level === '中'
      ? '控制風險：先減碼到半倉，若 2 天內無法站回 5 日線則續降部位。'
      : level === '低'
        ? '提高警戒：保留核心部位，5-10 天內若量價轉弱就先出一半。'
        : '暫無明確賣出警告，持續依停損與持有週期管理。';

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
    text: `單筆風險建議控制在總資金 ${round(riskBudgetPct, 1)}%，以止損幅度 ${round(stopPct * 100, 1)}% 推估，單檔資金上限約 ${Math.round(capitalPct)}%。`
  };
}

function inferThemes(stock) {
  const name = stock.name || '';
  const code = stock.code || '';
  const themes = [];

  if (/金|銀行|證券|保險/.test(name)) themes.push('finance');
  if (/記憶體|DRAM|快閃|模組|儲存|威剛|創見|群聯|南亞科|華邦電|旺宏|十銓|品安/.test(name)
    || ['2408', '2344', '2337', '3260', '2451', '8299', '4967', '8088'].includes(code)) {
    themes.push('memory');
  }
  if (/被動|電阻|電容|MLCC|國巨|華新科|禾伸堂|凱美|信昌電|鈺邦|蜜望實/.test(name)
    || ['2327', '2492', '3026', '2375', '6173', '6449', '8043'].includes(code)) {
    themes.push('passiveComponents');
  }
  if (/電機|重電|電纜|電線|變壓器|電力|儲能|充電|電源|台達電|中興電|華城|亞力|士電|大同|東元|樂事綠能/.test(name)
    || ['1513', '1519', '1503', '1504', '2308', '2371', '1605', '1609', '1611', '1529'].includes(code)) {
    themes.push('powerEquipment');
  }
  if (/半導體|IC|晶|矽|封測|電子|材料|設備|再生晶圓|萬潤|世禾|信紘科|崇越電|辛耘|帆宣|弘塑|中砂|志聖/.test(name)
    || ['2330', '2303', '2454', '3034', '3711', '2344', '2379', '3443', '6415', '8299', '6187', '3551', '6667', '3388', '3583', '6196', '3131', '1560', '2467'].includes(code)) {
    themes.push('semiconductor');
  }
  if (/伺服器|AI|網通|資料中心|電源|台達電|光寶|廣達|緯創/.test(name)
    || ['2308', '2317', '2382', '3231', '6669', '3017', '2356', '2376', '2357', '2383', '4938'].includes(code)) {
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
  const taiwanMove = overnightContext.taiwanComposite ?? null;
  const soxMove = overnightContext.indices.sox?.change ?? null;
  const dowMove = overnightContext.indices.dow?.change ?? null;
  const groupLabels = {
    semiconductor: '費半/半導體',
    memory: '美股記憶體族群',
    passiveComponents: '美股電子零組件/被動元件代理族群',
    aiHardware: '美股 AI 硬體族群',
    powerEquipment: '美股電力設備族群'
  };

  if (marketMove !== null) {
    if (marketMove <= -2) {
      score -= 12;
      risks.push(`美股大盤偏弱（${marketMove.toFixed(2)}%），隔日開盤承壓機率高。`);
    } else if (marketMove <= -1) {
      score -= 7;
      risks.push(`美股大盤轉弱（${marketMove.toFixed(2)}%），短線風險上升。`);
    } else if (marketMove >= 1.5) {
      score += 6;
      reasons.push(`美股大盤強勢（${marketMove.toFixed(2)}%），有利台股風險偏好。`);
    } else if (marketMove >= 0.8) {
      score += 3;
      reasons.push(`美股大盤偏多（${marketMove.toFixed(2)}%），情緒有支撐。`);
    }
  }

  if (taiwanMove !== null) {
    if (taiwanMove <= -1.5) {
      score -= 7;
      risks.push(`台股 ADR/ETF 夜盤情緒偏弱（${taiwanMove.toFixed(2)}%），隔日台股開盤承壓。`);
    } else if (taiwanMove >= 1.2) {
      score += 4;
      reasons.push(`台股 ADR/ETF 夜盤情緒偏多（${taiwanMove.toFixed(2)}%），有利隔日風險承接。`);
    }
  }

  if (themes.includes('semiconductor') && soxMove !== null) {
    if (soxMove <= -2.5) {
      score -= 10;
      risks.push(`費半重挫（${soxMove.toFixed(2)}%），半導體族群開盤易受壓。`);
    } else if (soxMove <= -1) {
      score -= 6;
      risks.push(`費半轉弱（${soxMove.toFixed(2)}%），半導體短線偏保守。`);
    } else if (soxMove >= 2) {
      score += 6;
      reasons.push(`費半強彈（${soxMove.toFixed(2)}%），半導體族群有助攻。`);
    } else if (soxMove >= 1) {
      score += 3;
      reasons.push(`費半偏多（${soxMove.toFixed(2)}%），半導體動能改善。`);
    }
  }

  if (themes.includes('ai-hardware') && techMove !== null) {
    if (techMove <= -2) {
      score -= 8;
      risks.push(`科技指數走弱（${techMove.toFixed(2)}%），AI/電子族群風險升高。`);
    } else if (techMove <= -1) {
      score -= 5;
      risks.push(`科技指數偏弱（${techMove.toFixed(2)}%），追價勝率下降。`);
    } else if (techMove >= 1.8) {
      score += 5;
      reasons.push(`科技指數轉強（${techMove.toFixed(2)}%），AI/電子族群有利。`);
    }
  }

  if (themes.includes('finance') && dowMove !== null) {
    if (dowMove <= -1.5) {
      score -= 5;
      risks.push(`道瓊下跌（${dowMove.toFixed(2)}%），金融族群可能受壓。`);
    } else if (dowMove >= 1.2) {
      score += 3;
      reasons.push(`道瓊上漲（${dowMove.toFixed(2)}%），金融族群情緒改善。`);
    }
  }

  const groupThemePairs = [
    ['memory', 'memory'],
    ['passiveComponents', 'passiveComponents'],
    ['aiHardware', 'ai-hardware'],
    ['powerEquipment', 'powerEquipment']
  ];
  for (const [groupKey, theme] of groupThemePairs) {
    const groupMove = overnightContext.groups?.[groupKey]?.change;
    if (!themes.includes(theme) || groupMove === null || groupMove === undefined) continue;
    const label = groupLabels[groupKey];
    if (groupMove <= -3) {
      score -= 13;
      risks.push(`${label}大跌（${groupMove.toFixed(2)}%），同族群隔日容易被拖累。`);
    } else if (groupMove <= -1.5) {
      score -= 8;
      risks.push(`${label}轉弱（${groupMove.toFixed(2)}%），隔日追價勝率下降。`);
    } else if (groupMove >= 3) {
      score += 9;
      reasons.push(`${label}強漲（${groupMove.toFixed(2)}%），同族群隔日有利多延伸。`);
    } else if (groupMove >= 1.5) {
      score += 5;
      reasons.push(`${label}偏多（${groupMove.toFixed(2)}%），族群情緒改善。`);
    }
  }

  return {
    score,
    bias: score <= -6 ? 'headwind' : score >= 6 ? 'tailwind' : 'neutral',
    reasons: reasons.slice(0, 5),
    risks: risks.slice(0, 5),
    themes,
    marketComposite: marketMove,
    techComposite: techMove,
    taiwanComposite: taiwanMove,
    groupImpacts: {
      ...(themes.includes('semiconductor') ? { semiconductor: round(soxMove, 2) } : {}),
      ...Object.fromEntries(
        Object.entries(overnightContext.groups || {})
          .filter(([key]) => groupThemePairs.some(([groupKey, theme]) => key === groupKey && themes.includes(theme)))
          .map(([key, value]) => [key, round(value.change, 2)])
      )
    },
    soxChange: soxMove,
    dowChange: dowMove
  };
}

function decideHoldDays(std20, patternScore, overnightScore, sellLevel) {
  if (sellLevel === '高') return 5;
  if (sellLevel === '中') return 7;
  if (std20 !== null && std20 > 0.04) return 5;
  if (std20 !== null && std20 > 0.028) return 7;
  if (overnightScore <= -6) return 5;
  if (overnightScore <= -3) return 7;
  if (patternScore >= 10 && overnightScore >= 0) return 10;
  return 7;
}

function buildHoldPlan(holdDays, latestClose, stop, targetFast, targetFull, ma5, ma20, sellWarning) {
  const midDays = Math.max(3, Math.ceil(holdDays / 2));
  const maHint = ma5
    ? `若 2 天內都站不上 5 日線`
    : `若 2 天內無法維持反彈節奏`;
  const baseExit = holdDays <= 5
    ? `偏短打節奏：若在 ${holdDays} 天內沒有延續上攻，先減碼保留現金。`
    : holdDays <= 7
      ? `標準中短期：觀察到第 ${holdDays} 天，若量價轉弱就分批退場。`
      : `偏順勢持有：最多看 ${holdDays} 天，途中若跌破關鍵均線就提前出場。`;
  const exitWarning = sellWarning.level === '高' || sellWarning.level === '中'
    ? sellWarning.action
    : baseExit;

  return {
    horizon: `建議持有 ${holdDays} 個交易日，若提前達標或轉弱可提早調整。`,
    takeProfit: `${midDays} 天先看 NT$ ${targetFast.toFixed(2)} 可先出一半；${holdDays} 天內續強再看 NT$ ${targetFull.toFixed(2)}，剩餘部位用 5 日線移動停利。`,
    stopLoss: `收盤跌破 NT$ ${stop.toFixed(2)} 或走勢轉弱先退，${maHint}也要主動降部位。`,
    exitWarning
  };
}

function analyzeWindow(history, stock, overnightContext = null, includeOvernight = true) {
  const closes = history.map(day => day.close);
  const volumes = history.map(day => day.volume || 0);
  const returns = closes.slice(1).map((value, idx) => (value - closes[idx]) / closes[idx]);
  const latest = history.at(-1);
  const ma5 = average(closes, 5);
  const ma10 = average(closes, 10);
  const ma20 = average(closes, 20);
  const ma60 = average(closes, 60);
  const rsi14 = rsi(closes, 14);
  const macdNow = macd(closes);
  const vol20 = average(volumes, 20);
  const ret5 = closes.length > 5 ? pct(latest.close, closes.at(-6)) : null;
  const ret10 = closes.length > 10 ? pct(latest.close, closes.at(-11)) : null;
  const ret20 = closes.length > 20 ? pct(latest.close, closes.at(-21)) : null;
  const ret60 = closes.length > 60 ? pct(latest.close, closes.at(-61)) : null;
  const momentumStartIndex = closes.length - MOMENTUM_SKIP_DAYS - MOMENTUM_LOOKBACK_DAYS;
  const momentumEndIndex = closes.length - MOMENTUM_SKIP_DAYS;
  const mom126_21 = momentumStartIndex >= 0 && momentumEndIndex > momentumStartIndex
    ? pct(closes.at(momentumEndIndex - 1), closes.at(momentumStartIndex))
    : null;
  const yearHigh = closes.length >= 120 ? Math.max(...closes) : null;
  const nearYearHigh = yearHigh ? latest.close / yearHigh : null;
  const pullback20 = closes.length > 20 ? Math.max(...closes.slice(-20)) : null;
  const drawdown20 = pullback20 ? ((latest.close - pullback20) / pullback20) * 100 : null;
  const returnAbs60 = returns.length >= 60 ? returns.slice(-60).reduce((sum, value) => sum + Math.abs(value), 0) : null;
  const intentFactor60 = returnAbs60 && ret60 !== null ? (ret60 / 100) / returnAbs60 : null;
  const std20 = returns.length >= 20 ? stddev(returns.slice(-20)) : null;
  const std60 = returns.length >= 60 ? stddev(returns.slice(-60)) : null;
  const min60 = closes.length >= 60 ? Math.min(...closes.slice(-60)) : null;
  const max60 = closes.length >= 60 ? Math.max(...closes.slice(-60)) : null;
  const rsv60 = min60 !== null && max60 !== null && max60 !== min60 ? (latest.close - min60) / (max60 - min60) : null;
  const volumeRatio = vol20 ? latest.volume / vol20 : null;

  const gateTrend = ma20 && ma60 && latest.close > ma20 && ma20 > ma60;
  const gateLiquidity = latest.volume > 100000;
  const gatePriceAboveMa5 = ma5 && latest.close >= ma5;
  const gateShortTrend = ma5 && ma20 && ma5 >= ma20;
  const gateVolumeConfirm = volumeRatio === null || volumeRatio >= 0.9;
  const gateMomentum = ret20 === null || ret20 > 0 || (ret10 !== null && ret10 >= 6);
  const gateHeat = ret20 === null || ret20 < 18;

  let score = 0;
  const reasons = [];
  const risks = [];

  if (gateTrend) {
    score += 16;
    reasons.push('價格位於 20 日線上方，且 20 日線高於 60 日線，趨勢偏多。');
  } else {
    score -= 14;
    risks.push('價格仍在 20 日線下方或均線走平，趨勢延續性較弱。');
  }
  if (ma5 && ma20 && latest.close >= ma5 && ma5 >= ma20) {
    score += 10;
    reasons.push('價格與 5 日線、20 日線維持多方排列，短中期動能一致。');
  } else if (ma5 && latest.close < ma5) {
    score -= 8;
    risks.push('價格跌破 5 日線，短線節奏可能轉弱。');
  } else if (ma5 && ma20 && ma5 < ma20 && latest.close > ma20) {
    score -= 10;
    risks.push('5 日線仍低於 20 日線，這比較像短線反彈，不是完整多方排列。');
  }
  if (gateLiquidity) {
    score += 3;
    reasons.push('流動性足夠，進出場較不容易卡住。');
  } else {
    score -= 10;
    risks.push('流動性不足，突破的延續性與進出場品質可能受限。');
  }
  if (volumeRatio !== null && volumeRatio < 0.9 && latest.close >= latest.open) {
    score -= 8;
    risks.push(`量比 ${volumeRatio.toFixed(2)} 未放大，上漲缺少成交量確認。`);
  }
  if (!gateHeat) {
    score -= 14;
    risks.push(`近 20 日漲幅 ${ret20.toFixed(1)}% 偏熱，短線震盪風險升高。`);
  } else if (ret20 !== null && ret20 <= 0 && ret5 !== null && ret5 > 5) {
    score -= 12;
    risks.push(`近 5 日反彈 ${ret5.toFixed(1)}%，但 20 日動能 ${ret20.toFixed(1)}% 尚未轉正，容易追到反彈尾端。`);
  } else if (ret10 !== null && ret10 > 0 && ret10 < 12) {
    score += 8;
    reasons.push(`近 10 日漲幅 ${ret10.toFixed(1)}%，動能穩定且不過熱。`);
  }
  if (intentFactor60 !== null) {
    if (intentFactor60 > 0.28) {
      score += 8;
      reasons.push(`價格意圖因子 ${intentFactor60.toFixed(3)} 偏高，趨勢推進力道充足。`);
    } else if (intentFactor60 < 0.08) {
      score -= 8;
      risks.push(`價格意圖因子 ${intentFactor60.toFixed(3)} 偏低，可能是盤整末端。`);
    }
  }
  if (rsv60 !== null) {
    if (rsv60 >= 0.72 && rsv60 <= 0.96) {
      score += 8;
      reasons.push(`60 日相對位置 ${rsv60.toFixed(2)}，接近強勢區但仍有空間。`);
    } else if (rsv60 > 0.98) {
      score -= 6;
      risks.push(`60 日相對位置 ${rsv60.toFixed(2)} 過高，留意拉回風險。`);
    }
  }
  if (std20 !== null && std60 !== null) {
    if (std20 < std60 * 0.95) {
      score += 8;
      reasons.push('短期波動低於中期波動，結構較穩定。');
    } else if (std20 > std60 * 1.15) {
      score -= 6;
      risks.push('短期波動擴大，需降低部位避免情緒盤。');
    }
  }
  if (rsi14 !== null && rsi14 >= 48 && rsi14 <= 68) {
    score += 12;
    reasons.push(`RSI ${rsi14.toFixed(1)} 位於健康強勢區。`);
  } else if (rsi14 !== null && rsi14 > 74) {
    score -= 10;
    risks.push(`RSI ${rsi14.toFixed(1)} 偏高，留意高檔震盪。`);
  } else if (rsi14 !== null && rsi14 < 42) {
    score -= 8;
    risks.push(`RSI ${rsi14.toFixed(1)} 偏弱，反彈延續性待確認。`);
  }
  if (macdNow !== null && macdNow > 0) {
    score += 8;
    reasons.push('MACD 在零軸上方，動能結構偏多。');
  }
  if (vol20 && latest.volume > vol20 * 1.2) {
    score += 8;
    reasons.push('成交量高於 20 日均量，突破可信度提升。');
  }
  if (ma20 && latest.close >= ma20 * 0.99 && latest.close <= ma20 * 1.07) {
    score += 10;
    reasons.push('價格貼近 20 日線上方，適合順勢回測布局。');
  } else if (ma20 && latest.close > ma20 * 1.12) {
    score -= 10;
    risks.push('乖離 20 日線過大，短線易出現均值回歸。');
  }
  if (stock.pe && stock.pe > 0 && stock.pe < 30) {
    score += 4;
    reasons.push(`本益比 ${stock.pe.toFixed(1)} 在可接受區間。`);
  } else if (stock.pe && stock.pe > 60) {
    score -= 6;
    risks.push(`本益比 ${stock.pe.toFixed(1)} 偏高，評價修正風險較大。`);
  }

  const patterns = detectPatterns(history, latest, ma5, ma20, ma60);
  score += patterns.score;
  reasons.push(...patterns.bullish);
  risks.push(...patterns.bearish);

  const priceAction = analyzePriceActionSop(history, latest, ma5, ma10, ma20, vol20);
  score += priceAction.score;
  reasons.push(...priceAction.reasons);
  risks.push(...priceAction.risks);
  const resistanceRoomPct = priceAction.resistance ? pct(priceAction.resistance, latest.close) : null;
  const gateUpsideRoom = resistanceRoomPct === null
    || resistanceRoomPct >= 4
    || latest.close > priceAction.resistance * 1.01;
  if (resistanceRoomPct !== null && resistanceRoomPct >= 0 && resistanceRoomPct < 4) {
    score -= 8;
    risks.push(`距離近 25 日壓力只剩 ${resistanceRoomPct.toFixed(1)}%，追價風險報酬不佳。`);
  }

  const overnightImpact = includeOvernight ? buildOvernightImpact(stock, overnightContext) : null;
  if (overnightImpact) {
    score += overnightImpact.score;
    reasons.push(...overnightImpact.reasons);
    risks.push(...overnightImpact.risks);
  }
  if (mom126_21 !== null) {
    if (mom126_21 > 18 && mom126_21 < 85) {
      score += 9;
      reasons.push(`動能(126-21) ${mom126_21.toFixed(1)}%，位於可延續區間。`);
    } else if (mom126_21 <= 0) {
      score -= 9;
      risks.push(`動能(126-21) ${mom126_21.toFixed(1)}%，中期趨勢偏弱。`);
    } else if (mom126_21 >= 100) {
      score -= 5;
      risks.push(`動能(126-21) ${mom126_21.toFixed(1)}% 過熱，留意回檔。`);
    }
  }
  if (nearYearHigh !== null) {
    if (nearYearHigh >= 0.88 && nearYearHigh <= 0.98) {
      score += 6;
      reasons.push(`接近年高 ${(nearYearHigh * 100).toFixed(1)}%，強勢結構完整。`);
    } else if (nearYearHigh < 0.72) {
      score -= 6;
      risks.push(`距離年高 ${(nearYearHigh * 100).toFixed(1)}%，仍在修復區。`);
    }
  }
  if (drawdown20 !== null && drawdown20 <= -9) {
    score -= 7;
    risks.push(`近 20 日回檔 ${drawdown20.toFixed(1)}%，波動風險提高。`);
  }

  const sellWarning = buildSellWarning(latest, ma5, ma20, rsi14, ret5, ret20, std20, patterns, priceAction, volumeRatio, rsv60);
  if (overnightImpact && overnightImpact.score <= -6) {
    sellWarning.score += 6;
    sellWarning.level = sellWarning.score >= 24 ? '高'
      : sellWarning.score >= 14 ? '中'
      : sellWarning.score >= 7 ? '低'
      : '無';
    sellWarning.reasons.push('隔夜風險轉弱，若反彈無量，隔日續跌機率提高。');
    if (sellWarning.level === '高') {
      sellWarning.action = '隔夜風險偏空，建議先降至防守部位，開盤轉弱就續減碼。';
    } else if (sellWarning.level === '中') {
      sellWarning.action = '隔夜風險偏弱，先降槓桿，2 天內無法站回 5 日線則續減碼。';
    }
  }
  score -= sellWarning.level === '高' ? 10 : sellWarning.level === '中' ? 6 : 0;

  const stop = ma20 ? Math.min(latest.close * 0.95, ma20 * 0.985) : latest.close * 0.95;
  const riskPerShare = Math.max(latest.close - stop, latest.close * 0.025);
  const entryLow = ma5 && ma20 ? Math.max(stop, Math.min(ma5, ma20) * 0.995) : latest.close * 0.99;
  const entryHigh = latest.close * 1.012;
  const resistanceTarget = priceAction.resistance && priceAction.resistance > latest.close
    ? priceAction.resistance * 0.995
    : null;
  const targetFast = resistanceTarget
    ? Math.min(latest.close + riskPerShare * 1.1, resistanceTarget)
    : latest.close + riskPerShare * 1.1;
  const targetFull = resistanceTarget
    ? Math.min(latest.close + riskPerShare * 1.7, resistanceTarget)
    : latest.close + riskPerShare * 1.7;
  const rewardRisk = riskPerShare ? (targetFull - latest.close) / riskPerShare : null;
  if (rewardRisk !== null && rewardRisk >= 1.5) {
    score += 4;
    reasons.push(`預估風險報酬比約 ${rewardRisk.toFixed(1)}，符合先規劃停損再進場。`);
  } else {
    score -= 6;
    risks.push('預估風險報酬比不足，需等更靠近支撐才有操作價值。');
  }
  score = clamp(Math.round(score), 0, 100);
  const riskCap = sellWarning.level === '中' ? 88
    : sellWarning.level === '低' ? 92
      : risks.length >= 2 ? 94
        : 100;
  score = Math.min(score, riskCap);
  const sizing = buildPositionSizing(latest.close, stop, std20, sellWarning);
  const holdDays = decideHoldDays(std20, patterns.score, overnightImpact?.score ?? 0, sellWarning.level);
  const holdPlan = buildHoldPlan(
    holdDays,
    latest.close,
    stop,
    targetFast,
    targetFull,
    ma5,
    ma20,
    sellWarning
  );
  const hardPass = gateTrend
    && gateLiquidity
    && gatePriceAboveMa5
    && gateShortTrend
    && gateVolumeConfirm
    && gateMomentum
    && gateUpsideRoom
    && gateHeat
    && (rewardRisk === null || rewardRisk >= 1.1)
    && (rsi14 === null || rsi14 >= 45)
    && sellWarning.level !== '高';
  if (!hardPass) score = Math.min(score, 72);
  const signal = hardPass
    ? (score >= 74 && sellWarning.level === '無' ? '買入候選' : score >= 60 ? '偏多觀察' : '等待進場')
    : '等待進場';

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
      ma10: round(ma10),
      ma20: round(ma20),
      ma60: round(ma60),
      rsi14: round(rsi14, 1),
      macd: round(macdNow),
      volume20d: Math.round(vol20 || 0),
      std20: round(std20, 4),
      std60: round(std60, 4),
      rsv60: round(rsv60, 3),
      intentFactor60: round(intentFactor60, 4),
      momentum126_21: round(mom126_21, 2),
      nearYearHigh: round(nearYearHigh, 3),
      drawdown20: round(drawdown20, 2),
      priceActionScore: priceAction.score,
      maDeduct: priceAction.maDeduct,
      volumeRatio: priceAction.volumeRatio,
      support: priceAction.support,
      resistance: priceAction.resistance,
      rewardRisk: round(rewardRisk, 2),
      resistanceRoomPct: round(resistanceRoomPct, 2),
      patternScore: patterns.score,
      stopPct: sizing.stopPct
    },
    patterns,
    overnight: overnightImpact ? {
      bias: overnightImpact.bias,
      themes: overnightImpact.themes,
      marketComposite: round(overnightImpact.marketComposite, 2),
      techComposite: round(overnightImpact.techComposite, 2),
      taiwanComposite: round(overnightImpact.taiwanComposite, 2),
      groupImpacts: overnightImpact.groupImpacts,
      soxChange: round(overnightImpact.soxChange, 2),
      dowChange: round(overnightImpact.dowChange, 2)
    } : null,
    sellWarning,
    reasons,
    risks,
    plan: {
      horizon: holdPlan.horizon,
      entry: `分批區間 NT$ ${entryLow.toFixed(2)} - ${entryHigh.toFixed(2)}。優先等回測 5 日線/20 日線或支撐區不破，或帶量突破近壓 ${priceAction.resistance ? `NT$ ${priceAction.resistance}` : '區間高點'} 後再進；若已拉開 1:1 風險報酬，再等回測 5 日線守穩才加碼。`,
      takeProfit: holdPlan.takeProfit,
      stopLoss: holdPlan.stopLoss,
      exitWarning: holdPlan.exitWarning,
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
    const analysis = analyzeWindow(sample, stock, null, false);
    if (analysis.signal !== '買入候選') continue;
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

function applyBacktestDiscipline(analysis, hits) {
  if (!hits.length) return analysis;
  const weakHits = hits.filter(hit => hit.return3d <= -5 || hit.return10d <= -6 || hit.maxDrawdown10d <= -10);
  const failedSetup = hits.find(hit => hit.return10d <= -6 && hit.maxGain10d <= 1);
  if (!weakHits.length && !failedSetup) return analysis;

  const penalty = failedSetup ? 20 : Math.min(12, weakHits.length * 6);
  analysis.score = clamp(analysis.score - penalty, 0, 100);
  analysis.risks.push(
    failedSetup
      ? `近期相似高分訊號在 ${failedSetup.date} 失效：10 日 ${failedSetup.return10d}%、最大漲幅 ${failedSetup.maxGain10d}%、最大回撤 ${failedSetup.maxDrawdown10d}%，本次先降級觀察。`
      : `近期相似訊號有 ${weakHits.length} 次回撤偏大，需降低追價期待。`
  );

  if (analysis.sellWarning.level === '無') analysis.sellWarning.level = '低';
  analysis.sellWarning.score += failedSetup ? 8 : 4;
  analysis.sellWarning.reasons.push('近期回測顯示相似高分訊號曾快速失效，需提高賣出警戒。');
  analysis.sellWarning.action = failedSetup
    ? '近期相似訊號失效，除非重新站回壓力並放量，否則先觀察不追價。'
    : analysis.sellWarning.action;
  analysis.plan.exitWarning = analysis.sellWarning.action;

  if (failedSetup) {
    analysis.signal = '等待進場';
  } else if (analysis.signal === '買入候選') {
    analysis.signal = '偏多觀察';
  }
  return analysis;
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
      warnings.push(`TPEx 上櫃資料讀取失敗：${error.message}`);
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
    const hits = backtest(history, stock);
    applyBacktestDiscipline(analysis, hits);
    return {
      code: stock.code,
      name: stock.name,
      market: stock.market,
      pe: stock.pe,
      tradeValue: stock.tradeValue,
      ...analysis,
      backtest: hits
    };
  });

  const recommendations = analyzed
    .filter(item => item.signal !== '等待進場')
    .sort((a, b) => b.score - a.score || b.tradeValue - a.tradeValue)
    .slice(0, RECOMMENDATION_LIMIT);

  const data = {
    asOf: new Date().toISOString(),
    generatedAtTaipei: new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei',
      dateStyle: 'medium',
      timeStyle: 'medium'
    }).format(new Date()),
    source: 'TWSE OpenAPI、TPEX API、Yahoo Finance chart API（夜盤風險因子）',
    universeSize: universe.length,
    scanned: pool.length,
    scanStrategy: `上市成交值前 ${Math.min(twse.length, SYMBOLS_PER_MARKET)} 檔 + 上櫃成交值前 ${Math.min(tpex.length, SYMBOLS_PER_MARKET)} 檔，套用趨勢/型態/價格行為/隔夜風險後取前 ${RECOMMENDATION_LIMIT} 檔。`,
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

