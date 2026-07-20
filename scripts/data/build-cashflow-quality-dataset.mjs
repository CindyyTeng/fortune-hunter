import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MARKET = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const RAW = new URL('../../data/cashflow-quality/raw/', import.meta.url);
const OUTPUT = new URL('../../data/cashflow-quality/cashflow-quality.json', import.meta.url);
const REPORT = new URL('../../data/research/cashflow-quality-build-report.json', import.meta.url);
const environment = globalThis.process?.env || {};
const START_YEAR = Number(environment.CASHFLOW_START_YEAR || 2015);
const END_YEAR = Number(environment.CASHFLOW_END_YEAR || new Date().getFullYear());
const CONCURRENCY = Number(environment.CASHFLOW_FETCH_CONCURRENCY || 2);
const FETCH_SKIP = environment.CASHFLOW_FETCH_SKIP === '1';

const endpoints = {
  income: 'ajax_t163sb04',
  balance: 'ajax_t163sb05',
  cashflow: 'ajax_t163sb20'
};
const markets = ['sii', 'otc'];

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const number = value => {
  const text = String(value ?? '').replaceAll(',', '').replaceAll('%', '').trim();
  if (!text || text === '--') return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};
const clean = value => String(value || '')
  .replace(/<br\s*\/?\s*>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

async function readJson(url, fallback = null) {
  try { return JSON.parse(await fs.readFile(url, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
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

function deadline(year, quarter) {
  if (quarter === 1) return `${year}-05-30`;
  if (quarter === 2) return `${year}-08-31`;
  if (quarter === 3) return `${year}-11-29`;
  return `${year + 1}-03-31`;
}

function rowsFromTable(table) {
  return [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(match => [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(cell => clean(cell[1])))
    .filter(row => row.length);
}

function headerIndex(headers, patterns) {
  return headers.findIndex(header => {
    const normalized = header.replace(/\s+/g, '');
    return patterns.some(pattern => normalized.includes(pattern.replace(/\s+/g, '')));
  });
}

function field(row, headers, patterns) {
  const index = headerIndex(headers, patterns);
  return index >= 0 ? number(row[index]) : null;
}

function parseStatement(html, statement, year, quarter, market) {
  const records = [];
  let headers = null;
  for (const row of rowsFromTable(html)) {
    const companyIndex = row.findIndex(cell => cell.replace(/\s+/g, '') === '公司代號');
    if (companyIndex >= 0) {
      headers = row.slice(companyIndex);
      continue;
    }
    const symbolIndex = row.findIndex(cell => /^\d{4}$/.test(cell));
    if (symbolIndex < 0 || !headers) continue;
    const normalized = row.slice(symbolIndex);
    const alignedHeaders = headers.slice(0, normalized.length);
    const record = {
      symbol: normalized[0],
      stockName: normalized[1],
      market: market === 'sii' ? 'TWSE' : 'TPEX',
      quarter: `${year}Q${quarter}`
    };
    if (statement === 'income') {
      record.netIncomeCumulative = field(normalized, alignedHeaders, [
        '本期稅後淨利（淨損）', '本期稅後淨利', '本期淨利（淨損）',
        '本期淨利', '淨利（損）歸屬於母公司業主', '淨利（淨損）歸屬於母公司業主'
      ]);
    } else if (statement === 'balance') {
      record.cash = field(normalized, alignedHeaders, ['現金及約當現金']);
      record.currentAssets = field(normalized, alignedHeaders, ['流動資產']);
      record.inventory = field(normalized, alignedHeaders, ['存貨']);
      record.receivables = field(normalized, alignedHeaders, ['應收帳款', '應收款項']);
      record.totalAssets = field(normalized, alignedHeaders, ['資產總計', '資產總額']);
      record.currentLiabilities = field(normalized, alignedHeaders, ['流動負債']);
      record.totalLiabilities = field(normalized, alignedHeaders, ['負債總計', '負債總額']);
      record.totalEquity = field(normalized, alignedHeaders, ['權益總計', '權益總額']);
    } else {
      record.operatingCashFlowCumulative = field(normalized, alignedHeaders, ['營業活動之淨現金流入（流出）']);
      record.investingCashFlowCumulative = field(normalized, alignedHeaders, ['投資活動之淨現金流入（流出）']);
      record.financingCashFlowCumulative = field(normalized, alignedHeaders, ['籌資活動之淨現金流入（流出）']);
    }
    records.push(record);
  }
  return records;
}

async function fetchPage(task) {
  const directory = new URL(`${task.year}/`, RAW);
  await fs.mkdir(directory, { recursive: true });
  const cache = new URL(`${task.year}Q${task.quarter}-${task.market}-${task.statement}.html`, directory);
  try {
    const html = await fs.readFile(cache, 'utf8');
    return { ...task, html, cached: true };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (FETCH_SKIP) return { ...task, html: '', skipped: true };
  const query = new URLSearchParams({
    encodeURIComponent: '1',
    step: '1',
    firstin: '1',
    off: '1',
    TYPEK: task.market,
    year: String(task.year - 1911),
    season: String(task.quarter)
  });
  const url = `https://mopsov.twse.com.tw/mops/web/${endpoints[task.statement]}?${query}`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'fortune-hunter-cashflow-research/1.0' },
        signal: AbortSignal.timeout(45_000)
      });
      const html = await response.text();
      if (!response.ok || html.length < 10_000 || html.includes('查無資料')) {
        throw new Error(`HTTP ${response.status} 或回傳資料不足`);
      }
      await fs.writeFile(cache, html, 'utf8');
      await sleep(250);
      return { ...task, html, url };
    } catch (error) {
      lastError = error;
      await sleep(attempt * 1500);
    }
  }
  return { ...task, html: '', error: lastError?.message, url };
}

async function mapLimit(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return output;
}

function singleQuarterValue(row, lookup, cumulativeField) {
  if (!Number.isFinite(row?.[cumulativeField])) return null;
  const year = Number(row.quarter.slice(0, 4));
  const quarter = Number(row.quarter.at(-1));
  const previous = quarter === 1 ? null : lookup.get(`${year}Q${quarter - 1}`);
  return row[cumulativeField] - (quarter === 1 ? 0 : previous?.[cumulativeField] || 0);
}

function mergeStatements(pages, tradingDates) {
  const merged = new Map();
  for (const page of pages) {
    if (!page.html) continue;
    for (const row of parseStatement(page.html, page.statement, page.year, page.quarter, page.market)) {
      const key = `${row.market}|${row.symbol}|${row.quarter}`;
      merged.set(key, { ...(merged.get(key) || {}), ...row });
    }
  }
  const bySymbol = new Map();
  for (const row of merged.values()) {
    const groupKey = `${row.market}|${row.symbol}`;
    const list = bySymbol.get(groupKey) || [];
    list.push(row);
    bySymbol.set(groupKey, list);
  }
  const output = [];
  for (const list of bySymbol.values()) {
    list.sort((left, right) => left.quarter.localeCompare(right.quarter));
    const lookup = new Map(list.map(row => [row.quarter, row]));
    for (const row of list) {
      const year = Number(row.quarter.slice(0, 4));
      const quarter = Number(row.quarter.at(-1));
      const previous = lookup.get(quarter === 1 ? `${year - 1}Q4` : `${year}Q${quarter - 1}`);
      const priorYear = lookup.get(`${year - 1}Q${quarter}`);
      const announcedDate = deadline(year, quarter);
      const effectiveDate = nextTradingDay(tradingDates, announcedDate);
      if (!effectiveDate || !Number.isFinite(row.totalAssets)) continue;
      const operatingCashFlow = singleQuarterValue(row, lookup, 'operatingCashFlowCumulative');
      const netIncome = singleQuarterValue(row, lookup, 'netIncomeCumulative');
      const priorYearOperatingCashFlow = singleQuarterValue(priorYear, lookup, 'operatingCashFlowCumulative');
      const priorYearNetIncome = singleQuarterValue(priorYear, lookup, 'netIncomeCumulative');
      const priorOperatingCashFlow = singleQuarterValue(previous, lookup, 'operatingCashFlowCumulative');
      const averageAssets = Number.isFinite(previous?.totalAssets)
        ? (row.totalAssets + previous.totalAssets) / 2
        : row.totalAssets;
      output.push({
        ...row,
        announcedDate,
        publishedAt: `${announcedDate}T23:59:59+08:00`,
        effectiveDate,
        operatingCashFlow,
        netIncome,
        operatingCashFlowToAssets: operatingCashFlow / averageAssets * 100,
        accrualRatio: (netIncome - operatingCashFlow) / averageAssets * 100,
        cashConversion: netIncome > 0 ? operatingCashFlow / netIncome : null,
        debtRatio: row.totalLiabilities / row.totalAssets * 100,
        currentRatio: row.currentLiabilities > 0 ? row.currentAssets / row.currentLiabilities : null,
        assetGrowthYoY: priorYear?.totalAssets > 0 ? (row.totalAssets / priorYear.totalAssets - 1) * 100 : null,
        debtRatioChangeYoY: Number.isFinite(priorYear?.totalLiabilities)
          ? row.totalLiabilities / row.totalAssets * 100 - priorYear.totalLiabilities / priorYear.totalAssets * 100
          : null,
        operatingCashFlowYoY: priorYearOperatingCashFlow
          ? (operatingCashFlow / priorYearOperatingCashFlow - 1) * 100
          : null,
        netIncomeYoY: priorYearNetIncome
          ? (netIncome / priorYearNetIncome - 1) * 100
          : null,
        operatingCashFlowTurnPositive: Number.isFinite(priorOperatingCashFlow)
          && priorOperatingCashFlow <= 0 && operatingCashFlow > 0,
        source: 'MOPS official historical quarterly statements',
        publishedAtAssumption: 'latest_legal_filing_deadline_after_market_close',
        pointInTimeMode: 'conservative_assumption',
        isPointInTimeSafe: true,
        fullyVerifiedPointInTime: false,
        pointInTimeWarning: '缺少逐筆歷史公布時間，採用法定最晚申報日收盤後公布、下一交易日可用的保守假設。'
      });
    }
  }
  return output.sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate)
    || left.symbol.localeCompare(right.symbol));
}

async function main() {
  await fs.mkdir(RAW, { recursive: true });
  await fs.mkdir(new URL('../../data/research/', import.meta.url), { recursive: true });
  const marketPayload = await readJson(MARKET, {});
  const tradingDates = (marketPayload.benchmark || marketPayload.marketHistory || marketPayload || [])
    .map(row => row.date).filter(Boolean).sort();
  const tasks = [];
  for (let year = START_YEAR; year <= END_YEAR; year += 1) {
    for (let quarter = 1; quarter <= 4; quarter += 1) {
      if (deadline(year, quarter) > tradingDates.at(-1)) continue;
      for (const market of markets) {
        for (const statement of Object.keys(endpoints)) tasks.push({ year, quarter, market, statement });
      }
    }
  }
  const pages = await mapLimit(tasks, CONCURRENCY, fetchPage);
  const records = mergeStatements(pages, tradingDates);
  const symbols = new Set(records.map(row => row.symbol));
  const quarters = new Set(records.map(row => row.quarter));
  const report = {
    generatedAt: new Date().toISOString(),
    requestedPages: tasks.length,
    successfulPages: pages.filter(row => row.html).length,
    failedPages: pages.filter(row => row.error).map(({ year, quarter, market, statement, error }) => ({ year, quarter, market, statement, error })),
    records: records.length,
    symbols: symbols.size,
    quarters: quarters.size,
    pointInTimeSafeRecords: records.filter(row => row.isPointInTimeSafe).length,
    startQuarter: [...quarters].sort()[0] || null,
    endQuarter: [...quarters].sort().at(-1) || null,
    source: 'MOPS official historical quarterly statements',
    warning: '本資料採法定最晚申報日作為保守 point-in-time 假設，未取得逐筆歷史公布時間。'
  };
  await fs.mkdir(new URL('../../data/cashflow-quality/', import.meta.url), { recursive: true });
  await fs.writeFile(OUTPUT, `${JSON.stringify({ generatedAt: report.generatedAt, records })}\n`, 'utf8');
  await fs.writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { deadline, mergeStatements, nextTradingDay, parseStatement, singleQuarterValue };
