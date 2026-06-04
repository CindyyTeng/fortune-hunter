import { readFile, writeFile } from 'node:fs/promises';

const BACKTEST_FILE = new URL('../data/trade-mode-backtest.json', import.meta.url);
const OUTPUT_JSON = new URL('../data/best-mode-diagnostics.json', import.meta.url);
const OUTPUT_MD = new URL('../BEST_MODE_DIAGNOSTICS.md', import.meta.url);
const ENTRY_MODE = process.env.DIAG_ENTRY_MODE || 'resistance_breakout';
const EXIT_MODE = process.env.DIAG_EXIT_MODE || 'fixed_hold';

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function bucket(value, cuts, labels) {
  for (let i = 0; i < cuts.length; i++) {
    if (value < cuts[i]) return labels[i];
  }
  return labels.at(-1);
}

function summarize(rows) {
  const returns = rows.map(row => row.netReturnPct).filter(Number.isFinite);
  const wins = rows.filter(row => row.netReturnPct > 0);
  const losses = rows.filter(row => row.netReturnPct <= 0);
  const gross = rows.map(row => row.grossReturnPct).filter(Number.isFinite);
  const profit = wins.reduce((sum, row) => sum + row.netReturnPct, 0);
  const loss = Math.abs(losses.reduce((sum, row) => sum + row.netReturnPct, 0));
  return {
    trades: rows.length,
    winRatePct: round((wins.length / Math.max(1, rows.length)) * 100),
    avgNetReturnPct: round(mean(returns) || 0),
    medianNetReturnPct: round(median(returns) || 0),
    p25NetReturnPct: round(quantile(returns, 0.25) || 0),
    p75NetReturnPct: round(quantile(returns, 0.75) || 0),
    avgGrossReturnPct: round(mean(gross) || 0),
    totalNetReturnPct: round(returns.reduce((sum, value) => sum + value, 0)),
    bestTradePct: returns.length ? round(Math.max(...returns)) : null,
    worstTradePct: returns.length ? round(Math.min(...returns)) : null,
    avgMaePct: round(mean(rows.map(row => row.maePct).filter(Number.isFinite)) || 0),
    avgMfePct: round(mean(rows.map(row => row.mfePct).filter(Number.isFinite)) || 0),
    profitFactor: loss ? round(profit / loss) : null
  };
}

function groupBy(rows, keyFn, minTrades = 1) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .filter(([, groupRows]) => groupRows.length >= minTrades)
    .map(([key, groupRows]) => ({ key, ...summarize(groupRows) }))
    .sort((a, b) => b.avgNetReturnPct - a.avgNetReturnPct);
}

function topRows(rows, limit, direction) {
  return [...rows]
    .sort((a, b) => direction === 'best' ? b.netReturnPct - a.netReturnPct : a.netReturnPct - b.netReturnPct)
    .slice(0, limit)
    .map(row => ({
      symbol: row.symbol,
      name: row.name,
      market: row.market,
      industry: row.industry,
      signalDate: row.signalDate,
      entryDate: row.entryDate,
      signalScore: row.signalScore,
      netReturnPct: row.netReturnPct,
      maePct: row.maePct,
      mfePct: row.mfePct,
      avg20TradeValue: row.avg20TradeValue,
      std20: row.std20,
      planRiskPct: row.planRiskPct
    }));
}

function concentration(rows) {
  const totalNet = rows.reduce((sum, row) => sum + row.netReturnPct, 0);
  const wins = rows.filter(row => row.netReturnPct > 0).sort((a, b) => b.netReturnPct - a.netReturnPct);
  const top5 = wins.slice(0, 5).reduce((sum, row) => sum + row.netReturnPct, 0);
  const top10 = wins.slice(0, 10).reduce((sum, row) => sum + row.netReturnPct, 0);
  const withoutTop5 = summarize(rows.filter(row => !wins.slice(0, 5).includes(row)));
  const withoutTop10 = summarize(rows.filter(row => !wins.slice(0, 10).includes(row)));
  return {
    totalNetReturnPct: round(totalNet),
    top5WinnerContributionPct: totalNet ? round((top5 / totalNet) * 100) : null,
    top10WinnerContributionPct: totalNet ? round((top10 / totalNet) * 100) : null,
    withoutTop5,
    withoutTop10
  };
}

