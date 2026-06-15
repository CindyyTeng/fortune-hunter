import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  analyzeSingleFactors,
  loadResearchContext
} from './research-core.mjs';

const OUTPUT = new URL('../../data/research/factor-lab-results.json', import.meta.url);
const REPORT = new URL('../../docs/FACTOR_LAB_REPORT.md', import.meta.url);

function splitDate(context) {
  const dates = context.marketHistory
    .map(row => row.date)
    .filter(date => date >= context.startDate && date <= context.endDate);
  return dates[Math.floor(dates.length * 0.7)];
}

function groupMap(factor) {
  return new Map(factor.groups.map(group => [group.group, group]));
}

function evaluateValidation(train, validation) {
  const validationByFactor = new Map(validation.factors.map(factor => [factor.id, factor]));
  return train.factors.map(factor => {
    const validationFactor = validationByFactor.get(factor.id);
    const bestTrainGroup = [...factor.groups]
      .filter(group => group.horizons[5])
      .sort((left, right) => (
        right.horizons[5].costAdjustedAverageReturnPct
          - left.horizons[5].costAdjustedAverageReturnPct
      ))[0];
    const validationGroup = groupMap(validationFactor).get(bestTrainGroup?.group);
    const trainMetrics = bestTrainGroup?.horizons[5];
    const validationMetrics = validationGroup?.horizons[5];
    const effective = Boolean(
      trainMetrics?.costAdjustedAverageReturnPct > 0
      && validationMetrics?.sampleSize >= 300
      && validationMetrics?.costAdjustedAverageReturnPct > 0
      && validationMetrics?.profitFactor > 1
      && Math.abs(validationMetrics?.tStatistic || 0) >= 2
    );
    return {
      factorId: factor.id,
      factorLabel: factor.label,
      selectedTrainGroup: bestTrainGroup?.group || null,
      trainFiveDay: trainMetrics || null,
      validationFiveDay: validationMetrics || null,
      effective,
      overfit: Boolean(
        trainMetrics?.costAdjustedAverageReturnPct > 0
        && validationMetrics?.costAdjustedAverageReturnPct <= 0
      ),
      reason: effective
        ? '訓練與驗證皆維持扣除成本後正報酬，驗證樣本與穩定性達標。'
        : trainMetrics?.costAdjustedAverageReturnPct <= 0
          ? '訓練期間扣除成本後平均報酬不為正，不能視為穩定方向。'
          : validationMetrics?.sampleSize < 300
          ? '驗證樣本少於 300。'
          : validationMetrics?.profitFactor <= 1
            ? '驗證 Profit Factor 未超過 1。'
            : validationMetrics?.costAdjustedAverageReturnPct <= 0
              ? '驗證扣除成本後平均報酬不為正。'
              : '驗證 t-stat 絕對值未達 2，穩定性不足。'
    };
  });
}

