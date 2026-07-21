import fs from 'node:fs/promises';

const INPUT = new URL('../../data/research/stock-fixed-top5-oos-v13.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-top5-subset-portfolio-v2.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_TOP5_SUBSET_PORTFOLIO_V2.md', import.meta.url);
const TARGET_MONTHLY = 5;

const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const monthKey = date => String(date || '').slice(0, 7);

function filters() {
  const out = [];
  for (const maxAtr of [4, 5, 6, 8]) {
    for (const maxGap of [3, 5, 8]) {
      for (const minNearYearHigh of [0.5, 0.7, 0.85, 0.9]) {
        for (const maxDistanceToMa20 of [8, 12, 16, 22]) {
          for (const minMarketMom5 of [-5, -2, 0]) {
          for (const minGlobalComposite of [-1, -0.5, -0.25, 0]) {
              for (const minVolumeRatio of [0, 0.5, 0.8]) {
                out.push({ maxAtr, maxGap, minNearYearHigh, maxDistanceToMa20, minMarketMom5, minGlobalComposite, minVolumeRatio });
              }
            }
          }
        }
      }
    }
  }
  return out;
}

function pass(row, filter) {
  if ((row.atr14Pct ?? 999) > filter.maxAtr) return false;
  if ((row.gapUpPct ?? 999) > filter.maxGap) return false;
  if ((row.nearYearHigh ?? 0) < filter.minNearYearHigh) return false;
  if ((row.distanceToMa20Pct ?? 999) > filter.maxDistanceToMa20) return false;
  if ((row.marketMom5Pct ?? 0) < filter.minMarketMom5) return false;
  if ((row.globalCompositePct ?? 0) < filter.minGlobalComposite) return false;
  if ((row.volumeRatio1To20 ?? 0) < filter.minVolumeRatio) return false;
  return true;
}

function summarize(rows, exposureScale = 1) {
  const byMonth = new Map();
  for (const row of rows) {
    const month = monthKey(row.exitDate);
    byMonth.set(month, (byMonth.get(month) || 0) + (row.accountReturnPct || 0) * exposureScale);
  }
  const monthly = [...byMonth].sort().map(([month, returnPct]) => ({ month, returnPct: round(returnPct) }));
  let equity = 100;
  let peak = 100;
  let maxDrawdown = 0;
  for (const row of monthly) {
    equity *= 1 + row.returnPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, (equity / peak - 1) * 100);
  }
  const wins = rows.filter(row => row.tradeReturnPct > 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.tradeReturnPct, 0);
  const grossLoss = Math.abs(rows.filter(row => row.tradeReturnPct <= 0).reduce((sum, row) => sum + row.tradeReturnPct, 0));
  return {
    trades: rows.length,
    months: monthly.length,
    averageMonthlyReturnPct: round(avg(monthly.map(row => row.returnPct))),
    annualizedReturnPct: round((monthly.reduce((value, row) => value * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, monthly.length)) - 1) * 100),
    maximumDrawdownPct: round(maxDrawdown),
    winRatePct: round(rows.length ? wins.length / rows.length * 100 : 0),
    profitFactor: round(grossLoss ? grossProfit / grossLoss : grossProfit ? 99 : 0),
    negativeMonths: monthly.filter(row => row.returnPct < 0).length,
    monthly
  };
}

function score(metrics) {
  if (metrics.trades < 180 || metrics.profitFactor < 1.25 || metrics.maximumDrawdownPct < -18) return -Infinity;
  return metrics.averageMonthlyReturnPct * 4.5 + metrics.profitFactor * 2.5 + metrics.maximumDrawdownPct * 0.08 + Math.min(metrics.trades, 420) / 180 - metrics.negativeMonths * 0.06;
}

async function main() {
  const payload = JSON.parse(await fs.readFile(INPUT, 'utf8'));
  const trainTrades = payload.trainTradesDetail || [];
  const validationTrades = payload.validationTradesDetail || [];
  const candidates = [];
  for (const filter of filters()) {
    const trainRows = trainTrades.filter(row => pass(row, filter));
    for (const exposureScale of [1, 1.15]) {
      const train = summarize(trainRows, exposureScale);
      candidates.push({ filter, exposureScale, train, score: score(train) });
    }
  }
  const selected = candidates.sort((a, b) => b.score - a.score)[0];
  const validationRows = validationTrades.filter(row => pass(row, selected.filter));
  const validation = summarize(validationRows, selected.exposureScale);
  const passed = validation.averageMonthlyReturnPct >= TARGET_MONTHLY
    && validation.trades >= 300
    && validation.maximumDrawdownPct >= -20
    && validation.profitFactor > 1.15;
  const output = {
    generatedAt: new Date().toISOString(),
    strategyId: 'stock_top5_subset_portfolio_v2',
    source: 'stock-fixed-top5-oos-v13 trade details',
    selected: { filter: selected.filter, exposureScale: selected.exposureScale, train: selected.train },
    validation,
    targetMonthlyReturnPct: TARGET_MONTHLY,
    targetGapPct: round(TARGET_MONTHLY - validation.averageMonthlyReturnPct),
    passed,
    paperTradingReady: passed,
    liveTradingReady: false,
    conclusion: passed ? '達到初步門檻，但仍需紙上交易驗證。' : `未達月均 5%，目前月均 ${validation.averageMonthlyReturnPct}%，距離 5% 還差 ${round(TARGET_MONTHLY - validation.averageMonthlyReturnPct)} 個百分點。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 純個股 Top5 子集合 Portfolio v2\n\n- 來源：stock-fixed-top5-oos-v13 真實交易明細\n- 月均報酬：${validation.averageMonthlyReturnPct}%\n- 年化報酬：${validation.annualizedReturnPct}%\n- 最大回撤：${validation.maximumDrawdownPct}%\n- 交易筆數：${validation.trades}\n- Profit Factor：${validation.profitFactor}\n- 勝率：${validation.winRatePct}%\n- 是否達月均 5%：${passed}\n\n## 結論\n\n${output.conclusion}\n\n這版只交易個股，不以 ETF/0050 為主。v2 在 v1 的 Top5 子集合基礎上，加強全球順風與量能下限搜尋，目標是在交易筆數仍接近或高於 300 筆時提高月均報酬與 Profit Factor。\n`, 'utf8');
  console.log(JSON.stringify({ output: OUTPUT.pathname, report: REPORT.pathname, selected: output.selected, validation, passed }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
