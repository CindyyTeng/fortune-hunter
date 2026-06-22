import fs from 'node:fs/promises';

const RAW_TWSE = new URL('../../data/institutional/raw/twse/', import.meta.url);
const RAW_TPEX = new URL('../../data/institutional/raw/tpex/', import.meta.url);
const MARKET = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const OUTPUT = new URL('../../data/institutional/institutional-trades.json', import.meta.url);
const AUDIT = new URL('../../data/research/institutional-data-audit.json', import.meta.url);

const number = value => Number(String(value ?? '').replaceAll(',', '').replace(/[()]/g, '').trim() || 0);
const includeSymbol = symbol => {
  const code = String(symbol || '').trim();
  return process.env.INSTITUTIONAL_INCLUDE_NON_STOCKS === '1' || (/^\d{4}$/.test(code) && !code.startsWith('00'));
};
const hasInstitutionalActivity = row => [
  row.foreignBuy,
  row.foreignSell,
  row.foreignNetBuy,
  row.trustBuy,
  row.trustSell,
  row.trustNetBuy,
  row.dealerBuy,
  row.dealerSell,
  row.dealerNetBuy
].some(value => Number(value) !== 0);
const includeFlowRow = row => {
  if (process.env.INSTITUTIONAL_KEEP_ALL_FLOWS === '1') return hasInstitutionalActivity(row);
  return [row.trustBuy, row.trustSell, row.trustNetBuy].some(value => Number(value) !== 0);
};
const isoFromCompact = text => `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
const nextWeekday = date => {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day));
  do {
    next.setUTCDate(next.getUTCDate() + 1);
  } while ([0, 6].includes(next.getUTCDay()));
  return next.toISOString().slice(0, 10);
};
const rocDate = text => {
  const clean = String(text || '').replaceAll('/', '').replaceAll('-', '');
  return /^\d{7}$/.test(clean)
    ? `${Number(clean.slice(0, 3)) + 1911}-${clean.slice(3, 5)}-${clean.slice(5, 7)}`
    : String(text || '').replaceAll('/', '-');
};

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
  const dates = market.benchmark.map(row => row.date).filter(Boolean);
  return new Map(dates.slice(0, -1).map((date, index) => [date, dates[index + 1]]));
}

function pointInTime(date, source, fetchedAt) {
  return {
    publishedAt: `${date}T18:00:00+08:00`,
    isPointInTimeSafe: true,
    notes: 'PIT'
  };
}

function twseRecords(raw, nextMap) {
  const date = raw.date || isoFromCompact(raw.url.match(/date=(\d{8})/)?.[1] || '');
  const effectiveDate = nextMap.get(date) || nextWeekday(date);
  const { publishedAt, isPointInTimeSafe, notes } = pointInTime(date, 'TWSE T86', raw.fetchedAt);
  return (raw.payload?.data || []).map(row => ({
    date,
    market: 'TWSE',
    symbol: String(row[0] || '').trim(),
    name: String(row[1] || '').trim(),
    foreignBuy: number(row[2]),
    foreignSell: number(row[3]),
    foreignNetBuy: number(row[4]),
    trustBuy: number(row[8]),
    trustSell: number(row[9]),
    trustNetBuy: number(row[10]),
    dealerNetBuy: number(row[11]),
    dealerBuy: number(row[12]) + number(row[15]),
    dealerSell: number(row[13]) + number(row[16]),
    source: 'TWSE',
    publishedAt,
    effectiveDate,
    updatedAt: raw.fetchedAt,
    isPointInTimeSafe: isPointInTimeSafe && Boolean(effectiveDate),
    notes
  })).filter(row => row.symbol && row.name && includeSymbol(row.symbol) && includeFlowRow(row));
}

function tableRows(raw) {
  const payload = raw.payload;
  if (Array.isArray(payload)) return { rows: payload, fields: [] };
  if (Array.isArray(payload?.tables?.[0]?.data)) {
    return { rows: payload.tables[0].data, fields: payload.tables[0].fields || payload.tables[0].headers || [] };
  }
  if (Array.isArray(payload?.aaData)) return { rows: payload.aaData, fields: payload.fields || payload.columns || [] };
  if (Array.isArray(payload?.data)) return { rows: payload.data, fields: payload.fields || [] };
  return { rows: [], fields: [] };
}

function valueOf(row, fields, candidates) {
  if (!Array.isArray(row)) {
    for (const key of candidates) {
      if (row[key] !== undefined) return row[key];
      const matched = Object.keys(row).find(name => name.replace(/\s+/g, '').includes(key.replace(/\s+/g, '')));
      if (matched) return row[matched];
    }
    return '';
  }
  const index = fields.findIndex(field => candidates.some(key => String(field).replace(/\s+/g, '').includes(key.replace(/\s+/g, ''))));
  return index >= 0 ? row[index] : '';
}

function tpexRecords(raw, nextMap) {
  const { rows, fields } = tableRows(raw);
  return rows.map(row => {
    const date = rocDate(valueOf(row, fields, ['Date', '日期']) || raw.date || '');
    const effectiveDate = nextMap.get(date) || nextWeekday(date);
    const { publishedAt, isPointInTimeSafe, notes } = pointInTime(date, raw.source || 'TPEx', raw.fetchedAt);
    const groupedPage = Array.isArray(row) && fields.filter(field => field === '買進股數').length > 1;
    const record = {
      date,
      market: 'TPEX',
      symbol: String(valueOf(row, fields, ['SecuritiesCompanyCode', '證券代號', '代號']) || '').trim(),
      name: String(valueOf(row, fields, ['CompanyName', '證券名稱', '名稱']) || '').trim(),
      foreignBuy: groupedPage ? number(row[8]) : number(valueOf(row, fields, ['Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Total Buy', '外資及陸資買進', '外資買進'])),
      foreignSell: groupedPage ? number(row[9]) : number(valueOf(row, fields, ['Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Total Sell', '外資及陸資賣出', '外資賣出'])),
      foreignNetBuy: groupedPage ? number(row[10]) : number(valueOf(row, fields, ['Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Difference', '外資及陸資買賣超', '外資買賣超'])),
      trustBuy: groupedPage ? number(row[11]) : number(valueOf(row, fields, ['SecuritiesInvestmentTrustCompanies-TotalBuy', '投信買進'])),
      trustSell: groupedPage ? number(row[12]) : number(valueOf(row, fields, ['SecuritiesInvestmentTrustCompanies-TotalSell', '投信賣出'])),
      trustNetBuy: groupedPage ? number(row[13]) : number(valueOf(row, fields, ['SecuritiesInvestmentTrustCompanies-Difference', '投信買賣超'])),
      dealerBuy: groupedPage ? number(row[20]) : number(valueOf(row, fields, ['Dealers-TotalBuy', '自營商買進'])),
      dealerSell: groupedPage ? number(row[21]) : number(valueOf(row, fields, ['Dealers-TotalSell', '自營商賣出'])),
      dealerNetBuy: groupedPage ? number(row[22]) : number(valueOf(row, fields, ['Dealers-Difference', '自營商買賣超'])),
      source: 'TPEX',
      publishedAt,
      effectiveDate,
      updatedAt: raw.fetchedAt,
      isPointInTimeSafe: isPointInTimeSafe && Boolean(effectiveDate),
      notes
    };
    return record;
  }).filter(row => row.date && row.symbol && row.name && includeSymbol(row.symbol) && includeFlowRow(row));
}

const nextMap = await nextTradeDateMap();
const rawSummary = {
  twseFiles: 0,
  tpexFiles: 0,
  twseRawRows: 0,
  tpexRawRows: 0,
  twseRecords: 0,
  tpexRecords: 0
};
let outputRecords = 0;
let pointInTimeSafeRecords = 0;

await fs.mkdir(new URL('./', OUTPUT), { recursive: true });
const handle = await fs.open(OUTPUT, 'w');
await handle.write(`{"version":"1.0.0","sourceStatus":"保守 point-in-time 假設","pointInTimePolicy":{"fullyVerifiedPointInTime":false,"conservativePointInTimeAssumption":true,"publishedAtAssumption":"market_close_after_report","effectiveDateRule":"T 日資料只能於 T+1 交易日使用","warning":"逐筆歷史 publishedAt 待確認，不可宣稱 fully verified。"},"generatedAt":"${new Date().toISOString()}","records":[`);
let firstRecord = true;

async function writeRows(rows) {
  for (const row of rows) {
    if (!firstRecord) await handle.write(',');
    await handle.write(JSON.stringify(row));
    firstRecord = false;
    outputRecords += 1;
    if (row.isPointInTimeSafe) pointInTimeSafeRecords += 1;
  }
}

for (const file of await rawFiles(RAW_TWSE)) {
  const raw = await readJson(file, null);
  if (!raw) continue;
  rawSummary.twseFiles += 1;
  rawSummary.twseRawRows += raw.payload?.data?.length || 0;
  const rows = twseRecords(raw, nextMap);
  rawSummary.twseRecords += rows.length;
  await writeRows(rows);
}

for (const file of await rawFiles(RAW_TPEX)) {
  const raw = await readJson(file, null);
  if (!raw) continue;
  rawSummary.tpexFiles += 1;
  rawSummary.tpexRawRows += tableRows(raw).rows.length;
  const rows = tpexRecords(raw, nextMap);
  rawSummary.tpexRecords += rows.length;
  await writeRows(rows);
}

await handle.write(']}\n');
await handle.close();

const audit = await readJson(AUDIT, { generatedAt: new Date().toISOString(), sources: {}, fetchRuns: [] });
audit.build = {
  generatedAt: new Date().toISOString(),
  ...rawSummary,
  outputRecords,
  filteredOutRecords: rawSummary.twseRawRows + rawSummary.tpexRawRows - outputRecords,
  pointInTimeSafeRecords,
  assumePublishedAtRule: true,
  writer: 'streaming_compact_json',
  defaultFlowFilter: process.env.INSTITUTIONAL_KEEP_ALL_FLOWS === '1'
    ? '三大法人任一買賣活動'
    : '投信任一買賣活動'
};
await fs.writeFile(AUDIT, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');

console.log(`institutional records=${outputRecords}, safe=${audit.build.pointInTimeSafeRecords}`);
console.log(`raw twse=${rawSummary.twseFiles} files, tpex=${rawSummary.tpexFiles} files`);
