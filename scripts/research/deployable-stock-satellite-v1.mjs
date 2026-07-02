import fs from 'node:fs/promises';

const STOCK_REPORT = new URL('../../data/realized-exposure-frontier-10y.json', import.meta.url);
const OUTPUT = new URL('../../data/research/deployable-stock-satellite-v1.json', import.meta.url);
const REPORT = new URL('../../docs/DEPLOYABLE_STOCK_SATELLITE_V1.md', import.meta.url);

const stockReport = JSON.parse(await fs.readFile(STOCK_REPORT, 'utf8'));
const rolling = stockReport.rollingValidation;
const frontier = rolling.allocationFrontier;
const staticAllocation = rolling.selectedAllocation;
const tacticalAllocation = rolling.tacticalAllocation;
const output = {
  generatedAt: new Date().toISOString(),
  methodology: '個股與 0050 使用獨立資金袖套，以每日收盤總資產串接四段 rolling validation；0050 計入每段首次買進手續費與滑價，個股交易已含費稅、滑價與 T+2。',
  validationPeriod: rolling.validationPeriod,
  validationMonths: rolling.validationMonths,
  stockValidationTrades: rolling.validationTrades,
  frontier,
  staticAllocation,
  tacticalAllocation,
  conclusion: '沒有配置能同時大幅提高目前月均報酬並降低最大回撤；尚無可直接實盤的新策略。'
};

await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 個股／防守袖套資金比例驗證\n\n${output.conclusion}\n\n| 配置 | 月均報酬 | 年化報酬 | 每日最大回撤 | 負月份 |\n|---|---:|---:|---:|---:|\n| 純個股 | ${rolling.validationAverageMonthlyReturnPct}% | ${rolling.validationAnnualizedReturnPct}% | ${rolling.validationCombinedMaximumDrawdownPct}% | ${frontier.find(row => row.stockWeightPct === 100).negativeMonths} |\n| 90% 個股＋10% 0050 | ${staticAllocation.averageMonthlyReturnPct}% | ${staticAllocation.annualizedReturnPct}% | ${staticAllocation.maximumDrawdownPct}% | ${staticAllocation.negativeMonths} |\n| 訓練期選定戰術袖套 | ${tacticalAllocation.averageMonthlyReturnPct}% | ${tacticalAllocation.annualizedReturnPct}% | ${tacticalAllocation.maximumDrawdownPct}% | ${tacticalAllocation.negativeMonths} |\n\n- 驗證期間：${rolling.validationPeriod}，共 ${rolling.validationMonths} 個月、個股交易 ${rolling.validationTrades} 筆。\n- 戰術袖套只在每段訓練期選規則與 10%／20%／30% 比例，validation 不重新調整。\n- 戰術袖套降低回撤但犧牲報酬；靜態 0050 幾乎沒有降低回撤。\n- 歷史 validation 已被反覆研究，目前不可直接實盤；需以全新期間紙上交易確認。\n`, 'utf8');
console.log(`防守袖套驗證：純個股 ${rolling.validationAverageMonthlyReturnPct}%／${rolling.validationCombinedMaximumDrawdownPct}%，戰術袖套 ${tacticalAllocation.averageMonthlyReturnPct}%／${tacticalAllocation.maximumDrawdownPct}%。`);
