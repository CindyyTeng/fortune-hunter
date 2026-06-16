import fs from 'node:fs/promises';

export const DATA = new URL('../../data/institutional/institutional-trades.json', import.meta.url);
export const MARKET = new URL('../../data/market-regime-history-10y.json', import.meta.url);
export const RAW_TWSE = new URL('../../data/institutional/raw/twse/', import.meta.url);
export const RAW_TPEX = new URL('../../data/institutional/raw/tpex/', import.meta.url);

export async function readJson(url, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(url, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJson(url, value) {
  await fs.mkdir(new URL('./', url), { recursive: true });
  await fs.writeFile(url, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function exists(url) {
  try {
    await fs.access(url);
    return true;
  } catch {
    return false;
  }
}

export async function tradingDates() {
  const market = await readJson(MARKET, { benchmark: [] });
  return market.benchmark.map(row => row.date).filter(Boolean);
}

export function compactDate(date) {
  return date.replaceAll('-', '');
}

export function rocCompactDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return `${year - 1911}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

export function nearestTradingDate(dates, target) {
  return [...dates].reverse().find(date => date <= target) || dates[0] || target;
}

export function pickProbeDates(dates) {
  const latest = dates.at(-1);
  const offsets = [
    ['最新交易日', 0],
    ['1 個月前', 1],
    ['3 個月前', 3],
    ['6 個月前', 6],
    ['1 年前', 12],
    ['2 年前', 24],
    ['4 年前', 48]
  ];
  return offsets.map(([label, months]) => {
    const d = new Date(`${latest}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - months);
    return { label, date: nearestTradingDate(dates, d.toISOString().slice(0, 10)) };
  });
}

export async function fetchJson(url, timeoutMs = 15_000) {
  const startedAt = new Date().toISOString();
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'fortune-hunter/1.0' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return {
      ok: response.ok,
      status: response.status,
      url,
      contentLength: text.length,
      startedAt,
      finishedAt: new Date().toISOString(),
      json,
      error: json ? null : '回傳內容不是 JSON'
    };
  } catch (error) {
    return { ok: false, url, startedAt, finishedAt: new Date().toISOString(), error: error.message };
  }
}

export function dedupeRows(records) {
  const seen = new Map();
  const duplicates = [];
  for (const row of records) {
    const market = row.market || ((row.source || '').includes('TPEx') ? 'TPEX' : 'TWSE');
    const key = `${row.date}|${row.symbol}|${market}|${row.source}`;
    if (seen.has(key)) {
      duplicates.push({ key, kept: seen.get(key), duplicate: row });
      continue;
    }
    seen.set(key, { ...row, market });
  }
  return { records: [...seen.values()], duplicates };
}

export function coverage(records) {
  const byDate = new Map();
  const byMarket = { TWSE: { records: 0, dates: new Set() }, TPEX: { records: 0, dates: new Set() }, UNKNOWN: { records: 0, dates: new Set() } };
  const bySymbolDate = new Map();
  for (const row of records) {
    const market = row.market || ((row.source || '').includes('TPEx') ? 'TPEX' : 'TWSE');
    const bucket = byMarket[market] || byMarket.UNKNOWN;
    bucket.records += 1;
    bucket.dates.add(row.date);
    byDate.set(row.date, (byDate.get(row.date) || 0) + 1);
    const symbolKey = `${row.date}|${row.symbol}|${market}`;
    bySymbolDate.set(symbolKey, (bySymbolDate.get(symbolKey) || 0) + 1);
  }
  const dailyRows = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
  const averageDailyRows = dailyRows.length
    ? dailyRows.reduce((sum, row) => sum + row.count, 0) / dailyRows.length
    : 0;
  return {
    totalRecords: records.length,
    uniqueTradingDates: byDate.size,
    averageDailyRows: Number(averageDailyRows.toFixed(2)),
    twseRecords: byMarket.TWSE.records,
    twseDates: byMarket.TWSE.dates.size,
    tpexRecords: byMarket.TPEX.records,
    tpexDates: byMarket.TPEX.dates.size,
    dailyRows,
    abnormalDates: dailyRows.filter(row => averageDailyRows && row.count > averageDailyRows * 2),
    duplicatedSymbolDates: [...bySymbolDate.entries()].filter(([, count]) => count > 1).slice(0, 200).map(([key, count]) => ({ key, count }))
  };
}
