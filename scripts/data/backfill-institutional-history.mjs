import {
  RAW_TWSE,
  compactDate,
  exists,
  fetchJson,
  readJson,
  tradingDates,
  writeJson
} from './institutional-history-utils.mjs';

const PROBE = new URL('../../data/research/institutional-history-probe.json', import.meta.url);
const OUTPUT = new URL('../../data/research/institutional-history-probe.json', import.meta.url);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function twseUrl(date) {
  return `https://www.twse.com.tw/rwd/zh/fund/T86?date=${compactDate(date)}&selectType=ALL&response=json`;
}

async function backfillTwse(dates) {
  await fs.mkdir(RAW_TWSE, { recursive: true });
  const results = [];
  for (const date of dates) {
    const file = new URL(`${compactDate(date)}.json`, RAW_TWSE);
    if (await exists(file)) {
      results.push({ date, market: 'TWSE', status: 'cached', rows: null });
      continue;
    }
    const url = twseUrl(date);
    const result = await fetchJson(url, Number(process.env.INSTITUTIONAL_BACKFILL_TIMEOUT_MS || 15_000));
    const rows = result.json?.data?.length || 0;
    await writeJson(file, {
      market: '上市',
      date,
      url,
      fetchedAt: new Date().toISOString(),
      httpStatus: result.status || null,
      ok: result.ok,
      rows,
      payload: result.json
    });
    results.push({ date, market: 'TWSE', status: result.ok && rows ? 'downloaded' : 'no_data', rows, error: result.error || null });
    await sleep(Number(process.env.INSTITUTIONAL_BACKFILL_DELAY_MS || 250));
  }
  return results;
}

const fs = await import('node:fs/promises');
const probe = await readJson(PROBE, { sources: {} });
const allDates = await tradingDates();
const end = allDates.at(-1);
const startDate = new Date(`${end}T00:00:00Z`);
startDate.setUTCFullYear(startDate.getUTCFullYear() - Number(process.env.INSTITUTIONAL_BACKFILL_YEARS || 4));
const candidateDates = allDates.filter(date => date >= startDate.toISOString().slice(0, 10) && date <= end);
const maxDays = Number(process.env.INSTITUTIONAL_BACKFILL_MAX_DAYS || 20);
const dates = maxDays > 0 ? candidateDates.slice(-maxDays) : candidateDates;
const twseCanBackfill = probe.sources?.twseT86?.supportsHistory !== false;
const tpexCanBackfill = probe.sources?.tpexOpenApi?.supportsHistory === true;
const twseResults = twseCanBackfill ? await backfillTwse(dates) : [];

const backfill = {
  generatedAt: new Date().toISOString(),
  requestedYears: Number(process.env.INSTITUTIONAL_BACKFILL_YEARS || 4),
  safetyMaxDays: maxDays,
  candidateTradingDates: candidateDates.length,
  attemptedTradingDates: dates.length,
  twse: {
    enabled: twseCanBackfill,
    downloaded: twseResults.filter(row => row.status === 'downloaded').length,
    cached: twseResults.filter(row => row.status === 'cached').length,
    noData: twseResults.filter(row => row.status === 'no_data').length,
    failed: twseResults.filter(row => row.status === 'failed').length,
    results: twseResults
  },
  tpex: {
    enabled: false,
    reason: tpexCanBackfill ? '尚未接上 TPEx 歷史回填器' : 'TPEx OpenAPI 目前未確認支援歷史日期參數'
  },
  fourYearBackfillCompleted: maxDays === 0 && twseCanBackfill && tpexCanBackfill,
  manualImportFallbackRequired: !(twseCanBackfill && tpexCanBackfill),
  conclusion: maxDays === 0 && twseCanBackfill && tpexCanBackfill
    ? '已嘗試完整 4 年法人歷史回填'
    : '官方來源無法穩定回填 4 年法人歷史資料，或本次因安全上限未執行完整回填'
};

await writeJson(OUTPUT, { ...probe, backfill });

// 回填 raw 後立即重建 processed 並套用既有保守 point-in-time policy。
await import('./build-institutional-dataset.mjs');
await import('./apply-institutional-point-in-time-policy.mjs');

console.log(`backfill: attempted=${dates.length}, twseDownloaded=${backfill.twse.downloaded}, cached=${backfill.twse.cached}`);
console.log(backfill.conclusion);
