import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  loadRegimeDataset,
  runRegimeBacktest
} from './backtest-regime-ensemble-10y.mjs';

const OUTPUT = new URL('../data/strategy-failure-diagnostics.json', import.meta.url);
const REPORT = new URL('../docs/STRATEGY_FAILURE_DIAGNOSTICS.md', import.meta.url);

const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const mean = values => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : 0;

function tradeMetrics(trades) {
  const wins = trades.filter(trade => trade.realizedPnl > 0);
  const gains = wins.reduce((sum, trade) => sum + trade.realizedPnl, 0);
  const losses = Math.abs(trades.filter(trade => trade.realizedPnl <= 0)
    .reduce((sum, trade) => sum + trade.realizedPnl, 0));
  return {
    sampleSize: trades.length,
    winRatePct: round(wins.length / Math.max(1, trades.length) * 100),
    averageReturnPct: round(mean(trades.map(trade => trade.tradeReturnPct))),
    profitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    worstLossPct: trades.length ? round(Math.min(...trades.map(trade => trade.tradeReturnPct))) : null
  };
}

function groupTrades(trades, classifier) {
  const groups = new Map();
  for (const trade of trades) {
    const key = classifier(trade);
    const rows = groups.get(key) || [];
    rows.push(trade);
    groups.set(key, rows);
  }
  return [...groups.entries()]
    .map(([group, rows]) => ({ group, ...tradeMetrics(rows) }))
    .sort((a, b) => b.sampleSize - a.sampleSize);
}

function bucket(value, ranges, missing = '資料缺漏') {
  if (!Number.isFinite(value)) return missing;
  for (const [limit, label] of ranges) {
    if (value < limit) return label;
  }
  return ranges.at(-1)?.[1] || missing;
}

function stratifications(trades) {
  return {
    marketRegime: groupTrades(trades, trade => trade.regime || '未知'),
    strategy: groupTrades(trades, trade => trade.strategy || '未知'),
    entryMonth: groupTrades(trades, trade => trade.entryDate?.slice(0, 7) || '未知'),
    holdingDays: groupTrades(trades, trade => bucket(trade.holdingDays, [
      [4, '1-3 天'], [6, '4-5 天'], [8, '6-7 天'], [Infinity, '8 天以上']
    ])),
    averageTradeValue: groupTrades(trades, trade => bucket(trade.avgTradeValue20, [
      [50_000_000, '低於 5,000 萬'], [100_000_000, '5,000 萬至 1 億'],
      [300_000_000, '1 億至 3 億'], [1_000_000_000, '3 億至 10 億'],
      [Infinity, '10 億以上']
    ])),
    atr: groupTrades(trades, trade => bucket(trade.atr14Pct, [
      [2, '低於 2%'], [4, '2% 至 4%'], [6, '4% 至 6%'], [Infinity, '6% 以上']
    ])),
    rsi: groupTrades(trades, trade => bucket(trade.rsi14, [
      [30, '低於 30'], [40, '30 至 40'], [50, '40 至 50'],
      [60, '50 至 60'], [70, '60 至 70'], [Infinity, '70 以上']
    ])),
    ma20Deviation: groupTrades(trades, trade => bucket(trade.distanceToMa20Pct, [
      [-5, '低於 -5%'], [0, '-5% 至 0%'], [5, '0% 至 5%'],
      [10, '5% 至 10%'], [Infinity, '10% 以上']
    ])),
    ma60Deviation: groupTrades(trades, trade => bucket(trade.distanceToMa60Pct, [
      [-5, '低於 -5%'], [0, '-5% 至 0%'], [5, '0% 至 5%'],
      [10, '5% 至 10%'], [Infinity, '10% 以上']
    ])),
    entryGap: groupTrades(trades, trade => bucket(trade.entryGapPct, [
      [0, '跳空下跌'], [2, '0% 至 2%'], [5, '2% 至 5%'],
      [8, '5% 至 8%'], [Infinity, '8% 以上']
    ])),
    nearLimitUp: groupTrades(trades, trade => trade.nearLimitUp ? '接近漲停' : '未接近漲停'),
    themeStrengthRank: groupTrades(trades, trade => trade.themeStrengthRank === 1
      ? '當日最強族群'
      : '非當日最強族群')
  };
}

