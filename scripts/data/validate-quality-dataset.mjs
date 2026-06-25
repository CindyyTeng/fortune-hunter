import fs from 'node:fs/promises';

const INPUT = new URL('../../data/quality/financial-quality.json', import.meta.url);
const OUTPUT = new URL('../../data/quality/validation-report.json', import.meta.url);

let payload;
try { payload = JSON.parse(await fs.readFile(INPUT, 'utf8')); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
  payload = { records: [] };
}

const records = payload.records || [];
const errors = [];
const keys = new Set();
for (const row of records) {
  const key = `${row.quarter}|${row.market}|${row.symbol}`;
  if (keys.has(key)) errors.push(`重複資料：${key}`);
  keys.add(key);
  if (!/^\d{4}$/.test(row.symbol || '') || !/^\d{4}Q[1-4]$/.test(row.quarter || '')) errors.push(`格式錯誤：${key}`);
  if (!Number.isFinite(row.EPS) && !Number.isFinite(row.grossMargin) && !Number.isFinite(row.operatingMargin)) errors.push(`缺少核心品質欄位：${key}`);
  if (row.effectiveDate <= row.announcedDate || row.isPointInTimeSafe !== true) errors.push(`時間點不安全：${key}`);
}
const symbols = new Set(records.map(row => row.symbol)).size;
const quarters = new Set(records.map(row => row.quarter)).size;
const status = records.length > 0 && symbols >= 50 && quarters >= 12 && errors.length === 0 ? 'VALID'
  : records.length ? 'INSUFFICIENT' : 'MISSING_DATA';
const report = {
  generatedAt: new Date().toISOString(),
  status,
  records: records.length,
  symbols,
  quarters,
  pointInTimeSafeRecords: records.filter(row => row.isPointInTimeSafe).length,
  fullyVerifiedPointInTimeRecords: records.filter(row => row.fullyVerifiedPointInTime).length,
  conservativeAssumptionRecords: records.filter(row => row.pointInTimeMode === 'conservative_assumption').length,
  errorCount: errors.length,
  errors: errors.slice(0, 100),
  warning: '財報公布時間採保守 T+1，沒有逐筆 publishedAt 證據時不宣稱 fully verified。'
};
await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`獲利品質驗證：${report.status}，${symbols} 檔、${quarters} 季。`);
