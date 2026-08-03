import fs from 'node:fs/promises';
import { SOURCES, dedupeEvents, normalizeOfficialCsv, writeJson } from './material-information-utils.mjs';

const RAW = new URL('../../data/material-information/raw/', import.meta.url);
const PROCESSED = new URL('../../data/material-information/processed/', import.meta.url);

async function download(sourceKey) {
  const source = SOURCES[sourceKey];
  const response = await fetch(source.url, { headers: { 'user-agent': 'fortune-hunter-data/1.0' } });
  if (!response.ok) throw new Error(`${sourceKey} HTTP ${response.status}`);
  const csv = await response.text();
  const events = normalizeOfficialCsv(csv, sourceKey);
  if (!events.length) throw new Error(`${sourceKey} 官方檔沒有可辨識資料`);
  const reportDate = events[0].reportDate || new Date().toISOString().slice(0, 10);
  await fs.mkdir(RAW, { recursive: true });
  const rawFile = new URL(`${reportDate}-${sourceKey.toLowerCase()}.csv`, RAW);
  try {
    await fs.access(rawFile);
  } catch {
    await fs.writeFile(rawFile, csv, 'utf8');
  }
  return events;
}

const settled = await Promise.allSettled(['TWSE', 'TPEX'].map(download));
const failures = settled.flatMap((item, index) => item.status === 'rejected'
  ? [{ source: ['TWSE', 'TPEX'][index], reason: item.reason.message }]
  : []);
const events = dedupeEvents(settled.flatMap(item => item.status === 'fulfilled' ? item.value : []));
if (!events.length) throw new Error(`兩個官方來源都失敗：${failures.map(item => item.reason).join('；')}`);
const reportDate = events.map(event => event.reportDate).sort().at(-1);
await writeJson(new URL(`${reportDate}.json`, PROCESSED), {
  generatedAt: new Date().toISOString(),
  reportDate,
  pointInTimePolicy: '公布當日不交易，下一個行情交易日才可使用',
  failures,
  count: events.length,
  events
});
console.log(`重大訊息每日資料完成：${events.length} 筆，來源失敗 ${failures.length} 個。`);