function maximumDrawdownPeriod(curve) {
  let peakIndex = 0;
  let peakEquity = curve[0]?.equity || 0;
  let worst = { drawdownPct: 0, startIndex: 0, endIndex: 0 };
  for (let index = 0; index < curve.length; index += 1) {
    if (curve[index].equity > peakEquity) {
      peakEquity = curve[index].equity;
      peakIndex = index;
    }
    const drawdownPct = peakEquity ? (curve[index].equity / peakEquity - 1) * 100 : 0;
    if (drawdownPct < worst.drawdownPct) {
      worst = { drawdownPct, startIndex: peakIndex, endIndex: index };
    }
  }
  return {
    startDate: curve[worst.startIndex]?.date,
    endDate: curve[worst.endIndex]?.date,
    drawdownPct: round(worst.drawdownPct),
    daily: curve.slice(worst.startIndex, worst.endIndex + 1)
  };
}

function drawdownCauses(period, riskRules) {
  const daily = period.daily;
  const maximumExposurePct = Math.max(0, ...daily.map(row => row.exposurePct || 0));
  const maximumPositions = Math.max(0, ...daily.map(row => row.openPositions || 0));
  const maximumEntries = Math.max(0, ...daily.map(row => row.newEntries?.length || 0));
  const maximumSinglePositionPct = Math.max(0, ...daily.flatMap(row => (
    row.positions || []
  ).map(position => row.equity ? position.markValue / row.equity * 100 : 0)));
  const exposureViolations = daily.filter(row => (
    (row.exposurePct || 0) > (riskRules.exposureLimits[row.regime] ?? 0) + 0.01
  ));
  const entriesAfterEightPercentDrawdown = daily.filter(row => (
    (row.drawdownPct || 0) <= -8 && row.newEntries?.length
  ));
  const defensiveExposureDays = daily.filter(row => (
    ['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.regime) && (row.exposurePct || 0) > 0
  ));
  const negativeCashDays = daily.filter(row => (row.availableCash || 0) < 0);
  const stopLossCount = daily.reduce((sum, row) => sum + (row.stopLosses?.length || 0), 0);
  const conclusions = [];
  if (maximumSinglePositionPct > riskRules.maxSinglePositionPct) {
    conclusions.push(`單檔部位最高 ${round(maximumSinglePositionPct)}%，超過新的 10% 上限。`);
  }
  if (maximumEntries > 2) {
    conclusions.push(`單日最多同時新進 ${maximumEntries} 檔，虧損可能在同一天集中發生。`);
  }
  if (exposureViolations.length) {
    conclusions.push(`有 ${exposureViolations.length} 個交易日超過對應市場狀態的曝險上限。`);
  }
  if (entriesAfterEightPercentDrawdown.length) {
    conclusions.push(`帳戶回撤超過 8% 後，仍有 ${entriesAfterEightPercentDrawdown.length} 天繼續建立新倉。`);
  }
  if (defensiveExposureDays.length) {
    conclusions.push(`空頭或高波動狀態仍持有曝險的交易日共有 ${defensiveExposureDays.length} 天。`);
  }
  if (!stopLossCount) conclusions.push('最大回撤期間沒有留下停損紀錄，無法證明停損曾有效降低風險。');
  if (negativeCashDays.length) conclusions.push(`有 ${negativeCashDays.length} 天可用現金為負，T+2 資金控管異常。`);
  return {
    maximumExposurePct: round(maximumExposurePct),
    maximumSinglePositionPct: round(maximumSinglePositionPct),
    maximumPositions,
    maximumEntriesInOneDay: maximumEntries,
    exposureViolationDays: exposureViolations.length,
    entriesAfterEightPercentDrawdownDays: entriesAfterEightPercentDrawdown.length,
    defensiveExposureDays: defensiveExposureDays.length,
    stopLossCount,
    negativeAvailableCashDays: negativeCashDays.length,
    primaryCauses: conclusions
  };
}

function controlledRiskAudit(result) {
  const limits = result.riskRules.exposureLimits;
  const exposureViolationDays = result.equityCurve.filter(row => (
    (row.exposurePct || 0) > (limits[row.regime] ?? 0) + 0.01
  )).length;
  const maximumSinglePositionPct = Math.max(0, ...result.equityCurve.flatMap(row => (
    row.positions || []
  ).map(position => row.equity ? position.markValue / row.equity * 100 : 0)));
  const maximumEntryPositionPct = Math.max(0, ...result.equityCurve.flatMap(row => (
    row.newEntries || []
  ).map(entry => row.equity ? entry.positionValue / row.equity * 100 : 0)));
  return {
    exposureViolationDays,
    maximumSinglePositionPct: round(maximumSinglePositionPct),
    maximumEntryPositionPct: round(maximumEntryPositionPct),
    negativeAvailableCashDays: result.equityCurve.filter(row => row.availableCash < 0).length
  };
}

function conditionDefinitions() {
  return [
    ['市場狀態', trade => trade.regime],
    ['策略類型', trade => trade.strategy],
    ['成交值區間', trade => bucket(trade.avgTradeValue20, [
      [50_000_000, '低於 5,000 萬'], [100_000_000, '5,000 萬至 1 億'],
      [300_000_000, '1 億至 3 億'], [1_000_000_000, '3 億至 10 億'],
      [Infinity, '10 億以上']
    ])],
    ['ATR 區間', trade => bucket(trade.atr14Pct, [
      [2, '低於 2%'], [4, '2% 至 4%'], [6, '4% 至 6%'], [Infinity, '6% 以上']
    ])],
    ['RSI 區間', trade => bucket(trade.rsi14, [
      [30, '低於 30'], [40, '30 至 40'], [50, '40 至 50'],
      [60, '50 至 60'], [70, '60 至 70'], [Infinity, '70 以上']
    ])],
    ['進場型態', trade => trade.entryMode || '未知'],
    ['跳空幅度', trade => bucket(trade.entryGapPct, [
      [0, '跳空下跌'], [2, '0% 至 2%'], [5, '2% 至 5%'],
      [8, '5% 至 8%'], [Infinity, '8% 以上']
    ])],
    ['流動性', trade => Number(trade.avgTradeValue20) >= 100_000_000 ? '日均成交值至少 1 億' : '日均成交值低於 1 億'],
    ['族群排名', trade => trade.themeStrengthRank === 1 ? '當日最強族群' : '非當日最強族群']
  ];
}

function positiveExpectancySubsets(trades) {
  const definitions = conditionDefinitions();
  const candidates = [];
  for (const [name, classifier] of definitions) {
    for (const row of groupTrades(trades, classifier)) {
      candidates.push({ conditions: [`${name}：${row.group}`], ...row });
    }
  }
  const pairs = [
    [0, 1], [1, 2], [1, 3], [1, 4], [0, 6], [2, 3], [2, 7], [3, 4], [0, 8]
  ];
  for (const [leftIndex, rightIndex] of pairs) {
    const [leftName, leftClassifier] = definitions[leftIndex];
    const [rightName, rightClassifier] = definitions[rightIndex];
    const groups = new Map();
    for (const trade of trades) {
      const labels = [
        `${leftName}：${leftClassifier(trade)}`,
        `${rightName}：${rightClassifier(trade)}`
      ];
      const key = labels.join('｜');
      const row = groups.get(key) || { labels, trades: [] };
      row.trades.push(trade);
      groups.set(key, row);
    }
    for (const row of groups.values()) {
      candidates.push({ conditions: row.labels, ...tradeMetrics(row.trades) });
    }
  }
  return candidates
    .filter(row => row.sampleSize >= 100
      && row.averageReturnPct > 0
      && (row.profitFactor === null || row.profitFactor > 1))
    .sort((a, b) => (b.profitFactor ?? 999) - (a.profitFactor ?? 999));
}

function metricTable(rows) {
  return rows.map(row => (
    `| ${row.group} | ${row.sampleSize} | ${row.winRatePct}% | ${row.averageReturnPct}% | ${row.profitFactor ?? '-'} | ${row.worstLossPct}% |`
  )).join('\n');
}

function markdown(result) {
  const drawdownRows = result.baselineMaximumDrawdown.daily.map(row => (
    `| ${row.date} | ${row.regime} | ${row.openPositions} | ${row.exposurePct}% | ${(row.newEntries || []).map(item => item.symbol).join('、') || '-'} | ${(row.stopLosses || []).map(item => item.symbol).join('、') || '-'} | ${row.realizedPnl} | ${row.unrealizedPnl} | ${row.defenseTriggered ? '是' : '否'} | ${(row.defenseReasons || []).join('、') || '基準回測未啟用風控熔斷'} |`
  )).join('\n');
  const positiveRows = result.positiveExpectancySubsets.length
    ? result.positiveExpectancySubsets.map(row => (
      `| ${row.conditions.join('；')} | ${row.sampleSize} | ${row.winRatePct}% | ${row.averageReturnPct}% | ${row.profitFactor ?? '-'} | ${row.worstLossPct}% |`
    )).join('\n')
    : '| 找不到符合條件的子集合 | - | - | - | - | - |';
  const eventRows = result.riskControlled.riskEvents.map(row => (
    `| ${row.date} | ${row.type} | ${row.valuePct ?? row.value ?? '-'} | ${row.blockedUntilDayIndex ?? (row.blockedUntilMonthEnd ? '月底' : '-')} |`
  )).join('\n') || '| - | 無觸發紀錄 | - | - |';

  return `# 策略失敗診斷報告

## 結論

- 基準版最大回撤：${result.baseline.summary.maxDrawdownPct}%
- 風控版最大回撤：${result.riskControlled.summary.maxDrawdownPct}%
- 風控版曝險超限天數：${result.controlledRiskAudit.exposureViolationDays}
- 風控版單檔收盤曝險最高：${result.controlledRiskAudit.maximumSinglePositionPct}%
- 最大回撤期間：${result.baselineMaximumDrawdown.startDate} 至 ${result.baselineMaximumDrawdown.endDate}
- 正期望子集合：${result.positiveExpectancySubsets.length ? `找到 ${result.positiveExpectancySubsets.length} 組` : '找不到樣本數至少 100 且 Profit Factor 大於 1 的組合'}
- 這份診斷只使用訊號日或實際進場當下已知資料分組，沒有把出場後才知道的結果當成進場條件。

## 最大回撤主因

${result.drawdownCauseAnalysis.primaryCauses.map(item => `- ${item}`).join('\n')}

- 最大總曝險：${result.drawdownCauseAnalysis.maximumExposurePct}%
- 最大單檔部位：${result.drawdownCauseAnalysis.maximumSinglePositionPct}%
- 單日最多新進場：${result.drawdownCauseAnalysis.maximumEntriesInOneDay} 檔
- 超過市場狀態曝險上限：${result.drawdownCauseAnalysis.exposureViolationDays} 天
- 回撤超過 8% 後仍進場：${result.drawdownCauseAnalysis.entriesAfterEightPercentDrawdownDays} 天
- 防守市場仍有曝險：${result.drawdownCauseAnalysis.defensiveExposureDays} 天
- 可用現金為負：${result.drawdownCauseAnalysis.negativeAvailableCashDays} 天

## 風控規則觸發紀錄

| 日期 | 規則 | 觸發值 | 停止新倉至 |
|---|---|---:|---|
${eventRows}

## 市場狀態分層

| 市場狀態 | 樣本數 | 勝率 | 平均報酬 | Profit Factor | 最大虧損 |
|---|---:|---:|---:|---:|---:|
${metricTable(result.stratifications.marketRegime)}

## 策略分層

| 策略 | 樣本數 | 勝率 | 平均報酬 | Profit Factor | 最大虧損 |
|---|---:|---:|---:|---:|---:|
${metricTable(result.stratifications.strategy)}

## 正期望子集合

只有樣本數至少 100、平均報酬大於 0，且 Profit Factor 大於 1 的條件才列入。

| 條件 | 樣本數 | 勝率 | 平均報酬 | Profit Factor | 最大虧損 |
|---|---:|---:|---:|---:|---:|
${positiveRows}

## 樣本數警告

- 少於 100 筆的條件組合只保留在 JSON 分層資料中，不宣稱有效。
- 現有歷史股票池仍有倖存者偏差警告，診斷不能視為完全可信的全市場十年實證。
- 正期望子集合是診斷線索，不是可直接上線的規則，下一步仍需獨立走動式驗證。

## 下一步建議

1. 優先停用 Profit Factor 明顯低於 1 的市場狀態與策略，不再靠調高分數掩蓋負期望。
2. 對正期望且樣本數足夠的條件另做走動式驗證，確認不是同一段行情造成。
3. 若找不到合格子集合，應回到策略定義與市場資料品質，不應繼續微調門檻。
4. 保留風控熔斷作為投資組合層硬限制，即使未來更換策略也不得繞過。

## 最大回撤每日明細

| 日期 | 市場狀態 | 持倉數 | 總曝險 | 新進場 | 停損 | 已實現損益 | 未實現損益 | 防守觸發 | 未觸發原因或規則 |
|---|---|---:|---:|---|---|---:|---:|---|---|
${drawdownRows}
`;
}

async function main() {
  const dataset = await loadRegimeDataset();
  const baseline = await runRegimeBacktest(dataset, { riskControls: false });
  const riskControlled = await runRegimeBacktest(dataset, { riskControls: true });
  const baselineMaximumDrawdown = maximumDrawdownPeriod(baseline.equityCurve);
  const result = {
    generatedAt: new Date().toISOString(),
    methodology: {
      noFutureData: true,
      minimumPositiveSubsetSample: 100,
      positiveSubsetRequirements: ['平均報酬大於 0', 'Profit Factor 大於 1'],
      baselineRiskControls: false,
      controlledRiskControls: true
    },
    baseline: {
      summary: baseline.summary,
      riskEvents: baseline.riskEvents
    },
    riskControlled: {
      summary: riskControlled.summary,
      riskRules: riskControlled.riskRules,
      riskEvents: riskControlled.riskEvents
    },
    baselineMaximumDrawdown,
    drawdownCauseAnalysis: drawdownCauses(
      baselineMaximumDrawdown,
      riskControlled.riskRules
    ),
    controlledRiskAudit: controlledRiskAudit(riskControlled),
    stratifications: stratifications(baseline.trades),
    positiveExpectancySubsets: positiveExpectancySubsets(baseline.trades),
    sampleWarnings: [
      '少於 100 筆的條件組合不得宣稱有效。',
      '歷史股票池尚未完整消除倖存者偏差。',
      '條件子集合仍需用獨立走動式驗證確認。'
    ]
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, markdown(result), 'utf8');
  console.log(JSON.stringify({
    output: fileURLToPath(OUTPUT),
    report: fileURLToPath(REPORT),
    baseline: result.baseline.summary,
    riskControlled: result.riskControlled.summary,
    drawdownCauseAnalysis: result.drawdownCauseAnalysis,
    positiveExpectancySubsetCount: result.positiveExpectancySubsets.length
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
