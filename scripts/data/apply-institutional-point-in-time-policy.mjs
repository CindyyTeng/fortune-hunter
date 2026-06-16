import fs from 'node:fs/promises';

const DATA = new URL('../../data/institutional/institutional-trades.json', import.meta.url);
const MARKET = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const AUDIT = new URL('../../data/research/institutional-point-in-time-audit.json', import.meta.url);

async function readJson(url, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(url, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function nextWeekday(date) {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day));
  do {
    next.setUTCDate(next.getUTCDate() + 1);
  } while ([0, 6].includes(next.getUTCDay()));
  return next.toISOString().slice(0, 10);
}

async function nextTradeDateMap() {
  const market = await readJson(MARKET, { benchmark: [] });
  const dates = market.benchmark.map(row => row.date).filter(Boolean);
  return new Map(dates.slice(0, -1).map((date, index) => [date, dates[index + 1]]));
}

const payload = await readJson(DATA);
if (!payload?.records?.length) {
  const audit = {
    generatedAt: new Date().toISOString(),
    status: 'MISSING_DATA',
    message: '找不到可套用 point-in-time policy 的法人資料。'
  };
  await fs.writeFile(AUDIT, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
  console.log('找不到法人資料，請先執行 data:build-institutional。');
  process.exit(0);
}

const nextMap = await nextTradeDateMap();
const sourceCounts = {};
let fullyVerified = 0;
let conservative = 0;
let unsafe = 0;
let fallbackEffectiveDate = 0;

const records = payload.records.map(row => {
  const effectiveDate = nextMap.get(row.date) || nextWeekday(row.date);
  const usedFallback = !nextMap.has(row.date);
  const updated = {
    ...row,
    publishedAt: `${row.date}T18:00:00+08:00`,
    publishedAtAssumption: 'market_close_after_report',
    effectiveDate,
    isPointInTimeSafe: Boolean(effectiveDate),
    fullyVerifiedPointInTime: false,
    conservativePointInTimeAssumption: true,
    pointInTimeMode: 'conservative_assumption',
    pointInTimeWarning: '逐筆歷史 publishedAt 待確認；目前採用官方日報 T 日收盤後公布、T+1 交易日才可使用的保守假設。',
    notes: `${row.notes || ''}；已套用 conservative point-in-time assumption。`.replace(/^；/, '')
  };

  sourceCounts[updated.source] = (sourceCounts[updated.source] || 0) + 1;
  if (updated.fullyVerifiedPointInTime) fullyVerified += 1;
  if (updated.conservativePointInTimeAssumption && updated.isPointInTimeSafe) conservative += 1;
  if (!updated.isPointInTimeSafe) unsafe += 1;
  if (usedFallback) fallbackEffectiveDate += 1;
  return updated;
});

await fs.writeFile(DATA, `${JSON.stringify({
  ...payload,
  sourceStatus: '保守 point-in-time 假設',
  pointInTimePolicy: {
    fullyVerifiedPointInTime: false,
    conservativePointInTimeAssumption: true,
    publishedAtAssumption: 'market_close_after_report',
    effectiveDateRule: 'T 日資料只能於 T+1 交易日使用',
    warning: '逐筆歷史 publishedAt 待確認，不可宣稱 fully verified。'
  },
  generatedAt: new Date().toISOString(),
  records
}, null, 2)}\n`, 'utf8');

const dates = new Set(records.map(row => row.date));
const audit = {
  generatedAt: new Date().toISOString(),
  status: 'CONSERVATIVE_ASSUMPTION_APPLIED',
  totalRecords: records.length,
  fullyVerifiedPointInTimeRecords: fullyVerified,
  conservativeAssumptionRecords: conservative,
  unsafeRecords: unsafe,
  recordsBySource: sourceCounts,
  distinctDates: dates.size,
  fallbackEffectiveDateRecords: fallbackEffectiveDate,
  publishedAtSource: '逐筆歷史 publishedAt 待確認',
  policy: {
    publishedAtAssumption: 'market_close_after_report',
    effectiveDateRule: 'T 日法人資料只允許 T+1 交易日使用',
    intradayUseAllowed: false,
    sameDayUseAllowed: false,
    fullyVerifiedPointInTime: false
  },
  warnings: [
    '此政策是保守假設，不是官方逐筆 publishedAt 驗證。',
    '使用交易日曆找不到下一交易日時，會退回下一個工作日並記錄 fallbackEffectiveDateRecords。',
    '未來若取得官方逐筆 publishedAt，必須重新標記 fullyVerifiedPointInTime。'
  ]
};

await fs.writeFile(AUDIT, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
console.log(`套用保守 point-in-time policy：${records.length} 筆，safe=${conservative}，fullyVerified=${fullyVerified}。`);
if (fallbackEffectiveDate) console.log(`使用下一工作日 fallback：${fallbackEffectiveDate} 筆。`);
