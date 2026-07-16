import fs from 'node:fs/promises';

const MARKET = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const RAW = new URL('../../data/revenue/raw/official/', import.meta.url);
const OUTPUT = new URL('../../data/revenue/monthly-revenue.json', import.meta.url);
const AUDIT = new URL('../../data/research/official-revenue-universe-audit.json', import.meta.url);
const START_MONTH = process.env.OFFICIAL_REVENUE_START_MONTH || '2015-01';
const CONCURRENCY = Number(process.env.OFFICIAL_REVENUE_CONCURRENCY || 3);

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const number = value => {
  const parsed = Number(String(value ?? '').replaceAll(',', '').replaceAll('%', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
};

function addMonths(month, count) {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + count);
  return date.toISOString().slice(0, 7);
}

function monthsBetween(start, end) {
  const rows = [];
  for (let month = start; month <= end; month = addMonths(month, 1)) rows.push(month);
  return rows;
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

function cleanHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .trim();
}

function parsePage(html, revenueMonth, market) {
  const records = [];
  for (const match of html.matchAll(/<tr\s+align=['"]?right['"]?[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(row => cleanHtml(row[1]));
    const symbol = cells[0]?.trim();
    const monthlyRevenue = number(cells[2]);
    if (!/^\d{4}$/.test(symbol || '') || !Number.isFinite(monthlyRevenue) || monthlyRevenue <= 0) continue;
    records.push({
      symbol,
      stockName: cells[1],
      market,
      revenueMonth,
      monthlyRevenue,
      reportedMoM: number(cells[5]),
      reportedYoY: number(cells[6]),
      source: `MOPS ${market} t21sc03`
    });
  }
  return records;
}

async function fetchMonth(revenueMonth, marketCode) {
  const market = marketCode === 'sii' ? 'TWSE' : 'TPEX';
  const cache = new URL(`${revenueMonth}-${market}.json`, RAW);
  try {
    return { market, revenueMonth, rows: JSON.parse(await fs.readFile(cache, 'utf8')), cached: true };
  } catch {}
  const [year, month] = revenueMonth.split('-').map(Number);
  const rocYear = year - 1911;
  const url = `https://mopsov.twse.com.tw/nas/t21/${marketCode}/t21sc03_${rocYear}_${month}_0.html`;
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(45_000),
        headers: { 'User-Agent': 'fortune-hunter-point-in-time-revenue/1.0' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = new TextDecoder('big5').decode(await response.arrayBuffer());
      const rows = parsePage(html, revenueMonth, market);
      if (rows.length < 20) throw new Error(`解析筆數異常：${rows.length}`);
      await fs.writeFile(cache, `${JSON.stringify(rows)}\n`, 'utf8');
      await sleep(180);
      return { market, revenueMonth, rows, cached: false, url };
    } catch (error) {
      lastError = error;
      await sleep(attempt * 800);
    }
  }
  return { market, revenueMonth, rows: [], cached: false, url, error: lastError?.message || '未知錯誤' };
}

async function mapLimit(items, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return output;
}

function enrich(records, tradingDates) {
  const bySymbol = new Map();
  for (const row of records) {
    const list = bySymbol.get(row.symbol) || [];
    list.push(row);
    bySymbol.set(row.symbol, list);
  }
  const output = [];
  for (const list of bySymbol.values()) {
    list.sort((left, right) => left.revenueMonth.localeCompare(right.revenueMonth));
    const byMonth = new Map(list.map(row => [row.revenueMonth, row]));
    for (let index = 0; index < list.length; index += 1) {
      const row = list[index];
      const prior = list[index - 1];
      const priorYear = byMonth.get(`${Number(row.revenueMonth.slice(0, 4)) - 1}${row.revenueMonth.slice(4)}`);
      const announcedDate = `${addMonths(row.revenueMonth, 1)}-10`;
      const effectiveDate = nextTradingDay(tradingDates, announcedDate);
      if (!effectiveDate) continue;
      const YoY = priorYear?.monthlyRevenue ? (row.monthlyRevenue / priorYear.monthlyRevenue - 1) * 100 : row.reportedYoY;
      const MoM = prior?.monthlyRevenue ? (row.monthlyRevenue / prior.monthlyRevenue - 1) * 100 : row.reportedMoM;
      const current3 = list.slice(Math.max(0, index - 2), index + 1);
      const prior3 = current3.map(value => byMonth.get(`${Number(value.revenueMonth.slice(0, 4)) - 1}${value.revenueMonth.slice(4)}`));
      const threeMonthCumulativeYoY = current3.length === 3 && prior3.every(Boolean)
        ? (current3.reduce((sum, value) => sum + value.monthlyRevenue, 0)
          / prior3.reduce((sum, value) => sum + value.monthlyRevenue, 0) - 1) * 100
        : null;
      const current12 = list.slice(Math.max(0, index - 11), index + 1);
      const prior12 = current12.map(value => byMonth.get(`${Number(value.revenueMonth.slice(0, 4)) - 1}${value.revenueMonth.slice(4)}`));
      const twelveMonthCumulativeYoY = current12.length === 12 && prior12.every(Boolean)
        ? (current12.reduce((sum, value) => sum + value.monthlyRevenue, 0)
          / prior12.reduce((sum, value) => sum + value.monthlyRevenue, 0) - 1) * 100
        : null;
      const history = list.slice(Math.max(0, index - 23), index + 1);
      output.push({
        ...row,
        announcedDate,
        publishedAt: `${announcedDate}T23:59:59+08:00`,
        effectiveDate,
        MoM,
        YoY,
        threeMonthCumulativeYoY,
        twelveMonthCumulativeYoY,
        revenueHigh6: index >= 5 && row.monthlyRevenue >= Math.max(...history.slice(-6).map(value => value.monthlyRevenue)),
        revenueHigh12: index >= 11 && row.monthlyRevenue >= Math.max(...history.slice(-12).map(value => value.monthlyRevenue)),
        revenueHigh24: index >= 23 && row.monthlyRevenue >= Math.max(...history.map(value => value.monthlyRevenue)),
        consecutiveYoYGrowth2: Number.isFinite(YoY) && YoY > 0 && prior?.YoY > 0,
        consecutiveYoYGrowth3: Number.isFinite(YoY) && YoY > 0 && prior?.YoY > 0 && list[index - 2]?.YoY > 0,
        yoyAcceleration: Number.isFinite(YoY) && Number.isFinite(prior?.YoY) && YoY > prior.YoY,
        declineToGrowth: Number.isFinite(YoY) && prior?.YoY < 0 && YoY > 0,
        publishedAtAssumption: 'legal_deadline_market_close',
        pointInTimeMode: 'conservative_assumption',
        isPointInTimeSafe: true,
        fullyVerifiedPointInTime: false,
        pointInTimeWarning: '缺少逐筆歷史公布時間，採次月 10 日收盤後、下一交易日才可使用。'
      });
      row.YoY = YoY;
    }
  }
  return output.sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate) || left.symbol.localeCompare(right.symbol));
}

