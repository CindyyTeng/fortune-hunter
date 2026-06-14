import fs from 'node:fs/promises';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const CACHE = new URL('../../.cache/regime-ohlcv-10y.json.gz', import.meta.url);
const USER_AGENT = 'fortune-hunter-regime-research/1.0';

async function exists(url) {
  try {
    await fs.access(url);
    return true;
  } catch {
    return false;
  }
}

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function fetchHistory(stock, startDate, endDate) {
  const suffix = String(stock.market).includes('上櫃') ? 'TWO' : 'TW';
  const symbol = `${stock.symbol}.${suffix}`;
  const period1 = Math.floor(Date.parse(`${startDate}T00:00:00Z`) / 1000);
  const period2 = Math.floor(Date.parse(`${endDate}T00:00:00Z`) / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d&includePrePost=false&events=div%2Csplits`;
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(`${symbol}: HTTP ${response.status}`);
  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!result?.timestamp || !quote) throw new Error(`${symbol}: invalid history`);
  return result.timestamp.map((timestamp, index) => ({
    date: new Date(timestamp * 1000).toISOString().slice(0, 10),
    open: quote.open[index],
    high: quote.high[index],
    low: quote.low[index],
    close: quote.close[index],
    volume: quote.volume[index]
  })).filter(day => [day.open, day.high, day.low, day.close, day.volume].every(Number.isFinite));
}

function stockUniverse(backtest) {
  const stocks = new Map();
  for (const row of backtest.candidateTrades || []) {
    if (!stocks.has(row.symbol)) {
      stocks.set(row.symbol, {
        symbol: row.symbol,
        name: row.name,
        market: row.market,
        themes: Array.isArray(row.themes)
          ? row.themes
          : String(row.themes || '').split(',').map(value => value.trim()).filter(Boolean)
      });
    }
  }
  return [...stocks.values()];
}

export async function loadOhlcvDataset(backtest, options = {}) {
  if (await exists(CACHE) && options.refresh !== true) {
    const compressed = await fs.readFile(CACHE);
    return JSON.parse((await gunzipAsync(compressed)).toString('utf8'));
  }
  const stocks = stockUniverse(backtest);
  const startDate = options.startDate || '2015-06-01';
  const endDate = options.endDate || new Date().toISOString().slice(0, 10);
  const failures = [];
  const rows = await mapLimit(stocks, Number(process.env.REGIME_FETCH_CONCURRENCY || 12), async stock => {
    try {
      const history = await fetchHistory(stock, startDate, endDate);
      return history.length >= 220 ? { stock, history } : null;
    } catch (error) {
      failures.push(error.message);
      return null;
    }
  });
  const dataset = {
    generatedAt: new Date().toISOString(),
    source: 'Yahoo Finance chart API',
    universeSource: 'unique symbols present in tw-backtest-10y candidate history',
    sourceUniverseBiasWarning: true,
    requestedSymbols: stocks.length,
    loadedSymbols: rows.filter(Boolean).length,
    failures,
    stocks: rows.filter(Boolean)
  };
  await fs.mkdir(new URL('../../.cache/', import.meta.url), { recursive: true });
  await fs.writeFile(CACHE, await gzipAsync(JSON.stringify(dataset)));
  return dataset;
}
