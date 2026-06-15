import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  buildSignalMaps,
  foldWindows,
  loadResearchContext,
  mean,
  RESEARCH_COMBINATIONS,
  round,
  simulateSignalMap
} from './research-core.mjs';

const OUTPUT = new URL('../../data/research/factor-lab-results.json', import.meta.url);
const REPORT = new URL('../../docs/FACTOR_LAB_REPORT.md', import.meta.url);
const BENCHMARK = new URL('../../data/research/benchmark-comparison.json', import.meta.url);
const SECTION_MARKER = '\n## 因子組合 Walk-Forward 驗證\n';

function aggregateValidation(folds) {
  const trades = folds.flatMap(fold => fold.validation.trades);
  const monthly = folds.flatMap(fold => fold.validation.summary.monthly);
  const gains = trades.filter(trade => trade.realizedPnl > 0)
    .reduce((sum, trade) => sum + trade.realizedPnl, 0);
  const losses = Math.abs(trades.filter(trade => trade.realizedPnl <= 0)
    .reduce((sum, trade) => sum + trade.realizedPnl, 0));
  const symbolCounts = trades.reduce((counts, trade) => {
    counts[trade.symbol] = (counts[trade.symbol] || 0) + 1;
    return counts;
  }, {});
  return {
    validationSamples: trades.length,
    validationAverageMonthlyEquityReturnPct: round(
      mean(monthly.map(row => row.equityReturnPct)) || 0
    ),
    validationProfitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    validationWinRatePct: round(
      trades.filter(trade => trade.realizedPnl > 0).length / Math.max(1, trades.length) * 100
    ),
    validationMaximumDrawdownPct: round(
      Math.min(0, ...folds.map(fold => fold.validation.summary.maximumDrawdownPct))
    ),
    validationNegativeMonths: monthly.filter(row => row.equityReturnPct < 0).length,
    validationConcentrationPct: round(
      Math.max(0, ...Object.values(symbolCounts)) / Math.max(1, trades.length) * 100
    )
  };
}

function benchmarkThresholds(benchmark) {
  const byId = Object.fromEntries(benchmark.results.map(row => [row.id, row.summary]));
  return {
    randomMonthlyReturnPct: byId.random_selection.averageMonthlyEquityReturnPct,
    marketMonthlyReturnPct: byId.buy_and_hold_market.averageMonthlyEquityReturnPct
  };
}

function candidateDecision(summary, thresholds) {
  const checks = {
    enoughSamples: summary.validationSamples > 300,
    positiveProfitFactor: summary.validationProfitFactor > 1,
    positiveMonthlyReturn: summary.validationAverageMonthlyEquityReturnPct > 0,
    controlledDrawdown: summary.validationMaximumDrawdownPct > -20,
    beatsRandom: summary.validationAverageMonthlyEquityReturnPct
      >= thresholds.randomMonthlyReturnPct,
    beatsMarket: summary.validationAverageMonthlyEquityReturnPct
      >= thresholds.marketMonthlyReturnPct,
    diversified: summary.validationConcentrationPct <= 10
  };
  return {
    qualifies: Object.values(checks).every(Boolean),
    checks,
    failureReasons: Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => ({
        enoughSamples: 'Validation 交易樣本未超過 300。',
        positiveProfitFactor: 'Validation Profit Factor 未超過 1。',
        positiveMonthlyReturn: 'Validation 月均總資產報酬未大於 0。',
        controlledDrawdown: 'Validation 最大回撤超過 20%。',
        beatsRandom: 'Validation 月均報酬輸給隨機策略。',
        beatsMarket: 'Validation 月均報酬輸給 0050 買進持有。',
        diversified: '交易過度集中於少數股票。'
      })[name])
  };
}

