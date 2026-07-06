import fs from 'node:fs/promises';

const earlyFile = new URL('../../data/tw-backtest-3y.json', import.meta.url);
const currentFile = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const outputFile = new URL('../../data/tw-backtest-12y.json', import.meta.url);
const [early, current] = await Promise.all([
  fs.readFile(earlyFile, 'utf8').then(JSON.parse),
  fs.readFile(currentFile, 'utf8').then(JSON.parse)
]);
const cutoff = current.startDate;
const earlyCandidates = (early.candidateTrades || []).filter(trade => trade.signalDate < cutoff);
const candidateTrades = [...earlyCandidates, ...(current.candidateTrades || [])]
  .sort((a, b) => a.signalDate.localeCompare(b.signalDate) || a.symbol.localeCompare(b.symbol));
const output = {
  ...current,
  generatedAt: new Date().toISOString(),
  startDate: early.startDate,
  range: '12y-mixed-official',
  historyRange: '2014-2026',
  historicalUniverseCoverage: {
    earlyPeriod: `${early.startDate}～${early.endDate}`,
    earlyMarketCoverage: 'TPEX_ONLY',
    currentPeriod: `${current.startDate}～${current.endDate}`,
    currentUniverseSurvivorshipBias: true
  },
  candidateTrades,
  trades: [
    ...(early.trades || []).filter(trade => trade.signalDate < cutoff),
    ...(current.trades || [])
  ]
};
await fs.writeFile(outputFile, `${JSON.stringify(output)}\n`, 'utf8');
console.log(JSON.stringify({
  output: outputFile.pathname,
  earlyCandidates: earlyCandidates.length,
  currentCandidates: current.candidateTrades?.length || 0,
  totalCandidates: candidateTrades.length,
  startDate: output.startDate,
  endDate: output.endDate
}, null, 2));
