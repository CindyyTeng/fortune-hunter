import fs from 'node:fs/promises';

const STOCK_REPORT = new URL('../../data/realized-exposure-frontier-10y.json', import.meta.url);
const OUTPUT = new URL('../../data/research/deployable-stock-satellite-v1.json', import.meta.url);
const REPORT = new URL('../../docs/DEPLOYABLE_STOCK_SATELLITE_V1.md', import.meta.url);

const stockReport = JSON.parse(await fs.readFile(STOCK_REPORT, 'utf8'));
const rolling = stockReport.rollingValidation;
const frontier = rolling.allocationFrontier;
const selected = rolling.selectedAllocation;
const output = {
  generatedAt: new Date().toISOString(),
  methodology: '個股與 0050 使用獨立資金袖套，以每日收盤總資產串接四段 rolling validation；0050 計入每段首次買進手續費與滑價，個股交易已含費稅、滑價與 T+2。',
  validationPeriod: rolling.validationPeriod,
  validationMonths: rolling.validationMonths,
  stockValidationTrades: rolling.validationTrades,
  frontier,
  selected,
  conclusion: `目前風險調整後配置為個股 ${selected.stockWeightPct}%、0050 ${selected.etf0050WeightPct}%。`
};

await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 個股／0050 資金比例驗證\n\n${output.conclusion}\n\n| 個股比例 | 0050 比例 | 月均報酬 | 年化報酬 | 每日最大回撤 | 負月份 |\n|---:|---:|---:|---:|---:|---:|\n${frontier.map(row => `| ${row.stockWeightPct}% | ${row.etf0050WeightPct}% | ${row.averageMonthlyReturnPct}% | ${row.annualizedReturnPct}% | ${row.maximumDrawdownPct}% | ${row.negativeMonths} |`).join('\n')}\n\n- 驗證期間：${rolling.validationPeriod}，共 ${rolling.validationMonths} 個月、個股交易 ${rolling.validationTrades} 筆。\n- 純個股月均 ${rolling.validationAverageMonthlyReturnPct}%，每日連續最大回撤 ${rolling.validationCombinedMaximumDrawdownPct}%。\n- 目前配置月均 ${selected.averageMonthlyReturnPct}%，每日連續最大回撤 ${selected.maximumDrawdownPct}%。\n- 歷史驗證已被反覆研究，目前仍不可直接實盤；需以全新期間紙上交易確認。\n`, 'utf8');
console.log(`個股／0050 比例驗證：個股 ${selected.stockWeightPct}%、0050 ${selected.etf0050WeightPct}%，月均 ${selected.averageMonthlyReturnPct}%，每日最大回撤 ${selected.maximumDrawdownPct}%。`);
