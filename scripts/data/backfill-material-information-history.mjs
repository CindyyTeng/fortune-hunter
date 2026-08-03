import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { announcementTimestamp, dedupeEvents, nextWeekday, writeJson } from './material-information-utils.mjs';

const MARKET_HISTORY = new URL('../../data/market-history/processed/', import.meta.url);
const RAW = new URL('../../data/material-information/raw/history/', import.meta.url);
const OUTPUT = new URL('../../data/material-information/processed/history-liquid-universe.json.gz', import.meta.url);
const REPORT = new URL('../../data/research/material-information-backfill-report.json', import.meta.url);
const limit = Math.max(1, Number(process.env.EVENT_BACKFILL_LIMIT || 60));
const years = String(process.env.EVENT_BACKFILL_YEARS || '110,111,112,113,114').split(',').map(Number);

function cleanHtml(value) {
  return String(value).replace(/<[^>]+>/g, ' ').replaceAll('&nbsp;', ' ').replaceAll('&amp;', '&').replace(/\s+/g, ' ').trim();
}

function rocSlashDate(value) {
  const [year, month, day] = String(value).split('/').map(Number);
  if (!year || !month || !day) return '';
  return `${year + 1911}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseHistory(html, stock, rocYear) {
  const events = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(match => cleanHtml(match[1]));
    if (cells.length < 5 || cells[0] !== stock.rawSymbol) continue;
    const announcedDate = rocSlashDate(cells[2]);
    if (!announcedDate) continue;
    events.push({
      reportDate: '',
      announcedDate,
      announcedTime: cells[3],
      publishedAt: announcementTimestamp(announcedDate, cells[3]),
      effectiveDate: nextWeekday(announcedDate),
      rawSymbol: stock.rawSymbol,
      symbol: stock.symbol,
      market: stock.market,
      stockName: cells[1],
      subject: cells[4],
      clause: '',
      factDate: '',
      description: '',
      source: '公開資訊觀測站-單一公司歷史重大訊息',
      sourceUrl: 'https://mopsov.twse.com.tw/mops/web/t05st01',
      sourceRocYear: rocYear,
      pointInTimeMode: 'official_announcement_timestamp',
      effectiveDatePolicy: '公布後下一個可交易日；回測再以行情日曆校正',
      isPointInTimeSafe: true
    });
  }
  return events;
}

async function liquidUniverse() {
  const payload = JSON.parse(zlib.gunzipSync(await fs.readFile(new URL('2025.json.gz', MARKET_HISTORY))));
  return Object.entries(payload.symbols || {}).flatMap(([symbol, rows]) => {
    if (!/^\d{4}\.(TW|TWO)$/.test(symbol) || symbol.startsWith('00')) return [];
    const recent = rows.slice(-60);
    const averageTradeValue = recent.reduce((sum, row) => sum + Number(row.tradeValue || 0), 0) / Math.max(1, recent.length);
    return [{ symbol, rawSymbol: symbol.slice(0, 4), market: symbol.endsWith('.TW') ? '上市' : '上櫃', averageTradeValue }];
  }).sort((a, b) => b.averageTradeValue - a.averageTradeValue).slice(0, limit);
}

async function fetchHistory(stock, rocYear) {
  const directory = new URL(`${stock.rawSymbol}/`, RAW);
  const file = new URL(`${rocYear}.html`, directory);
  try {
    return { html: await fs.readFile(file, 'utf8'), cached: true };
  } catch {
    // 尚無快取才向官方查詢。
  }
  const body = new URLSearchParams({
    encodeURIComponent: '1', step: '1', firstin: '1', off: '1', co_id: stock.rawSymbol,
    TYPEK: 'all', year: String(rocYear), month: 'all', b_date: '', e_date: ''
  });
  let error;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch('https://mopsov.twse.com.tw/mops/web/ajax_t05st01', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'fortune-hunter-history-backfill/1.0',
          referer: 'https://mopsov.twse.com.tw/mops/web/t05st01'
        },
        body
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(file, html, 'utf8');
      return { html, cached: false };
    } catch (caught) {
      error = caught;
      await new Promise(resolve => setTimeout(resolve, attempt * 1200));
    }
  }
  throw error;
}

const universe = await liquidUniverse();
const events = [];
const failures = [];
let requests = 0;
let cacheHits = 0;
for (const stock of universe) {
  for (const year of years) {
    try {
      const result = await fetchHistory(stock, year);
      if (result.cached) cacheHits += 1;
      else {
        requests += 1;
        await new Promise(resolve => setTimeout(resolve, 700));
      }
      events.push(...parseHistory(result.html, stock, year));
    } catch (error) {
      failures.push({ symbol: stock.symbol, rocYear: year, reason: error.message });
    }
  }
}
const unique = dedupeEvents(events);
const generatedAt = new Date().toISOString();
await fs.writeFile(OUTPUT, zlib.gzipSync(JSON.stringify({
  generatedAt,
  universeType: `2025 年成交值前 ${universe.length} 檔普通股`,
  survivorshipBiasWarning: true,
  pointInTimePolicy: '官方發言時間後的下一個行情交易日才可使用',
  events: unique
})));
await writeJson(REPORT, {
  generatedAt,
  symbols: universe.length,
  years: years.map(year => year + 1911),
  requests,
  cacheHits,
  failures,
  events: unique.length,
  uniqueDates: new Set(unique.map(event => event.announcedDate)).size,
  earliestDate: unique[0]?.announcedDate || null,
  latestDate: unique.at(-1)?.announcedDate || null,
  survivorshipBiasWarning: true,
  suitableFor: '事件前瞻報酬初篩，不可宣稱全市場無偏差驗證'
});
console.log(`重大訊息歷史回填：${universe.length} 檔、${unique.length} 筆、失敗 ${failures.length} 組、快取 ${cacheHits} 組。`);
