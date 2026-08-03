import fs from 'node:fs/promises';
import { dedupeEvents, normalizeOfficialCsv, writeJson } from './material-information-utils.mjs';

const MANUAL = new URL('../../data/material-information/manual/', import.meta.url);
const OUTPUT = new URL('../../data/material-information/processed/manual-import.json', import.meta.url);
await fs.mkdir(MANUAL, { recursive: true });
const files = (await fs.readdir(MANUAL)).filter(file => file.toLowerCase().endsWith('.csv'));
const events = [];
const errors = [];
for (const file of files) {
  const sourceKey = /(?:tpex|上櫃|_o\b)/i.test(file) ? 'TPEX' : /(?:twse|上市|_l\b)/i.test(file) ? 'TWSE' : '';
  if (!sourceKey) {
    errors.push({ file, reason: '檔名須含 twse／上市／_L 或 tpex／上櫃／_O' });
    continue;
  }
  try {
    events.push(...normalizeOfficialCsv(await fs.readFile(new URL(file, MANUAL), 'utf8'), sourceKey));
  } catch (error) {
    errors.push({ file, reason: error.message });
  }
}
const unique = dedupeEvents(events);
await writeJson(OUTPUT, { generatedAt: new Date().toISOString(), files: files.length, imported: unique.length, errors, events: unique });
console.log(`人工重大訊息匯入：${files.length} 檔、${unique.length} 筆、${errors.length} 個錯誤。`);
if (errors.length) process.exitCode = 1;
