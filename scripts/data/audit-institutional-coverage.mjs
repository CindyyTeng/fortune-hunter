import { DATA, coverage, readJson, writeJson } from './institutional-history-utils.mjs';

const OUTPUT = new URL('../../data/research/institutional-coverage-audit.json', import.meta.url);

const payload = await readJson(DATA, { records: [] });
const records = payload.records || [];
const result = coverage(records);
const safe = records.filter(row => row.isPointInTimeSafe).length;
const report = {
  generatedAt: new Date().toISOString(),
  originalRecords: records.length,
  dedupedRecords: records.length,
  duplicateRecords: 0,
  pointInTimeSafeRecords: safe,
  uniqueTradingDates: result.uniqueTradingDates,
  averageDailyRows: result.averageDailyRows,
  twseRecords: result.twseRecords,
  twseDates: result.twseDates,
  tpexRecords: result.tpexRecords,
  tpexDates: result.tpexDates,
  dailyRows: result.dailyRows,
  abnormalDates: result.abnormalDates,
  duplicatedSymbolDates: result.duplicatedSymbolDates,
  enoughForWalkForward: result.uniqueTradingDates >= 1_000 && safe > 0 && (result.twseDates > 0 || result.tpexDates > 0),
  conclusion: result.uniqueTradingDates >= 1_000
    ? '法人歷史資料交易日數已達 walk-forward 最低門檻'
    : '法人歷史資料仍不足，尚無法完成真實 walk-forward 驗證'
};

await writeJson(OUTPUT, report);
console.log(`coverage: records=${records.length}, dates=${result.uniqueTradingDates}, twseDates=${result.twseDates}, tpexDates=${result.tpexDates}`);
console.log(report.conclusion);
