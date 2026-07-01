import fs from 'node:fs/promises';

const STOCK_REPORT = new URL('../../data/realized-exposure-frontier-10y.json', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/deployable-stock-satellite-v1.json', import.meta.url);
const REPORT = new URL('../../docs/DEPLOYABLE_STOCK_SATELLITE_V1.md', import.meta.url);
const INITIAL_CAPITAL = 1_000_000;
const ETF_INITIAL_COST_PCT = 0.1425 + 0.15;

const round = (value, digits = 4) => Number(value.toFixed(digits));

function monthlyReturns(rows) {
  const closes = new Map();
  for (const row of rows) closes.set(row.date.slice(0, 7), row.close);
  const months = [...closes];
  return new Map(months.slice(1).map(([month, close], index) => [
    month,
    (close / months[index][1] - 1) * 100
  ]));
}

function evaluate(stockMonthly, etfMonthly, stockWeightPct) {
  const etfWeightPct = 100 - stockWeightPct;
  let stockEquity = INITIAL_CAPITAL * stockWeightPct / 100;
  let etfEquity = INITIAL_CAPITAL * etfWeightPct / 100 * (1 - ETF_INITIAL_COST_PCT / 100);
  let priorEquity = stockEquity + etfEquity;
  let peak = priorEquity;
  let maximumDrawdownPct = 0;
  const monthly = [];

  for (const row of stockMonthly) {
    stockEquity *= 1 + row.returnPct / 100;
    etfEquity *= 1 + (etfMonthly.get(row.month) || 0) / 100;
    const equity = stockEquity + etfEquity;
    const returnPct = (equity / priorEquity - 1) * 100;
    priorEquity = equity;
    peak = Math.max(peak, equity);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, (equity / peak - 1) * 100);
    monthly.push({ month: row.month, returnPct: round(returnPct), equity: round(equity, 0) });
  }

  const growth = monthly.reduce((value, row) => value * (1 + row.returnPct / 100), 1);
  return {
    stockWeightPct,
    etf0050InitialWeightPct: etfWeightPct,
    months: monthly.length,
    endingEquity: round(priorEquity, 0),
    averageMonthlyReturnPct: round(monthly.reduce((sum, row) => sum + row.returnPct, 0) / monthly.length),
    annualizedReturnPct: round((growth ** (12 / monthly.length) - 1) * 100),
    monthEndMaximumDrawdownPct: round(maximumDrawdownPct),
    negativeMonths: monthly.filter(row => row.returnPct < 0).length,
    monthly
  };
}

const [stockReport, etfHistory] = await Promise.all([
  fs.readFile(STOCK_REPORT, 'utf8').then(JSON.parse),
  fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)
]);
const stockMonthly = stockReport.rollingValidation.monthly;
const etfMonthly = monthlyReturns(etfHistory.series['0050.TW'] || []);
const frontier = [60, 70, 80, 90, 100].map(weight => {
  const { monthly, ...summary } = evaluate(stockMonthly, etfMonthly, weight);
  return summary;
});
  const selected = [...frontier].sort((left, right) => (
  right.averageMonthlyReturnPct - left.averageMonthlyReturnPct
  || right.monthEndMaximumDrawdownPct - left.monthEndMaximumDrawdownPct
))[0];
const output = {
  generatedAt: new Date().toISOString(),
  methodology: '個股與 0050 使用獨立資金袖套；初始配置後不強制再平衡，0050 計入首次買進手續費與滑價，個股袖套沿用已含費稅、滑價與 T+2 的 rolling validation 月報酬。',
  validationPeriod: stockReport.rollingValidation.validationPeriod,
  validationMonths: stockReport.rollingValidation.validationMonths,
  stockValidationTrades: stockReport.rollingValidation.validationTrades,
  currentStrategyClarification: {
    deployableMultiAssetEstimated0050TargetPct: 42,
    deployableCoreSatelliteEstimated0050TargetPct: 53.3,
    stockExposureFrontier0050Pct: 0
  },
  frontier,
  selected,
  conclusion: selected.etf0050InitialWeightPct === 0
    ? '本段長期驗證沒有證據支持配置 0050；保留 100% 個股策略資金、0050 為 0% 的結果較佳。'
    : `本段長期驗證選擇個股 ${selected.stockWeightPct}%、0050 ${selected.etf0050InitialWeightPct}%。`
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 個股／0050 資金比例驗證\n\n${output.conclusion}\n\n| 個股初始比例 | 0050 初始比例 | 月均報酬 | 年化報酬 | 月末最大回撤 | 負月份 |\n|---:|---:|---:|---:|---:|---:|\n${frontier.map(row => `| ${row.stockWeightPct}% | ${row.etf0050InitialWeightPct}% | ${row.averageMonthlyReturnPct}% | ${row.annualizedReturnPct}% | ${row.monthEndMaximumDrawdownPct}% | ${row.negativeMonths} |`).join('\n')}\n\n- 驗證期間：${output.validationPeriod}，共 ${output.validationMonths} 個月、個股交易 ${output.stockValidationTrades} 筆。\n- 個股袖套已含手續費、交易稅、滑價與 T+2；0050 計入首次買進成本。\n- 比例表使用月末資產計算回撤；個股策略的含盤中最差分段回撤仍以 ${stockReport.rollingValidation.validationCombinedMaximumDrawdownPct}% 為準。\n- 這是資金比例驗證，不代表策略已可直接實盤；仍需全新期間紙上交易驗證。\n`, 'utf8');
console.log(`個股／0050 比例驗證：個股 ${selected.stockWeightPct}%、0050 ${selected.etf0050InitialWeightPct}%，月均 ${selected.averageMonthlyReturnPct}%，月末最大回撤 ${selected.monthEndMaximumDrawdownPct}%。`);
