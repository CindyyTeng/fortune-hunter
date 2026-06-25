import fs from 'node:fs/promises';

const RAW = new URL('../../data/quality/raw/', import.meta.url);
const OUTPUT = new URL('../../data/research/quality-source-probe.json', import.meta.url);
const environment = globalThis.process?.env || {};

async function readJson(url, fallback = null) {
  try { return JSON.parse(await fs.readFile(url, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function fetchSample() {
  if (environment.QUALITY_PROBE_FETCH_SKIP === '1') return { skipped: true, rows: [] };
  const url = 'https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockFinancialStatements&data_id=2330&start_date=2024-01-01';
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: { 'User-Agent': 'fortune-hunter-quality-research/1.0' }
    });
    const payload = await response.json();
    return {
      skipped: false,
      ok: response.ok && payload.status === 200,
      status: response.status,
      apiStatus: payload.status,
      rowCount: Array.isArray(payload.data) ? payload.data.length : 0,
      sampleFields: Object.keys(payload.data?.[0] || {}),
      rows: payload.data || [],
      url
    };
  } catch (error) {
    return { skipped: false, ok: false, error: error.message, url };
  }
}

async function main() {
  await fs.mkdir(RAW, { recursive: true });
  await fs.mkdir(new URL('../../data/quality/manual/', import.meta.url), { recursive: true });
  await fs.mkdir(new URL('../../data/research/', import.meta.url), { recursive: true });
  const cachedFiles = (await fs.readdir(RAW).catch(() => [])).filter(name => name.endsWith('.json'));
  const cachedRows = (await Promise.all(cachedFiles.slice(0, 20).map(file => readJson(new URL(file, RAW), { data: [] })))).reduce((sum, row) => sum + (row.data?.length || row.records?.length || 0), 0);
  const finmind = await fetchSample();
  const report = {
    generatedAt: new Date().toISOString(),
    sources: [
      {
        id: 'finmind_taiwan_stock_financial_statements',
        name: 'FinMind TaiwanStockFinancialStatements',
        freePublicSource: true,
        supportsHistoricalBackfill: finmind.ok === true || cachedFiles.length > 0,
        pointInTimeMode: 'conservative_assumption',
        recommendedForBuild: finmind.ok === true || cachedFiles.length > 0,
        probe: { ...finmind, rows: undefined }
      },
      {
        id: 'manual_csv',
        name: '人工 CSV 匯入',
        freePublicSource: true,
        supportsHistoricalBackfill: true,
        recommendedForBuild: true,
        notes: '當 API 無法取得完整財報時，可用 data/quality/manual 匯入。'
      }
    ],
    cached: { files: cachedFiles.length, sampledRows: cachedRows },
    warning: '財報若沒有逐筆歷史公布時間，採保守 T+1，不宣稱 fully verified point-in-time。'
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`獲利品質來源探測完成：FinMind ${finmind.ok ? '可用' : '未確認'}，快取 ${cachedFiles.length} 檔。`);
}

await main();
