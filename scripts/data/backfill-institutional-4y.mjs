import { runInstitutionalBackfill } from './backfill-institutional-range.mjs';

const report = await runInstitutionalBackfill({ mode: 'four_year', years: 4 });
console.log(`4y backfill: dates=${report.requestedDates}, twseDays=${report.twse.successDays}, tpexDays=${report.tpex.successDays}, failures=${report.failures.length}`);
