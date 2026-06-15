import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_INPUT = new URL('../../data/institutional/institutional-trades.json', import.meta.url);
const REPORT = new URL('../../data/institutional/validation-report.json', import.meta.url);
const REQUIRED_FIELDS = [
  'date',
  'symbol',
  'name',
  'foreignBuy',
  'foreignSell',
  'foreignNetBuy',
  'trustBuy',
  'trustSell',
  'trustNetBuy',
  'dealerBuy',
  'dealerSell',
  'dealerNetBuy',
  'source',
  'publishedAt',
  'effectiveDate',
  'updatedAt',
  'isPointInTimeSafe',
  'notes'
];

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(value => value.startsWith(prefix))?.slice(prefix.length);
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function isDateTime(value) {
  return typeof value === 'string'
    && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function validateRecord(row, index, duplicateKeys) {
  const errors = [];
  const warnings = [];
  const missing = REQUIRED_FIELDS.filter(field => row[field] === undefined || row[field] === null);
  if (missing.length) errors.push(`缺少欄位：${missing.join('、')}`);
  if (!isDate(row.date)) errors.push('date 不是 YYYY-MM-DD');
  if (!String(row.symbol || '').trim()) errors.push('symbol 不可空白');
  if (!String(row.name || '').trim()) errors.push('name 不可空白');
  if (!String(row.source || '').trim()) errors.push('source 不可空白');
  if (!isDate(row.effectiveDate)) errors.push('effectiveDate 不是 YYYY-MM-DD');
  if (!isDateTime(row.publishedAt)) errors.push('publishedAt 必須包含時區');
  if (!isDateTime(row.updatedAt)) errors.push('updatedAt 必須包含時區');
  if (isDateTime(row.publishedAt) && isDate(row.date)
    && Date.parse(row.publishedAt) < Date.parse(`${row.date}T13:30:00+08:00`)) {
    errors.push('publishedAt 不得早於資料交易日收盤');
  }
  if (isDateTime(row.publishedAt) && isDateTime(row.updatedAt)
    && Date.parse(row.updatedAt) < Date.parse(row.publishedAt)) {
    errors.push('updatedAt 不得早於 publishedAt');
  }
  if (row.effectiveDate && row.date && row.effectiveDate <= row.date) {
    errors.push('effectiveDate 必須晚於法人資料交易日');
  }
  if (isDateTime(row.publishedAt) && isDate(row.effectiveDate)
    && Date.parse(row.publishedAt) >= Date.parse(`${row.effectiveDate}T09:00:00+08:00`)) {
    errors.push('publishedAt 不得晚於 effectiveDate 開盤');
  }
  const numericFields = REQUIRED_FIELDS.filter(field =>
    /(?:Buy|Sell)$/.test(field) && field !== 'isPointInTimeSafe'
  );
  for (const field of numericFields) {
    if (!Number.isFinite(row[field])) errors.push(`${field} 不是有效數字`);
    if (!field.includes('Net') && Number.isFinite(row[field]) && row[field] < 0) {
      errors.push(`${field} 不得為負數`);
    }
  }
  if (typeof row.isPointInTimeSafe !== 'boolean') errors.push('isPointInTimeSafe 必須是布林值');
  for (const [prefix, buy, sell, net] of [
    ['外資', row.foreignBuy, row.foreignSell, row.foreignNetBuy],
    ['投信', row.trustBuy, row.trustSell, row.trustNetBuy],
    ['自營商', row.dealerBuy, row.dealerSell, row.dealerNetBuy]
  ]) {
    if ([buy, sell, net].every(Number.isFinite) && Math.abs((buy - sell) - net) > 1) {
      errors.push(`${prefix}買進減賣出不等於買賣超`);
    }
  }
  if (row.isPointInTimeSafe !== true) warnings.push('isPointInTimeSafe 不是 true，不可進入回測');
  if (/待確認/.test(row.source || '')) warnings.push('資料來源仍待確認');
  const duplicateKey = `${row.date}|${row.symbol}|${row.publishedAt}`;
  if (duplicateKeys.has(duplicateKey)) errors.push('date、symbol、publishedAt 重複');
  duplicateKeys.add(duplicateKey);
  return {
    index,
    key: `${row.date || '?'}|${row.symbol || '?'}`,
    errors,
    warnings,
    valid: errors.length === 0,
    pointInTimeEligible: errors.length === 0 && row.isPointInTimeSafe === true
  };
}

const input = argument('input')
  ? pathToFileURL(argument('input'))
  : DEFAULT_INPUT;
const inputLabel = argument('input') || 'data/institutional/institutional-trades.json';
let payload;
try {
  payload = JSON.parse(await fs.readFile(input, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const report = {
    generatedAt: new Date().toISOString(),
    status: 'MISSING_DATA',
    input: inputLabel,
    records: 0,
    validRecords: 0,
    pointInTimeEligibleRecords: 0,
    errors: ['找不到 data/institutional/institutional-trades.json'],
    missingRequirements: [
      '至少一份真實法人 CSV 或 JSON',
      '每筆資料的 publishedAt',
      '每筆資料的 effectiveDate',
      '可稽核的來源與版本紀錄'
    ]
  };
  await fs.writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log('法人資料不存在，驗證安全結束。');
  console.log('缺少：真實法人檔、publishedAt、effectiveDate 與來源版本紀錄。');
  process.exit(0);
}

const rows = Array.isArray(payload) ? payload : payload.records;
if (!Array.isArray(rows)) throw new Error('法人資料必須是陣列或包含 records 陣列');
const duplicateKeys = new Set();
const details = rows.map((row, index) => validateRecord(row, index, duplicateKeys));
const report = {
  generatedAt: new Date().toISOString(),
  status: details.every(row => row.valid) && details.some(row => row.pointInTimeEligible)
    ? 'VALID'
    : 'INVALID_OR_INELIGIBLE',
  input: inputLabel,
  records: rows.length,
  validRecords: details.filter(row => row.valid).length,
  pointInTimeEligibleRecords: details.filter(row => row.pointInTimeEligible).length,
  dateRange: rows.length ? {
    start: rows.map(row => row.date).filter(Boolean).sort().at(0) || null,
    end: rows.map(row => row.date).filter(Boolean).sort().at(-1) || null
  } : null,
  errors: details.flatMap(row => row.errors.map(message => `${row.key}：${message}`)),
  warnings: details.flatMap(row => row.warnings.map(message => `${row.key}：${message}`)),
  details
};
await fs.writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`法人資料：${report.records} 筆。`);
console.log(`格式有效：${report.validRecords} 筆；可供 point-in-time 回測：${report.pointInTimeEligibleRecords} 筆。`);
if (report.errors.length) console.log(`錯誤：${report.errors.length} 項，請查看 validation-report.json。`);
if (!report.pointInTimeEligibleRecords) console.log('因資料缺口尚無法完成真實驗證。');
