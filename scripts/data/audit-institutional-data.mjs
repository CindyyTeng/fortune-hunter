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
const fullyVerified = records.filter(row => row.fullyVerifiedPointInTime === true);
const conservative = records.filter(row => row.conservativePointInTimeAssumption === true && row.isPointInTimeSafe);
const bySource = countBy(records, 'source');
const missing = [];

if (!safe.length) missing.push('目前沒有 point-in-time safe 資料。');
if (dates.size < 1_000) missing.push('交易日不足 1000 天，尚不足以做 36/12 個月 walk-forward。');
if (symbols.size < 100) missing.push('股票數不足 100 檔，市場涵蓋度不足。');
if (validation?.status !== 'VALID') missing.push('法人資料驗證尚未通過。');

audit.summary = {
  generatedAt: new Date().toISOString(),
  totalRecords: records.length,
  fullyVerifiedPointInTimeRecords: fullyVerified.length,
  conservativeAssumptionRecords: conservative.length,
  pointInTimeSafeRecords: safe.length,
  unsafeRecords: records.length - safe.length,
  distinctDates: dates.size,
  distinctSymbols: symbols.size,
  recordsBySource: bySource,
  validationStatus: validation?.status || 'NOT_RUN',
  validationErrorCount: validation?.errorCount || 0,
  validationWarningCount: validation?.warningCount || 0,
  enoughForWalkForward: safe.length >= 50_000 && dates.size >= 1_000 && symbols.size >= 100 && validation?.status === 'VALID',
  missing,
  warnings: [
    '目前沒有逐筆 fully verified publishedAt。',
    '保守假設僅允許 T 日資料於 T+1 交易日使用。',
    '資料日期不足時不得宣稱完成 walk-forward。'
  ]
};

const md = `# 法人資料管線稽核

產生時間：${audit.summary.generatedAt}

## 摘要

- 總資料筆數：${audit.summary.totalRecords}
- fully verified 筆數：${audit.summary.fullyVerifiedPointInTimeRecords}
- conservative assumption 筆數：${audit.summary.conservativeAssumptionRecords}
- 仍不安全筆數：${audit.summary.unsafeRecords}
- 交易日數：${audit.summary.distinctDates}
- 股票檔數：${audit.summary.distinctSymbols}
- 驗證狀態：${audit.summary.validationStatus}
- 是否足夠 walk-forward：${audit.summary.enoughForWalkForward ? '是' : '否'}

## 資料來源筆數

${Object.entries(bySource).map(([source, count]) => `- ${source}：${count}`).join('\n') || '- 尚無資料'}

## 缺口

${missing.length ? missing.map(item => `- ${item}`).join('\n') : '- 無'}

## 風險警告

${audit.summary.warnings.map(item => `- ${item}`).join('\n')}
`;

await fs.writeFile(AUDIT, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
await fs.writeFile(DOC, md, 'utf8');

console.log(`institutional audit: records=${records.length}, safe=${safe.length}, validation=${audit.summary.validationStatus}`);
if (!audit.summary.enoughForWalkForward) console.log('法人歷史資料不足，尚無法完成真實 walk-forward 驗證');
