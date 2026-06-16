import fs from 'node:fs/promises';

const MARKET = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const RAW_DIR = new URL('../../data/institutional/raw/twse/', import.meta.url);
const AUDIT = new URL('../../data/research/institutional-data-audit.json', import.meta.url);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const compactDate = date => date.replaceAll('-', '');

async function readJson(url, fallback) {
  try {
    return JSON.parse(await fs.readFile(url, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function exists(url) {
  try {
    await fs.access(url);
    return true;
  } catch {
    return false;
  }
}

function targetDates() {
  const years = Number(process.env.INSTITUTIONAL_FETCH_YEARS || 4);
  const maxDays = Number(process.env.INSTITUTIONAL_FETCH_MAX_DAYS || 5);
  return fs.readFile(MARKET, 'utf8')
    .then(JSON.parse)
    .then(data => {
      const end = data.benchmark.at(-1).date;
      const start = new Date(`${end}T00:00:00Z`);
      start.setUTCFullYear(start.getUTCFullYear() - years);
      return data.benchmark
        .map(row => row.date)
        .filter(date => date >= start.toISOString().slice(0, 10) && date <= end)
        .slice(maxDays > 0 ? -maxDays : 0);
    });
}

async function fetchDate(date) {
  const file = new URL(`${compactDate(date)}.json`, RAW_DIR);
  if (await exists(file)) return { date, status: 'cached', rows: null };
  const url = `https://www.twse.com.tw/rwd/zh/fund/T86?date=${compactDate(date)}&selectType=ALL&response=json`;
  const response = await fetch(url, { headers: { 'user-agent': 'fortune-hunter/1.0' } });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  const rows = payload?.data?.length || 0;
  const raw = {
    market: '上市',
    date,
    url,
    fetchedAt: new Date().toISOString(),
    httpStatus: response.status,
    ok: response.ok,
    rows,
    payload
  };
  await fs.writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  await sleep(Number(process.env.INSTITUTIONAL_FETCH_DELAY_MS || 250));
  return { date, status: response.ok && rows ? 'downloaded' : 'no_data', rows };
}

async function writeAudit(results, dates) {
  const audit = await readJson(AUDIT, { generatedAt: new Date().toISOString(), sources: {}, fetchRuns: [] });
  audit.fetchRuns ||= [];
  audit.fetchRuns = audit.fetchRuns.filter(row => row.runId !== 'twse-current-batch');
  audit.fetchRuns.push({
    runId: 'twse-current-batch',
    generatedAt: new Date().toISOString(),
    market: '上市',
    plannedDates: dates.length,
    downloadedDates: results.filter(row => row.status === 'downloaded').length,
    cachedDates: results.filter(row => row.status === 'cached').length,
    noDataDates: results.filter(row => row.status === 'no_data').length,
    failedDates: results.filter(row => row.status === 'failed').length,
    defaultSafetyLimit: Number(process.env.INSTITUTIONAL_FETCH_MAX_DAYS || 5),
    results
  });
  await fs.writeFile(AUDIT, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
}

await fs.mkdir(RAW_DIR, { recursive: true });
const dates = await targetDates();
const results = [];
for (const date of dates) {
  try {
    results.push(await fetchDate(date));
  } catch (error) {
    results.push({ date, status: 'failed', error: error.message });
  }
  await writeAudit(results, dates);
}
console.log(`TWSE planned=${dates.length}, downloaded=${results.filter(row => row.status === 'downloaded').length}, cached=${results.filter(row => row.status === 'cached').length}`);
