import { DATA, coverage, dedupeRows, readJson, writeJson } from './institutional-history-utils.mjs';

const OUTPUT = new URL('../../data/research/institutional-coverage-audit.json', import.meta.url);

const payload = await readJson(DATA, { records: [] });
const original = payload.records || [];
const { records, duplicates } = dedupeRows(original);
const summary = {
  generatedAt: new Date().toISOString(),
  action: 'dedupe',
  originalRecords: original.length,
  dedupedRecords: records.length,
  duplicateRecords: duplicates.length,
  duplicateSamples: duplicates.slice(0, 100).map(row => row.key),
  coverage: coverage(records)
};

if (duplicates.length) {
  await writeJson(DATA, {
    ...payload,
    generatedAt: new Date().toISOString(),
    records
  });
}

await writeJson(OUTPUT, {
  generatedAt: new Date().toISOString(),
  dedupe: summary,
  coverage: summary.coverage
});

console.log(`dedupe: original=${original.length}, deduped=${records.length}, duplicates=${duplicates.length}`);
