import fs from 'node:fs/promises';

const INPUT = new URL('../../data/cashflow-quality/cashflow-quality.json', import.meta.url);
const OUTPUT = new URL('../../data/research/cashflow-quality-validation.json', import.meta.url);

async function main() {
  const payload = JSON.parse(await fs.readFile(INPUT, 'utf8'));
  const records = payload.records || [];
  const keys = new Set();
  const errors = [];
  for (const row of records) {
    const key = `${row.market}|${row.symbol}|${row.quarter}`;
    if (keys.has(key)) errors.push(`重複資料：${key}`);
    keys.add(key);
    if (!/^\d{4}$/.test(row.symbol || '')) errors.push(`股票代號格式錯誤：${row.symbol}`);
    if (!/^\d{4}Q[1-4]$/.test(row.quarter || '')) errors.push(`季度格式錯誤：${row.quarter}`);
    if (!row.effectiveDate || !row.isPointInTimeSafe) errors.push(`point-in-time 不安全：${key}`);
    if (!Number.isFinite(row.totalAssets) || row.totalAssets <= 0) errors.push(`資產總額錯誤：${key}`);
  }
  const symbols = new Set(records.map(row => row.symbol));
  const quarters = new Set(records.map(row => row.quarter));
  const report = {
    generatedAt: new Date().toISOString(),
    status: errors.length ? 'INVALID' : 'VALID',
    records: records.length,
    symbols: symbols.size,
    quarters: quarters.size,
    pointInTimeSafeRecords: records.filter(row => row.isPointInTimeSafe).length,
    cashFlowRecords: records.filter(row => Number.isFinite(row.operatingCashFlow)).length,
    errors: errors.slice(0, 100)
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (errors.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
