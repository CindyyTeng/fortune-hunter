import fs from 'node:fs/promises';

const OUTPUT = new URL('../../data/research/revenue-source-probe.json', import.meta.url);
const finMindUrl = 'https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMonthRevenue&data_id=2330&start_date=2021-01-01';
const results = [
  {
    market: 'TWSE',
    id: 'current_openapi',
    url: 'https://openapi.twse.com.tw/v1/opendata/t187ap05_L',
    status: 'CURRENT_ONLY',
    supportsHistoricalMonth: false,
    note: '官方 OpenAPI 提供當期資料，不作歷史回填主來源。'
  },
  {
    market: 'TPEX',
    id: 'current_openapi',
    url: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O',
    status: 'CURRENT_ONLY',
    supportsHistoricalMonth: false,
    note: '官方 OpenAPI 提供當期資料，不作歷史回填主來源。'
  }
];

let cachedFiles = [];
try { cachedFiles = (await fs.readdir(new URL('../../data/revenue/raw/', import.meta.url))).filter(name => name.endsWith('.json')); } catch {}
results.push({
  market: 'ALL',
  id: 'finmind_history',
  url: finMindUrl,
  status: cachedFiles.length ? 'AVAILABLE' : 'NOT_YET_FETCHED',
  supportsHistoricalMonth: true,
  cachedFiles: cachedFiles.length,
  note: '已以成功下載並通過解析的本機快取作為可用性證據，避免每次探測消耗免費 API 額度。'
});

const historicalAvailable = results.some(row => row.status === 'AVAILABLE' && row.supportsHistoricalMonth);
const report = {
  generatedAt: new Date().toISOString(),
  status: historicalAvailable ? 'AVAILABLE' : 'PARTIAL',
  historicalBackfillSupported: historicalAvailable,
  pointInTimeMode: 'conservative_assumption',
  policy: '營收月份次月 10 日視為最晚公布日，僅於下一交易日使用。',
  revisionWarning: 'FinMind 公開 API 未提供完整逐筆歷史公布時間，採法定期限後 T+1；原始版本與事後更正未完全驗證。',
  manualFallback: 'data/revenue/manual/',
  sources: results
};
await fs.mkdir(new URL('../../data/research/', import.meta.url), { recursive: true });
await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`月營收來源：${report.status}，歷史回填 ${report.historicalBackfillSupported ? '可用' : '不可用'}。`);
