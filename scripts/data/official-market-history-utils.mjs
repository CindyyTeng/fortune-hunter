import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const execFileAsync = promisify(execFile);
export const ROOT = new URL('../../', import.meta.url);
export const RAW_ROOT = new URL('../../data/market-history/raw/', import.meta.url);
export const PROCESSED_ROOT = new URL('../../data/market-history/processed/', import.meta.url);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function compactDate(date) {
  return date.replaceAll('-', '');
}

export function rocDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return `${year - 1911}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
}

export function marketUrl(market, date) {
  if (market === 'TWSE') {
    return `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${compactDate(date)}&type=ALLBUT0999&response=json`;
  }
  return `https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${rocDate(date)}&id=&response=json`;
}

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function writeGzipJson(file, value) {
  await fs.mkdir(new URL('./', file), { recursive: true });
  await fs.writeFile(file, await gzipAsync(`${JSON.stringify(value)}\n`));
}

export async function readGzipJson(file) {
  return JSON.parse((await gunzipAsync(await fs.readFile(file))).toString('utf8'));
}

export async function fetchJsonWithRetry(url, retries = 1) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Number(process.env.MARKET_HISTORY_TIMEOUT_MS || 12_000)
    );
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': 'fortune-hunter-official-market-history/1.0' }
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(750 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    const { stdout } = await execFileAsync('curl.exe', [
      '-L',
      '--silent',
      '--show-error',
      '--max-time',
      '30',
      url
    ], { maxBuffer: 20 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${lastError?.message || 'fetch failed'}; curl fallback: ${error.message}`);
  }
}

function number(value) {
  if (typeof value === 'number') return value;
  const cleaned = String(value ?? '').replaceAll(',', '').replaceAll('--', '').trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function commonStock(symbol) {
  return /^[1-9]\d{3}$/.test(String(symbol).trim());
}

export function parseTwse(payload, date) {
  const table = payload.tables?.find(item => (
    item.fields?.includes('證券代號') && item.fields?.includes('開盤價')
  ));
  if (!table) return [];
  const field = Object.fromEntries(table.fields.map((name, index) => [name, index]));
  return table.data.flatMap(row => {
    const symbol = String(row[field['證券代號']] ?? '').trim();
    if (!commonStock(symbol)) return [];
    const item = {
      date,
      symbol: `${symbol}.TW`,
      id: symbol,
      name: String(row[field['證券名稱']] ?? '').trim(),
      market: 'TWSE',
      open: number(row[field['開盤價']]),
      high: number(row[field['最高價']]),
      low: number(row[field['最低價']]),
      close: number(row[field['收盤價']]),
      volume: number(row[field['成交股數']]),
      tradeValue: number(row[field['成交金額']])
    };
    return [item.open, item.high, item.low, item.close, item.volume].every(Number.isFinite)
      ? [item]
      : [];
  });
}

export function parseTpex(payload, date) {
  const table = payload.tables?.find(item => (
    item.fields?.includes('代號') && item.fields?.includes('開盤')
  ));
  if (!table) return [];
  const field = Object.fromEntries(table.fields.map((name, index) => [name, index]));
  return table.data.flatMap(row => {
    const symbol = String(row[field['代號']] ?? '').trim();
    if (!commonStock(symbol)) return [];
    const item = {
      date,
      symbol: `${symbol}.TWO`,
      id: symbol,
      name: String(row[field['名稱']] ?? '').trim(),
      market: 'TPEX',
      open: number(row[field['開盤']]),
      high: number(row[field['最高']]),
      low: number(row[field['最低']]),
      close: number(row[field['收盤']]),
      volume: number(row[field['成交股數']]),
      tradeValue: number(row[field['成交金額(元)']])
    };
    return [item.open, item.high, item.low, item.close, item.volume].every(Number.isFinite)
      ? [item]
      : [];
  });
}

export function parseMarket(market, payload, date) {
  return market === 'TWSE' ? parseTwse(payload, date) : parseTpex(payload, date);
}

export function weekdays(start, end) {
  const dates = [];
  for (let time = Date.parse(`${start}T00:00:00Z`); time <= Date.parse(`${end}T00:00:00Z`); time += 86_400_000) {
    const date = new Date(time);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}
