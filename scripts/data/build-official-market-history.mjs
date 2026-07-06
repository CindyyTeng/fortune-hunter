import fs from 'node:fs/promises';
import { RAW_ROOT, PROCESSED_ROOT, readGzipJson, writeGzipJson } from './official-market-history-utils.mjs';

async function files(folder) {
  try {
    return (await fs.readdir(folder, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.json.gz'))
      .map(entry => new URL(entry.name, folder));
  } catch {
    return [];
  }
}

const rawFiles = [
  ...await files(new URL('twse/', RAW_ROOT)),
  ...await files(new URL('tpex/', RAW_ROOT))
];
const byYear = new Map();
const coverage = new Map();
for (const file of rawFiles) {
  const payload = await readGzipJson(file);
  if (payload.market === 'TWSE' && payload.sourceDate !== payload.date.replaceAll('-', '')) continue;
  const year = payload.date.slice(0, 4);
  const coverageKey = `${year}:${payload.market}`;
  if (!coverage.has(coverageKey)) coverage.set(coverageKey, new Set());
  coverage.get(coverageKey).add(payload.date);
  if (!byYear.has(year)) byYear.set(year, new Map());
  const symbols = byYear.get(year);
  for (const row of payload.rows) {
    if (![row.open, row.high, row.low, row.close].every(value => Number.isFinite(value) && value > 0)) continue;
    if (!symbols.has(row.symbol)) symbols.set(row.symbol, []);
    symbols.get(row.symbol).push(row);
  }
}

await fs.mkdir(PROCESSED_ROOT, { recursive: true });
const dateIndexes = new Map([...coverage].map(([key, dates]) => [
  key,
  new Map([...dates].sort().map((date, index) => [date, index]))
]));
const audit = [];
for (const [year, symbols] of [...byYear].sort()) {
  let rows = 0;
  let suspectedCorporateActions = 0;
  const output = {};
  for (const [symbol, history] of symbols) {
    history.sort((a, b) => a.date.localeCompare(b.date));
    let previous;
    output[symbol] = history.map(row => {
      const dateIndex = dateIndexes.get(`${year}:${row.market}`);
      const calendarGapDays = previous
        ? (Date.parse(`${row.date}T00:00:00Z`) - Date.parse(`${previous.date}T00:00:00Z`)) / 86_400_000
        : null;
      const consecutiveMarketSession = previous?.market === row.market
        && calendarGapDays <= 7
        && dateIndex?.get(row.date) === dateIndex?.get(previous.date) + 1;
      const gapPct = previous ? (row.open / previous.close - 1) * 100 : 0;
      const corporateActionSuspected = consecutiveMarketSession && Math.abs(gapPct) > 15;
      if (corporateActionSuspected) suspectedCorporateActions += 1;
      previous = row;
      rows += 1;
      return { ...row, corporateActionSuspected };
    });
  }
  await writeGzipJson(new URL(`${year}.json.gz`, PROCESSED_ROOT), {
    generatedAt: new Date().toISOString(),
    year,
    symbols: output
  });
  audit.push({
    year,
    symbols: symbols.size,
    rows,
    twseDates: coverage.get(`${year}:TWSE`)?.size || 0,
    tpexDates: coverage.get(`${year}:TPEX`)?.size || 0,
    suspectedCorporateActions
  });
}
console.log(JSON.stringify({ files: rawFiles.length, years: audit }, null, 2));
