import fs from 'node:fs/promises';

const INPUT = new URL('../../data/revenue/monthly-revenue.json', import.meta.url);
const OUTPUT = new URL('../../data/revenue/validation-report.json', import.meta.url);
let payload;
try { payload = JSON.parse(await fs.readFile(INPUT, 'utf8')); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
  payload = { records: [] };
}
const records = payload.records || [];
const errors = [];
const keys = new Set();
for (const row of records) {
  const key = `${row.revenueMonth}|${row.market}|${row.symbol}`;
  if (keys.has(key)) errors.push(`重複鍵：${key}`);
  keys.add(key);
  if (!/^\d{4}$/.test(row.symbol || '') || !/^\d{4}-\d{2}$/.test(row.revenueMonth || '')) errors.push(`識別欄位錯誤：${key}`);
  if (!Number.isFinite(row.monthlyRevenue) || row.monthlyRevenue < 0) errors.push(`營收錯誤：${key}`);
  if (row.effectiveDate <= row.announcedDate || row.isPointInTimeSafe !== true) errors.push(`時間點錯誤：${key}`);
}
const months = new Set(records.map(row => row.revenueMonth)).size;
const symbols = new Set(records.map(row => row.symbol)).size;
const report = {
  generatedAt: new Date().toISOString(),
  status: records.length > 0 && months >= 48 && symbols >= 100 && errors.length === 0 ? 'VALID' : records.length ? 'INSUFFICIENT' : 'MISSING_DATA',
  records: records.length, symbols, months,
  pointInTimeSafeRecords: records.filter(row => row.isPointInTimeSafe).length,
  fullyVerifiedPointInTimeRecords: records.filter(row => row.fullyVerifiedPointInTime).length,
  conservativeAssumptionRecords: records.filter(row => row.pointInTimeMode === 'conservative_assumption').length,
  errorCount: errors.length, errors: errors.slice(0, 100),
  warning: '採次月 10 日後 T+1 保守政策；歷史彙總檔的事後更正風險尚未完全排除。'
};
await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`月營收驗證：${report.status}，${report.symbols} 檔、${report.months} 個月份。`);
