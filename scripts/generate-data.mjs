const OUTPUT = new URL('../data/recommendations.json', import.meta.url);
const SYMBOLS_PER_MARKET = Number(process.env.SYMBOLS_PER_MARKET || 120);
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const USER_AGENT = 'fortune-hunter/1.0';

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
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'user-agent': USER_AGENT
    }
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
  const q = result.indicators?.quote?.[0];
  if (!q) throw new Error(`沒有 ${symbol} K線欄位`);
  return result.timestamp.map((timestamp, index) => ({
    date: new Date(timestamp * 1000).toISOString().slice(0, 10),
    open: q.open[index],
    high: q.high[index],
    low: q.low[index],
    close: q.close[index],
    volume: q.volume[index]
  })).filter(day => [day.open, day.high, day.low, day.close].every(Number.isFinite));
}

function average(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

function stddev(values) {
  if (!values.length) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
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

function analyzeWindow(history, stock) {
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
  const ret20 = closes.length > 20 ? pct(latest.close, closes.at(-21)) : null;
  const ret60 = closes.length > 60 ? pct(latest.close, closes.at(-61)) : null;
  const returnAbs60 = returns.length >= 60 ? returns.slice(-60).reduce((sum, value) => sum + Math.abs(value), 0) : null;
  const intentFactor60 = returnAbs60 && ret60 !== null ? (ret60 / 100) / returnAbs60 : null;
  const std20 = returns.length >= 20 ? stddev(returns.slice(-20)) : null;
  const std60 = returns.length >= 60 ? stddev(returns.slice(-60)) : null;
  const min60 = closes.length >= 60 ? Math.min(...closes.slice(-60)) : null;
  const max60 = closes.length >= 60 ? Math.max(...closes.slice(-60)) : null;
  const rsv60 = min60 !== null && max60 !== null && max60 !== min60 ? (latest.close - min60) / (max60 - min60) : null;

  const gateTrend = ma60 && latest.close > ma60;
  const gateVolume = latest.volume > 100000;
  const gateOverheat = ret60 === null || ret60 < 20;

  let score = 0;
  const reasons = [];
  const risks = [];

  if (gateTrend) {
    score += 8;
    reasons.push('股價位於60日線上方，符合中期多頭趨勢。');
  } else {
    score -= 12;
    risks.push('股價跌回60日線下方，趨勢保護不足。');
  }
  if (gateVolume) {
    score += 6;
    reasons.push('日成交量高於10萬股，具備基本流動性。');
  } else {
    score -= 10;
    risks.push('成交量偏低，進出場滑價風險較高。');
  }
  if (gateOverheat) {
    score += 4;
  } else {
    score -= 12;
    risks.push(`近60日漲幅 ${ret60.toFixed(1)}% 偏大，容易追高。`);
  }
  if (intentFactor60 !== null) {
    if (intentFactor60 > 0.42) {
      score += 15;
      reasons.push(`價格意圖因子 ${intentFactor60.toFixed(3)} 偏高，走勢較接近穩定推升。`);
    } else if (intentFactor60 > 0.28) {
      score += 8;
      reasons.push(`價格意圖因子 ${intentFactor60.toFixed(3)} 中性偏強。`);
    } else {
      score -= 10;
      risks.push(`價格意圖因子 ${intentFactor60.toFixed(3)} 偏低，價格路徑較震盪。`);
    }
  }
  if (rsv60 !== null) {
    if (rsv60 > 0.9) {
      score += 12;
      reasons.push(`60日相對位置 ${rsv60.toFixed(2)}，屬於高動能區。`);
    } else if (rsv60 < 0.35) {
      score -= 8;
      risks.push(`60日相對位置 ${rsv60.toFixed(2)} 偏低，動能不足。`);
    }
  }
  if (std20 !== null && std60 !== null) {
    if (std20 < std60 * 0.9) {
      score += 8;
      reasons.push('短期波動低於長期波動，價格結構較穩。');
    } else if (std20 > std60 * 1.2) {
      score -= 8;
      risks.push('短期波動明顯放大，回撤風險升高。');
    }
  }

  if (ma20 && ma60 && latest.close > ma20 && ma20 > ma60) {
    score += 24;
    reasons.push('價格站上20日線，且20日線高於60日線，代表中短期趨勢偏多。');
  }
  if (ma5 && ma20 && ma5 > ma20) {
    score += 12;
    reasons.push('5日均線高於20日均線，短線買盤仍有延續性。');
  }
  if (rsi14 !== null && rsi14 >= 45 && rsi14 <= 68) {
    score += 16;
    reasons.push(`RSI ${rsi14.toFixed(1)} 位於健康偏強區，尚未明顯過熱。`);
  } else if (rsi14 !== null && rsi14 < 35) {
    score += 6;
    risks.push(`RSI ${rsi14.toFixed(1)} 偏弱，若要進場需等待止跌訊號。`);
  } else if (rsi14 !== null && rsi14 > 75) {
    score -= 14;
    risks.push(`RSI ${rsi14.toFixed(1)} 過熱，追高風險偏大。`);
  }
  if (macdNow !== null && macdNow > 0) {
    score += 12;
    reasons.push('MACD 為正，動能仍站在多方。');
  }
  if (vol20 && latest.volume > vol20 * 1.25) {
    score += 12;
    reasons.push('成交量高於20日均量，資金關注度提升。');
  }
  if (ma20 && latest.close >= ma20 * 0.98 && latest.close <= ma20 * 1.08) {
    score += 10;
    reasons.push('股價離20日線不遠，較容易用月線規劃風險報酬。');
  } else if (ma20 && latest.close > ma20 * 1.15) {
    score -= 10;
    risks.push('股價離20日線過遠，短線容易拉回整理。');
  }
  if (ret60 !== null && ret60 > 0 && ret60 < 45) {
    score += 8;
    reasons.push(`近三個月漲幅 ${ret60.toFixed(1)}%，趨勢向上但未到極端噴出。`);
  }
  if (ret20 !== null && ret20 > 25) {
    score -= 10;
    risks.push(`近20日已漲 ${ret20.toFixed(1)}%，短線過度延伸。`);
  }
  if (stock.pe && stock.pe > 0 && stock.pe < 30) {
    score += 6;
    reasons.push(`本益比 ${stock.pe.toFixed(1)}，估值尚未明顯失控。`);
  } else if (stock.pe && stock.pe > 60) {
    score -= 8;
    risks.push(`本益比 ${stock.pe.toFixed(1)} 偏高，基本面安全邊際較低。`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const hardPass = gateTrend && gateVolume && gateOverheat;
  const signal = hardPass ? (score >= 72 ? '買入候選' : score >= 58 ? '觀察候選' : '暫不進場') : '暫不進場';
  const stop = ma20 ? Math.min(latest.close * 0.92, ma20 * 0.97) : latest.close * 0.92;
  const riskPerShare = Math.max(latest.close - stop, latest.close * 0.03);
  const entryLow = ma20 ? Math.max(stop, ma20 * 0.99) : latest.close * 0.985;
  const entryHigh = latest.close * 1.015;
  const target1 = latest.close + riskPerShare * 1.8;
  const target2 = latest.close + riskPerShare * 2.8;

  return {
    score,
    signal,
    latestDate: latest.date,
    latestPrice: round(latest.close),
    change20d: round(ret20),
    change60d: round(ret60),
    metrics: {
      ma5: round(ma5), ma20: round(ma20), ma60: round(ma60),
      rsi14: round(rsi14, 1),
      macd: round(macdNow),
      volume20d: Math.round(vol20 || 0),
      std20: round(std20, 4),
      std60: round(std60, 4),
      rsv60: round(rsv60, 3),
      intentFactor60: round(intentFactor60, 4)
    },
    reasons,
    risks,
    plan: {
      entry: `分批區間 NT$ ${entryLow.toFixed(2)} - ${entryHigh.toFixed(2)}。優先等拉回不破20日線，或放量突破近期高點後少量試單。`,
      takeProfit: `第一段 NT$ ${target1.toFixed(2)} 先減碼，第二段 NT$ ${target2.toFixed(2)} 視量價續抱。`,
      stopLoss: `收盤跌破 NT$ ${stop.toFixed(2)}，或放量跌破20日線且隔日無法收復，應退出。`,
      positionSizing: '單筆風險建議控制在總資金 1% - 2%，不要因分數高就重倉。'
    }
  };
}

function backtest(history, stock) {
  const hits = [];
  const start = Math.max(60, history.length - 75);
  let lastHit = -99;
  for (let i = start; i < history.length - 5; i++) {
    if (i - lastHit < 7) continue;
    const sample = history.slice(0, i + 1);
    const analysis = analyzeWindow(sample, stock);
    if (analysis.score < 68) continue;
    const entry = history[i].close;
    const close5 = history[Math.min(i + 5, history.length - 1)].close;
    const close20 = history[Math.min(i + 20, history.length - 1)].close;
    const future = history.slice(i + 1, Math.min(i + 21, history.length));
    const maxClose = Math.max(...future.map(day => day.close));
    const minClose = Math.min(...future.map(day => day.close));
    hits.push({
      date: history[i].date,
      signalScore: analysis.score,
      entryPrice: round(entry),
      return5d: round(pct(close5, entry)),
      return20d: round(pct(close20, entry)),
      maxGain20d: round(pct(maxClose, entry)),
      maxDrawdown20d: round(pct(minClose, entry))
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
  const universe = [...twse, ...tpex].sort((a, b) => b.tradeValue - a.tradeValue);
  const pool = [
    ...twse.slice(0, SYMBOLS_PER_MARKET),
    ...tpex.slice(0, SYMBOLS_PER_MARKET)
  ].sort((a, b) => b.tradeValue - a.tradeValue);
  const analyzed = await mapLimit(pool, CONCURRENCY, async stock => {
    const history = await fetchYahooHistory(stock.yahooSymbol);
    if (history.length < 70) throw new Error('歷史資料不足');
    const analysis = analyzeWindow(history, stock);
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
      timeZone: 'Asia/Taipei', dateStyle: 'medium', timeStyle: 'medium'
    }).format(new Date()),
    source: 'TWSE OpenAPI、TPEx 公開日收盤 API、Yahoo Finance chart API；整合價格意圖因子與60日動能/波動框架，GitHub Actions 定時更新。',
    universeSize: universe.length,
    scanned: pool.length,
    scanStrategy: `上市成交金額前 ${Math.min(twse.length, SYMBOLS_PER_MARKET)} 檔 + 上櫃成交金額前 ${Math.min(tpex.length, SYMBOLS_PER_MARKET)} 檔`,
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
