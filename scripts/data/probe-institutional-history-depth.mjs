import fs from 'node:fs/promises';
import {
  compactDate,
  fetchJson,
  pickProbeDates,
  readJson,
  rocCompactDate,
  tradingDates,
  writeJson
} from './institutional-history-utils.mjs';

const OUTPUT = new URL('../../data/research/institutional-history-probe.json', import.meta.url);
const DOC = new URL('../../docs/INSTITUTIONAL_HISTORY_BACKFILL.md', import.meta.url);

function twseT86(date) {
  return `https://www.twse.com.tw/rwd/zh/fund/T86?date=${compactDate(date)}&selectType=ALL&response=json`;
}

function tpexCurrent() {
  return 'https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading';
}

function tpexWithDate(date) {
  return `https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading?date=${rocCompactDate(date)}`;
}

function rowsOf(source, result) {
  if (source === 'TWSE T86') return result.json?.data?.length || 0;
  if (source.startsWith('TPEx')) return Array.isArray(result.json) ? result.json.length : 0;
  return 0;
}

function fieldsOf(result) {
  if (Array.isArray(result.json?.fields)) return result.json.fields.slice(0, 30);
  if (Array.isArray(result.json) && result.json[0]) return Object.keys(result.json[0]).slice(0, 30);
  return [];
}

async function probeSource(source, date, url) {
  const result = await fetchJson(url);
  const rows = rowsOf(source, result);
  const firstDate = Array.isArray(result.json) && result.json[0]?.Date ? result.json[0].Date : null;
  return {
    source,
    date,
    url,
    ok: result.ok,
    httpStatus: result.status || null,
    rows,
    fields: fieldsOf(result),
    error: result.error || result.json?.stat || result.json?.message || null,
    supportsSpecifiedDate: source === 'TWSE T86' ? rows > 0 : false,
    dateFormat: source === 'TWSE T86' ? '西元 YYYYMMDD' : source.includes('date=') ? '民國 YYYMMDD 待確認' : '無日期參數',
    onlyLatestDataLikely: source.startsWith('TPEx') && rows > 0 && firstDate !== null,
    suitableForAutomatedBackfill: source === 'TWSE T86' && rows > 0,
    fallbackToManualImport: !(source === 'TWSE T86' && rows > 0)
  };
}

const dates = pickProbeDates(await tradingDates());
const probes = [];
for (const item of dates) {
  probes.push(await probeSource('TWSE T86', item.date, twseT86(item.date)));
  probes.push(await probeSource('TPEx OpenAPI latest', item.date, tpexCurrent()));
  probes.push(await probeSource('TPEx OpenAPI date parameter', item.date, tpexWithDate(item.date)));
}
const twseOpenApi = await fetchJson('https://openapi.twse.com.tw/swagger.json');
const tpexOpenApi = await fetchJson('https://www.tpex.org.tw/openapi/swagger.json');
const prior = await readJson(OUTPUT, {});
const report = {
  ...prior,
  generatedAt: new Date().toISOString(),
  probeDates: dates,
  sources: {
    twseT86: {
      endpoint: 'https://www.twse.com.tw/rwd/zh/fund/T86',
      supportsHistory: probes.some(row => row.source === 'TWSE T86' && row.rows > 0),
      suitableForAutomatedBackfill: probes.filter(row => row.source === 'TWSE T86').every(row => row.rows > 0),
      note: '若某些日期 rows=0，可能是非交易日、資料未提供或參數限制，需以交易日清單分批確認。'
    },
    twseOpenApi: {
      endpoint: 'https://openapi.twse.com.tw/swagger.json',
      swaggerReachable: twseOpenApi.ok,
      supportsHistory: false,
      note: '目前僅確認 Swagger 可取得，尚未確認三大法人歷史日期 OpenAPI。'
    },
    tpexOpenApi: {
      endpoint: 'https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading',
      swaggerReachable: tpexOpenApi.ok,
      supportsHistory: probes.some(row => row.source === 'TPEx OpenAPI date parameter' && row.rows > 0 && !row.onlyLatestDataLikely),
      note: '目前 TPEx OpenAPI latest 可取最新資料；日期參數是否有效需由 probe 結果判定。'
    }
  },
  probes
};

const successful = probes.filter(row => row.rows > 0).map(row => `${row.source} ${row.date}`);
const failed = probes.filter(row => !row.rows).map(row => `${row.source} ${row.date}`);
const doc = `# 法人歷史資料深度探測與回填

產生時間：${report.generatedAt}

## 探測結論

- TWSE T86 是否支援歷史日期：${report.sources.twseT86.supportsHistory ? '部分支援' : '尚未確認'}
- TWSE OpenAPI 是否支援歷史日期：${report.sources.twseOpenApi.supportsHistory ? '是' : '否，尚未確認歷史日期端點'}
- TPEx OpenAPI 是否支援歷史日期：${report.sources.tpexOpenApi.supportsHistory ? '是' : '否，目前偏向只支援最新資料'}

## 成功日期摘要

${successful.length ? successful.map(row => `- ${row}`).join('\n') : '- 無'}

## 失敗或無資料日期摘要

${failed.length ? failed.map(row => `- ${row}`).join('\n') : '- 無'}

## 人工匯入 fallback

若官方來源無法穩定回填 4 年資料，請將人工下載的 CSV 放到 \`data/institutional/manual/\`，後續 importer 需支援同一份 schema：date、symbol、name、foreignBuy、foreignSell、foreignNetBuy、trustBuy、trustSell、trustNetBuy、dealerBuy、dealerSell、dealerNetBuy、source。
`;

await writeJson(OUTPUT, report);
await fs.writeFile(DOC, doc, 'utf8');
console.log(`history probe: dates=${dates.length}, successful=${successful.length}, failed=${failed.length}`);
