import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const PROCESSED = new URL('../../data/material-information/processed/', import.meta.url);
await fs.mkdir(PROCESSED, { recursive: true });
const files = (await fs.readdir(PROCESSED)).filter(file => file.endsWith('.json') || file.endsWith('.json.gz'));
let rows = 0;
const errors = [];
for (const file of files) {
  const buffer = await fs.readFile(new URL(file, PROCESSED));
  const payload = JSON.parse(file.endsWith('.gz')
    ? zlib.gunzipSync(buffer).toString('utf8')
    : buffer.toString('utf8'));
  for (const [index, event] of (payload.events || []).entries()) {
    rows += 1;
    const missing = ['symbol', 'market', 'announcedDate', 'publishedAt', 'effectiveDate', 'subject', 'source'].filter(field => !event[field]);
    if (missing.length) errors.push({ file, index, reason: `缺少 ${missing.join('、')}` });
    if (event.effectiveDate <= event.announcedDate) errors.push({ file, index, reason: 'effectiveDate 未晚於發言日期' });
    if (!event.isPointInTimeSafe) errors.push({ file, index, reason: '未標示時間點安全' });
  }
}
const result = errors.length ? 'INVALID' : rows ? 'VALID' : 'NO_DATA';
console.log(`重大訊息驗證：${result}；${rows} 筆；${errors.length} 個錯誤。`);
if (errors.length) {
  console.error(errors.slice(0, 10));
  process.exitCode = 1;
}
