import fs from 'node:fs/promises';
import {
  RAW_ROOT,
  compactDate,
  exists,
  fetchJsonWithRetry,
  marketUrl,
  parseMarket,
  readGzipJson,
  weekdays,
  writeGzipJson
} from './official-market-history-utils.mjs';

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.split('=')[1];
const start = arg('start') || '2011-01-01';
const end = arg('end') || new Date().toISOString().slice(0, 10);
const smoke = process.argv.includes('--smoke');
const delayMs = Number(process.env.MARKET_HISTORY_DELAY_MS || 250);
const concurrency = Number(process.env.MARKET_HISTORY_CONCURRENCY || 4);
const dates = smoke
  ? ['2011-01-03', '2016-06-13', '2020-03-19', end]
  : weekdays(start, end);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];

async function processDate(date) {
  for (const market of ['TWSE', 'TPEX']) {
    const folder = new URL(`${market.toLowerCase()}/`, RAW_ROOT);
    const file = new URL(`${compactDate(date)}.json.gz`, folder);
    if (await exists(file)) {
      const cached = await readGzipJson(file);
      if (market === 'TPEX' || cached.sourceDate === compactDate(date)) {
        results.push({ date, market, status: 'cached' });
        continue;
      }
    }
    try {
      let rows = [];
      let sourceDate = null;
      for (let attempt = 0; attempt < 3 && !rows.length; attempt += 1) {
        const payload = await fetchJsonWithRetry(marketUrl(market, date));
        sourceDate = String(payload.date || '').replaceAll('/', '');
        rows = sourceDate === compactDate(date) ? parseMarket(market, payload, date) : [];
        if (!rows.length && attempt < 2) await sleep(1_500 * (attempt + 1));
      }
      if (!rows.length) {
        results.push({ date, market, status: 'no_data' });
      } else {
        await fs.mkdir(folder, { recursive: true });
        await writeGzipJson(file, {
          date,
          sourceDate,
          market,
          fetchedAt: new Date().toISOString(),
          rows
        });
        results.push({ date, market, status: 'downloaded', rows: rows.length });
      }
    } catch (error) {
      results.push({ date, market, status: 'failed', error: error.message });
    }
    await sleep(delayMs);
  }
}

const queue = [...new Set(dates)];
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  while (cursor < queue.length) {
    const index = cursor;
    cursor += 1;
    await processDate(queue[index]);
  }
}));

const summary = {
  requestedDates: dates.length,
  concurrency,
  downloadedDays: results.filter(row => row.status === 'downloaded').length,
  cachedDays: results.filter(row => row.status === 'cached').length,
  noDataDays: results.filter(row => row.status === 'no_data').length,
  failedDays: results.filter(row => row.status === 'failed').length,
  downloadedRows: results.reduce((sum, row) => sum + (row.rows || 0), 0)
};
console.log(JSON.stringify({ summary, failures: results.filter(row => row.status === 'failed') }, null, 2));
