import fs from 'node:fs/promises';

const RAW_DIR = new URL('../../data/institutional/raw/tpex/', import.meta.url);
const AUDIT = new URL('../../data/research/institutional-data-audit.json', import.meta.url);

async function readJson(url, fallback) {
  try {
    return JSON.parse(await fs.readFile(url, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function main() {
  await fs.mkdir(RAW_DIR, { recursive: true });
  const url = 'https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading';
  const response = await fetch(url, { headers: { 'user-agent': 'fortune-hunter/1.0' } });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  const rows = Array.isArray(payload) ? payload.length : 0;
  const firstDate = rows ? String(payload[0].Date || payload[0].date || '') : 'unknown';
  const fileDate = firstDate.replaceAll('/', '').replaceAll('-', '') || 'latest';
  const raw = {
    market: '上櫃',
    date: firstDate,
    url,
    fetchedAt: new Date().toISOString(),
    httpStatus: response.status,
    ok: response.ok,
    rows,
    payload,
    historicalBackfillStatus: 'OpenAPI 未確認日期參數，本腳本目前只能保存最新可取得資料'
  };
  await fs.writeFile(new URL(`${fileDate}.json`, RAW_DIR), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  const audit = await readJson(AUDIT, { generatedAt: new Date().toISOString(), sources: {}, fetchRuns: [] });
  audit.fetchRuns ||= [];
  audit.fetchRuns.push({
    generatedAt: new Date().toISOString(),
    market: '上櫃',
    plannedDates: 1,
    downloadedDates: rows ? 1 : 0,
    cachedDates: 0,
    noDataDates: rows ? 0 : 1,
    failedDates: response.ok ? 0 : 1,
    historicalBackfillStatus: raw.historicalBackfillStatus,
    rows
  });
  await fs.writeFile(AUDIT, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
  console.log(`TPEX downloaded=${rows ? 1 : 0}, rows=${rows}`);
  console.log(raw.historicalBackfillStatus);
}

await main();