function appendMarkdown(existing, report) {
  const base = existing.includes(SECTION_MARKER)
    ? existing.slice(0, existing.indexOf(SECTION_MARKER))
    : existing.trimEnd();
  const rows = report.combinations.map(row => (
    `| ${row.label} | ${row.summary.validationSamples} | ${row.summary.validationAverageMonthlyEquityReturnPct}% | ${row.summary.validationProfitFactor ?? '-'} | ${row.summary.validationMaximumDrawdownPct}% | ${row.summary.validationWinRatePct}% | ${row.summary.validationConcentrationPct}% | ${row.overfitFolds} | ${row.decision.qualifies ? '候選' : '不合格'} | ${row.decision.failureReasons.join('、') || '-'} |`
  )).join('\n');
  const foldRows = report.combinations.flatMap(combo => combo.folds.map(fold => (
    `| ${combo.label} | ${fold.index} | ${fold.trainStart} 至 ${fold.trainEnd} | ${fold.validationStart} 至 ${fold.validationEnd} | ${fold.train.summary.averageMonthlyEquityReturnPct}% | ${fold.validation.summary.averageMonthlyEquityReturnPct}% | ${fold.train.summary.profitFactor ?? '-'} | ${fold.validation.summary.profitFactor ?? '-'} | ${fold.overfit ? '是' : '否'} |`
  ))).join('\n');
  return `${base}${SECTION_MARKER}

固定規則使用 36 個月訓練、12 個月驗證，每次向前滾動 12 個月。訓練區間只用來檢查規則是否曾有效，驗證期間不修改任何條件。

### 合併驗證結果

| 因子組合 | Validation 樣本 | 月均總資產報酬 | Profit Factor | 最大回撤 | 勝率 | 集中度 | 過度擬合區段 | 判定 | 未通過原因 |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|
${rows}

### 候選策略

${report.candidates.length
    ? report.candidates.map(row => `- ${row.label}`).join('\n')
    : '- 找不到符合全部條件的候選策略。'}

### 各段 Walk-Forward

| 因子組合 | 區段 | 訓練期間 | 驗證期間 | 訓練月均報酬 | 驗證月均報酬 | 訓練 PF | 驗證 PF | 過度擬合 |
|---|---:|---|---|---:|---:|---:|---:|---|
${foldRows}
`;
}

async function main() {
  const [context, benchmark, prior] = await Promise.all([
    loadResearchContext(),
    fs.readFile(BENCHMARK, 'utf8').then(JSON.parse),
    fs.readFile(OUTPUT, 'utf8').then(JSON.parse)
  ]);
  const signalMaps = buildSignalMaps(context, RESEARCH_COMBINATIONS, { dailyLimit: 8 });
  const windows = foldWindows(context.startDate, context.endDate);
  const thresholds = benchmarkThresholds(benchmark);
  const combinations = [];

  for (const definition of RESEARCH_COMBINATIONS) {
    const folds = [];
    for (const [index, window] of windows.entries()) {
      const train = simulateSignalMap(context, signalMaps[definition.id], {
        strategyId: definition.label,
        holdingDays: 5,
        startDate: window.trainStart,
        endDate: window.trainEnd
      });
      const validation = simulateSignalMap(context, signalMaps[definition.id], {
        strategyId: definition.label,
        holdingDays: 5,
        startDate: window.validationStart,
        endDate: window.validationEnd
      });
      const overfit = train.summary.averageMonthlyEquityReturnPct > 0
        && (validation.summary.averageMonthlyEquityReturnPct <= 0
          || validation.summary.profitFactor <= 1);
      folds.push({
        index: index + 1,
        ...window,
        train,
        validation,
        overfit
      });
    }
    const summary = aggregateValidation(folds);
    const compactFolds = folds.map(fold => ({
      index: fold.index,
      trainStart: fold.trainStart,
      trainEnd: fold.trainEnd,
      validationStart: fold.validationStart,
      validationEnd: fold.validationEnd,
      train: { summary: fold.train.summary },
      validation: { summary: fold.validation.summary },
      overfit: fold.overfit
    }));
    combinations.push({
      id: definition.id,
      label: definition.label,
      summary,
      overfitFolds: folds.filter(fold => fold.overfit).length,
      decision: candidateDecision(summary, thresholds),
      folds: compactFolds
    });
    console.log(`${definition.label}：驗證 ${summary.validationSamples} 筆，月均 ${summary.validationAverageMonthlyEquityReturnPct}%`);
  }

  const candidates = combinations.filter(row => row.decision.qualifies).map(row => ({
    id: row.id,
    label: row.label,
    summary: row.summary
  }));
  const factorCombinations = {
    generatedAt: new Date().toISOString(),
    methodology: {
      trainMonths: 36,
      validationMonths: 12,
      rollMonths: 12,
      holdingDays: 5,
      fixedRulesDuringValidation: true,
      minimumValidationSamples: 300,
      maximumAllowedDrawdownPct: 20,
      randomMonthlyReturnThresholdPct: thresholds.randomMonthlyReturnPct,
      marketMonthlyReturnThresholdPct: thresholds.marketMonthlyReturnPct
    },
    combinations,
    candidates,
    conclusion: candidates.length
      ? `找到 ${candidates.length} 組符合全部條件的候選策略。`
      : '找不到符合全部條件的候選策略。'
  };
  const result = { ...prior, factorCombinations };
  const existingMarkdown = await fs.readFile(REPORT, 'utf8');
  await fs.writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, appendMarkdown(existingMarkdown, factorCombinations), 'utf8');
  console.log(JSON.stringify({
    output: fileURLToPath(OUTPUT),
    report: fileURLToPath(REPORT),
    candidates,
    conclusion: factorCombinations.conclusion
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
