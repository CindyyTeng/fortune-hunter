import fs from 'node:fs/promises';

const QUALITY = new URL('../../data/quality/financial-quality.json', import.meta.url);
const MARKET = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const OUTPUT = new URL('../../data/quality/eps-history-2015.json', import.meta.url);
const REPORT = new URL('../../data/research/eps-history-backfill.json', import.meta.url);
const START_DATE = '2015-01-01';
const CONCURRENCY = 4;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function quarter(date) {
  const [year, month] = date.split('-').map(Number);
  return `${year}Q${Math.ceil(month / 3)}`;
}

function deadline(value) {
  const year = Number(value.slice(0, 4));
  const q = Number(value.at(-1));
  if (q === 1) return `${year}-05-15`;
  if (q === 2) return `${year}-08-14`;
  if (q === 3) return `${year}-11-14`;
  return `${year + 1}-03-31`;
}

function nextTradingDay(dates, date) {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (dates[middle] <= date) low = middle + 1;
    else high = middle;
  }
  return dates[low] || null;
}

async function fetchEps(stock, dates) {
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockFinancialStatements&data_id=${stock.symbol}&start_date=${START_DATE}`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: { 'User-Agent': 'fortune-hunter-eps-research/1.0' }
      });
      const payload = await response.json();
      if (!response.ok || payload.status !== 200) throw new Error(payload.msg || `HTTP ${response.status}`);
      return (payload.data || []).filter(row => String(row.type).toUpperCase() === 'EPS').map(row => {
        const value = quarter(row.date);
        const announcedDate = deadline(value);
        const effectiveDate = nextTradingDay(dates, announcedDate);
        return {
          symbol: stock.symbol,
          name: stock.name,
          market: stock.market,
          quarter: value,
          EPS: Number(row.value),
          announcedDate,
          publishedAt: `${announcedDate}T23:59:59+08:00`,
          effectiveDate,
          source: 'FinMind TaiwanStockFinancialStatements',
          pointInTimeMode: 'conservative_assumption',
          isPointInTimeSafe: Boolean(effectiveDate),
          pointInTimeWarning: '缺少逐筆歷史公布時間，採法定期限收盤後、下一交易日可用。'
        };
      }).filter(row => Number.isFinite(row.EPS) && row.effectiveDate);
    } catch (error) {
      lastError = error;
      await sleep(attempt * 700);
    }
  }
  throw new Error(`${stock.symbol}: ${lastError?.message || '下載失敗'}`);
}

async function mapLimit(items, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try { output[index] = { records: await mapper(items[index]), error: null }; }
      catch (error) { output[index] = { records: [], error: error.message }; }
      await sleep(100);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return output;
}

async function main() {
  const [quality, marketPayload, existing] = await Promise.all([
    fs.readFile(QUALITY, 'utf8').then(JSON.parse),
    fs.readFile(MARKET, 'utf8').then(JSON.parse),
    fs.readFile(OUTPUT, 'utf8').then(JSON.parse).catch(() => ({ records: [] }))
  ]);
  const dates = (marketPayload.benchmark || marketPayload.marketHistory || marketPayload)
    .map(row => row.date).sort();
  const stocks = [...new Map(quality.records.map(row => [row.symbol, {
    symbol: row.symbol,
    name: row.stockName,
    market: row.market
  }])).values()];
  const complete = new Set();
  for (const row of existing.records || []) {
    if (row.quarter <= '2015Q2') complete.add(row.symbol);
  }
  const pending = stocks.filter(row => !complete.has(row.symbol));
  const fetched = await mapLimit(pending, stock => fetchEps(stock, dates));
  const records = [...(existing.records || []), ...fetched.flatMap(row => row.records)];
  const deduped = [...new Map(records.map(row => [`${row.symbol}|${row.quarter}`, row])).values()]
    .sort((left, right) => left.quarter.localeCompare(right.quarter) || left.symbol.localeCompare(right.symbol));
  const report = {
    generatedAt: new Date().toISOString(),
    requestedSymbols: stocks.length,
    cachedSymbols: complete.size,
    fetchedSymbols: pending.length,
    successfulSymbols: fetched.filter(row => row.records.length).length + complete.size,
    failedSymbols: fetched.filter(row => row.error).length,
    failures: fetched.filter(row => row.error).map(row => row.error),
    records: deduped.length,
    symbols: new Set(deduped.map(row => row.symbol)).size,
    quarters: new Set(deduped.map(row => row.quarter)).size,
    earliestQuarter: deduped[0]?.quarter,
    latestQuarter: deduped.at(-1)?.quarter,
    pointInTimeSafeRecords: deduped.filter(row => row.isPointInTimeSafe).length
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify({ generatedAt: report.generatedAt, records: deduped }, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

await main();
