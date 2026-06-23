import fs from 'node:fs/promises';

const RAW_DIR = new URL('../../data/sector/raw/', import.meta.url);
const OUTPUT = new URL('../../data/sector/sector-classification.json', import.meta.url);
const SECTORS = {
  '01': '水泥工業', '02': '食品工業', '03': '塑膠工業', '04': '紡織纖維', '05': '電機機械',
  '06': '電器電纜', '08': '玻璃陶瓷', '09': '造紙工業', '10': '鋼鐵工業', '11': '橡膠工業',
  '12': '汽車工業', '14': '建材營造', '15': '航運業', '16': '觀光餐旅', '17': '金融保險',
  '18': '貿易百貨', '20': '其他業', '21': '化學工業', '22': '生技醫療', '23': '油電燃氣',
  '24': '半導體業', '25': '電腦及週邊設備', '26': '光電業', '27': '通信網路業', '28': '電子零組件',
  '29': '電子通路業', '30': '資訊服務業', '31': '其他電子業', '32': '文化創意業', '33': '農業科技業',
  '34': '電子商務', '35': '綠能環保', '36': '數位雲端', '37': '運動休閒', '38': '居家生活'
};

const read = name => fs.readFile(new URL(name, RAW_DIR), 'utf8').then(JSON.parse);
const clean = value => String(value ?? '').trim();
function rocDate(value) {
  const digits = clean(value).replace(/\D/g, '');
  if (digits.length === 7) return `${Number(digits.slice(0, 3)) + 1911}-${digits.slice(3, 5)}-${digits.slice(5, 7)}`;
  if (digits.length === 8) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  return null;
}
function normalize(row, market) {
  const twse = market === 'TWSE';
  const symbol = clean(twse ? row['公司代號'] : row.SecuritiesCompanyCode);
  const sectorCode = clean(twse ? row['產業別'] : row.SecuritiesIndustryCode).padStart(2, '0');
  if (!/^\d{4}$/.test(symbol) || !sectorCode || sectorCode === '00') return null;
  return {
    symbol,
    name: clean(twse ? (row['公司簡稱'] || row['公司名稱']) : row.CompanyAbbreviation),
    market,
    sectorCode,
    sectorName: SECTORS[sectorCode] || `其他產業-${sectorCode}`,
    classificationAsOf: rocDate(twse ? row['出表日期'] : row.Date),
    source: twse ? 'TWSE OpenAPI t187ap03_L' : 'TPEx OpenAPI mopsfin_t187ap03_O',
    classificationMode: 'static_current_classification',
    pointInTimeSafe: false
  };
}

const [twse, tpex] = await Promise.all([read('twse-company-profile.json'), read('tpex-company-profile.json')]);
const unique = new Map();
for (const [rows, market] of [[twse, 'TWSE'], [tpex, 'TPEX']]) {
  for (const row of rows) {
    const value = normalize(row, market);
    if (value) unique.set(`${market}|${value.symbol}`, value);
  }
}
const records = [...unique.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.market.localeCompare(b.market));
const payload = {
  generatedAt: new Date().toISOString(),
  classificationMode: 'static_current_classification',
  pointInTimeSafe: false,
  survivorshipBiasWarning: true,
  warning: '現行產業分類沒有歷史生效日，只能作探索性回測，不可據此批准紙上或實盤交易。',
  records
};
await fs.mkdir(new URL('../../data/sector/', import.meta.url), { recursive: true });
await fs.writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`產業資料集：${records.length} 檔（上市 ${records.filter(row => row.market === 'TWSE').length}、上櫃 ${records.filter(row => row.market === 'TPEX').length}）。`);
