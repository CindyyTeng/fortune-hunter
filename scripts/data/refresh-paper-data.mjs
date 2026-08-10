import fs from 'node:fs/promises';
import { loadOhlcvDataset, saveOhlcvDataset } from '../lib/ohlcv-dataset.mjs';

const MARKET_FILE = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const BACKTEST_FILE = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const START_DATE = process.env.PAPER_DATA_START || '2024-01-01';
const END_DATE = process.env.PAPER_DATA_END || new Date().toISOString().slice(0, 10);
const TIMEOUT_MS = 20_000;

function dateToUnix(date) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}

async function fetchHistory(symbol) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.search = new URLSearchParams({
    period1: String(dateToUnix(START_DATE)),
    period2: String(dateToUnix(END_DATE) + 86_400),
    interval: '1d',
    includePrePost: 'false',
    events: 'div,splits'
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'fortune-hunter-paper-refresh/1.0' }, signal: controller.signal });
    if (!response.ok) throw new Error(`${symbol}: HTTP ${response.status}`);
    const payload = await response.json();
    const result = payload.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    if (!result?.timestamp || !quote) throw new Error(`${symbol}: 找不到歷史資料`);
    return result.timestamp.map((timestamp, index) => ({
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      open: quote.open[index],
      close: quote.close[index]
    })).filter(row => Number.isFinite(row.open) && Number.isFinite(row.close));
  } finally {
    clearTimeout(timer);
  }
}

function mergeByDate(oldRows, freshRows) {
  const rows = [...new Map([...oldRows, ...freshRows]
    .filter(row => /^\d{4}-\d{2}-\d{2}$/.test(String(row?.date)))
    .map(row => [row.date, row])).values()];
  return rows.sort((left, right) => String(left.date).localeCompare(String(right.date)));
}

async function main() {
  const [market, backtest] = await Promise.all([
    fs.readFile(MARKET_FILE, 'utf8').then(JSON.parse),
    fs.readFile(BACKTEST_FILE, 'utf8').then(JSON.parse)
  ]);
  const [benchmark, inverse] = await Promise.all([
    fetchHistory(market.benchmarkSymbol || '0050.TW'),
    fetchHistory(market.inverseSymbol || '00632R.TW')
  ]);
  if (!benchmark.length || !inverse.length) throw new Error('基準資料為空，停止更新。');
  const nextMarket = {
    ...market,
    generatedAt: new Date().toISOString(),
    benchmark: mergeByDate(market.benchmark || [], benchmark),
    inverse: mergeByDate(market.inverse || [], inverse)
  };
  const ohlcv = await loadOhlcvDataset(backtest, {
    refresh: true,
    writeCache: false,
    startDate: START_DATE,
    endDate: END_DATE
  });
  if (ohlcv.failures.length) {
    throw new Error(`個股資料有 ${ohlcv.failures.length} 筆下載失敗，保留原有資料。`);
  }
  await fs.writeFile(MARKET_FILE, `${JSON.stringify(nextMarket, null, 2)}\n`, 'utf8');
  await saveOhlcvDataset(ohlcv);
  console.log(JSON.stringify({
    status: 'OK',
    startDate: START_DATE,
    endDate: END_DATE,
    benchmarkDate: nextMarket.benchmark.at(-1)?.date,
    inverseDate: nextMarket.inverse.at(-1)?.date,
    loadedSymbols: ohlcv.loadedSymbols,
    requestedSymbols: ohlcv.requestedSymbols,
    failures: ohlcv.failures.length,
    warning: ohlcv.sourceUniverseBiasWarning === true
      ? '個股快取仍使用既有回測股票池，存在倖存者偏差。'
      : null
  }, null, 2));
}

main().catch(error => {
  console.error(`紙上資料更新失敗，未完成安全更新：${error.message}`);
  process.exitCode = 1;
});
