import fs from 'node:fs/promises';

const RAW_TWSE = new URL('../../data/institutional/raw/twse/', import.meta.url);
const RAW_TPEX = new URL('../../data/institutional/raw/tpex/', import.meta.url);
const MARKET = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const OUTPUT = new URL('../../data/institutional/institutional-trades.json', import.meta.url);
const AUDIT = new URL('../../data/research/institutional-data-audit.json', import.meta.url);

const number = value => Number(String(value ?? '').replaceAll(',', '').trim() || 0);
const isoFromCompact = text => `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
const rocDate = text => /^\d{7}$/.test(String(text))
  ? `${Number(String(text).slice(0, 3)) + 1911}-${String(text).slice(3, 5)}-${String(text).slice(5, 7)}`
  : String(text || '').replaceAll('/', '-');

async function readJson(url, fallback) {
  try {
    return JSON.parse(await fs.readFile(url, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function rawFiles(dir) {
  try {
    return (await fs.readdir(dir)).filter(name => name.endsWith('.json')).map(name => new URL(name, dir));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function nextTradeDateMap() {
  const market = await readJson(MARKET, { benchmark: [] });
  const dates = market.benchmark.map(row => row.date);
  return new Map(dates.slice(0, -1).map((date, index) => [date, dates[index + 1]]));
}

function pointInTime(date, source, fetchedAt) {
  const assume = process.env.INSTITUTIONAL_ASSUME_PUBLISHED_AT === '1';
  return {
    publishedAt: assume ? `${date}T18:00:00+08:00` : fetchedAt,
    isPointInTimeSafe: assume,
    notes: assume
      ? `${source}；publishedAt 採收盤後 18:00 推定規則，仍需日後以官方或留存檔案佐證`
      : `${source}；官方原始資料未提供逐筆 publishedAt，歷史回填預設不可進入 point-in-time 回測`
  };
}

function twseRecords(raw, nextMap) {
  const date = raw.date || isoFromCompact(raw.url.match(/date=(\d{8})/)?.[1] || '');
  const effectiveDate = nextMap.get(date) || '';
  const { publishedAt, isPointInTimeSafe, notes } = pointInTime(date, 'TWSE T86', raw.fetchedAt);
  return (raw.payload?.data || []).map(row => ({
    date,
    symbol: String(row[0] || '').trim(),
    name: String(row[1] || '').trim(),
    foreignBuy: number(row[2]),
    foreignSell: number(row[3]),
    foreignNetBuy: number(row[4]),
    trustBuy: number(row[8]),
    trustSell: number(row[9]),
    trustNetBuy: number(row[10]),
    dealerBuy: number(row[12]) + number(row[15]),
    dealerSell: number(row[13]) + number(row[16]),
    dealerNetBuy: number(row[11]),
    source: 'TWSE T86',
    publishedAt,
    effectiveDate,
    updatedAt: raw.fetchedAt,
    isPointInTimeSafe: isPointInTimeSafe && Boolean(effectiveDate),
    notes
  })).filter(row => row.symbol && row.name);
}

function tpexRecords(raw, nextMap) {
  const rows = Array.isArray(raw.payload) ? raw.payload : [];
  return rows.map(row => {
    const date = rocDate(row.Date || raw.date || '');
    const effectiveDate = nextMap.get(date) || '';
    const { publishedAt, isPointInTimeSafe, notes } = pointInTime(date, 'TPEx OpenAPI', raw.fetchedAt);
    return {
      date,
      symbol: String(row.SecuritiesCompanyCode || '').trim(),
      name: String(row.CompanyName || '').trim(),
      foreignBuy: number(row['Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Total Buy']),
      foreignSell: number(row[' Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Total Sell']),
      foreignNetBuy: number(row['Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Difference']),
      trustBuy: number(row['SecuritiesInvestmentTrustCompanies-TotalBuy']),
      trustSell: number(row['SecuritiesInvestmentTrustCompanies-TotalSell']),
      trustNetBuy: number(row['SecuritiesInvestmentTrustCompanies-Difference']),
      dealerBuy: number(row['Dealers-TotalBuy']),
      dealerSell: number(row['Dealers-TotalSell']),
      dealerNetBuy: number(row['Dealers-Difference']),
      source: 'TPEx OpenAPI',
      publishedAt,
      effectiveDate,
      updatedAt: raw.fetchedAt,
      isPointInTimeSafe: isPointInTimeSafe && Boolean(effectiveDate),
      notes
    };
  }).filter(row => row.symbol && row.name);
}

const nextMap = await nextTradeDateMap();
const records = [];
const rawSummary = { twseFiles: 0, tpexFiles: 0, twseRecords: 0, tpexRecords: 0 };
for (const file of await rawFiles(RAW_TWSE)) {
  const raw = await readJson(file, null);
  if (!raw) continue;
  rawSummary.twseFiles += 1;
  const rows = twseRecords(raw, nextMap);
  rawSummary.twseRecords += rows.length;
  records.push(...rows);
}
for (const file of await rawFiles(RAW_TPEX)) {
  const raw = await readJson(file, null);
  if (!raw) continue;
  rawSummary.tpexFiles += 1;
  const rows = tpexRecords(raw, nextMap);
  rawSummary.tpexRecords += rows.length;
  records.push(...rows);
}
records.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
await fs.writeFile(OUTPUT, `${JSON.stringify({
  version: '1.0.0',
  sourceStatus: process.env.INSTITUTIONAL_ASSUME_PUBLISHED_AT === '1' ? '待確認' : '需人工匯入',
  generatedAt: new Date().toISOString(),
  records
}, null, 2)}\n`, 'utf8');

const audit = await readJson(AUDIT, { generatedAt: new Date().toISOString(), sources: {}, fetchRuns: [] });
audit.build = {
  generatedAt: new Date().toISOString(),
  ...rawSummary,
  outputRecords: records.length,
  pointInTimeSafeRecords: records.filter(row => row.isPointInTimeSafe).length,
  assumePublishedAtRule: process.env.INSTITUTIONAL_ASSUME_PUBLISHED_AT === '1'
};
await fs.writeFile(AUDIT, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
console.log(`institutional records=${records.length}, safe=${audit.build.pointInTimeSafeRecords}`);
console.log(`raw twse=${rawSummary.twseFiles} files, tpex=${rawSummary.tpexFiles} files`);
