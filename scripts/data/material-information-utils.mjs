import fs from 'node:fs/promises';

export const SOURCES = {
  TWSE: { market: '上市', suffix: '.TW', url: 'https://mopsfin.twse.com.tw/opendata/t187ap04_L.csv' },
  TPEX: { market: '上櫃', suffix: '.TWO', url: 'https://mopsfin.twse.com.tw/opendata/t187ap04_O.csv' }
};

export function parseCsv(input) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(value);
      value = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      row.push(value);
      if (row.some(cell => cell.trim())) rows.push(row);
      row = [];
      value = '';
    } else value += character;
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

export function rocDate(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 7) return '';
  const yearLength = digits.length - 4;
  const year = Number(digits.slice(0, yearLength)) + 1911;
  const date = `${year}-${digits.slice(yearLength, yearLength + 2)}-${digits.slice(yearLength + 2, yearLength + 4)}`;
  return Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ? '' : date;
}

export function announcementTimestamp(date, time) {
  const digits = String(time || '').replace(/\D/g, '').padStart(6, '0');
  if (!date || digits.length !== 6) return '';
  return `${date}T${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4, 6)}+08:00`;
}

export function nextWeekday(date) {
  const value = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(value.getTime())) return '';
  do value.setUTCDate(value.getUTCDate() + 1);
  while (value.getUTCDay() === 0 || value.getUTCDay() === 6);
  return value.toISOString().slice(0, 10);
}

export function normalizeOfficialCsv(csv, sourceKey, collectedAt = new Date().toISOString()) {
  const source = SOURCES[sourceKey];
  if (!source) throw new Error(`未知市場來源：${sourceKey}`);
  const [headers, ...records] = parseCsv(csv.replace(/^\uFEFF/, ''));
  const index = Object.fromEntries(headers.map((header, position) => [header.trim(), position]));
  const required = ['出表日期', '發言日期', '發言時間', '公司代號', '公司名稱', '主旨', '符合條款', '事實發生日', '說明'];
  const missing = required.filter(field => index[field] === undefined);
  if (missing.length) throw new Error(`缺少必要欄位：${missing.join('、')}`);
  return records.flatMap(record => {
    const rawSymbol = String(record[index['公司代號']] || '').trim();
    const announcedDate = rocDate(record[index['發言日期']]);
    if (!/^\d{4,6}$/.test(rawSymbol) || !announcedDate) return [];
    const announcedTime = String(record[index['發言時間']] || '').replace(/\D/g, '').padStart(6, '0');
    return [{
      reportDate: rocDate(record[index['出表日期']]),
      announcedDate,
      announcedTime,
      publishedAt: announcementTimestamp(announcedDate, announcedTime),
      effectiveDate: nextWeekday(announcedDate),
      rawSymbol,
      symbol: `${rawSymbol}${source.suffix}`,
      market: source.market,
      stockName: String(record[index['公司名稱']] || '').trim(),
      subject: String(record[index['主旨']] || '').trim(),
      clause: String(record[index['符合條款']] || '').trim(),
      factDate: rocDate(record[index['事實發生日']]),
      description: String(record[index['說明']] || '').trim(),
      source: `公開資訊觀測站-${source.market}公司每日重大訊息`,
      sourceUrl: source.url,
      pointInTimeMode: 'official_announcement_timestamp',
      effectiveDatePolicy: '公布後下一個可交易日；回測再以行情日曆校正',
      isPointInTimeSafe: true,
      collectedAt
    }];
  });
}

export function dedupeEvents(events) {
  const map = new Map();
  for (const event of events) {
    const key = [event.announcedDate, event.announcedTime, event.market, event.rawSymbol, event.subject].join('|');
    map.set(key, event);
  }
  return [...map.values()].sort((a, b) => `${a.publishedAt}|${a.symbol}`.localeCompare(`${b.publishedAt}|${b.symbol}`));
}

export async function writeJson(url, value) {
  await fs.mkdir(new URL('.', url), { recursive: true });
  await fs.writeFile(url, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
