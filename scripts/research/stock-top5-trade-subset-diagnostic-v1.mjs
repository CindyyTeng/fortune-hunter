import fs from 'node:fs/promises';

const V13 = new URL('../../data/research/stock-fixed-top5-oos-v13.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-top5-trade-subset-diagnostic-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_TOP5_TRADE_SUBSET_DIAGNOSTIC_V1.md', import.meta.url);

const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function monthKey(date) {
  return String(date || '').slice(0, 7);
}

function makeFilters() {
  const rows = [];
  for (const maxAtr of [4, 6, 8, 10]) {
    for (const maxGap of [3, 5, 8]) {
      for (const minNearYearHigh of [0.5, 0.7, 0.8, 0.9]) {
        for (const maxDistanceToMa20 of [8, 12, 16, 22]) {
          for (const minMarketMom5 of [-5, -2, 0]) {
            rows.push({ maxAtr, maxGap, minNearYearHigh, maxDistanceToMa20, minMarketMom5 });
          }
        }
      }
    }
  }
  return rows;
}

function pass(row, filter) {
  if ((row.atr14Pct ?? 999) > filter.maxAtr) return false;
  if ((row.gapUpPct ?? 999) > filter.maxGap) return false;
  if ((row.nearYearHigh ?? 0) < filter.minNearYearHigh) return false;
  if ((row.distanceToMa20Pct ?? 999) > filter.maxDistanceToMa20) return false;
  if ((row.marketMom5Pct ?? 0) < filter.minMarketMom5) return false;
  return true;
}

function summarize(rows) {
  const wins = rows.filter(row => row.tradeReturnPct > 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.tradeReturnPct, 0);
  const grossLoss = Math.abs(rows.filter(row => row.tradeReturnPct <= 0).reduce((sum, row) => sum + row.tradeReturnPct, 0));
  const monthly = new Map();
  for (const row of rows) {
    const month = monthKey(row.exitDate);
    monthly.set(month, (monthly.get(month) || 0) + (row.accountReturnPct || 0));
  }
  const monthlyReturns = [...monthly.values()];
  return {
    trades: rows.length,
    averageTradeReturnPct: round(avg(rows.map(row => row.tradeReturnPct || 0))),
    averageMonthlyAccountReturnPct: round(avg(monthlyReturns)),
    winRatePct: round(rows.length ? wins.length / rows.length * 100 : 0),
    profitFactor: round(grossLoss ? grossProfit / grossLoss : grossProfit ? 99 : 0),
    negativeMonths: monthlyReturns.filter(value => value < 0).length
  };
}

async function main() {
  const v13 = JSON.parse(await fs.readFile(V13, 'utf8'));
  const trainTrades = v13.trainTradesDetail || [];
  const validationTrades = v13.validationTradesDetail || [];
  if (!trainTrades.length || !validationTrades.length) {
    const output = {
      generatedAt: new Date().toISOString(),
      status: 'missing_trade_details',
      conclusion: 'v13 目前沒有保存 train/validation closedTrades，需下一輪改完整回測引擎輸出交易明細後才能做真實子集合診斷。'
    };
    await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    await fs.writeFile(REPORT, `# Top5 交易子集合診斷 v1\n\n${output.conclusion}\n`, 'utf8');
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  const candidates = makeFilters().map(filter => {
    const trainRows = trainTrades.filter(row => pass(row, filter));
    const train = summarize(trainRows);
    return { filter, train, score: train.averageMonthlyAccountReturnPct * 3 + train.profitFactor + Math.min(1, train.trades / 300) - train.negativeMonths * 0.02 };
  }).filter(row => row.train.trades >= 120 && row.train.profitFactor > 1.15)
    .sort((a, b) => b.score - a.score);
  const selected = candidates[0] || null;
  const validationRows = selected ? validationTrades.filter(row => pass(row, selected.filter)) : [];
  const validation = summarize(validationRows);
  const output = {
    generatedAt: new Date().toISOString(),
    status: selected ? 'validated' : 'no_candidate',
    selected,
    validation,
    conclusion: selected
      ? `找到交易明細子集合，validation 交易 ${validation.trades} 筆、月均帳戶貢獻 ${validation.averageMonthlyAccountReturnPct}%。仍需下一輪完整 portfolio 回測確認。`
      : '訓練期找不到足夠樣本且 PF > 1.15 的子集合。'
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# Top5 交易子集合診斷 v1\n\n- 狀態：${output.status}\n- 結論：${output.conclusion}\n\n本診斷只用訓練期挑條件，再套到 validation；不是實盤策略，下一步仍需完整 portfolio 回測。\n`, 'utf8');
  console.log(JSON.stringify(output, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
