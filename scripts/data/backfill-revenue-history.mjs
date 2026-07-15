import fs from 'node:fs/promises';

const RAW = new URL('../../data/revenue/raw/', import.meta.url);
const REPORT = new URL('../../data/research/revenue-history-backfill.json', import.meta.url);
const START_DATE = process.env.REVENUE_HISTORY_START_DATE || '2015-01-01';
const CONCURRENCY = Number(process.env.REVENUE_HISTORY_CONCURRENCY || 3);
let quotaExhausted = false;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fetchRows(symbol, endDate) {
  if (quotaExhausted) throw new Error('HTTP 402：公開介面本輪額度已用完，保留快取等待下次續跑');
  const query = new URL('https://api.finmindtrade.com/api/v4/data');
  query.searchParams.set('dataset', 'TaiwanStockMonthRevenue');
  query.searchParams.set('data_id', symbol);
  query.searchParams.set('start_date', START_DATE);
  query.searchParams.set('end_date', endDate);
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(query, {
        signal: AbortSignal.timeout(45_000),
        headers: { 'User-Agent': 'fortune-hunter-revenue-history/1.0' }
      });
      if (response.status === 402) {
        quotaExhausted = true;
        throw new Error('HTTP 402：公開介面本輪額度已用完');
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.status !== 200) throw new Error(payload.msg || `API status ${payload.status}`);
      return payload.data || [];
    } catch (error) {
      lastError = error;
      if (quotaExhausted) break;
      await sleep(attempt * 1_500);
    }
  }
  throw lastError;
}

async function mapLimit(items, mapper) {
  let cursor = 0;
  const output = new Array(items.length);
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return output;
}

function rowKey(row) {
  return `${row.date || ''}|${row.revenue_year || ''}|${row.revenue_month || ''}`;
}

await fs.mkdir(RAW, { recursive: true });
const files = (await fs.readdir(RAW)).filter(name => /^\d{4}\.json$/.test(name)).sort();
const results = await mapLimit(files, async file => {
  const symbol = file.slice(0, 4);
  const url = new URL(file, RAW);
  try {
    const current = JSON.parse(await fs.readFile(url, 'utf8'));
    const firstDate = current.map(row => row.date).filter(Boolean).sort()[0];
    if (firstDate && firstDate <= START_DATE) {
      return { symbol, status: 'cached', added: 0, total: current.length, firstDate };
    }
    const endDate = firstDate || '2021-01-01';
    const historical = await fetchRows(symbol, endDate);
    const merged = new Map([...historical, ...current].map(row => [rowKey(row), row]));
    const rows = [...merged.values()].sort((left, right) => rowKey(left).localeCompare(rowKey(right)));
    await fs.writeFile(url, `${JSON.stringify(rows)}\n`, 'utf8');
    await sleep(150);
    return {
      symbol,
      status: 'updated',
      added: rows.length - current.length,
      total: rows.length,
      firstDate: rows[0]?.date || null
    };
  } catch (error) {
    return { symbol, status: 'failed', added: 0, error: error.message };
  }
});

const report = {
  generatedAt: new Date().toISOString(),
  source: 'FinMind TaiwanStockMonthRevenue 公開介面',
  requestedStartDate: START_DATE,
  files: files.length,
  updatedSymbols: results.filter(row => row.status === 'updated').length,
  cachedSymbols: results.filter(row => row.status === 'cached').length,
  failedSymbols: results.filter(row => row.status === 'failed').length,
  addedRows: results.reduce((sum, row) => sum + row.added, 0),
  earliestDate: results.map(row => row.firstDate).filter(Boolean).sort()[0] || null,
  pointInTimeNote: '原始資料沒有逐筆歷史公告時間；建置資料集時仍採次月申報期限後下一交易日才可使用的保守假設。',
  failures: results.filter(row => row.status === 'failed')
};
await fs.mkdir(new URL('../../data/research/', import.meta.url), { recursive: true });
await fs.writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
