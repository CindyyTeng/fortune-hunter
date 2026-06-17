import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_INPUT = new URL('../../data/institutional/institutional-trades.json', import.meta.url);
const REPORT = new URL('../../data/institutional/validation-report.json', import.meta.url);
const DETAIL_LIMIT = Number(process.env.INSTITUTIONAL_VALIDATION_DETAIL_LIMIT || 500);
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
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function isDateTime(value) {
  return typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}

function validateRecord(row, index, duplicateKeys) {
  const errors = [];
  const warnings = [];
  const missing = REQUIRED_FIELDS.filter(field => row[field] === undefined || row[field] === null);

  if (missing.length) errors.push(`缺少欄位：${missing.join(', ')}`);
  if (!isDate(row.date)) errors.push('date 必須是 YYYY-MM-DD');
  if (!String(row.symbol || '').trim()) errors.push('symbol 不可空白');
  if (!String(row.name || '').trim()) errors.push('name 不可空白');
  if (!String(row.source || '').trim()) errors.push('source 不可空白');
  if (!isDate(row.effectiveDate)) errors.push('effectiveDate 必須是 YYYY-MM-DD');
  if (!isDateTime(row.publishedAt)) errors.push('publishedAt 必須是含時區的 ISO 時間');
  if (!isDateTime(row.updatedAt)) errors.push('updatedAt 必須是含時區的 ISO 時間');

  if (isDateTime(row.publishedAt) && isDate(row.date)
    && Date.parse(row.publishedAt) < Date.parse(`${row.date}T13:30:00+08:00`)) {
    errors.push('publishedAt 不可早於資料日期收盤時間');
  }
  if (isDateTime(row.publishedAt) && isDateTime(row.updatedAt)
    && Date.parse(row.updatedAt) < Date.parse(row.publishedAt)) {
    errors.push('updatedAt 不可早於 publishedAt');
  }
  if (row.effectiveDate && row.date && row.effectiveDate <= row.date) {
    errors.push('effectiveDate 必須晚於資料日期，避免當日偷看資料');
  }
  if (isDateTime(row.publishedAt) && isDate(row.effectiveDate)
    && Date.parse(row.publishedAt) >= Date.parse(`${row.effectiveDate}T09:00:00+08:00`)) {
    errors.push('publishedAt 必須早於 effectiveDate 開盤');
  }

  for (const field of REQUIRED_FIELDS.filter(field => /(?:Buy|Sell)$/.test(field))) {
    if (!Number.isFinite(row[field])) errors.push(`${field} 必須是數字`);
    if (!field.includes('Net') && Number.isFinite(row[field]) && row[field] < 0) {
      warnings.push(`${field} 為負數，需確認官方欄位定義或特殊商品資料`);
    }
  }
  if (typeof row.isPointInTimeSafe !== 'boolean') errors.push('isPointInTimeSafe 必須是布林值');
  for (const [label, buy, sell, net] of [
    ['外資', row.foreignBuy, row.foreignSell, row.foreignNetBuy],
    ['投信', row.trustBuy, row.trustSell, row.trustNetBuy],
    ['自營商', row.dealerBuy, row.dealerSell, row.dealerNetBuy]
  ]) {
    if ([buy, sell, net].every(Number.isFinite) && Math.abs((buy - sell) - net) > 1) {
      warnings.push(`${label}買賣超與買進減賣出不一致，需回頭確認官方欄位定義`);
    }
  }

  if (row.isPointInTimeSafe !== true) warnings.push('isPointInTimeSafe 不是 true，不可用於真實 point-in-time 回測');
  if (/待確認/.test(row.source || '')) warnings.push('資料來源仍待確認');

  const duplicateKey = `${row.date}|${row.symbol}|${row.market || ''}|${row.source || ''}|${row.publishedAt}`;
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

const input = argument('input') ? pathToFileURL(argument('input')) : DEFAULT_INPUT;
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
    errorCount: 1,
    warningCount: 0,
    errors: ['找不到 data/institutional/institutional-trades.json'],
    warnings: [],
    missingRequirements: [
      '至少一份法人買賣超 CSV 或 JSON',
      '每筆資料需要 publishedAt',
      '每筆資料需要 effectiveDate',
      '需確認資料來源與 point-in-time 安全性'
    ]
  };
  await fs.writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log('法人資料不存在，無法完成驗證。');
  process.exit(0);
}

const rows = Array.isArray(payload) ? payload : payload.records;
if (!Array.isArray(rows)) throw new Error('法人資料必須是陣列或包含 records 陣列。');

const duplicateKeys = new Set();
const details = rows.map((row, index) => validateRecord(row, index, duplicateKeys));
const errors = details.flatMap(row => row.errors.map(message => `${row.key}：${message}`));
const warnings = details.flatMap(row => row.warnings.map(message => `${row.key}：${message}`));
const report = {
  generatedAt: new Date().toISOString(),
  status: details.every(row => row.valid) && details.some(row => row.pointInTimeEligible) ? 'VALID' : 'INVALID_OR_INELIGIBLE',
  input: inputLabel,
  records: rows.length,
  validRecords: details.filter(row => row.valid).length,
  pointInTimeEligibleRecords: details.filter(row => row.pointInTimeEligible).length,
  dateRange: rows.length ? {
    start: rows.map(row => row.date).filter(Boolean).sort().at(0) || null,
    end: rows.map(row => row.date).filter(Boolean).sort().at(-1) || null
  } : null,
  errorCount: errors.length,
  warningCount: warnings.length,
  errors: errors.slice(0, DETAIL_LIMIT),
  warnings: warnings.slice(0, DETAIL_LIMIT),
  detailLimit: DETAIL_LIMIT,
  truncated: errors.length > DETAIL_LIMIT || warnings.length > DETAIL_LIMIT
};

await fs.writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`法人資料：${report.records} 筆。`);
console.log(`格式有效：${report.validRecords} 筆；可供 point-in-time 回測：${report.pointInTimeEligibleRecords} 筆。`);
if (report.errorCount) console.log(`錯誤：${report.errorCount} 項，報告僅保留前 ${DETAIL_LIMIT} 項。`);
if (!report.pointInTimeEligibleRecords) console.log('因資料缺口尚無法完成真實驗證。');
