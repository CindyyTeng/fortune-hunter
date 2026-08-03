import { SOURCES, normalizeOfficialCsv, writeJson } from './material-information-utils.mjs';

const OUTPUT = new URL('../../data/research/material-information-source-probe.json', import.meta.url);

async function fetchText(url, options = {}, attempts = 3) {
  let error;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { status: response.status, text };
    } catch (caught) {
      error = caught;
      await new Promise(resolve => setTimeout(resolve, attempt * 800));
    }
  }
  throw error;
}

async function probeDaily(sourceKey) {
  const source = SOURCES[sourceKey];
  try {
    const response = await fetchText(source.url, { headers: { 'user-agent': 'fortune-hunter-source-probe/1.0' } });
    const rows = normalizeOfficialCsv(response.text, sourceKey);
    return {
      source: sourceKey,
      url: source.url,
      status: response.status,
      rows: rows.length,
      dates: [...new Set(rows.map(row => row.announcedDate))],
      hasPrecisePublishedAt: rows.every(row => Boolean(row.publishedAt)),
      supportsHistoricalBulkDate: false,
      suitability: '適合每日排程累積，不是多年歷史批次端點'
    };
  } catch (error) {
    return { source: sourceKey, url: source.url, error: error.message, rows: 0 };
  }
}

async function probeCompanyHistory(symbol, rocYear) {
  const body = new URLSearchParams({
    encodeURIComponent: '1', step: '1', firstin: '1', off: '1',
    co_id: symbol, TYPEK: 'all', year: String(rocYear), month: 'all', b_date: '', e_date: ''
  });
  try {
    const response = await fetchText('https://mopsov.twse.com.tw/mops/web/ajax_t05st01', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'fortune-hunter-source-probe/1.0',
        referer: 'https://mopsov.twse.com.tw/mops/web/t05st01'
      },
      body
    });
    const rowCount = [...response.text.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
      .filter(match => [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].length >= 5
        && new RegExp(`(?:^|\\D)${symbol}(?:\\D|$)`).test(match[1])).length;
    return { symbol, rocYear, status: response.status, rowCount, supportsHistoricalDate: rowCount > 0 };
  } catch (error) {
    return { symbol, rocYear, rowCount: 0, error: error.message, supportsHistoricalDate: false };
  }
}

const daily = await Promise.all(['TWSE', 'TPEX'].map(probeDaily));
const companyHistory = [];
for (const [symbol, year] of [['2330', 113], ['2330', 110], ['6488', 113], ['6488', 110]]) {
  companyHistory.push(await probeCompanyHistory(symbol, year));
  await new Promise(resolve => setTimeout(resolve, 500));
}
const report = {
  generatedAt: new Date().toISOString(),
  conclusion: {
    officialDailySnapshotAvailable: daily.some(item => item.rows > 0),
    companyAnnualHistoryAvailable: companyHistory.every(item => item.supportsHistoricalDate),
    allMarketHistoricalBulkEndpointConfirmed: false,
    recommendedPlan: '每日排程累積官方 CSV；歷史研究先人工匯入，避免對 MOPS 逐公司大量請求。'
  },
  daily,
  companyHistory
};
await writeJson(OUTPUT, report);
console.log(`重大訊息來源探測完成：每日 ${daily.reduce((sum, item) => sum + item.rows, 0)} 筆；單一公司歷史查詢 ${companyHistory.filter(item => item.supportsHistoricalDate).length}/${companyHistory.length} 成功。`);
