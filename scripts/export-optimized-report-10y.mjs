import fs from 'node:fs/promises';

const INPUT = new URL('../data/realized-strategy-diagnostics-10y.json', import.meta.url);
const XLS = new URL('../data/optimized-strategy-10y.xls', import.meta.url);
const CSV = new URL('../data/optimized-strategy-10y-monthly.csv', import.meta.url);
const HTML = new URL('../data/optimized-strategy-10y-mobile.html', import.meta.url);

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function cell(value) {
  const number = typeof value === 'number' && Number.isFinite(value);
  return `<Cell><Data ss:Type="${number ? 'Number' : 'String'}">${escapeXml(value)}</Data></Cell>`;
}

function worksheet(name, rows) {
  return `<Worksheet ss:Name="${escapeXml(name)}"><Table>${rows.map(
    row => `<Row>${row.map(cell).join('')}</Row>`
  ).join('')}</Table></Worksheet>`;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main() {
  const payload = JSON.parse(await fs.readFile(INPUT, 'utf8'));
  const result = payload.balanced || payload.targetFirst;
  const summaryRows = [
    ['項目', '結果'],
    ['完整評估月份', result.full.months],
    ['已實現淨報酬達 10% 月數', result.full.hit],
    ['負報酬月數', result.full.negative],
    ['零交易月數', result.full.zero],
    ['平均月已實現淨報酬 (%)', Number(result.full.average.toFixed(2))],
    ['最差月份報酬 (%)', result.full.worst],
    ['最大資金回撤 (%)', result.maxDrawdownPct],
    ['已完成交易筆數', result.trades],
    ['是否每月皆達 10%', result.full.hit === result.full.months ? '是' : '否']
  ];
  const monthlyRows = [
    ['月份', '已實現淨報酬 (%)', '已實現損益 (NT$)', '出場筆數', '是否達 10%'],
    ...result.monthly.map(row => [
      row.month,
      row.returnPct,
      row.realizedPnl,
      row.trades,
      row.returnPct >= 10 ? '是' : '否'
    ])
  ];
  const tradeRows = [
    [
      '股票代號',
      '股票名稱',
      '訊號日期',
      '進場日期',
      '出場日期',
      '出場原因',
      '股數',
      '進場價',
      '出場價',
      '已實現損益',
      '交易報酬 (%)',
      '訊號分數'
    ],
    ...(result.closedTrades || []).map(row => [
      row.symbol,
      row.name,
      row.signalDate,
      row.entryDate,
      row.exitDate,
      row.exitReason,
      row.quantity,
      row.entryPrice,
      row.exitPrice,
      row.realizedPnl,
      row.tradeReturnPct,
      row.signalScore
    ])
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
${worksheet('績效摘要', summaryRows)}
${worksheet('每月已實現績效', monthlyRows)}
${worksheet('逐筆交易', tradeRows)}
</Workbook>`;
  await fs.writeFile(XLS, xml, 'utf8');
  await fs.writeFile(
    CSV,
    `\uFEFF${monthlyRows.map(row => row.map(csvCell).join(',')).join('\n')}\n`,
    'utf8'
  );
  const table = monthlyRows.map((row, index) => `<tr>${row.map(value => (
    index ? `<td>${escapeXml(value)}</td>` : `<th>${escapeXml(value)}</th>`
  )).join('')}</tr>`).join('');
  await fs.writeFile(HTML, `<!doctype html>
<html lang="zh-Hant">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>十年策略回測報表</title>
<style>
:root{color-scheme:light;--ink:#2d2022;--wine:#7d1f34;--paper:#fffaf6;--line:#ead7d0}
*{box-sizing:border-box}body{font-family:"Noto Sans TC","PingFang TC",sans-serif;margin:0;color:var(--ink);background:#f6ece6}
main{max-width:980px;margin:auto;padding:24px 14px 48px}h1{font-size:26px;margin:0 0 12px}
p{line-height:1.7}.warn{padding:14px 16px;border-left:5px solid var(--wine);background:var(--paper);border-radius:8px}
.table-wrap{overflow:auto;background:#fff;border:1px solid var(--line);border-radius:12px}
table{border-collapse:collapse;width:100%;min-width:620px;font-size:14px}th,td{padding:10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}th{position:sticky;top:0;background:#3b2028;color:#fff}
</style>
<main>
<h1>十年策略回測報表</h1>
<p class="warn">目前只有 ${result.full.hit}/${result.full.months} 個完整月份達到 10%，平均月已實現淨報酬為 ${result.full.average.toFixed(2)}%。目標尚未達成，本報表只供研究與紙上交易驗證，不代表保證獲利。</p>
<div class="table-wrap"><table>${table}</table></div>
</main>
</html>`, 'utf8');
  console.log(JSON.stringify({ xls: XLS.pathname, csv: CSV.pathname, html: HTML.pathname }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