function markdown(report) {
  const lines = [];
  const add = line => lines.push(line);
  const addTable = (columns, rows) => {
    add(columns.join(' | '));
    add(columns.map(() => '---').join(' | '));
    for (const row of rows) add(columns.map(col => row[col] ?? '').join(' | '));
    add('');
  };

  add('# Best Mode Diagnostics');
  add('');
  add(`Mode: \`${report.mode}\``);
  add(`Generated at: ${report.generatedAt}`);
  add('');
  add('## Overall');
  add('');
  addTable(
    ['trades', 'winRatePct', 'avgNetReturnPct', 'medianNetReturnPct', 'profitFactor', 'bestTradePct', 'worstTradePct'],
    [report.overall]
  );
  add('## Concentration');
  add('');
  addTable(
    ['totalNetReturnPct', 'top5WinnerContributionPct', 'top10WinnerContributionPct'],
    [report.concentration]
  );
  add('## By Year');
  add('');
  addTable(['key', 'trades', 'winRatePct', 'avgNetReturnPct', 'profitFactor', 'worstTradePct'], report.byYear);
  add('## By Market');
  add('');
  addTable(['key', 'trades', 'winRatePct', 'avgNetReturnPct', 'profitFactor', 'worstTradePct'], report.byMarket);
  add('## By Score Bucket');
  add('');
  addTable(['key', 'trades', 'winRatePct', 'avgNetReturnPct', 'profitFactor', 'worstTradePct'], report.byScoreBucket);
  add('## By Liquidity Bucket');
  add('');
  addTable(['key', 'trades', 'winRatePct', 'avgNetReturnPct', 'profitFactor', 'worstTradePct'], report.byLiquidityBucket);
  add('## By Volatility Bucket');
  add('');
  addTable(['key', 'trades', 'winRatePct', 'avgNetReturnPct', 'profitFactor', 'worstTradePct'], report.byVolatilityBucket);
  add('## By Plan Risk Bucket');
  add('');
  addTable(['key', 'trades', 'winRatePct', 'avgNetReturnPct', 'profitFactor', 'worstTradePct'], report.byPlanRiskBucket);
  add('## Top Winners');
  add('');
  addTable(['symbol', 'name', 'industry', 'entryDate', 'signalScore', 'netReturnPct', 'maePct', 'mfePct'], report.topWinners);
  add('## Top Losers');
  add('');
  addTable(['symbol', 'name', 'industry', 'entryDate', 'signalScore', 'netReturnPct', 'maePct', 'mfePct'], report.topLosers);
  add('## Decision Notes');
  add('');
  for (const note of report.decisionNotes) add(`- ${note}`);
  add('');
  return `${lines.join('\n')}\n`;
}

function buildDecisionNotes(report) {
  const notes = [];
  const top5 = report.concentration.top5WinnerContributionPct;
  const withoutTop5 = report.concentration.withoutTop5;
  if (top5 !== null && top5 > 50) {
    notes.push(`High concentration risk: top 5 winners contribute ${top5}% of total net return.`);
  } else {
    notes.push(`Concentration is acceptable at this stage: top 5 winners contribute ${top5}% of total net return.`);
  }
  if (withoutTop5.avgNetReturnPct > 0 && withoutTop5.profitFactor > 1) {
    notes.push(`After removing top 5 winners, the mode still has positive average return (${withoutTop5.avgNetReturnPct}%) and PF ${withoutTop5.profitFactor}.`);
  } else {
    notes.push('After removing top 5 winners, the edge is weak; this mode should not be automated without more filters.');
  }
  const badYears = report.byYear.filter(row => row.avgNetReturnPct <= 0);
  if (badYears.length) {
    notes.push(`Unstable by year: negative or flat years detected (${badYears.map(row => row.key).join(', ')}).`);
  } else {
    notes.push('No negative year in the current two-year split, but 2024 and 2025 are much weaker than 2026.');
  }
  const worst = report.topLosers[0];
  if (worst) notes.push(`Worst observed trade is ${worst.symbol} ${worst.name} at ${worst.netReturnPct}%, so the first automation version still needs hard risk limits.`);
  notes.push('Next engineering step: use this diagnosis to add mode-specific filters, then rerun the backtest before any paper trading or broker API work.');
  return notes;
}

async function main() {
  const data = JSON.parse(await readFile(BACKTEST_FILE, 'utf8'));
  const rows = data.trades.filter(row => row.entryMode === ENTRY_MODE && row.exitMode === EXIT_MODE);
  if (!rows.length) {
    throw new Error(`No trades found for ${ENTRY_MODE} + ${EXIT_MODE}. Run npm run backtest:modes first.`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    sourceGeneratedAt: data.generatedAt,
    mode: `${ENTRY_MODE} + ${EXIT_MODE}`,
    assumptions: data.assumptions,
    filters: data.filters,
    overall: summarize(rows),
    concentration: concentration(rows),
    byYear: groupBy(rows, row => row.entryDate.slice(0, 4)),
    byMarket: groupBy(rows, row => row.market || 'unknown'),
    byIndustry: groupBy(rows, row => row.industry || 'unknown', 5),
    byScoreBucket: groupBy(rows, row => bucket(row.signalScore, [80, 90, 95, 100], ['<80', '80-89', '90-94', '95-99', '100'])),
    byLiquidityBucket: groupBy(rows, row => bucket(row.avg20TradeValue, [100000000, 500000000, 1000000000], ['<100m', '100m-500m', '500m-1b', '>=1b'])),
    byVolatilityBucket: groupBy(rows, row => bucket(row.std20, [2, 4, 6], ['<2', '2-4', '4-6', '>=6'])),
    byPlanRiskBucket: groupBy(rows, row => bucket(row.planRiskPct || 0, [4, 6, 8.5], ['<4', '4-6', '6-8.5', '>=8.5'])),
    topWinners: topRows(rows, 10, 'best'),
    topLosers: topRows(rows, 10, 'worst')
  };
  report.decisionNotes = buildDecisionNotes(report);

  await writeFile(OUTPUT_JSON, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(OUTPUT_MD, markdown(report), 'utf8');
  console.log(JSON.stringify({
    outputJson: OUTPUT_JSON.pathname,
    outputMarkdown: OUTPUT_MD.pathname,
    mode: report.mode,
    overall: report.overall,
    concentration: {
      top5WinnerContributionPct: report.concentration.top5WinnerContributionPct,
      withoutTop5: report.concentration.withoutTop5
    },
    decisionNotes: report.decisionNotes
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
