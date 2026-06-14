import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  compositeScore,
  loadRegimeDataset,
  runRegimeBacktest
} from './backtest-regime-ensemble-10y.mjs';

const OUTPUT = new URL('../data/walk-forward-regime-report.json', import.meta.url);
const REPORT = new URL('../docs/WALK_FORWARD_REGIME_REPORT.md', import.meta.url);
const TRAIN_MONTHS = 36;
const VALIDATION_MONTHS = 12;
const ROLL_MONTHS = 12;

const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function addMonths(dateText, count) {
  const date = new Date(`${dateText.slice(0, 7)}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + count);
  return date.toISOString().slice(0, 10);
}

function dayBefore(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function parameterSets() {
  return [
    {
      id: 'balanced',
      maxOpenPositions: 6,
      accountRiskPct: 1.5,
      strategyParameters: {
        breakoutMomentumStrategy: { minScore: 72, minVolumeRatio: 1.05 },
        pullbackTrendStrategy: { minScore: 65 },
        rangeReversionStrategy: { minScore: 60 },
        oversoldReboundStrategy: { minScore: 55 }
      }
    },
    {
      id: 'quality',
      maxOpenPositions: 5,
      accountRiskPct: 1.25,
      strategyParameters: {
        breakoutMomentumStrategy: { minScore: 80, minVolumeRatio: 1.2 },
        pullbackTrendStrategy: { minScore: 72 },
        rangeReversionStrategy: { minScore: 68 },
        oversoldReboundStrategy: { minScore: 62 }
      }
    },
    {
      id: 'diversified',
      maxOpenPositions: 8,
      accountRiskPct: 1,
      regimeStrategyMap: {
        RANGE_BOUND: 'oversoldReboundStrategy'
      },
      strategyParameters: {
        breakoutMomentumStrategy: { minScore: 68, minVolumeRatio: 1 },
        pullbackTrendStrategy: { minScore: 60 },
        rangeReversionStrategy: { minScore: 56 },
        oversoldReboundStrategy: { minScore: 52 }
      }
    },
    {
      id: 'trend_focus',
      maxOpenPositions: 6,
      accountRiskPct: 1.5,
      allowOversold: false,
      regimeStrategyMap: {
        BULL_PULLBACK: 'breakoutMomentumStrategy',
        RANGE_BOUND: 'cashDefenseStrategy'
      },
      strategyParameters: {
        breakoutMomentumStrategy: { minScore: 70, minVolumeRatio: 1.1 },
        pullbackTrendStrategy: { minScore: 68 },
        rangeReversionStrategy: { minScore: 70 }
      }
    },
    {
      id: 'defensive',
      maxOpenPositions: 4,
      accountRiskPct: 0.8,
      allowOversold: false,
      regimeStrategyMap: {
        RANGE_BOUND: 'cashDefenseStrategy'
      },
      strategyParameters: {
        breakoutMomentumStrategy: { minScore: 82, minVolumeRatio: 1.25 },
        pullbackTrendStrategy: { minScore: 75 },
        rangeReversionStrategy: { minScore: 70 },
        oversoldReboundStrategy: { minScore: 65 }
      }
    },
    {
      id: 'adaptive_breadth',
      maxOpenPositions: 7,
      accountRiskPct: 1.2,
      regimeStrategyMap: {
        RANGE_BOUND: 'oversoldReboundStrategy'
      },
      strategyParameters: {
        breakoutMomentumStrategy: { minScore: 74, minVolumeRatio: 1 },
        pullbackTrendStrategy: { minScore: 62 },
        rangeReversionStrategy: { minScore: 58 },
        oversoldReboundStrategy: { minScore: 58 }
      }
    }
  ];
}

function optimizerScore(result) {
  return compositeScore(result);
}

function validationComposite(result, trainResult) {
  const base = optimizerScore(result);
  const gap = Math.abs(
    trainResult.summary.equityAverageMonthlyReturnPct
      - result.summary.equityAverageMonthlyReturnPct
  );
  return round(base - gap * 3, 4);
}

function windows(startDate, endDate) {
  const rows = [];
  let trainStart = `${startDate.slice(0, 7)}-01`;
  while (true) {
    const validationStart = addMonths(trainStart, TRAIN_MONTHS);
    const validationEndExclusive = addMonths(validationStart, VALIDATION_MONTHS);
    if (validationStart > endDate) break;
    rows.push({
      trainStart,
      trainEnd: dayBefore(validationStart),
      validationStart,
      validationEnd: dayBefore(validationEndExclusive) > endDate
        ? endDate
        : dayBefore(validationEndExclusive)
    });
    if (validationEndExclusive > endDate) break;
    trainStart = addMonths(trainStart, ROLL_MONTHS);
  }
  return rows;
}

function combinedSummary(folds) {
  const monthly = folds.flatMap(fold => fold.validation.monthly);
  const trades = folds.reduce((sum, fold) => sum + fold.validation.summary.trades, 0);
  return {
    folds: folds.length,
    validationMonths: monthly.length,
    trades,
    validationEquityAverageMonthlyReturnPct: round(mean(monthly.map(row => row.equityReturnPct))),
    validationRealizedAverageMonthlyReturnPct: round(mean(monthly.map(row => row.realizedReturnPct))),
    negativeEquityMonths: monthly.filter(row => row.equityReturnPct < 0).length,
    tenPercentRealizedMonths: monthly.filter(row => row.realizedReturnPct >= 10).length,
    worstValidationMaxDrawdownPct: round(Math.min(...folds.map(fold => fold.validation.summary.maxDrawdownPct))),
    overfitFolds: folds.filter(fold => fold.overfitFlag).length
  };
}

function markdown(report) {
  const foldRows = report.folds.map(fold => (
    `| ${fold.index} | ${fold.train.startDate} ~ ${fold.train.endDate} | ${fold.validation.startDate} ~ ${fold.validation.endDate} | ${fold.selectedConfig.id} | ${fold.train.summary.equityAverageMonthlyReturnPct}% | ${fold.validation.summary.equityAverageMonthlyReturnPct}% | ${fold.trainValidationGapPct}% | ${fold.overfitFlag ? '是' : '否'} |`
  )).join('\n');
  const monthRows = report.folds.flatMap(fold => fold.validation.monthly.map(row => (
    `| ${fold.index} | ${row.month} | ${row.realizedReturnPct}% | ${row.equityReturnPct}% | ${row.openPositions} |`
  ))).join('\n');
  return `# 滾動式市場狀態策略驗證

> 訓練 ${TRAIN_MONTHS} 個月、驗證 ${VALIDATION_MONTHS} 個月，每次前進 ${ROLL_MONTHS} 個月。每段驗證期的參數在進入驗證前已固定。

## 合併驗證績效

- 驗證區段：${report.summary.folds}
- 驗證月份：${report.summary.validationMonths}
- 交易筆數：${report.summary.trades}
- 平均月總資產報酬：${report.summary.validationEquityAverageMonthlyReturnPct}%
- 平均月已實現報酬：${report.summary.validationRealizedAverageMonthlyReturnPct}%
- 負總資產月份：${report.summary.negativeEquityMonths}
- 已實現報酬達 10% 月份：${report.summary.tenPercentRealizedMonths}
- 最差驗證期最大回撤：${report.summary.worstValidationMaxDrawdownPct}%
- 過度擬合警告區段：${report.summary.overfitFolds}
- 倖存者偏差警告：**${report.survivorshipBiasWarning ? '是' : '否'}**

## 各段訓練與驗證

| 段 | 訓練期間 | 驗證期間 | 固定參數組 | 訓練月總資產報酬 | 驗證月總資產報酬 | 落差 | 過度擬合 |
|---:|---|---|---|---:|---:|---:|---|
${foldRows}

## 驗證期每月績效

| 段 | 月份 | 已實現報酬 | 總資產報酬 | 月底持倉 |
|---:|---|---:|---:|---:|
${monthRows}
`;
}

async function main() {
  const dataset = await loadRegimeDataset();
  const endDate = dataset.marketHistory.at(-1).date;
  const startDate = addMonths(endDate, -120);
  const folds = [];
  const configs = parameterSets();

  for (const [index, window] of windows(startDate, endDate).entries()) {
    const trainingRuns = [];
    for (const config of configs) {
      const result = await runRegimeBacktest(dataset, {
        ...config,
        startDate: window.trainStart,
        endDate: window.trainEnd
      });
      trainingRuns.push({ config, result, score: optimizerScore(result) });
    }
    trainingRuns.sort((a, b) => b.score - a.score);
    const selected = trainingRuns[0];
    const validation = await runRegimeBacktest(dataset, {
      ...selected.config,
      startDate: window.validationStart,
      endDate: window.validationEnd
    });
    const gap = round(
      selected.result.summary.equityAverageMonthlyReturnPct
        - validation.summary.equityAverageMonthlyReturnPct
    );
    const overfitFlag = gap > 2
      || (selected.result.summary.equityAverageMonthlyReturnPct > 0
        && validation.summary.equityAverageMonthlyReturnPct <= 0)
      || selected.result.summary.trades >= 20 && validation.summary.trades < 3;
    folds.push({
      index: index + 1,
      selectedConfig: selected.config,
      trainScore: selected.score,
      validationScore: validationComposite(validation, selected.result),
      trainValidationGapPct: gap,
      overfitFlag,
      trainLeaderboard: trainingRuns.map(run => ({
        configId: run.config.id,
        score: run.score,
        equityAverageMonthlyReturnPct: run.result.summary.equityAverageMonthlyReturnPct,
        realizedAverageMonthlyReturnPct: run.result.summary.realizedAverageMonthlyReturnPct,
        maxDrawdownPct: run.result.summary.maxDrawdownPct,
        trades: run.result.summary.trades
      })),
      train: selected.result,
      validation
    });
    console.log(`walk-forward ${index + 1}: ${selected.config.id}, validation ${validation.summary.equityAverageMonthlyReturnPct}%`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    methodology: {
      trainMonths: TRAIN_MONTHS,
      validationMonths: VALIDATION_MONTHS,
      rollMonths: ROLL_MONTHS,
      selection: '僅使用訓練期 composite score 選參數，驗證期不再調整',
      compositeScore: 'equityAvg*3 + realizedAvg - negativeMonths*3 - drawdown*2 - trainValidationGap*3 - lowTradeCount - concentration'
    },
    survivorshipBiasWarning: folds.some(fold => fold.validation.survivorshipBiasWarning),
    summary: combinedSummary(folds),
    folds
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, markdown(report), 'utf8');
  console.log(JSON.stringify({
    output: fileURLToPath(OUTPUT),
    report: fileURLToPath(REPORT),
    summary: report.summary
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
