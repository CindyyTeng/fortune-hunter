import fs from 'node:fs/promises';

const AUDIT = new URL('../../data/research/institutional-data-audit.json', import.meta.url);
const DATA = new URL('../../data/institutional/institutional-trades.json', import.meta.url);
const VALIDATION = new URL('../../data/institutional/validation-report.json', import.meta.url);
const DOC = new URL('../../docs/INSTITUTIONAL_DATA_PIPELINE.md', import.meta.url);

async function readJson(url, fallback) {
  try {
    return JSON.parse(await fs.readFile(url, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) counts[row[key] || 'UNKNOWN'] = (counts[row[key] || 'UNKNOWN'] || 0) + 1;
  return counts;
}

const [audit, data, validation] = await Promise.all([
  readJson(AUDIT, { sources: {}, fetchRuns: [] }),
  readJson(DATA, { records: [] }),
  readJson(VALIDATION, null)
]);

const records = data.records || [];
const dates = new Set(records.map(row => row.date).filter(Boolean));
const symbols = new Set(records.map(row => row.symbol).filter(Boolean));
const safe = records.filter(row => row.isPointInTimeSafe);
const bySource = countBy(records, 'source');
const missing = [];

if (!safe.length) missing.push('目前沒有可供 point-in-time 回測的安全資料。');
if (dates.size < 1_000) missing.push('有效交易日不足 1000 天，尚不足以做 36/12 個月 walk-forward。');
if (symbols.size < 100) missing.push('股票數不足 100 檔，市場涵蓋度不足。');
if (validation?.status !== 'VALID') missing.push('法人資料驗證尚未通過。');

audit.summary = {
  generatedAt: new Date().toISOString(),
  totalRecords: records.length,
  pointInTimeSafeRecords: safe.length,
  distinctDates: dates.size,
  distinctSymbols: symbols.size,
  recordsBySource: bySource,
  validationStatus: validation?.status || 'NOT_RUN',
  enoughForWalkForward: safe.length >= 50_000 && dates.size >= 1_000 && symbols.size >= 100 && validation?.status === 'VALID',
  missing
};

const md = `# 法人資料管線稽核

產生時間：${audit.summary.generatedAt}

## 摘要

- 總資料筆數：${audit.summary.totalRecords}
- point-in-time 安全筆數：${audit.summary.pointInTimeSafeRecords}
- 交易日數：${audit.summary.distinctDates}
- 股票檔數：${audit.summary.distinctSymbols}
- 驗證狀態：${audit.summary.validationStatus}
- 是否足夠 walk-forward：${audit.summary.enoughForWalkForward ? '是' : '否'}

## 官方來源探測

- 證交所 T86：${audit.sources?.twseT86?.status || '尚未探測'}
- 證交所 OpenAPI：${audit.sources?.twseOpenApi?.status || '尚未探測'}
- 櫃買中心 OpenAPI：${audit.sources?.tpexOpenApi?.status || '尚未探測'}

## 資料來源筆數

${Object.entries(bySource).map(([source, count]) => `- ${source}：${count}`).join('\n') || '- 尚無資料'}

## 缺口

${missing.length ? missing.map(item => `- ${item}`).join('\n') : '- 目前沒有重大缺口。'}

## 結論

目前資料管線已能保存官方來源回傳資料，但在沒有可驗證歷史公布時間的情況下，系統會保守標記為非 point-in-time safe。
因此投信連買強勢股回檔策略尚不能宣稱完成真實 walk-forward 驗證。
`;

await fs.writeFile(AUDIT, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
await fs.writeFile(DOC, md, 'utf8');

console.log(`institutional audit: records=${records.length}, safe=${safe.length}, validation=${audit.summary.validationStatus}`);
if (!audit.summary.enoughForWalkForward) console.log('法人歷史資料不足，尚無法完成真實 walk-forward 驗證');
