import fs from 'node:fs/promises';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gunzipAsync = promisify(gunzip);
const year = process.argv.find(value => value.startsWith('--year='))?.split('=')[1] || '2014';
const file = new URL(`../../data/market-history/processed/${year}.json.gz`, import.meta.url);
const payload = JSON.parse((await gunzipAsync(await fs.readFile(file))).toString('utf8'));
const suspects = [];
for (const [symbol, rows] of Object.entries(payload.symbols || {})) {
  let previous;
  for (const row of rows) {
    if (row.corporateActionSuspected && previous) {
      suspects.push({
        symbol,
        name: row.name,
        market: row.market,
        previousDate: previous.date,
        date: row.date,
        previousClose: previous.close,
        open: row.open,
        gapPct: Number(((row.open / previous.close - 1) * 100).toFixed(2))
      });
    }
    previous = row;
  }
}
suspects.sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));
console.log(JSON.stringify({ year, count: suspects.length, largest: suspects.slice(0, 30) }, null, 2));
