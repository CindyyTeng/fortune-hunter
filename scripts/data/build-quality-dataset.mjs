import fs from 'node:fs/promises';

const MARKET = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const BACKTEST = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const REVENUE = new URL('../../data/revenue/monthly-revenue.json', import.meta.url);
const RAW = new URL('../../data/quality/raw/', import.meta.url);
const MANUAL = new URL('../../data/quality/manual/', import.meta.url);
const OUTPUT = new URL('../../data/quality/financial-quality.json', import.meta.url);
const REPORT = new URL('../../data/research/quality-build-report.json', import.meta.url);
const environment = globalThis.process?.env || {};
const START_DATE = environment.QUALITY_START_DATE || '2020-01-01';
const SYMBOL_LIMIT = Number(environment.QUALITY_SYMBOL_LIMIT || 470);
const FETCH_SKIP = environment.QUALITY_FETCH_SKIP === '1';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const number = value => {
  const parsed = Number(String(value ?? '').replaceAll(',', '').replaceAll('%', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
};

async function readJson(url, fallback = null) {
  try { return JSON.parse(await fs.readFile(url, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
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

function quarterFromDate(dateText) {
  const [yearText, monthText] = String(dateText || '').slice(0, 10).split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  if (!year || !month) return null;
  return `${year}Q${Math.ceil(month / 3)}`;
}

function defaultAnnouncedDate(quarter) {
  const year = Number(quarter.slice(0, 4));
  const q = Number(quarter.slice(5));
  if (q === 1) return `${year}-05-15`;
  if (q === 2) return `${year}-08-14`;
  if (q === 3) return `${year}-11-14`;
  return `${year + 1}-03-31`;
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

async function universe() {
  const revenue = await readJson(REVENUE, { records: [] });
  const fromRevenue = new Map((revenue.records || []).map(row => [row.symbol, {
    symbol: row.symbol,
    stockName: row.stockName,
    market: row.market
  }]));
  if (fromRevenue.size) return [...fromRevenue.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)).slice(0, SYMBOL_LIMIT);
  const backtest = await readJson(BACKTEST, { candidateTrades: [] });
  return [...new Map((backtest.candidateTrades || []).map(row => [row.symbol, {
    symbol: row.symbol,
    stockName: row.name,
    market: String(row.market).includes('上櫃') ? 'TPEX' : 'TWSE'
  }])).values()].sort((a, b) => a.symbol.localeCompare(b.symbol)).slice(0, SYMBOL_LIMIT);
}

async function fetchFinancial(stock) {
  await fs.mkdir(RAW, { recursive: true });
  const cache = new URL(`${stock.symbol}.json`, RAW);
  const cached = await readJson(cache, null);
  if (cached) return { ...cached, cached: true };
  if (FETCH_SKIP) return { stock_id: stock.symbol, data: [], skipped: true };
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockFinancialStatements&data_id=${stock.symbol}&start_date=${START_DATE}`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'fortune-hunter-quality-research/1.0' } });
      const payload = await response.json();
      if (!response.ok || payload.status !== 200) throw new Error(payload.msg || `HTTP ${response.status}`);
      const saved = { stock_id: stock.symbol, source: 'FinMind TaiwanStockFinancialStatements', url, data: payload.data || [] };
      await fs.writeFile(cache, `${JSON.stringify(saved)}\n`, 'utf8');
      await sleep(350);
      return saved;
    } catch (error) {
      lastError = error;
      await sleep(attempt * 1000);
    }
  }
  return { stock_id: stock.symbol, source: 'FinMind TaiwanStockFinancialStatements', url, data: [], error: lastError?.message };
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

function metricKind(row) {
  const text = `${row.type || ''} ${row.origin_name || ''} ${row.name || ''}`.toLowerCase();
  if (/eps|每股|基本每股|稀釋每股/.test(text)) return 'EPS';
  if (/gross.*margin|毛利率/.test(text)) return 'grossMargin';
  if (/operating.*margin|營益率|營業利益率/.test(text)) return 'operatingMargin';
  if (/net.*margin|稅後淨利率|淨利率/.test(text)) return 'netMargin';
  if (/roe|權益報酬/.test(text)) return 'ROE';
  if (/gross.*profit|營業毛利|毛利/.test(text)) return 'grossProfit';
  if (/operating.*income|營業利益|營業損益/.test(text)) return 'operatingIncome';
  if (/net.*income|income.*tax|本期淨利|稅後淨利/.test(text)) return 'netIncome';
  if (/revenue|營業收入|營收/.test(text)) return 'revenue';
  if (/equity|權益總計|股東權益/.test(text)) return 'equity';
  return null;
}

function normalizeFinMind(payload, stock, tradingDates) {
  const grouped = new Map();
  for (const row of payload.data || []) {
    const quarter = row.quarter || quarterFromDate(row.date);
    const kind = metricKind(row);
    const value = number(row.value ?? row[kind]);
    if (!quarter || !kind || !Number.isFinite(value)) continue;
    const key = `${stock.symbol}|${quarter}`;
    const record = grouped.get(key) || { symbol: stock.symbol, stockName: stock.stockName, market: stock.market, quarter };
    record[kind] = value;
    grouped.set(key, record);
  }
  return [...grouped.values()].map(row => completeRecord(row, tradingDates, 'FinMind TaiwanStockFinancialStatements'));
}

function completeRecord(row, tradingDates, source) {
  const announcedDate = row.announcedDate || defaultAnnouncedDate(row.quarter);
  const effectiveDate = nextTradingDay(tradingDates, announcedDate);
  if (!effectiveDate) return null;
  const revenue = row.revenue;
  const grossMargin = Number.isFinite(row.grossMargin) ? row.grossMargin : (Number.isFinite(row.grossProfit) && revenue ? row.grossProfit / revenue * 100 : null);
  const operatingMargin = Number.isFinite(row.operatingMargin) ? row.operatingMargin : (Number.isFinite(row.operatingIncome) && revenue ? row.operatingIncome / revenue * 100 : null);
  const netMargin = Number.isFinite(row.netMargin) ? row.netMargin : (Number.isFinite(row.netIncome) && revenue ? row.netIncome / revenue * 100 : null);
  const ROE = Number.isFinite(row.ROE) ? row.ROE : (Number.isFinite(row.netIncome) && row.equity ? row.netIncome / row.equity * 100 : null);
  return {
    symbol: row.symbol,
    stockName: row.stockName,
    market: row.market || 'TWSE',
    quarter: row.quarter,
    announcedDate,
    publishedAt: `${announcedDate}T23:59:59+08:00`,
    effectiveDate,
    EPS: row.EPS,
    grossMargin,
    operatingMargin,
    netMargin,
    ROE,
    source,
    publishedAtAssumption: 'financial_report_deadline_market_close',
    pointInTimeMode: 'conservative_assumption',
    isPointInTimeSafe: true,
    fullyVerifiedPointInTime: false,
    pointInTimeWarning: '缺少逐筆歷史公布時間，採用法定財報期限後下一個交易日才可使用的保守假設。'
  };
}

async function manualRecords(tradingDates) {
  const files = (await fs.readdir(MANUAL).catch(() => [])).filter(name => name.toLowerCase().endsWith('.csv'));
  const rows = [];
  for (const file of files) {
    const lines = (await fs.readFile(new URL(file, MANUAL), 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) continue;
    const headers = csvLine(lines[0]);
    const pick = (values, names) => values[headers.findIndex(header => names.includes(header))];
    for (const line of lines.slice(1)) {
      const values = csvLine(line);
      const row = completeRecord({
        symbol: String(pick(values, ['symbol', '股票代號']) || '').trim(),
        stockName: pick(values, ['stockName', '公司名稱']),
        market: String(pick(values, ['market', '市場']) || 'TWSE').toUpperCase(),
        quarter: String(pick(values, ['quarter', '季度']) || '').toUpperCase(),
        announcedDate: String(pick(values, ['announcedDate', '公布日']) || '').replaceAll('/', '-'),
        EPS: number(pick(values, ['EPS'])),
        grossMargin: number(pick(values, ['grossMargin', '毛利率'])),
        operatingMargin: number(pick(values, ['operatingMargin', '營益率'])),
        netMargin: number(pick(values, ['netMargin', '稅後淨利率'])),
        ROE: number(pick(values, ['ROE']))
      }, tradingDates, `manual:${file}`);
      if (row?.symbol && /^\d{4}Q[1-4]$/.test(row.quarter)) rows.push(row);
    }
  }
  return rows;
}

function enrich(records) {
  const output = [];
  const bySymbol = new Map();
  for (const row of records.filter(Boolean)) {
    if (!/^\d{4}$/.test(row.symbol || '') || !/^\d{4}Q[1-4]$/.test(row.quarter || '')) continue;
    if (!Number.isFinite(row.EPS) && !Number.isFinite(row.grossMargin) && !Number.isFinite(row.operatingMargin)) continue;
    const key = `${row.symbol}|${row.quarter}`;
    bySymbol.set(row.symbol, [...(bySymbol.get(row.symbol) || []), { ...row, key }]);
  }
  for (const list of bySymbol.values()) {
    list.sort((a, b) => a.quarter.localeCompare(b.quarter));
    for (let index = 0; index < list.length; index += 1) {
      const row = list[index];
      const previous = list[index - 1];
      const priorYear = list.find(value => value.quarter === `${Number(row.quarter.slice(0, 4)) - 1}${row.quarter.slice(4)}`);
      const last4 = list.slice(Math.max(0, index - 3), index + 1);
      const last8 = list.slice(Math.max(0, index - 7), index + 1);
      row.epsYoY = priorYear?.EPS ? (row.EPS / priorYear.EPS - 1) * 100 : null;
      row.epsQoQ = previous?.EPS ? (row.EPS / previous.EPS - 1) * 100 : null;
      row.grossMarginYoYChange = Number.isFinite(priorYear?.grossMargin) && Number.isFinite(row.grossMargin) ? row.grossMargin - priorYear.grossMargin : null;
      row.grossMarginQoQChange = Number.isFinite(previous?.grossMargin) && Number.isFinite(row.grossMargin) ? row.grossMargin - previous.grossMargin : null;
      row.operatingMarginYoYChange = Number.isFinite(priorYear?.operatingMargin) && Number.isFinite(row.operatingMargin) ? row.operatingMargin - priorYear.operatingMargin : null;
      row.operatingMarginQoQChange = Number.isFinite(previous?.operatingMargin) && Number.isFinite(row.operatingMargin) ? row.operatingMargin - previous.operatingMargin : null;
      row.epsTurnPositive = Number.isFinite(previous?.EPS) && previous.EPS <= 0 && row.EPS > 0;
      row.epsHigh4 = Number.isFinite(row.EPS) && last4.every(value => row.EPS >= value.EPS);
      row.epsHigh8 = Number.isFinite(row.EPS) && last8.every(value => row.EPS >= value.EPS);
      row.grossMarginImprovingStreak = [row, previous, list[index - 2]].every(value => Number.isFinite(value?.grossMargin))
        && row.grossMargin > previous.grossMargin && previous.grossMargin > list[index - 2].grossMargin;
      row.operatingMarginImprovingStreak = [row, previous, list[index - 2]].every(value => Number.isFinite(value?.operatingMargin))
        && row.operatingMargin > previous.operatingMargin && previous.operatingMargin > list[index - 2].operatingMargin;
      output.push(row);
    }
  }
  const seen = new Set();
  return output.filter(row => {
    const key = `${row.quarter}|${row.market}|${row.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main() {
  await fs.mkdir(RAW, { recursive: true });
  await fs.mkdir(new URL('../../data/research/', import.meta.url), { recursive: true });
  const marketPayload = await readJson(MARKET, []);
  const market = Array.isArray(marketPayload) ? marketPayload : marketPayload.benchmark || marketPayload.marketHistory || [];
  const tradingDates = market.map(row => row.date).sort();
  const stocks = await universe();
  const payloads = await mapLimit(stocks, Number(environment.QUALITY_FETCH_CONCURRENCY || 2), fetchFinancial);
  const finmindRecords = payloads.flatMap((payload, index) => normalizeFinMind(payload, stocks[index], tradingDates));
  const manual = await manualRecords(tradingDates);
  const records = enrich([...finmindRecords, ...manual]);
  const quarters = new Set(records.map(row => row.quarter));
  const symbols = new Set(records.map(row => row.symbol));
  const report = {
    generatedAt: new Date().toISOString(),
    requestedSymbols: stocks.length,
    successfulSymbols: payloads.filter(row => (row.data || []).length).length,
    cachedSymbols: payloads.filter(row => row.cached).length,
    failedSymbols: payloads.filter(row => row.error).length,
    manualRecords: manual.length,
    records: records.length,
    symbols: symbols.size,
    quarters: quarters.size,
    source: 'FinMind TaiwanStockFinancialStatements + manual CSV fallback',
    warning: '缺少逐筆歷史公布時間，採保守財報期限 T+1。'
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify({ generatedAt: report.generatedAt, records }, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`獲利品質資料：${records.length} 筆、${symbols.size} 檔、${quarters.size} 季。`);
}

await main();
