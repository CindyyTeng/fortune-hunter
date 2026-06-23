import fs from 'node:fs/promises';

const OUTPUT = new URL('../../data/research/margin-source-probe.json', import.meta.url);
const probes = [
  ['TWSE', 'latest_openapi', 'https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN', false],
  ['TWSE', 'historical_rwd', 'https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=20250623&selectType=ALL&response=json', true],
  ['TPEX', 'latest_openapi', 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance', false],
  ['TPEX', 'historical_page', 'https://www.tpex.org.tw/www/zh-tw/margin/balance?date=2025/06/23&id=&response=json', true]
];

const results = [];
for (const [market, id, url, historical] of probes) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const rows = Array.isArray(payload)
      ? payload.length
      : payload.tables?.reduce((sum, table) => sum + (table.data?.length || 0), 0) || 0;
    results.push({ market, id, url, status: 'AVAILABLE', rows, supportsHistoricalDate: historical, returnedDate: payload.date || null });
  } catch (error) {
    results.push({ market, id, url, status: 'FAILED', rows: 0, supportsHistoricalDate: historical, error: error.message });
  }
}
const historicalMarkets = new Set(results.filter(row => row.status === 'AVAILABLE' && row.supportsHistoricalDate).map(row => row.market));
const report = {
  generatedAt: new Date().toISOString(),
  status: historicalMarkets.size === 2 ? 'AVAILABLE' : 'PARTIAL',
  historicalBackfillSupported: historicalMarkets.size === 2,
  pointInTimePolicy: 'T 日收盤資料僅允許 T+1 交易日使用；歷史逐筆公布時間仍採保守假設。',
  sources: results
};
await fs.mkdir(new URL('../../data/research/', import.meta.url), { recursive: true });
await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`融資融券來源：${report.status}，歷史回填 ${report.historicalBackfillSupported ? '可用' : '不可用'}。`);