const marketPayload = JSON.parse(await fs.readFile(MARKET, 'utf8'));
const tradingDates = marketPayload.benchmark.map(row => row.date).sort();
const lastMarketMonth = tradingDates.at(-1).slice(0, 7);
const endMonth = process.env.OFFICIAL_REVENUE_END_MONTH || addMonths(lastMarketMonth, -1);
const jobs = monthsBetween(START_MONTH, endMonth).flatMap(revenueMonth => [
  { revenueMonth, marketCode: 'sii' },
  { revenueMonth, marketCode: 'otc' }
]);

await fs.mkdir(RAW, { recursive: true });
await fs.mkdir(new URL('../../data/research/', import.meta.url), { recursive: true });
const downloads = await mapLimit(jobs, job => fetchMonth(job.revenueMonth, job.marketCode));
const unique = new Map();
for (const result of downloads) {
  for (const row of result.rows) unique.set(`${row.revenueMonth}|${row.market}|${row.symbol}`, row);
}
const records = enrich([...unique.values()], tradingDates);
const latestEffectiveMonth = [...new Set(records.map(row => row.revenueMonth))].sort().at(-1) || null;
const audit = {
  generatedAt: new Date().toISOString(),
  range: { start: START_MONTH, end: endMonth },
  requestedPages: jobs.length,
  successfulPages: downloads.filter(row => row.rows.length).length,
  failedPages: downloads.filter(row => row.error).length,
  cachedPages: downloads.filter(row => row.cached).length,
  records: records.length,
  symbols: new Set(records.map(row => row.symbol)).size,
  months: new Set(records.map(row => row.revenueMonth)).size,
  twseRecords: records.filter(row => row.market === 'TWSE').length,
  tpexRecords: records.filter(row => row.market === 'TPEX').length,
  latestEffectiveMonth,
  symbolsAtLatestEffectiveMonth: new Set(records.filter(row => row.revenueMonth === latestEffectiveMonth).map(row => row.symbol)).size,
  pointInTimeSafeRecords: records.filter(row => row.isPointInTimeSafe).length,
  warning: '公布日採法定申報期限的保守假設，不是逐筆 fully verified publishedAt。',
  failures: downloads.filter(row => row.error).map(row => ({
    revenueMonth: row.revenueMonth,
    market: row.market,
    error: row.error
  }))
};

await fs.writeFile(OUTPUT, `${JSON.stringify({ generatedAt: audit.generatedAt, records })}\n`, 'utf8');
await fs.writeFile(AUDIT, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(audit, null, 2));
