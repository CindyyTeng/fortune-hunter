import fs from 'node:fs/promises';

const RESEARCH_DIR = new URL('../../data/research/', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-strategy-frontier-audit-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_STRATEGY_FRONTIER_AUDIT_V1.md', import.meta.url);

const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

function readMetric(payload) {
  const metrics = payload.metrics || payload.best?.metrics || payload.bestFixed?.metrics || payload.bestStrategy?.metrics || payload.summary;
  if (!metrics) return null;
  const monthly = metrics.averageMonthlyReturnPct ?? metrics.averageMonthlyEquityReturnPct ?? metrics.monthlyReturnPct;
  const drawdown = metrics.maximumDrawdownPct ?? metrics.maxDrawdownPct;
  const trades = metrics.trades ?? metrics.tradeCount;
  if (!Number.isFinite(monthly) || !Number.isFinite(drawdown) || !Number.isFinite(trades)) return null;
  return {
    monthly: round(monthly),
    annualized: round(metrics.annualizedReturnPct ?? metrics.annualReturnPct),
    drawdown: round(drawdown),
    trades,
    profitFactor: round(metrics.profitFactor),
    winRate: round(metrics.winRatePct),
    beats0050: Boolean(metrics.beats0050 ?? payload.checks?.beats0050),
    targetMet: Boolean(payload.targetMet)
  };
}

function score(row) {
  const tradeScore = Math.min(1, row.trades / 300);
  const drawdownScore = row.drawdown >= -20 ? 1 : Math.max(0, 1 + (row.drawdown + 20) / 30);
  const pfScore = Number.isFinite(row.profitFactor) ? Math.min(2, row.profitFactor) / 2 : 0;
  return round(row.monthly * 3 + tradeScore + drawdownScore + pfScore);
}

async function main() {
  const files = (await fs.readdir(RESEARCH_DIR)).filter(file => file.startsWith('stock-') && file.endsWith('.json'));
  const rows = [];
  for (const file of files) {
    try {
      const payload = JSON.parse(await fs.readFile(new URL(file, RESEARCH_DIR), 'utf8'));
      const metrics = readMetric(payload);
      if (!metrics) continue;
      rows.push({
        file,
        strategyId: payload.strategyId || file.replace(/\.json$/, ''),
        ...metrics
      });
    } catch {
      // Ignore broken or compressed research artifacts; this audit only ranks readable JSON summaries.
    }
  }
  const ranked = rows.map(row => ({ ...row, score: score(row), gapToFivePct: round(5 - row.monthly) }))
    .sort((left, right) => right.score - left.score || right.monthly - left.monthly);
  const viableBase = ranked.filter(row => row.trades >= 300 && row.drawdown >= -20 && Number.isFinite(row.profitFactor) && row.profitFactor > 1.15);
  const best = ranked[0] || null;
  const bestViableBase = viableBase[0] || null;
  const output = {
    generatedAt: new Date().toISOString(),
    universe: '純個股研究結果；ETF/0050 僅作比較基準，不列入候選策略。',
    totalReadableStrategies: rows.length,
    best,
    bestViableBase,
    top: ranked.slice(0, 12),
    conclusion: bestViableBase
      ? `目前最值得延伸的是 ${bestViableBase.strategyId}，月均 ${bestViableBase.monthly}%，距離 5% 還差 ${bestViableBase.gapToFivePct} 個百分點。`
      : '目前沒有同時滿足交易數、回撤與 PF 的純個股母策略。'
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 純個股策略 Frontier 稽核 v1\n\n- 可讀策略數：${output.totalReadableStrategies}\n- 最佳分數策略：${best?.strategyId || '無'}\n- 最佳可延伸母策略：${bestViableBase?.strategyId || '無'}\n- 月均報酬：${bestViableBase?.monthly ?? '無'}%\n- 最大回撤：${bestViableBase?.drawdown ?? '無'}%\n- 交易筆數：${bestViableBase?.trades ?? '無'}\n- Profit Factor：${bestViableBase?.profitFactor ?? '無'}\n- 距離月均 5%：${bestViableBase?.gapToFivePct ?? '無'} 個百分點\n\n## 結論\n\n${output.conclusion}\n\n放寬交易條件的策略交易數會變多，但多數績效與回撤大幅惡化。後續應以目前最穩定的正報酬母策略做「保留正期望」改良，而不是增加低品質交易。\n`, 'utf8');
  console.log(JSON.stringify({
    totalReadableStrategies: output.totalReadableStrategies,
    best: output.best,
    bestViableBase: output.bestViableBase,
    conclusion: output.conclusion
  }, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
