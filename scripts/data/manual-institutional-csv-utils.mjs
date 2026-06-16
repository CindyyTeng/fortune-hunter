import fs from 'node:fs/promises';
import { DATA, dedupeRows, readJson, tradingDates, writeJson } from './institutional-history-utils.mjs';

export const MANUAL_DIR = new URL('../../data/institutional/manual/', import.meta.url);
export const VALIDATION = new URL('../../data/research/manual-institutional-validation.json', import.meta.url);

const fieldMap = {
  date: ['date', '日期', '資料日期'],
  symbol: ['symbol', '證券代號', '股票代號', '代號', 'SecuritiesCompanyCode'],
  name: ['name', '證券名稱', '股票名稱', '名稱', 'CompanyName'],
  foreignBuy: ['foreignBuy', '外資買進', '外資買進股數', '外資買進張數'],
  foreignSell: ['foreignSell', '外資賣出', '外資賣出股數', '外資賣出張數'],
  foreignNetBuy: ['foreignNetBuy', '外資買賣超', '外資買賣超股數', '外資買賣超張數'],
  trustBuy: ['trustBuy', '投信買進', '投信買進股數', '投信買進張數'],
  trustSell: ['trustSell', '投信賣出', '投信賣出股數', '投信賣出張數'],
  trustNetBuy: ['trustNetBuy', '投信買賣超', '投信買賣超股數', '投信買賣超張數'],
  dealerBuy: ['dealerBuy', '自營商買進', '自營商買進股數', '自營商買進張數'],
  dealerSell: ['dealerSell', '自營商賣出', '自營商賣出股數', '自營商賣出張數'],
  dealerNetBuy: ['dealerNetBuy', '自營商買賣超', '自營商買賣超股數', '自營商買賣超張數']
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function normalizeDate(value) {
  const text = String(value || '').trim().replaceAll('/', '-');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (/^\d{3}-\d{2}-\d{2}$/.test(text)) return `${Number(text.slice(0, 3)) + 1911}-${text.slice(4, 6)}-${text.slice(7, 9)}`;
  if (/^\d{7}$/.test(text)) return `${Number(text.slice(0, 3)) + 1911}-${text.slice(3, 5)}-${text.slice(5, 7)}`;
  return text;
}

function number(value) {
  const text = String(value ?? '').replaceAll(',', '').replace(/[()]/g, '').trim();
  const sign = /\(.+\)/.test(String(value ?? '')) ? -1 : 1;
  return sign * Number(text || 0);
}

function nextWeekday(date) {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day));
  do {
    next.setUTCDate(next.getUTCDate() + 1);
  } while ([0, 6].includes(next.getUTCDay()));
  return next.toISOString().slice(0, 10);
}

function headerIndex(headers, names) {
  return names.map(name => headers.findIndex(header => header.trim() === name)).find(index => index >= 0) ?? -1;
}

function marketFromName(name) {
  const lower = name.toLowerCase();
  if (lower.includes('tpex') || lower.includes('otc') || lower.includes('上櫃')) return 'TPEX';
  return 'TWSE';
}

export async function manualFiles() {
  try {
    return (await fs.readdir(MANUAL_DIR)).filter(name => /\.csv$/i.test(name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function parseManualFiles() {
  const dates = await tradingDates();
  const nextMap = new Map(dates.slice(0, -1).map((date, index) => [date, dates[index + 1]]));
  const files = await manualFiles();
  const records = [];
  const errors = [];
  for (const file of files) {
    if (/mock|sample|demo|test/i.test(file)) {
      errors.push(`${file}：檔名疑似 mock/sample/test，不可當真資料匯入`);
      continue;
    }
    const rows = parseCsv(await fs.readFile(new URL(file, MANUAL_DIR), 'utf8'));
    const headers = rows[0] || [];
    const indexes = Object.fromEntries(Object.entries(fieldMap).map(([key, names]) => [key, headerIndex(headers, names)]));
    const missing = Object.entries(indexes).filter(([, index]) => index < 0).map(([key]) => key);
    if (missing.length) {
      errors.push(`${file}：缺少必要欄位 ${missing.join(', ')}`);
      continue;
    }
    const market = marketFromName(file);
    for (const cells of rows.slice(1)) {
      const date = normalizeDate(cells[indexes.date]);
      const effectiveDate = nextMap.get(date) || nextWeekday(date);
      records.push({
        date,
        market,
        symbol: String(cells[indexes.symbol] || '').trim(),
        name: String(cells[indexes.name] || '').trim(),
        foreignBuy: number(cells[indexes.foreignBuy]),
        foreignSell: number(cells[indexes.foreignSell]),
        foreignNetBuy: number(cells[indexes.foreignNetBuy]),
        trustBuy: number(cells[indexes.trustBuy]),
        trustSell: number(cells[indexes.trustSell]),
        trustNetBuy: number(cells[indexes.trustNetBuy]),
        dealerBuy: number(cells[indexes.dealerBuy]),
        dealerSell: number(cells[indexes.dealerSell]),
        dealerNetBuy: number(cells[indexes.dealerNetBuy]),
        source: `Manual CSV ${market}`,
        publishedAt: `${date}T18:00:00+08:00`,
        publishedAtAssumption: 'market_close_after_report',
        effectiveDate,
        updatedAt: new Date().toISOString(),
        isPointInTimeSafe: true,
        fullyVerifiedPointInTime: false,
        conservativePointInTimeAssumption: true,
        pointInTimeMode: 'conservative_assumption',
        pointInTimeWarning: '人工匯入資料採用 T 日收盤後公布、T+1 交易日才可使用的保守假設。',
        notes: `manual file: ${file}`
      });
    }
  }
  return { files, records: records.filter(row => row.date && row.symbol && row.name), errors };
}

export async function mergeManualRecords(manualRecords) {
  const payload = await readJson(DATA, { version: '1.0.0', records: [] });
  const { records, duplicates } = dedupeRows([...(payload.records || []), ...manualRecords]);
  await writeJson(DATA, {
    ...payload,
    generatedAt: new Date().toISOString(),
    records
  });
  return { records, duplicates };
}
