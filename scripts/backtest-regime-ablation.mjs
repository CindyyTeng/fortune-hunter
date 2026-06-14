import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  loadRegimeDataset,
  runRegimeBacktest
} from './backtest-regime-ensemble-10y.mjs';

const OUTPUT = new URL('../data/regime-strategy-ablation.json', import.meta.url);
const REPORT = new URL('../docs/REGIME_STRATEGY_ABLATION.md', import.meta.url);

const experiments = [
  {
    id: 'breakout_only',
    label: '只跑突破策略',
    config: {
      enabledStrategies: ['breakoutMomentumStrategy'],
      allowOversold: false
    }
  },
  {
    id: 'pullback_only',
    label: '只跑拉回策略',
    config: {
      enabledStrategies: ['pullbackTrendStrategy'],
      allowOversold: false
    }
  },
  {
    id: 'range_only',
    label: '只跑區間策略',
    config: {
      enabledStrategies: ['rangeReversionStrategy'],
      allowOversold: false
    }
  },
  {
    id: 'oversold_only',
    label: '只跑超跌反彈策略',
    config: {
      enabledStrategies: ['oversoldReboundStrategy'],
      allowOversold: true,
      regimeStrategyMap: {
        BULL_PULLBACK: 'oversoldReboundStrategy',
        RANGE_BOUND: 'oversoldReboundStrategy'
      }
    }
  },
  {
    id: 'full_ensemble',
    label: '完整 regime ensemble',
    config: {}
  }
];

function rowOf(experiment, result) {
  return {
    id: experiment.id,
    label: experiment.label,
    config: experiment.config,
    trades: result.summary.trades,
    equityAverageMonthlyReturnPct: result.summary.equityAverageMonthlyReturnPct,
    negativeEquityMonths: result.summary.negativeEquityMonths,
    maxDrawdownPct: result.summary.maxDrawdownPct,
    profitFactor: result.summary.profitFactor,
    winRatePct: result.summary.winRatePct,
    tenPercentRealizedMonths: result.summary.tenPercentRealizedMonths,
    candidateFunnel: result.candidateFunnel
  };
}

function markdown(report) {
  const rows = report.results.map(row => (
    `| ${row.label} | ${row.trades} | ${row.equityAverageMonthlyReturnPct}% | ${row.negativeEquityMonths} | ${row.maxDrawdownPct}% | ${row.profitFactor ?? '-'} | ${row.winRatePct}% | ${row.tenPercentRealizedMonths} |`
  )).join('\n');
  return `# 市場狀態策略移除實驗

所有實驗使用相同 OHLCV、成本、滑價、投資組合與成交模擬器，只改變允許使用的策略。

| 實驗 | 交易筆數 | 平均月總資產報酬 | 負月份 | 最大回撤 | Profit Factor | 勝率 | 每月達 10% 次數 |
|---|---:|---:|---:|---:|---:|---:|---:|
${rows}

## 判讀

${report.conclusion}
`;
}

async function main() {
  const dataset = await loadRegimeDataset();
  const results = [];
  for (const experiment of experiments) {
    const result = await runRegimeBacktest(dataset, experiment.config);
    results.push(rowOf(experiment, result));
    console.log(`${experiment.id}: ${result.summary.trades} trades, ${result.summary.equityAverageMonthlyReturnPct}% monthly equity`);
  }
  const breakout = results.find(row => row.id === 'breakout_only');
  const ensemble = results.find(row => row.id === 'full_ensemble');
  const difference = Math.abs(
    (ensemble?.equityAverageMonthlyReturnPct || 0)
      - (breakout?.equityAverageMonthlyReturnPct || 0)
  );
  const conclusion = difference < 0.1
    ? '完整組合績效幾乎等於只跑突破策略。目前只能確認多策略架構已建立，不能宣稱其他策略已有顯著貢獻。'
    : '完整組合與只跑突破策略的績效存在差異；仍需搭配各策略交易數與風險指標判斷貢獻是否為正。';
  const report = {
    generatedAt: new Date().toISOString(),
    methodology: 'same data and execution simulator; one strategy family enabled at a time',
    conclusion,
    results
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, markdown(report), 'utf8');
  console.log(JSON.stringify({
    output: fileURLToPath(OUTPUT),
    report: fileURLToPath(REPORT),
    conclusion
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
