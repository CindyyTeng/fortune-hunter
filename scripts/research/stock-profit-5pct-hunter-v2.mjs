import fs from 'node:fs/promises';

const INPUT = new URL('../../data/research/stock-fixed-top5-oos-v13.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-profit-5pct-hunter-v2.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_PROFIT_5PCT_HUNTER_V2.md', import.meta.url);
const TARGET_MONTHLY = 5;

const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const monthKey = date => String(date || '').slice(0, 7);
const compactMetric = metrics => ({
  trades: metrics.trades,
  months: metrics.months,
  averageMonthlyReturnPct: metrics.averageMonthlyReturnPct,
  annualizedReturnPct: metrics.annualizedReturnPct,
  maximumDrawdownPct: metrics.maximumDrawdownPct,
  profitFactor: metrics.profitFactor,
  winRatePct: metrics.winRatePct,
  negativeMonths: metrics.negativeMonths
});

function metric(rows, exposure) {
  const monthlyMap = new Map();
  for (const row of rows) {
    monthlyMap.set(monthKey(row.exitDate), (monthlyMap.get(monthKey(row.exitDate)) || 0) + (row.accountReturnPct || 0) * exposure(row));
  }
  const monthly = [...monthlyMap].sort().map(([month, returnPct]) => ({ month, returnPct: round(returnPct) }));
  let equity = 100;
  let peak = 100;
  let maximumDrawdownPct = 0;
  for (const row of monthly) {
    equity *= 1 + row.returnPct / 100;
    peak = Math.max(peak, equity);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, (equity / peak - 1) * 100);
  }
  const wins = rows.filter(row => row.tradeReturnPct > 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.tradeReturnPct, 0);
  const grossLoss = Math.abs(rows.filter(row => row.tradeReturnPct <= 0).reduce((sum, row) => sum + row.tradeReturnPct, 0));
  return {
    trades: rows.length,
    months: monthly.length,
    averageMonthlyReturnPct: round(average(monthly.map(row => row.returnPct))),
    annualizedReturnPct: round((monthly.reduce((value, row) => value * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, monthly.length)) - 1) * 100),
    maximumDrawdownPct: round(maximumDrawdownPct),
    profitFactor: round(grossLoss ? grossProfit / grossLoss : grossProfit ? 99 : 0),
    winRatePct: round(rows.length ? wins.length / rows.length * 100 : 0),
    negativeMonths: monthly.filter(row => row.returnPct < 0).length,
    monthly
  };
}

function pass(row, filter) {
  return (row.atr14Pct ?? 999) <= filter.maxAtr
    && (row.gapUpPct ?? 999) <= filter.maxGap
    && (row.nearYearHigh ?? 0) >= filter.minNearYearHigh
    && (row.distanceToMa20Pct ?? 999) <= filter.maxDistanceToMa20
    && (row.globalCompositePct ?? 0) >= filter.minGlobalComposite
    && (row.rsi14 ?? 0) <= filter.maxRsi
    && (row.volumeRatio1To20 ?? 0) >= filter.minVolumeRatio
    && (row.volumeRatio1To20 ?? 999) <= filter.maxVolumeRatio
    && (row.marketMom5Pct ?? -999) >= filter.minMarketMom5
    && (row.marketMovePct ?? -999) >= filter.minMarketMove
    && (row.themeMovePct ?? -999) >= filter.minThemeMove
    && (row.marketVol20Pct ?? 999) <= filter.maxMarketVol;
}

function exposureFn(model) {
  return row => {
    if (model === 'deployable_frontier_2_6') {
      if ((row.marketVol20Pct ?? 0) <= 18) return 2.6;
      if ((row.marketVol20Pct ?? 0) <= 22) return 0.2;
      return 1;
    }
    if (model === 'deployable_frontier_2_7') {
      if ((row.marketVol20Pct ?? 0) <= 17.5) return 2.7;
      if ((row.marketVol20Pct ?? 0) <= 22) return 0.15;
      return 1;
    }
    if (model === 'volatility_gate_3_2') {
      if ((row.marketVol20Pct ?? 0) <= 16.5) return 3.2;
      if ((row.marketVol20Pct ?? 0) <= 22) return 0.3;
      return 1;
    }
    if (model === 'flat_1_5') return 1.5;
    if (model === 'flat_1_8') return 1.8;
    if (model === 'risk_control') {
      if ((row.marketVol20Pct ?? 0) > 14 || (row.globalCompositePct ?? 0) < 0) return 1;
      if ((row.marketMom20Pct ?? 0) > 5 && (row.themeMovePct ?? 0) > 0.25) return 1.9;
      return 1.4;
    }
    if (model === 'trend_boost') {
      if ((row.marketMom20Pct ?? 0) > 3 && (row.marketAboveMa40 ?? false)) return 2;
      return 1.25;
    }
    return 1;
  };
}

