import fs from 'node:fs/promises';

const AUDIT = new URL('../../data/research/institutional-data-audit.json', import.meta.url);

async function probeJson(url) {
  const startedAt = new Date().toISOString();
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'fortune-hunter/1.0' },
      signal: AbortSignal.timeout(Number(process.env.INSTITUTIONAL_PROBE_TIMEOUT_MS || 15_000))
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return {
      url,
      ok: response.ok,
      status: response.status,
      contentLength: text.length,
      startedAt,
      finishedAt: new Date().toISOString(),
      json
    };
  } catch (error) {
    return {
      url,
      ok: false,
      error: error.message,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }
}

function twseUrl(date) {
  return `https://www.twse.com.tw/rwd/zh/fund/T86?date=${date.replaceAll('-', '')}&selectType=ALL&response=json`;
}

async function main() {
  const recent = process.env.INSTITUTIONAL_PROBE_RECENT_DATE || '2026-06-12';
  const older = process.env.INSTITUTIONAL_PROBE_OLD_DATE || '2022-06-16';
  const [twseRecent, twseOld, twseSwagger, tpexSwagger, tpexCurrent] = await Promise.all([
    probeJson(twseUrl(recent)),
    probeJson(twseUrl(older)),
    probeJson('https://openapi.twse.com.tw/swagger.json'),
    probeJson('https://www.tpex.org.tw/openapi/swagger.json'),
    probeJson('https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading')
  ]);

  const twseRecentRows = twseRecent.json?.data?.length || 0;
  const twseOldRows = twseOld.json?.data?.length || 0;
  const tpexRows = Array.isArray(tpexCurrent.json) ? tpexCurrent.json.length : 0;
  const audit = {
    generatedAt: new Date().toISOString(),
    sources: {
      twseT86: {
        status: twseRecent.ok && twseOld.ok && (twseRecentRows || twseOldRows)
          ? '可取得資料，歷史回填可行性待分段驗證'
          : '待確認',
        recentDate: recent,
        recentRows: twseRecentRows,
        oldDate: older,
        oldRows: twseOldRows,
        endpoint: 'https://www.twse.com.tw/rwd/zh/fund/T86'
      },
      twseOpenApi: {
        status: twseSwagger.ok ? '可取得 Swagger' : '待確認',
        endpoint: 'https://openapi.twse.com.tw/swagger.json'
      },
      tpexOpenApi: {
        status: tpexRows ? '可取得最近資料；歷史日期參數待確認' : '待確認',
        currentRows: tpexRows,
        endpoint: 'https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading'
      }
    },
    probes: {
      twseRecent: { ok: twseRecent.ok, status: twseRecent.status, rows: twseRecentRows },
      twseOld: { ok: twseOld.ok, status: twseOld.status, rows: twseOldRows },
      twseSwagger: { ok: twseSwagger.ok, status: twseSwagger.status },
      tpexSwagger: { ok: tpexSwagger.ok, status: tpexSwagger.status },
      tpexCurrent: { ok: tpexCurrent.ok, status: tpexCurrent.status, rows: tpexRows }
    },
    limitations: [
      '官方歷史資料未逐筆提供 publishedAt，預設不可視為 point-in-time safe。',
      '櫃買中心 OpenAPI 目前僅確認最新資料可取得，歷史日期參數仍待確認。',
      '大量回填需要分批、快取、重試與速率限制，避免對官方網站造成壓力。'
    ],
    fetchRuns: []
  };

  await fs.mkdir(new URL('../../data/research/', import.meta.url), { recursive: true });
  await fs.writeFile(AUDIT, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
  console.log(`TWSE recent rows=${twseRecentRows}, old rows=${twseOldRows}`);
  console.log(`TPEX current rows=${tpexRows}`);
  console.log(`資料探測結論：${audit.sources.twseT86.status}；${audit.sources.tpexOpenApi.status}`);
}

await main();
