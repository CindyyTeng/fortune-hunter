import { mergeManualRecords, parseManualFiles, VALIDATION } from './manual-institutional-csv-utils.mjs';
import { writeJson } from './institutional-history-utils.mjs';

const parsed = await parseManualFiles();
if (!parsed.files.length) {
  await writeJson(VALIDATION, {
    generatedAt: new Date().toISOString(),
    status: 'NO_MANUAL_FILES',
    files: [],
    parsedRecords: 0,
    importedRecords: 0,
    errors: [],
    message: '目前沒有人工 CSV 檔案，未匯入任何資料'
  });
  console.log('manual import: no files');
  process.exit(0);
}

if (parsed.errors.length) {
  await writeJson(VALIDATION, {
    generatedAt: new Date().toISOString(),
    status: 'INVALID',
    files: parsed.files,
    parsedRecords: parsed.records.length,
    importedRecords: 0,
    errors: parsed.errors
  });
  console.log(`manual import blocked: errors=${parsed.errors.length}`);
  process.exit(0);
}

const merged = await mergeManualRecords(parsed.records);
await writeJson(VALIDATION, {
  generatedAt: new Date().toISOString(),
  status: 'IMPORTED',
  files: parsed.files,
  parsedRecords: parsed.records.length,
  importedRecords: parsed.records.length,
  mergedRecords: merged.records.length,
  duplicateRecords: merged.duplicates.length,
  errors: []
});

console.log(`manual import: files=${parsed.files.length}, imported=${parsed.records.length}, duplicates=${merged.duplicates.length}`);