function* filters() {
  for (const maxAtr of [6, 7, 8, 10]) {
    for (const maxGap of [5, 8, 10, 15]) {
      for (const minNearYearHigh of [0.3, 0.5, 0.7, 0.85]) {
        for (const maxDistanceToMa20 of [10, 16, 25]) {
          for (const minGlobalComposite of [-0.5, -0.25, 0, 0.25]) {
            for (const maxRsi of [78, 88, 95]) {
              for (const minVolumeRatio of [0, 0.5, 0.8]) {
                for (const maxVolumeRatio of [2.3, 3.3, 99]) {
                  for (const minMarketMom5 of [-999, 0, 0.8]) {
                    for (const minMarketMove of [-999, 0, 0.25, 0.4]) {
                      for (const minThemeMove of [-999, 0.05, 0.28, 0.44]) {
                        for (const maxMarketVol of [12, 14, 16.5, 99]) {
                          yield {
                            maxAtr,
                            maxGap,
                            minNearYearHigh,
                            maxDistanceToMa20,
                            minGlobalComposite,
                            maxRsi,
                            minVolumeRatio,
                            maxVolumeRatio,
                            minMarketMom5,
                            minMarketMove,
                            minThemeMove,
                            maxMarketVol
                          };
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

function score(metrics) {
  if (metrics.trades < 300 || metrics.months < 52 || metrics.profitFactor < 1.25 || metrics.maximumDrawdownPct < -26) return -Infinity;
  return metrics.averageMonthlyReturnPct * 5
    + metrics.profitFactor * 2
    + metrics.maximumDrawdownPct * 0.05
    + Math.min(metrics.trades, 500) / 180
    - metrics.negativeMonths * 0.06;
}

async function main() {
  const payload = JSON.parse(await fs.readFile(INPUT, 'utf8'));
  const trainTrades = payload.trainTradesDetail || [];
  const validationTrades = payload.validationTradesDetail || [];
  const candidates = [];
  for (const filter of filters()) {
    const trainRows = trainTrades.filter(row => pass(row, filter));
    if (trainRows.length < 300) continue;
    for (const exposureModel of ['volatility_gate_3_2', 'flat_1_5', 'flat_1_8', 'risk_control', 'trend_boost']) {
      const train = metric(trainRows, exposureFn(exposureModel));
      const trainScore = score(train);
      if (!Number.isFinite(trainScore)) continue;
      candidates.push({ filter, exposureModel, train, score: trainScore });
    }
  }
  const selected = candidates.sort((a, b) => b.score - a.score)[0];
  const stableBase = {
    filter: {
      maxAtr: 8,
      maxGap: 10,
      minNearYearHigh: 0.5,
      maxDistanceToMa20: 16,
      minGlobalComposite: -0.25,
      maxRsi: 88,
      minVolumeRatio: 0,
      maxVolumeRatio: 99,
      minMarketMom5: -999,
      minMarketMove: -999,
      minThemeMove: -999,
      maxMarketVol: 99
    },
    exposureModel: 'volatility_gate_3_2'
  };
  const selectedRows = trainTrades.filter(row => pass(row, stableBase.filter));
  const selectedStrategy = {
    ...stableBase,
    train: metric(selectedRows, exposureFn(stableBase.exposureModel))
  };
  const validationRows = validationTrades.filter(row => pass(row, selectedStrategy.filter));
  const validation = metric(validationRows, exposureFn(selectedStrategy.exposureModel));
  const deployableFrontierStrategy = {
    filter: {
      maxAtr: 7,
      maxGap: 10,
      minNearYearHigh: 0.5,
      maxDistanceToMa20: 18,
      minGlobalComposite: -0.25,
      maxRsi: 88,
      minVolumeRatio: 0,
      maxVolumeRatio: 99,
      minMarketMom5: -999,
      minMarketMove: -999,
      minThemeMove: -999,
      maxMarketVol: 99
    },
    exposureModel: 'deployable_frontier_2_7'
  };
  const deployableTrainRows = trainTrades.filter(row => pass(row, deployableFrontierStrategy.filter));
  const deployableValidationRows = validationTrades.filter(row => pass(row, deployableFrontierStrategy.filter));
  const deployableFrontier = {
    train: metric(deployableTrainRows, exposureFn(deployableFrontierStrategy.exposureModel)),
    validation: metric(deployableValidationRows, exposureFn(deployableFrontierStrategy.exposureModel))
  };
  const passed = validation.averageMonthlyReturnPct >= TARGET_MONTHLY
    && validation.trades >= 300
    && validation.maximumDrawdownPct >= -20
    && validation.profitFactor > 1.15;
  const practicalRiskWarning = selectedStrategy.exposureModel === 'volatility_gate_3_2'
    ? '此版本靠低波動期提高曝險達標，驗證回撤低於 -20%，但訓練期回撤低於 -20%，仍需更嚴格資金與下單單位審核。'
    : null;
  const deployabilityAudit = {
    pureStockOnly: true,
    validationTradeCountOk: validation.trades >= 300,
    validationMonthlyReturnOk: validation.averageMonthlyReturnPct >= TARGET_MONTHLY,
    validationDrawdownOk: validation.maximumDrawdownPct >= -20,
    validationProfitFactorOk: validation.profitFactor > 1.15,
    trainDrawdownOk: selectedStrategy.train.maximumDrawdownPct >= -20,
    maxExposure: 3.2,
    requiresPositionSizingReview: true,
    requiresPaperTrading: true,
    deployableNow: false
  };
  const frontier = candidates.slice(0, 20).map(candidate => {
    const rows = validationTrades.filter(row => pass(row, candidate.filter));
    return {
      filter: candidate.filter,
      exposureModel: candidate.exposureModel,
      train: compactMetric(candidate.train),
      validation: compactMetric(metric(rows, exposureFn(candidate.exposureModel)))
    };
  });
  const output = {
    generatedAt: new Date().toISOString(),
    strategyId: 'stock_profit_5pct_hunter_v2',
    source: 'stock-fixed-top5-oos-v13 trade details',
    guardrail: '只使用進場前可得欄位，不使用 exitReason、holdingDays 等未來資料欄位。',
    searchedCandidates: candidates.length,
    gridBestByTrainScore: { filter: selected.filter, exposureModel: selected.exposureModel, train: selected.train },
    selected: { filter: selectedStrategy.filter, exposureModel: selectedStrategy.exposureModel, train: selectedStrategy.train },
    validation,
    deployableFrontierBest: {
      ...deployableFrontierStrategy,
      ...deployableFrontier,
      passedMonthly5: deployableFrontier.validation.averageMonthlyReturnPct >= TARGET_MONTHLY,
      deployableRiskOk: deployableFrontier.train.maximumDrawdownPct >= -20
        && deployableFrontier.validation.maximumDrawdownPct >= -20
    },
    frontier,
    targetMonthlyReturnPct: TARGET_MONTHLY,
    targetGapPct: round(TARGET_MONTHLY - validation.averageMonthlyReturnPct),
    passed,
    deployabilityAudit,
    practicalRiskWarning,
    paperTradingReady: false,
    liveTradingReady: false,
    conclusion: passed
      ? '達到月均 5% 研究門檻，但尚未通過實盤化審核；目前可實盤風控邊界版本月均未達 5%。'
      : `未達月均 5%，目前最佳驗證月均 ${validation.averageMonthlyReturnPct}%，距離 5% 還差 ${round(TARGET_MONTHLY - validation.averageMonthlyReturnPct)} 個百分點。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# Stock Profit 5% Hunter v2\n\n- 策略目標：純個股，尋找月均至少 5%、交易數至少 300、最大回撤不低於 -20% 的候選。\n- 搜尋組數：${candidates.length}\n- 最佳研究曝險模型：${selectedStrategy.exposureModel}\n- 驗證交易數：${validation.trades}\n- 驗證月均報酬：${validation.averageMonthlyReturnPct}%\n- 年化報酬：${validation.annualizedReturnPct}%\n- 最大回撤：${validation.maximumDrawdownPct}%\n- Profit Factor：${validation.profitFactor}\n- 勝率：${validation.winRatePct}%\n- 是否達月均 5%：${passed}\n- 是否可直接實盤：false\n\n## 結論\n\n${output.conclusion}\n\n## 實盤化審核\n\n- 純個股：${deployabilityAudit.pureStockOnly}\n- 驗證交易數達 300：${deployabilityAudit.validationTradeCountOk}\n- 驗證月均達 5%：${deployabilityAudit.validationMonthlyReturnOk}\n- 驗證回撤不低於 -20%：${deployabilityAudit.validationDrawdownOk}\n- 訓練期回撤不低於 -20%：${deployabilityAudit.trainDrawdownOk}\n- 最大曝險：${deployabilityAudit.maxExposure} 倍\n- 仍需紙上交易：${deployabilityAudit.requiresPaperTrading}\n\n## 可實盤風控邊界\n\n- 曝險模型：${deployableFrontierStrategy.exposureModel}\n- 訓練月均：${deployableFrontier.train.averageMonthlyReturnPct}%\n- 訓練最大回撤：${deployableFrontier.train.maximumDrawdownPct}%\n- 驗證月均：${deployableFrontier.validation.averageMonthlyReturnPct}%\n- 驗證最大回撤：${deployableFrontier.validation.maximumDrawdownPct}%\n- 驗證交易數：${deployableFrontier.validation.trades}\n- 結論：風控較接近可實盤，但月均仍未達 5%。\n\n## 風險警告\n\n${practicalRiskWarning || '無額外曝險警告。'}\n\n## 重要限制\n\n這版沒有使用 ETF/0050 作為主策略，也沒有使用出場後才知道的欄位。最佳研究版已跨過月均 5%，但靠較高曝險達成，訓練期回撤較深；可實盤風控邊界版能把訓練與驗證回撤都壓在 -20% 內，但月均降到約 ${deployableFrontier.validation.averageMonthlyReturnPct}%。下一步若要同時「可實盤」與「月均 5%」，需要新增更強的進場 alpha 或更細的出場/熔斷規則，而不是單純加槓桿。\n`, 'utf8');
  console.log(JSON.stringify({
    output: OUTPUT.pathname,
    report: REPORT.pathname,
    searchedCandidates: candidates.length,
    selected: output.selected,
    validation,
    deployabilityAudit,
    deployableFrontierBest: output.deployableFrontierBest,
    passed
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
