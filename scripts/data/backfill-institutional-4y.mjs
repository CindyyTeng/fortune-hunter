import { runInstitutionalBackfill } from './backfill-institutional-range.mjs';

const report = await runInstitutionalBackfill({ mode: 'four_year_extended', years: 4, months: 3 });
console.log(`4y+3m backfill: dates=${report.requestedDates}, twseDays=${report.twse.successDays}, tpexDays=${report.tpex.successDays}, failures=${report.failures.length}`);
