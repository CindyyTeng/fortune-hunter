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

const OUTPUT = new URL('../../data/research/institutional-endpoint-forensics.json', import.meta.url);
const DOC = new URL('../../docs/INSTITUTIONAL_ENDPOINT_FORENSICS.md', import.meta.url);

function rocSlashDate(date) {
  const compact = rocCompactDate(date);
  return `${compact.slice(0, 3)}/${compact.slice(3, 5)}/${compact.slice(5, 7)}`;
}

function rowsAndDate(endpointId, result) {
  if (endpointId === 'twse-t86') {
    return { rows: result.json?.data?.length || 0, returnedDate: result.json?.date || null, fields: result.json?.fields || [] };
  }
  if (endpointId.startsWith('tpex-openapi')) {
    const rows = Array.isArray(result.json) ? result.json : [];
    return { rows: rows.length, returnedDate: rows[0]?.Date || null, fields: rows[0] ? Object.keys(rows[0]) : [] };
  }
  const rows = result.json?.aaData || result.json?.tables?.[0]?.data || result.json?.data || [];
  return { rows: Array.isArray(rows) ? rows.length : 0, returnedDate: result.json?.date || result.json?.reportDate || null, fields: result.json?.fields || [] };
}

function expectedDates(date) {
  return new Set([date, compactDate(date), rocCompactDate(date), rocSlashDate(date)]);
}

function isSpecifiedDateReturned(endpointId, date, returnedDate, rows) {
  if (!rows) return false;
  if (endpointId === 'twse-t86') return true;
  if (!returnedDate) return false;
  return expectedDates(date).has(String(returnedDate).replaceAll('-', '/')) || expectedDates(date).has(String(returnedDate).replaceAll('/', ''));
}

const dates = pickProbeDates(await tradingDates());
const endpoints = [
  {
    id: 'twse-t86',
    name: 'TWSE T86',
    marketCoverage: '上市',
    dateFormat: '西元 YYYYMMDD',
    url: date => `https://www.twse.com.tw/rwd/zh/fund/T86?date=${compactDate(date)}&selectType=ALL&response=json`,
    queryParameters: ['date', 'selectType=ALL', 'response=json']
  },
  {
    id: 'twse-openapi-swagger',
    name: 'TWSE OpenAPI Swagger',
    marketCoverage: '上市',
    dateFormat: '無指定日期測試',
    url: () => 'https://openapi.twse.com.tw/swagger.json',
    queryParameters: []
  },
  {
    id: 'tpex-openapi-latest',
    name: 'TPEx OpenAPI latest',
    marketCoverage: '上櫃',
    dateFormat: '無日期參數',
    url: () => 'https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading',
    queryParameters: []
  },
  {
    id: 'tpex-openapi-date',
    name: 'TPEx OpenAPI date parameter',
    marketCoverage: '上櫃',
    dateFormat: '民國 YYYMMDD 待確認',
    url: date => `https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading?date=${rocCompactDate(date)}`,
    queryParameters: ['date']
  },
  {
    id: 'tpex-page-dailytrade',
    name: 'TPEx 三大法人頁面 dailyTrade',
    marketCoverage: '上櫃',
    dateFormat: '民國 YYY/MM/DD 待確認',
    url: date => `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?date=${rocSlashDate(date)}&type=Daily&response=json`,
    queryParameters: ['date', 'type=Daily', 'response=json']
  },
  {
    id: 'tpex-legacy-3itrade',
    name: 'TPEx legacy 3itrade',
    marketCoverage: '上櫃',
    dateFormat: '民國 YYY/MM/DD 待確認',
    url: date => `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&se=EW&t=D&d=${rocSlashDate(date)}&s=0,asc,0`,
    queryParameters: ['d', 'se=EW', 't=D']
  }
];

const probes = [];
for (const endpoint of endpoints) {
  for (const probeDate of dates) {
    const url = endpoint.url(probeDate.date);
    const result = await fetchJson(url, Number(process.env.INSTITUTIONAL_FORENSIC_TIMEOUT_MS || 15_000));
    const parsed = rowsAndDate(endpoint.id, result);
    const specified = isSpecifiedDateReturned(endpoint.id, probeDate.date, parsed.returnedDate, parsed.rows);
    probes.push({
      endpointId: endpoint.id,
      endpointName: endpoint.name,
      label: probeDate.label,
      requestedDate: probeDate.date,
      url,
      queryParameters: endpoint.queryParameters,
      dateFormat: endpoint.dateFormat,
      httpStatus: result.status || null,
      rowCount: parsed.rows,
      returnedDate: parsed.returnedDate,
      returnedRequestedDate: specified,
      likelyLatestOnly: parsed.rows > 0 && endpoint.id.includes('latest'),
      fields: parsed.fields.slice(0, 40),
      fieldsComplete: parsed.fields.length > 0,
      suitableForAutomatedBackfill: parsed.rows > 0 && specified && !endpoint.id.includes('latest'),
      failureReason: parsed.rows
        ? specified ? null : '有資料但無法確認為指定日期，可能只回最新資料'
        : (result.error || '無資料或端點不支援該日期')
    });
  }
}

const matrix = endpoints.map(endpoint => {
  const rows = probes.filter(row => row.endpointId === endpoint.id);
  const historicalRows = rows.filter(row => row.suitableForAutomatedBackfill);
  return {
    endpointId: endpoint.id,
    endpointName: endpoint.name,
    supportsHistoricalDate: historicalRows.length >= Math.min(3, rows.length),
    dateFormat: endpoint.dateFormat,
    earliestConfirmedDate: historicalRows.map(row => row.requestedDate).sort().at(0) || null,
    latestConfirmedDate: historicalRows.map(row => row.requestedDate).sort().at(-1) || null,
    marketCoverage: endpoint.marketCoverage,
    recommendedForBackfill: historicalRows.length === rows.length && rows.length > 0,
    notes: historicalRows.length
      ? `確認 ${historicalRows.length}/${rows.length} 個日期可取回指定日期資料`
      : '尚未確認可穩定取回指定歷史日期'
  };
});

const report = {
  generatedAt: new Date().toISOString(),
  probeDates: dates,
  matrix,
  probes,
  conclusion: matrix.some(row => row.recommendedForBackfill)
    ? '至少一個端點可進入自動回填 smoke test'
    : '目前沒有端點可直接建議做 4 年自動回填，需人工 CSV 匯入 fallback'
};

await writeJson(OUTPUT, report);
await fs.writeFile(DOC, `# 法人端點鑑識報告

產生時間：${report.generatedAt}

## 端點矩陣

${matrix.map(row => `- ${row.endpointName}：supportsHistoricalDate=${row.supportsHistoricalDate}，recommendedForBackfill=${row.recommendedForBackfill}，coverage=${row.marketCoverage}，notes=${row.notes}`).join('\n')}

## 結論

${report.conclusion}

## 人工匯入

若沒有端點可穩定回填，請改用 \`data/institutional/manual/\` 放入人工下載 CSV，再執行 \`npm run data:validate-manual-institutional\` 與 \`npm run data:import-manual-institutional\`。
`, 'utf8');

console.log(`endpoint forensic: endpoints=${matrix.length}, recommended=${matrix.filter(row => row.recommendedForBackfill).length}`);
console.log(report.conclusion);
