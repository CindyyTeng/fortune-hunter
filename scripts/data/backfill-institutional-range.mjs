import fs from 'node:fs/promises';
import {
  RAW_TPEX,
  RAW_TWSE,
  compactDate,
  exists,
  fetchJson,
  readJson,
  rocCompactDate,
  tradingDates,
  writeJson
} from './institutional-history-utils.mjs';

const REPORT = new URL('../../data/research/institutional-backfill-report.json', import.meta.url);
const DOC = new URL('../../docs/INSTITUTIONAL_BACKFILL_RESULT.md', import.meta.url);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function rocSlashDate(date) {
  const compact = rocCompactDate(date);
  return `${compact.slice(0, 3)}/${compact.slice(3, 5)}/${compact.slice(5, 7)}`;
}

function twseUrl(date) {
  return `https://www.twse.com.tw/rwd/zh/fund/T86?date=${compactDate(date)}&selectType=ALL&response=json`;
}

function tpexDailyUrl(date) {
  return `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?date=${rocSlashDate(date)}&type=Daily&response=json`;
}

function tpexLegacyUrl(date) {
  return `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&se=EW&t=D&d=${rocSlashDate(date)}&s=0,asc,0`;
}

function rowCount(source, json) {
  if (source === 'twse') return json?.data?.length || 0;
  if (Array.isArray(json)) return json.length;
  if (Array.isArray(json?.tables?.[0]?.data)) return json.tables[0].data.length;
  if (Array.isArray(json?.aaData)) return json.aaData.length;
  if (Array.isArray(json?.data)) return json.data.length;
  return 0;
}

async function fetchWithRetry(url, retries) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    last = await fetchJson(url, Number(process.env.INSTITUTIONAL_BACKFILL_TIMEOUT_MS || 15_000));
    if (last.ok && last.json) return { ...last, attempt };
    await sleep(Number(process.env.INSTITUTIONAL_BACKFILL_RETRY_DELAY_MS || 1_000));
  }
  return { ...last, attempt: retries };
}

async function fetchTwse(date, retries) {
  await fs.mkdir(RAW_TWSE, { recursive: true });
  const file = new URL(`${compactDate(date)}.json`, RAW_TWSE);
  if (await exists(file)) return { date, market: 'TWSE', status: 'cached', rows: null };
  const url = twseUrl(date);
  const result = await fetchWithRetry(url, retries);
  const rows = rowCount('twse', result.json);
  if (result.ok) {
    await writeJson(file, { market: '上市', source: 'TWSE T86', date, url, fetchedAt: new Date().toISOString(), httpStatus: result.status, ok: result.ok, rows, payload: result.json });
  }
  return { date, market: 'TWSE', status: result.ok && rows ? 'downloaded' : 'no_data', rows, error: result.error || null };
}

async function fetchTpex(date, retries) {
  await fs.mkdir(RAW_TPEX, { recursive: true });
  const file = new URL(`dailytrade-${compactDate(date)}.json`, RAW_TPEX);
  if (await exists(file)) return { date, market: 'TPEX', status: 'cached', rows: null, endpoint: 'dailyTrade' };

  for (const endpoint of [
    { name: 'dailyTrade', url: tpexDailyUrl(date) },
    { name: 'legacy3itrade', url: tpexLegacyUrl(date) }
  ]) {
    const result = await fetchWithRetry(endpoint.url, retries);
    const rows = rowCount('tpex', result.json);
    if (result.ok && rows) {
      await writeJson(file, { market: '上櫃', source: `TPEx ${endpoint.name}`, date, url: endpoint.url, fetchedAt: new Date().toISOString(), httpStatus: result.status, ok: result.ok, rows, payload: result.json });
      return { date, market: 'TPEX', status: 'downloaded', rows, endpoint: endpoint.name };
    }
  }
  return { date, market: 'TPEX', status: 'no_data', rows: 0, endpoint: 'dailyTrade/legacy3itrade' };
}

export async function runInstitutionalBackfill({ mode, months = null, years = null }) {
  const allDates = await tradingDates();
  const end = allDates.at(-1);
  const start = new Date(`${end}T00:00:00Z`);
  if (months) start.setUTCMonth(start.getUTCMonth() - months);
  if (years) start.setUTCFullYear(start.getUTCFullYear() - years);
  const dates = allDates.filter(date => date >= start.toISOString().slice(0, 10) && date <= end);
  const delay = Number(process.env.INSTITUTIONAL_BACKFILL_DELAY_MS || 250);
  const retries = Number(process.env.INSTITUTIONAL_BACKFILL_RETRIES || 2);
  const results = [];

  for (const date of dates) {
    try {
      results.push(await fetchTwse(date, retries));
      await sleep(delay);
      results.push(await fetchTpex(date, retries));
      await sleep(delay);
    } catch (error) {
      results.push({ date, market: 'UNKNOWN', status: 'failed', error: error.message });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode,
    requestedDates: dates.length,
    rateLimitDelayMs: delay,
    retries,
    twse: {
      successDays: new Set(results.filter(row => row.market === 'TWSE' && ['downloaded', 'cached'].includes(row.status)).map(row => row.date)).size,
      downloadedRows: results.filter(row => row.market === 'TWSE' && row.status === 'downloaded').reduce((sum, row) => sum + (row.rows || 0), 0),
      downloadedDays: results.filter(row => row.market === 'TWSE' && row.status === 'downloaded').length,
      cachedDays: results.filter(row => row.market === 'TWSE' && row.status === 'cached').length
    },
    tpex: {
      successDays: new Set(results.filter(row => row.market === 'TPEX' && ['downloaded', 'cached'].includes(row.status)).map(row => row.date)).size,
      downloadedRows: results.filter(row => row.market === 'TPEX' && row.status === 'downloaded').reduce((sum, row) => sum + (row.rows || 0), 0),
      downloadedDays: results.filter(row => row.market === 'TPEX' && row.status === 'downloaded').length,
      cachedDays: results.filter(row => row.market === 'TPEX' && row.status === 'cached').length
    },
    failures: results.filter(row => ['failed', 'no_data'].includes(row.status)),
    results,
    smokePassed: mode === 'smoke'
      ? results.filter(row => row.market === 'TWSE' && ['downloaded', 'cached'].includes(row.status)).length > 0
        && results.filter(row => row.market === 'TPEX' && ['downloaded', 'cached'].includes(row.status)).length > 0
      : null
  };

  await writeJson(REPORT, report);
  await fs.writeFile(DOC, `# 法人歷史回填結果

產生時間：${report.generatedAt}

- 模式：${mode}
- 嘗試交易日：${report.requestedDates}
- TWSE 成功天數：${report.twse.successDays}
- TWSE 新下載筆數：${report.twse.downloadedRows}
- TPEx 成功天數：${report.tpex.successDays}
- TPEx 新下載筆數：${report.tpex.downloadedRows}
- 失敗筆數：${report.failures.length}
- Smoke 是否通過：${report.smokePassed === null ? '不適用' : report.smokePassed ? '是' : '否'}
`, 'utf8');

  await import('./build-institutional-dataset.mjs');
  return report;
}
