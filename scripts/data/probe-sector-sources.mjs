import fs from 'node:fs/promises';

const SOURCES = [
  {
    id: 'twse-company-profile',
    market: 'TWSE',
    url: 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',
    symbolField: '公司代號',
    sectorField: '產業別'
  },
  {
    id: 'tpex-company-profile',
    market: 'TPEX',
    url: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O',
    symbolField: 'SecuritiesCompanyCode',
    sectorField: 'SecuritiesIndustryCode'
  }
];
const RAW_DIR = new URL('../../data/sector/raw/', import.meta.url);
const OUTPUT = new URL('../../data/research/sector-source-probe.json', import.meta.url);

async function fetchJson(source) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(source.url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { rows: await response.json(), status: response.status, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

await fs.mkdir(RAW_DIR, { recursive: true });
await fs.mkdir(new URL('../../data/research/', import.meta.url), { recursive: true });
const results = [];
for (const source of SOURCES) {
  try {
    const { rows, status, attempts } = await fetchJson(source);
    const list = Array.isArray(rows) ? rows : [];
    await fs.writeFile(new URL(`${source.market.toLowerCase()}-company-profile.json`, RAW_DIR), `${JSON.stringify(list)}\n`, 'utf8');
    const fields = Object.keys(list[0] || {});
    results.push({
      ...source,
      status: 'AVAILABLE',
      httpStatus: status,
      attempts,
      rows: list.length,
      fields,
      hasSymbol: fields.includes(source.symbolField),
      hasSector: fields.includes(source.sectorField),
      classificationMode: 'static_current_classification',
      supportsHistoricalDate: false,
      pointInTimeSafe: false,
      suitableForCurrentClassification: list.length > 100,
      suitableForHistoricalBacktest: false
    });
  } catch (error) {
    results.push({ ...source, status: 'FAILED', error: error.message, rows: 0 });
  }
}
const report = {
  generatedAt: new Date().toISOString(),
  status: results.every(row => row.status === 'AVAILABLE') ? 'AVAILABLE' : 'PARTIAL',
  classificationMode: 'static_current_classification',
  pointInTimeSafe: false,
  warning: '官方端點提供現行公司產業分類，沒有歷史分類生效日；回測套用現行分類，存在分類變更與倖存者偏差。',
  sources: results
};
await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`產業來源探測：${report.status}，TWSE ${results[0]?.rows || 0} 筆，TPEx ${results[1]?.rows || 0} 筆。`);