function markdown(report) {
  const validationRows = report.validationAssessment.map(row => (
    `| ${row.factorLabel} | ${row.selectedTrainGroup || '-'} | ${row.trainFiveDay?.costAdjustedAverageReturnPct ?? '-'}% | ${row.validationFiveDay?.sampleSize ?? 0} | ${row.validationFiveDay?.costAdjustedAverageReturnPct ?? '-'}% | ${row.validationFiveDay?.profitFactor ?? '-'} | ${row.validationFiveDay?.tStatistic ?? '-'} | ${row.effective ? '有效' : '無效'} | ${row.reason} |`
  )).join('\n');
  const factorSections = report.fullPeriod.factors.map(factor => {
    const rows = factor.groups.flatMap(group => Object.entries(group.horizons).map(([horizon, metrics]) => (
      `| ${group.group} | ${horizon} 日 | ${metrics.sampleSize} | ${metrics.averageReturnPct}% | ${metrics.medianReturnPct}% | ${metrics.winRatePct}% | ${metrics.maximumLossPct}% | ${metrics.standardDeviationPct}% | ${metrics.tStatistic ?? '-'} | ${metrics.costAdjustedAverageReturnPct}% | ${metrics.positiveAfterCosts ? '是' : '否'} |`
    ))).join('\n');
    return `### ${factor.label}

分組門檻：${factor.quantileThresholds?.join('、') || '二元或類別分組'}

| 分組 | 未來期間 | 樣本數 | 平均報酬 | 中位數報酬 | 勝率 | 最大虧損 | 標準差 | t-stat | 扣成本平均報酬 | 扣成本後為正 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
${rows}`;
  }).join('\n\n');
  return `# 因子研究實驗室報告

> 所有因子只使用訊號日收盤以前可取得的資料。Forward return 使用訊號日收盤到未來收盤，並另外扣除雙邊手續費、交易稅與滑價估計。
> 股票池仍存在倖存者偏差：**${report.survivorshipBiasWarning ? '是' : '否'}**。
> 為避免未還原股價受到減資、分割污染，前 120 日至後 20 日內若出現單日絕對報酬超過 15%，該觀測不納入研究。

## 資料切分

- 全期間：${report.startDate} 至 ${report.endDate}
- 訓練期間：${report.trainPeriod.startDate} 至 ${report.trainPeriod.endDate}
- 驗證期間：${report.validationPeriod.startDate} 至 ${report.validationPeriod.endDate}
- 全期間觀測數：${report.fullPeriod.observations}
- 驗證期五分位固定沿用訓練期門檻，不使用驗證期完整分布重新切分。
- 大盤波動分位只和當日以前已發生的波動比較。
- t-stat 將大量股票日觀測視為近似獨立，只能作為排序用穩定性指標，不應解讀為嚴格統計顯著性。

## 單一因子驗證

有效標準：驗證樣本至少 300、五日扣成本報酬大於 0、Profit Factor 大於 1、t-stat 絕對值至少 2，而且訓練期間方向一致。

| 因子 | 訓練選中組 | 訓練五日扣成本報酬 | 驗證樣本 | 驗證五日扣成本報酬 | 驗證 Profit Factor | 驗證 t-stat | 判定 | 原因 |
|---|---|---:|---:|---:|---:|---:|---|---|
${validationRows}

## 全期間 Forward Return 分析

${factorSections}
`;
}

async function main() {
  const context = await loadResearchContext();
  const validationStart = splitDate(context);
  const trainEnd = new Date(`${validationStart}T00:00:00Z`);
  trainEnd.setUTCDate(trainEnd.getUTCDate() - 1);
  const trainPeriod = {
    startDate: context.startDate,
    endDate: trainEnd.toISOString().slice(0, 10)
  };
  const validationPeriod = {
    startDate: validationStart,
    endDate: context.endDate
  };
  const fullPeriod = analyzeSingleFactors(context);
  const train = analyzeSingleFactors(context, trainPeriod);
  const trainThresholds = Object.fromEntries(train.factors
    .filter(factor => factor.type === 'continuous')
    .map(factor => [factor.id, factor.quantileThresholds]));
  const validation = analyzeSingleFactors(context, {
    ...validationPeriod,
    quantileThresholds: trainThresholds
  });
  const validationAssessment = evaluateValidation(train, validation);
  let prior = {};
  try {
    prior = JSON.parse(await fs.readFile(OUTPUT, 'utf8'));
  } catch {
    prior = {};
  }
  const report = {
    ...prior,
    generatedAt: new Date().toISOString(),
    startDate: context.startDate,
    endDate: context.endDate,
    survivorshipBiasWarning: context.survivorshipBiasWarning,
    methodology: {
      noFutureData: true,
      quantileGroups: 5,
      forwardHorizons: [1, 3, 5, 10, 20],
      transactionCostsIncluded: true,
      validationSplit: '前 70% 訓練、後 30% 驗證',
      validationQuantiles: '固定使用訓練期間分位門檻',
      marketVolatilityPercentile: '只與當日以前的歷史大盤波動比較',
      minimumEffectiveSample: 300,
      corporateActionFilter: '前 120 日至後 20 日內單日絕對報酬超過 15% 即排除',
      tStatisticWarning: '股票與日期間存在相關性，t-stat 僅作為近似穩定性指標'
    },
    trainPeriod,
    validationPeriod,
    fullPeriod,
    train,
    validation,
    validationAssessment
  };
  await fs.mkdir(new URL('../../data/research/', import.meta.url), { recursive: true });
  await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, markdown(report), 'utf8');
  console.log(JSON.stringify({
    output: fileURLToPath(OUTPUT),
    report: fileURLToPath(REPORT),
    observations: fullPeriod.observations,
    effectiveFactors: validationAssessment
      .filter(row => row.effective)
      .map(row => row.factorLabel),
    overfitFactors: validationAssessment
      .filter(row => row.overfit)
      .map(row => row.factorLabel)
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
