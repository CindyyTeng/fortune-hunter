import { runInstitutionalBackfill } from './backfill-institutional-range.mjs';

const report = await runInstitutionalBackfill({ mode: 'smoke', months: 3 });
console.log(`smoke backfill: dates=${report.requestedDates}, twseDays=${report.twse.successDays}, tpexDays=${report.tpex.successDays}, failures=${report.failures.length}`);
console.log(report.smokePassed ? '3 個月 smoke backfill 通過' : '3 個月 smoke backfill 未通過');
