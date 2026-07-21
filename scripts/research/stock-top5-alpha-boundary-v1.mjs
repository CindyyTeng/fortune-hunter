import fs from 'node:fs/promises';

const INPUT = new URL('../../data/research/stock-fixed-top5-oos-v13.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-top5-alpha-boundary-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_TOP5_ALPHA_BOUNDARY_V1.md', import.meta.url);

const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function summarize(rows, scale) {
  const monthly = new Map();
  for (const row of rows) {
    const month = row.exitDate.slice(0, 7);
    monthly.set(month, (monthly.get(month) || 0) + (row.accountReturnPct || 0) * scale);
  }
  const returns = [...monthly.values()];
  let equity = 100;
  let peak = 100;
  let maxDrawdown = 0;
  for (const value of returns) {
    equity *= 1 + value / 100;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, (equity / peak - 1) * 100);
  }
  const wins = rows.filter(row => row.tradeReturnPct > 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.tradeReturnPct, 0);
  const grossLoss = Math.abs(rows.filter(row => row.tradeReturnPct <= 0).reduce((sum, row) => sum + row.tradeReturnPct, 0));
  return {
    trades: rows.length,
    months: returns.length,
    averageMonthlyReturnPct: round(avg(returns)),
    maximumDrawdownPct: round(maxDrawdown),
    profitFactor: round(grossLoss ? grossProfit / grossLoss : 0),
    winRatePct: round(wins.length / Math.max(1, rows.length) * 100),
    negativeMonths: returns.filter(value => value < 0).length
  };
}

function pass(row, option) {
  if (row.atr14Pct > option.maxAtr) return false;
  if (row.gapUpPct > option.maxGap) return false;
  if (row.nearYearHigh < 0.5) return false;
  if (row.distanceToMa20Pct > option.maxDistanceToMa20) return false;
  if (row.marketMom5Pct < -5) return false;
  if ((row.globalCompositePct ?? 0) < -0.25) return false;
  if ((row.volumeRatio1To20 ?? 0) > option.maxVolumeRatio) return false;
  if ((row.intradayMomentum20Pct ?? 0) > option.maxIntradayMomentum) return false;
  if ((row.rsi14 ?? 0) > option.maxRsi) return false;
  return true;
}

async function main() {
  const source = JSON.parse(await fs.readFile(INPUT, 'utf8'));
  const options = [];
  for (const maxAtr of [8, 10]) {
    for (const maxGap of [8, 10]) {
      for (const maxDistanceToMa20 of [12, 16, 18]) {
        for (const maxVolumeRatio of [3, 5, 99]) {
          for (const maxIntradayMomentum of [6, 8, 99]) {
            for (const maxRsi of [78, 82, 88]) {
              for (const scale of [1.47, 1.5]) {
                options.push({ maxAtr, maxGap, maxDistanceToMa20, maxVolumeRatio, maxIntradayMomentum, maxRsi, scale });
              }
            }
          }
        }
      }
    }
  }
  const rows = options.map(option => {
    const trainRows = source.trainTradesDetail.filter(row => pass(row, option));
    const validationRows = source.validationTradesDetail.filter(row => pass(row, option));
    return { option, train: summarize(trainRows, option.scale), validation: summarize(validationRows, option.scale) };
  }).filter(row => row.train.trades >= 250 && row.validation.trades >= 280)
    .sort((left, right) => right.validation.averageMonthlyReturnPct - left.validation.averageMonthlyReturnPct);
  const validRisk = rows.filter(row => row.validation.trades >= 300 && row.validation.maximumDrawdownPct >= -20);
  const output = {
    generatedAt: new Date().toISOString(),
    strategyId: 'stock_top5_alpha_boundary_v1',
    purpose: '檢查 Top5 子集合在不破 -20% 回撤、交易數 300+ 的前提下，是否還能靠濾網或曝險推高月均。',
    testedOptions: options.length,
    bestOverall: rows[0],
    bestRiskControlled: validRisk[0] || null,
    currentBestReference: {
      strategyId: 'stock_top5_subset_portfolio_v6',
      averageMonthlyReturnPct: 2.3281,
      maximumDrawdownPct: -19.901,
      trades: 307,
      profitFactor: 1.6955
    },
    conclusion: validRisk[0] && validRisk[0].validation.averageMonthlyReturnPct > 2.3281
      ? '找到比 v6 更高且仍符合回撤/交易數限制的候選。'
      : '未找到明顯優於 v6 且同時滿足交易數 300+、最大回撤不破 -20% 的濾網組合；下一步需要新 alpha，而不是繼續放大曝險。'
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 純個股 Top5 Alpha 邊界診斷 v1\n\n- 測試組數：${output.testedOptions}\n- 目前參考最佳：v6，月均 2.3281%、回撤 -19.901%、交易 307 筆\n- 最佳風控內候選月均：${output.bestRiskControlled?.validation.averageMonthlyReturnPct ?? null}%\n- 最佳風控內候選回撤：${output.bestRiskControlled?.validation.maximumDrawdownPct ?? null}%\n- 最佳風控內候選交易數：${output.bestRiskControlled?.validation.trades ?? null}\n\n## 結論\n\n${output.conclusion}\n`, 'utf8');
  console.log(JSON.stringify({
    output: OUTPUT.pathname,
    report: REPORT.pathname,
    testedOptions: output.testedOptions,
    bestRiskControlled: output.bestRiskControlled?.validation || null,
    conclusion: output.conclusion
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
