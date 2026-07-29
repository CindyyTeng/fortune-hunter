import fs from 'node:fs/promises';

const TOP5 = new URL('../../data/research/stock-fixed-top5-oos-v15.json', import.meta.url);
const REVENUE = new URL('../../data/research/stock-record-revenue-drift-v1.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-dual-alpha-ensemble-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_DUAL_ALPHA_ENSEMBLE_V1.md', import.meta.url);
const START_MONTH = '2022-01';
const END_MONTH = '2026-05';
const round = value => Math.round(value * 10_000) / 10_000;

function monthlyMap(rows, returnKey) {
  return new Map(rows
    .filter(row => row.month >= START_MONTH && row.month <= END_MONTH)
    .map(row => [row.month, Number(row[returnKey] || 0)]));
}

function combine(topReturns, revenueReturns, topWeightPct) {
  let topCapital = topWeightPct * 10_000;
  let revenueCapital = (100 - topWeightPct) * 10_000;
  let peak = 1_000_000;
  let maximumDrawdownPct = 0;
  const monthly = [];
  for (const month of [...topReturns.keys()].sort()) {
    if (!revenueReturns.has(month)) continue;
    const start = topCapital + revenueCapital;
    topCapital *= 1 + topReturns.get(month) / 100;
    revenueCapital *= 1 + revenueReturns.get(month) / 100;
    const equity = topCapital + revenueCapital;
    peak = Math.max(peak, equity);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, (equity / peak - 1) * 100);
    monthly.push({ month, returnPct: round((equity / start - 1) * 100), endingEquity: round(equity) });
  }
  const endingEquity = topCapital + revenueCapital;
  return {
    topWeightPct,
    revenueWeightPct: 100 - topWeightPct,
    months: monthly.length,
    averageMonthlyReturnPct: round(monthly.reduce((sum, row) => sum + row.returnPct, 0) / monthly.length),
    annualizedReturnPct: round((endingEquity / 1_000_000) ** (12 / monthly.length) * 100 - 100),
    monthEndMaximumDrawdownPct: round(maximumDrawdownPct),
    endingEquity: round(endingEquity),
    monthly
  };
}

const [top5, revenue] = await Promise.all([
  fs.readFile(TOP5, 'utf8').then(JSON.parse),
  fs.readFile(REVENUE, 'utf8').then(JSON.parse)
]);
const topReturns = monthlyMap(top5.validation.monthly, 'returnPct');
const revenueRows = revenue.folds.flatMap(fold => fold.validation.monthly);
const revenueReturns = monthlyMap(revenueRows, 'equityReturnPct');
const allocations = [25, 50, 75].map(weight => combine(topReturns, revenueReturns, weight));
const primary = allocations.find(row => row.topWeightPct === 50);
const revenueTrades = revenueRows
  .filter(row => row.month >= START_MONTH && row.month <= END_MONTH)
  .reduce((sum, row) => sum + row.trades, 0);
const totalTrades = top5.metrics.trades + revenueTrades;
const conservativeIntramonthDrawdownPct = Math.min(
  top5.metrics.maximumDrawdownPct,
  revenue.metrics.maximumDrawdownPct
);
const output = {
  generatedAt: new Date().toISOString(),
  strategyId: 'stock_dual_alpha_ensemble_v1',
  universe: '純個股；ETF 與 0050 只作比較基準，交易占比 0%',
  validationPeriod: `${START_MONTH}～${END_MONTH}`,
  method: '兩個策略各自保留現金、T+2 與成本模型；只在起始日分配資金，期間不做免成本再平衡。',
  allocations,
  primary: {
    ...primary,
    tradesFromIndependentSleeves: totalTrades,
    conservativeIntramonthDrawdownPct
  },
  baselines: {
    top5: top5.metrics,
    revenue: revenue.metrics,
    benchmark0050: top5.benchmark0050
  },
  targetMonthlyReturnPct: 5,
  targetMet: false,
  paperTradingReady: false,
  liveTradingReady: false,
  conclusion: '固定雙策略分配可降低月末回撤並增加訊號樣本，但月均低於 Top5 單獨策略，拒絕作為候選。'
};

await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 純個股雙 Alpha 組合 v1

- 驗證期間：${output.validationPeriod}
- 固定配置：Top5 50%／創高營收與動能 50%
- 月均報酬：${primary.averageMonthlyReturnPct}%
- 年化報酬：${primary.annualizedReturnPct}%
- 月末最大回撤：${primary.monthEndMaximumDrawdownPct}%
- 保守日內回撤上限：${conservativeIntramonthDrawdownPct}%
- 兩個獨立 sleeve 的交易來源合計：${totalTrades} 筆
- 0050 同期月均：${top5.benchmark0050.averageMonthlyReturnPct}%

兩個 sleeve 各自承擔交易成本、滑價、T+2 與風控，起始資金分配後不做免費再平衡。結果雖降低月末回撤並增加交易來源，但月均低於 Top5 單獨策略的 ${top5.metrics.averageMonthlyReturnPct}%，因此不進紙上交易或實盤。
`, 'utf8');
console.log(JSON.stringify({
  primary: {
    ...output.primary,
    monthly: undefined
  },
  conclusion: output.conclusion
}, null, 2));
