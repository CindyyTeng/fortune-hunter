import fs from 'node:fs/promises';

const INPUT = new URL('../../data/margin/margin-trades.json', import.meta.url);
const OUTPUT = new URL('../../data/margin/validation-report.json', import.meta.url);
let payload;
try {
  payload = JSON.parse(await fs.readFile(INPUT, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  payload = { records: [] };
}
const records = payload.records || [];
const errors = [];
const keys = new Set();
for (const row of records) {
  const key = `${row.date}|${row.market}|${row.symbol}`;
  if (keys.has(key)) errors.push(`重複鍵：${key}`);
  keys.add(key);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date || '') || row.effectiveDate <= row.date) errors.push(`日期錯誤：${key}`);
  if (!/^\d{4}$/.test(row.symbol || '')) errors.push(`代號錯誤：${key}`);
  if (![row.marginBalance, row.marginChange, row.shortBalance, row.shortChange, row.shortMarginRatio].every(Number.isFinite)) errors.push(`數值錯誤：${key}`);
  if (row.isPointInTimeSafe !== true) errors.push(`時間點不安全：${key}`);
}
const uniqueDates = new Set(records.map(row => row.date)).size;
const twseDates = new Set(records.filter(row => row.market === 'TWSE').map(row => row.date)).size;
const tpexDates = new Set(records.filter(row => row.market === 'TPEX').map(row => row.date)).size;
const report = {
  generatedAt: new Date().toISOString(),
  status: records.length > 0 && uniqueDates >= 1_000 && twseDates >= 1_000 && tpexDates >= 1_000 && errors.length === 0
    ? 'VALID' : records.length ? 'INSUFFICIENT' : 'MISSING_DATA',
  records: records.length, uniqueDates,
  pointInTimeSafeRecords: records.filter(row => row.isPointInTimeSafe).length,
  twseRecords: records.filter(row => row.market === 'TWSE').length,
  tpexRecords: records.filter(row => row.market === 'TPEX').length,
  twseDates,
  tpexDates,
  errorCount: errors.length, errors: errors.slice(0, 100),
  warning: '逐筆 publishedAt 未驗證，採 T+1 保守時間點政策。'
};
await fs.mkdir(new URL('../../data/margin/', import.meta.url), { recursive: true });
await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`融資融券驗證：${report.status}，${report.records} 筆、${report.uniqueDates} 日。`);
