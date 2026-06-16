import { parseManualFiles, VALIDATION } from './manual-institutional-csv-utils.mjs';
import { dedupeRows, writeJson } from './institutional-history-utils.mjs';

const result = await parseManualFiles();
const { duplicates } = dedupeRows(result.records);
const report = {
  generatedAt: new Date().toISOString(),
  files: result.files,
  parsedRecords: result.records.length,
  duplicateRecords: duplicates.length,
  errors: result.errors,
  status: result.errors.length
    ? 'INVALID'
    : result.files.length ? 'VALID' : 'NO_MANUAL_FILES',
  message: result.files.length
    ? '人工 CSV 已完成檢查'
    : '目前沒有人工 CSV 檔案，略過人工匯入驗證'
};

await writeJson(VALIDATION, report);
console.log(`manual validation: files=${result.files.length}, records=${result.records.length}, status=${report.status}`);
if (result.errors.length) console.log(`errors=${result.errors.length}`);
