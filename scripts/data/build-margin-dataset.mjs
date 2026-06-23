import fs from 'node:fs/promises';

const INSTITUTIONAL = new URL('../../data/institutional/institutional-trades.json', import.meta.url);
const BACKTEST = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const RAW = new URL('../../data/margin/raw/', import.meta.url);
const OUTPUT = new URL('../../data/margin/margin-trades.json', import.meta.url);
const REPORT = new URL('../../data/research/margin-build-report.json', import.meta.url);
const MANUAL = new URL('../../data/margin/manual/', import.meta.url);
const CONCURRENCY = Number(process.env.MARGIN_FETCH_CONCURRENCY || 8);

const number = value => Number(String(value ?? '').replaceAll(',', '').trim()) || 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rocDate = date => `${Number(date.slice(0, 4)) - 1911}${date.slice(5, 7)}${date.slice(8, 10)}`;
const compactDate = date => date.replaceAll('-', '');

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/json,text/plain,*/*',
          'Accept-Language': 'zh-TW,zh;q=0.9',
          Referer: 'https://www.twse.com.tw/zh/trading/margin/mi-margn.html'
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(attempt * 500);
    }
  }
  throw lastError;
}

async function cacheDay(market, date) {
  const directory = new URL(`${market.toLowerCase()}/`, RAW);
  const file = new URL(`${date}.json`, directory);
  try {
    await fs.access(file);
    return { market, date, cached: true, ok: true };
  } catch {}
  if (process.env.MARGIN_FETCH_SKIP === '1') {
    return { market, date, cached: false, ok: false, error: '本次只重建快取，不進行網路下載' };
  }
  const url = market === 'TWSE'
    ? `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&date=${compactDate(date)}&selectType=ALL`
    : `https://www.tpex.org.tw/www/zh-tw/margin/balance?date=${date.replaceAll('-', '/')}&id=&response=json`;
  try {
    const payload = await fetchJson(url);
    if (String(payload.stat || '').toLowerCase() !== 'ok') throw new Error(payload.stat || '官方回應無資料');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(payload)}\n`, 'utf8');
    return { market, date, cached: false, ok: true };
  } catch (error) {
    return { market, date, cached: false, ok: false, error: error.message };
  }
}

async function pool(tasks, worker) {
  const results = new Array(tasks.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      results[index] = await worker(tasks[index]);
    }
  }));
  return results;
}

function row(date, effectiveDate, market, source, values) {
  const marginPrevious = number(values.marginPrevious);
  const marginBalance = number(values.marginBalance);
  const shortPrevious = number(values.shortPrevious);
  const shortBalance = number(values.shortBalance);
  const marginQuota = number(values.marginQuota);
  const marginChange = marginBalance - marginPrevious;
  const shortChange = shortBalance - shortPrevious;
  const marginUtilizationRate = values.marginUtilizationRate == null
    ? marginQuota ? marginBalance / marginQuota * 100 : null
    : number(values.marginUtilizationRate);
  return {
    date, effectiveDate, symbol: String(values.symbol).trim(), name: String(values.name || '').trim(), market,
    marginBalance, marginChange, shortBalance, shortChange,
    shortMarginRatio: marginBalance ? shortBalance / marginBalance * 100 : 0,
    marginUtilizationRate,
    marginOverheated: marginUtilizationRate >= 70 || (marginPrevious > 0 && marginChange / marginPrevious >= 0.2),
    marginIncreasePriceWeak: null,
    shortCoverPressure: shortPrevious > 0 && shortChange < 0 && Math.abs(shortChange) / shortPrevious >= 0.15,
    source, publishedAtAssumption: 'market_close_after_report', pointInTimeMode: 'conservative_assumption',
    isPointInTimeSafe: true, warning: '逐筆歷史公布時間未驗證；T 日資料僅於下一交易日使用。'
  };
}

function parseTwse(payload, date, effectiveDate, symbols) {
  const data = payload.tables?.find(table => table.data?.[0]?.length >= 16)?.data || [];
  return data.map(value => row(date, effectiveDate, 'TWSE', 'TWSE MI_MARGN', {
    symbol: value[0], name: value[1], marginPrevious: value[5], marginBalance: value[6], marginQuota: value[7],
    shortPrevious: value[11], shortBalance: value[12]
  })).filter(value => /^\d{4}$/.test(value.symbol) && symbols.has(value.symbol));
}

function parseTpex(payload, date, effectiveDate, symbols) {
  const data = payload.tables?.[0]?.data || [];
  return data.map(value => row(date, effectiveDate, 'TPEX', 'TPEx margin balance', {
    symbol: value[0], name: value[1], marginPrevious: value[2], marginBalance: value[6], marginUtilizationRate: value[8], marginQuota: value[9],
    shortPrevious: value[10], shortBalance: value[14]
  })).filter(value => /^\d{4}$/.test(value.symbol) && symbols.has(value.symbol));
}

function csvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && line[index + 1] === '"') { value += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) { values.push(value.trim()); value = ''; }
    else value += character;
  }
  values.push(value.trim());
  return values;
}

function normalizedDate(value) {
  const text = String(value || '').replaceAll('/', '-').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const digits = text.replace(/\D/g, '');
  if (digits.length === 7) return `${Number(digits.slice(0, 3)) + 1911}-${digits.slice(3, 5)}-${digits.slice(5, 7)}`;
  if (digits.length === 8) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  return null;
}

async function manualRows(symbols, nextDate) {
  let files = [];
  try { files = (await fs.readdir(MANUAL)).filter(name => name.toLowerCase().endsWith('.csv')); } catch {}
  const records = [];
  for (const file of files) {
    const lines = (await fs.readFile(new URL(file, MANUAL), 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) continue;
    const headers = csvLine(lines[0]);
    const pick = (row, names) => row[headers.findIndex(header => names.includes(header))];
    for (const line of lines.slice(1)) {
      const values = csvLine(line);
      const date = normalizedDate(pick(values, ['date', '日期']));
      const symbol = String(pick(values, ['symbol', '代號', '股票代號']) || '').trim();
      const marketText = String(pick(values, ['market', '市場']) || '').toUpperCase();
      const market = ['TPEX', '上櫃'].includes(marketText) ? 'TPEX' : 'TWSE';
      if (!date || !nextDate.has(date) || !symbols.has(symbol)) continue;
      records.push(row(date, nextDate.get(date), market, `manual:${file}`, {
        symbol, name: pick(values, ['name', '名稱', '股票名稱']),
        marginPrevious: pick(values, ['marginPrevious', '前資餘額']),
        marginBalance: pick(values, ['marginBalance', '融資餘額', '資餘額']),
        marginQuota: pick(values, ['marginQuota', '融資限額', '資限額']),
        marginUtilizationRate: pick(values, ['marginUtilizationRate', '融資使用率', '資使用率']),
        shortPrevious: pick(values, ['shortPrevious', '前券餘額']),
        shortBalance: pick(values, ['shortBalance', '融券餘額', '券餘額'])
      }));
    }
  }
  return records;
}

const [institutional, backtest] = await Promise.all([readJson(INSTITUTIONAL), readJson(BACKTEST)]);
function readJson(url) { return fs.readFile(url, 'utf8').then(JSON.parse); }
const dates = [...new Set((institutional.records || []).map(value => value.date))].sort();
const symbols = new Set((backtest.candidateTrades || []).map(value => String(value.symbol).replace(/\.(TW|TWO)$/i, '')).filter(value => /^\d{4}$/.test(value)));
const nextDate = new Map(dates.slice(0, -1).map((date, index) => [date, dates[index + 1]]));
const tasks = dates.filter(date => nextDate.has(date)).flatMap(date => ['TWSE', 'TPEX'].map(market => ({ market, date })));
await fs.mkdir(RAW, { recursive: true });
const fetchResults = await pool(tasks, task => cacheDay(task.market, task.date));
const records = [];
for (const date of dates.filter(value => nextDate.has(value))) {
  for (const market of ['TWSE', 'TPEX']) {
    try {
      const payload = JSON.parse(await fs.readFile(new URL(`${market.toLowerCase()}/${date}.json`, RAW), 'utf8'));
      records.push(...(market === 'TWSE' ? parseTwse(payload, date, nextDate.get(date), symbols) : parseTpex(payload, date, nextDate.get(date), symbols)));
    } catch {}
  }
}
records.push(...await manualRows(symbols, nextDate));
const unique = new Map(records.map(value => [`${value.date}|${value.market}|${value.symbol}`, value]));
const payload = {
  generatedAt: new Date().toISOString(),
  pointInTimePolicy: { mode: 'conservative_assumption', rule: 'T 日資料僅於 T+1 交易日使用' },
  records: [...unique.values()].sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol))
};
await fs.mkdir(new URL('../../data/margin/', import.meta.url), { recursive: true });
await fs.writeFile(OUTPUT, `${JSON.stringify(payload)}\n`, 'utf8');
const report = {
  generatedAt: payload.generatedAt, requestedDates: dates.length, requestedRequests: tasks.length,
  successfulRequests: fetchResults.filter(value => value.ok).length, failedRequests: fetchResults.filter(value => !value.ok).length,
  cachedRequests: fetchResults.filter(value => value.cached).length, universeSymbols: symbols.size,
  records: payload.records.length, uniqueDates: new Set(payload.records.map(value => value.date)).size,
  twseRecords: payload.records.filter(value => value.market === 'TWSE').length,
  tpexRecords: payload.records.filter(value => value.market === 'TPEX').length,
  twseDates: new Set(payload.records.filter(value => value.market === 'TWSE').map(value => value.date)).size,
  tpexDates: new Set(payload.records.filter(value => value.market === 'TPEX').map(value => value.date)).size,
  failures: fetchResults.filter(value => !value.ok).slice(0, 100)
};
await fs.writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`融資融券資料：${report.records} 筆、${report.uniqueDates} 日；失敗請求 ${report.failedRequests}。`);
