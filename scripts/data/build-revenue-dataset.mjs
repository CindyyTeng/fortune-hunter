import fs from 'node:fs/promises';
const MARKET = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const BACKTEST = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const RAW = new URL('../../data/revenue/raw/', import.meta.url);
const MANUAL = new URL('../../data/revenue/manual/', import.meta.url);
const OUTPUT = new URL('../../data/revenue/monthly-revenue.json', import.meta.url);
const REPORT = new URL('../../data/research/revenue-build-report.json', import.meta.url);
const environment = globalThis.process?.env || {};
const START_DATE = environment.REVENUE_START_DATE || '2021-01-01';
const SYMBOL_LIMIT = Number(environment.REVENUE_SYMBOL_LIMIT || 472);
const FETCH_SKIP = environment.REVENUE_FETCH_SKIP === '1';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const number = value => {
  const parsed = Number(String(value ?? '').replaceAll(',', '').replaceAll('%', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
};

function followingMonthDeadline(revenueMonth) {
  const date = new Date(`${revenueMonth}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return `${date.toISOString().slice(0, 7)}-10`;
}

function nextTradingDay(dates, date) {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (dates[middle] <= date) low = middle + 1;
    else high = middle;
  }
  return dates[low] || null;
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

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: { 'User-Agent': 'fortune-hunter-revenue-research/1.0' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.status !== 200) throw new Error(payload.msg || `API status ${payload.status}`);
      return payload.data || [];
    } catch (error) {
      lastError = error;
      await sleep(attempt * 1_000);
    }
  }
  throw lastError;
}

async function mapLimit(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return output;
}

async function universe() {
  const backtest = JSON.parse(await fs.readFile(BACKTEST, 'utf8'));
  const metadata = new Map((backtest.candidateTrades || []).map(row => [row.symbol, {
    symbol: row.symbol,
    stockName: row.name,
    market: String(row.market).includes('上櫃') ? 'TPEX' : 'TWSE'
  }]));
  return [...metadata.values()]
    .sort((left, right) => left.symbol.localeCompare(right.symbol))
    .slice(0, SYMBOL_LIMIT);
}

function normalizeFinMind(rows, stock, tradingDates) {
  return rows.map(row => {
    const revenueMonth = `${row.revenue_year}-${String(row.revenue_month).padStart(2, '0')}`;
    const announcedDate = followingMonthDeadline(revenueMonth);
    const effectiveDate = nextTradingDay(tradingDates, announcedDate);
    if (!effectiveDate || !Number.isFinite(Number(row.revenue)) || Number(row.revenue) <= 0) return null;
    return {
      symbol: stock.symbol,
      stockName: stock.stockName,
      market: stock.market,
      revenueMonth,
      announcedDate,
      publishedAt: `${announcedDate}T23:59:59+08:00`,
      effectiveDate,
      monthlyRevenue: Number(row.revenue),
      source: 'FinMind TaiwanStockMonthRevenue（原始資料源自公開市場資訊）',
      publishedAtAssumption: 'legal_deadline_market_close',
      pointInTimeMode: 'conservative_assumption',
      isPointInTimeSafe: true,
      fullyVerifiedPointInTime: false,
      pointInTimeWarning: '逐公司實際歷史公布時間待確認；本資料只能於營收月份次月 10 日後的下一交易日使用。',
      revisionWarning: '缺少逐筆歷史公布時間與原始版本，採法定期限後 T+1 保守使用，仍可能含事後更正。'
    };
  }).filter(Boolean);
}

async function manualRecords(tradingDates) {
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
      const revenueMonth = String(pick(values, ['revenueMonth', '資料年月']) || '').replace('/', '-');
      const announcedDate = String(pick(values, ['announcedDate', '公布日期']) || followingMonthDeadline(revenueMonth)).replaceAll('/', '-');
      const effectiveDate = nextTradingDay(tradingDates, announcedDate);
      const symbol = String(pick(values, ['symbol', '公司代號']) || '').trim();
      const monthlyRevenue = number(pick(values, ['monthlyRevenue', '當月營收', '營業收入-當月營收']));
      if (!/^\d{4}$/.test(symbol) || !/^\d{4}-\d{2}$/.test(revenueMonth) || !effectiveDate || !Number.isFinite(monthlyRevenue)) continue;
      records.push({
        symbol,
        stockName: pick(values, ['stockName', '公司名稱']),
        market: String(pick(values, ['market', '市場']) || 'TWSE').toUpperCase(),
        revenueMonth,
        announcedDate,
        publishedAt: `${announcedDate}T23:59:59+08:00`,
        effectiveDate,
        monthlyRevenue,
        source: `manual:${file}`,
        publishedAtAssumption: 'manual_date_market_close',
        pointInTimeMode: 'conservative_assumption',
        isPointInTimeSafe: true,
        fullyVerifiedPointInTime: false,
        pointInTimeWarning: '缺少精確公布時間，僅於人工公布日期後的下一交易日使用。',
        revisionWarning: '人工匯入資料未提供精確公布時間，採公布日後下一交易日使用。'
      });
    }
  }
  return records;
}

function enrich(records) {
  const output = [];
  const bySymbol = new Map();
  for (const row of records) {
    const list = bySymbol.get(row.symbol) || [];
    list.push(row);
    bySymbol.set(row.symbol, list);
  }
  for (const list of bySymbol.values()) {
    list.sort((left, right) => left.revenueMonth.localeCompare(right.revenueMonth));
    const enriched = [];
    for (let index = 0; index < list.length; index += 1) {
      const row = list[index];
      const previous = enriched[index - 1];
      const priorYearMonth = `${Number(row.revenueMonth.slice(0, 4)) - 1}${row.revenueMonth.slice(4)}`;
      const priorYear = list.find(value => value.revenueMonth === priorYearMonth);
      const YoY = priorYear?.monthlyRevenue ? (row.monthlyRevenue / priorYear.monthlyRevenue - 1) * 100 : null;
      const MoM = list[index - 1]?.monthlyRevenue ? (row.monthlyRevenue / list[index - 1].monthlyRevenue - 1) * 100 : null;
      const cumulativeYoY = count => {
        if (index + 1 < count) return null;
        const currentRows = list.slice(index + 1 - count, index + 1);
        const priorRows = currentRows.map(value => list.find(candidate => candidate.revenueMonth === `${Number(value.revenueMonth.slice(0, 4)) - 1}${value.revenueMonth.slice(4)}`));
        if (priorRows.some(value => !value?.monthlyRevenue)) return null;
        const current = currentRows.reduce((sum, value) => sum + value.monthlyRevenue, 0);
        const prior = priorRows.reduce((sum, value) => sum + value.monthlyRevenue, 0);
        return prior ? (current / prior - 1) * 100 : null;
      };
      const priorValues = count => list.slice(Math.max(0, index + 1 - count), index + 1).map(value => value.monthlyRevenue);
      const item = {
        ...row,
        MoM,
        YoY,
        threeMonthCumulativeYoY: cumulativeYoY(3),
        twelveMonthCumulativeYoY: cumulativeYoY(12),
        revenueHigh6: index >= 5 && row.monthlyRevenue >= Math.max(...priorValues(6)),
        revenueHigh12: index >= 11 && row.monthlyRevenue >= Math.max(...priorValues(12)),
        revenueHigh24: index >= 23 && row.monthlyRevenue >= Math.max(...priorValues(24)),
        consecutiveYoYGrowth2: Number.isFinite(YoY) && YoY > 0 && previous?.YoY > 0,
        consecutiveYoYGrowth3: Number.isFinite(YoY) && YoY > 0 && previous?.YoY > 0 && enriched[index - 2]?.YoY > 0,
        yoyAcceleration: Number.isFinite(YoY) && Number.isFinite(previous?.YoY) && YoY > previous.YoY,
        declineToGrowth: Number.isFinite(YoY) && previous?.YoY < 0 && YoY > 0
      };
      enriched.push(item);
      output.push(item);
    }
  }
  return output.sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate) || left.symbol.localeCompare(right.symbol));
}

const market = JSON.parse(await fs.readFile(MARKET, 'utf8'));
const tradingDates = market.benchmark.map(row => row.date);
const endDate = tradingDates.at(-1);
const stocks = await universe();
await fs.mkdir(RAW, { recursive: true });
const downloads = await mapLimit(stocks, Number(environment.REVENUE_FETCH_CONCURRENCY || 6), async stock => {
  const file = new URL(`${stock.symbol}.json`, RAW);
  try {
    return { stock, rows: JSON.parse(await fs.readFile(file, 'utf8')), cached: true };
  } catch {}
  if (FETCH_SKIP) return { stock, rows: [], cached: false, error: '本次只使用既有快取' };
  const query = new URL('https://api.finmindtrade.com/api/v4/data');
  query.searchParams.set('dataset', 'TaiwanStockMonthRevenue');
  query.searchParams.set('data_id', stock.symbol);
  query.searchParams.set('start_date', START_DATE);
  query.searchParams.set('end_date', endDate);
  try {
    const rows = await fetchJson(query);
    await fs.writeFile(file, `${JSON.stringify(rows)}\n`, 'utf8');
    await sleep(80);
    return { stock, rows, cached: false };
  } catch (error) {
    return { stock, rows: [], cached: false, error: error.message };
  }
});
const rawRecords = downloads.flatMap(result => normalizeFinMind(result.rows, result.stock, tradingDates));
rawRecords.push(...await manualRecords(tradingDates));
const unique = new Map(rawRecords.map(row => [`${row.revenueMonth}|${row.market}|${row.symbol}`, row]));
const records = enrich([...unique.values()]);
const payload = {
  generatedAt: new Date().toISOString(),
  pointInTimePolicy: {
    mode: 'conservative_assumption',
    fullyVerified: false,
    rule: '營收月份次月 10 日視為最晚公布日，只能於下一交易日使用。'
  },
  records
};
await fs.mkdir(new URL('../../data/revenue/', import.meta.url), { recursive: true });
await fs.writeFile(OUTPUT, `${JSON.stringify(payload)}\n`, 'utf8');
const report = {
  generatedAt: payload.generatedAt,
  requestedSymbols: stocks.length,
  successfulSymbols: downloads.filter(row => row.rows.length).length,
  failedSymbols: downloads.filter(row => row.error).length,
  cachedSymbols: downloads.filter(row => row.cached).length,
  records: records.length,
  symbols: new Set(records.map(row => row.symbol)).size,
  months: new Set(records.map(row => row.revenueMonth)).size,
  twseRecords: records.filter(row => row.market === 'TWSE').length,
  tpexRecords: records.filter(row => row.market === 'TPEX').length,
  failures: downloads.filter(row => row.error).map(row => ({ symbol: row.stock.symbol, error: row.error }))
};
await fs.mkdir(new URL('../../data/research/', import.meta.url), { recursive: true });
await fs.writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`月營收資料：${report.records} 筆、${report.symbols} 檔、${report.months} 個月份。`);
