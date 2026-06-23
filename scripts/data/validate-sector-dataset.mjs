import fs from 'node:fs/promises';

const INPUT = new URL('../../data/sector/sector-classification.json', import.meta.url);
const OUTPUT = new URL('../../data/sector/validation-report.json', import.meta.url);
const payload = JSON.parse(await fs.readFile(INPUT, 'utf8'));
const records = payload.records || [];
const keys = new Set();
const errors = [];
for (const row of records) {
  const key = `${row.market}|${row.symbol}`;
  if (keys.has(key)) errors.push(`重複鍵：${key}`);
  keys.add(key);
  if (!/^\d{4}$/.test(row.symbol || '')) errors.push(`股票代號格式錯誤：${key}`);
  if (!row.sectorCode || !row.sectorName) errors.push(`缺少產業：${key}`);
  if (!['TWSE', 'TPEX'].includes(row.market)) errors.push(`市場錯誤：${key}`);
}
const report = {
  generatedAt: new Date().toISOString(),
  status: records.length >= 100 && errors.length === 0 ? 'VALID' : 'INVALID',
  records: records.length,
  uniqueSymbols: new Set(records.map(row => row.symbol)).size,
  twseRecords: records.filter(row => row.market === 'TWSE').length,
  tpexRecords: records.filter(row => row.market === 'TPEX').length,
  sectors: new Set(records.map(row => `${row.sectorCode}|${row.sectorName}`)).size,
  classificationMode: payload.classificationMode,
  pointInTimeSafe: payload.pointInTimeSafe === true,
  survivorshipBiasWarning: payload.survivorshipBiasWarning === true,
  errorCount: errors.length,
  errors: errors.slice(0, 100),
  warning: '靜態現行分類並非歷史 point-in-time 分類；VALID 只代表結構可用，不代表可批准交易。'
};
await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`產業資料驗證：${report.status}，${report.records} 檔，${report.sectors} 個產業。`);
