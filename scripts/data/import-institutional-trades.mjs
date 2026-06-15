import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_OUTPUT = new URL('../../data/institutional/institutional-trades.json', import.meta.url);

function argumentsMap(argv) {
  return Object.fromEntries(argv
    .filter(value => value.startsWith('--'))
    .map(value => {
      const [key, ...rest] = value.slice(2).split('=');
      return [key, rest.join('=') || true];
    }));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  row.push(field);
  if (row.some(value => value.trim())) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows[0].map(value => value.trim().replace(/^\uFEFF/, ''));
  return rows.slice(1).map(values => Object.fromEntries(
    headers.map((header, index) => [header, values[index]?.trim() ?? ''])
  ));
}

function pick(row, aliases) {
  for (const alias of aliases) {
    if (row[alias] !== undefined && row[alias] !== '') return row[alias];
  }
  return null;
}

function number(value) {
  if (typeof value === 'number') return value;
  const normalized = String(value ?? '').replaceAll(',', '').trim();
  if (!normalized) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function date(value) {
  const text = String(value ?? '').trim().replaceAll('/', '-');
  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  if (/^\d{7}$/.test(text)) {
    return `${Number(text.slice(0, 3)) + 1911}-${text.slice(3, 5)}-${text.slice(5, 7)}`;
  }
  const roc = text.match(/^(\d{2,3})-(\d{1,2})-(\d{1,2})$/);
  if (roc) {
    return `${Number(roc[1]) + 1911}-${roc[2].padStart(2, '0')}-${roc[3].padStart(2, '0')}`;
  }
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  return iso ? `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}` : text;
}

function normalize(row, defaults) {
  const foreignBuy = number(pick(row, [
    'foreignBuy',
    '外陸資買進股數(不含外資自營商)',
    '外資及陸資買進股數',
    'Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Total Buy'
  ]));
  const foreignSell = number(pick(row, [
    'foreignSell',
    '外陸資賣出股數(不含外資自營商)',
    '外資及陸資賣出股數',
    ' Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Total Sell'
  ]));
  const trustBuy = number(pick(row, [
    'trustBuy',
    '投信買進股數',
    'SecuritiesInvestmentTrustCompanies-TotalBuy'
  ]));
  const trustSell = number(pick(row, [
    'trustSell',
    '投信賣出股數',
    'SecuritiesInvestmentTrustCompanies-TotalSell'
  ]));
  const directDealerBuy = pick(row, [
    'dealerBuy',
    '自營商買進股數',
    'Dealers-TotalBuy'
  ]);
  const directDealerSell = pick(row, [
    'dealerSell',
    '自營商賣出股數',
    'Dealers-TotalSell'
  ]);
  const dealerBuy = directDealerBuy == null
    ? number(pick(row, ['自營商買進股數(自行買賣)']))
      + number(pick(row, ['自營商買進股數(避險)']))
    : number(directDealerBuy);
  const dealerSell = directDealerSell == null
    ? number(pick(row, ['自營商賣出股數(自行買賣)']))
      + number(pick(row, ['自營商賣出股數(避險)']))
    : number(directDealerSell);
  const publishedAt = pick(row, ['publishedAt', '公布時間']) || defaults.publishedAt || '';
  const effectiveDate = date(
    pick(row, ['effectiveDate', '生效日期']) || defaults.effectiveDate || ''
  );
  const updatedAt = pick(row, ['updatedAt', '更新時間'])
    || defaults.updatedAt
    || new Date().toISOString();
  const source = pick(row, ['source', '資料來源']) || defaults.source || '待確認';
  const notes = [
    pick(row, ['notes', '備註']),
    defaults.notes
  ].filter(Boolean).join('；');
  const sourceDate = date(
    pick(row, ['date', '日期', '資料日期', 'Date']) || defaults.date || ''
  );
  const safe = Boolean(
    sourceDate
    && publishedAt
    && effectiveDate
    && !Number.isNaN(Date.parse(publishedAt))
    && effectiveDate > sourceDate
    && Date.parse(publishedAt) < Date.parse(`${effectiveDate}T09:00:00+08:00`)
  );
  return {
    date: sourceDate,
    symbol: String(pick(row, [
      'symbol',
      '證券代號',
      '股票代號',
      'SecuritiesCompanyCode'
    ]) || '').trim(),
    name: String(pick(row, ['name', '證券名稱', '股票名稱', 'CompanyName']) || '').trim(),
    foreignBuy,
    foreignSell,
    foreignNetBuy: number(pick(row, [
      'foreignNetBuy',
      '外陸資買賣超股數(不含外資自營商)',
      '外資及陸資買賣超股數',
      'Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Difference'
    ]) ?? foreignBuy - foreignSell),
    trustBuy,
    trustSell,
    trustNetBuy: number(pick(row, [
      'trustNetBuy',
      '投信買賣超股數',
      'SecuritiesInvestmentTrustCompanies-Difference'
    ])
      ?? trustBuy - trustSell),
    dealerBuy,
    dealerSell,
    dealerNetBuy: number(pick(row, [
      'dealerNetBuy',
      '自營商買賣超股數',
      '自營商買賣超股數(自行買賣)',
      'Dealers-Difference'
    ]) ?? dealerBuy - dealerSell),
    source,
    publishedAt,
    effectiveDate,
    updatedAt,
    isPointInTimeSafe: safe && String(pick(row, ['isPointInTimeSafe']) ?? 'true') !== 'false',
    notes
  };
}

async function readRows(inputPath) {
  const text = (await fs.readFile(inputPath, 'utf8')).replace(/^\uFEFF/, '');
  if (path.extname(inputPath).toLowerCase() === '.csv') return parseCsv(text);
  const payload = JSON.parse(text);
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.records)) return payload.records;
  throw new Error('JSON 必須是陣列或包含 records 陣列');
}

const args = argumentsMap(process.argv.slice(2));
if (!args.input) {
  console.log('尚未提供法人資料。');
  console.log('用法：npm run data:import-institutional -- --input=檔案.csv --source-status=需人工匯入');
  console.log('若檔案缺少公布時間與生效日，請加上 --published-at 與 --effective-date。');
  process.exit(0);
}

const inputPath = path.resolve(String(args.input));
const outputPath = args.output
  ? path.resolve(String(args.output))
  : fileURLToPath(DEFAULT_OUTPUT);
const sourceStatus = String(args['source-status'] || '需人工匯入');
if (!['待確認', '可自動化', '需人工匯入'].includes(sourceStatus)) {
  throw new Error('source-status 只允許：待確認、可自動化、需人工匯入');
}
const rows = await readRows(inputPath);
const records = rows.map(row => normalize(row, {
  publishedAt: args['published-at'],
  effectiveDate: args['effective-date'],
  date: args.date,
  updatedAt: args['updated-at'],
  source: args.source,
  notes: args.notes
}));
const payload = {
  version: '1.0.0',
  sourceStatus,
  generatedAt: new Date().toISOString(),
  records
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

const safeCount = records.filter(row => row.isPointInTimeSafe).length;
console.log(`已匯入 ${records.length} 筆法人資料。`);
console.log(`point-in-time 安全：${safeCount} 筆；需補時間欄位或確認：${records.length - safeCount} 筆。`);
console.log(`輸出：${outputPath}`);
