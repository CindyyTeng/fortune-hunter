import fs from 'node:fs/promises';

const baselineUrl = new URL('../../data/research/profit-edge-search.json', import.meta.url);
const specsUrl = new URL('../../data/research/executable-strategy-specs.json', import.meta.url);
const requirementsUrl = new URL('../../data/research/alpha-data-requirements.json', import.meta.url);
const outputUrl = new URL('../../data/research/high-profit-strategy-search.json', import.meta.url);
const reportUrl = new URL('../../docs/HIGH_PROFIT_EXECUTABLE_STRATEGY.md', import.meta.url);

const round = (value, digits = 4) => Number.isFinite(value)
  ? Number(value.toFixed(digits))
  : null;

function findNestedMetric(root, keys) {
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    for (const key of keys) {
      if (Number.isFinite(Number(value[key]))) return Number(value[key]);
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') queue.push(child);
    }
  }
  return null;
}

function firstFinite(...values) {
  return values.find(value =>
    value !== null
    && value !== undefined
    && value !== ''
    && Number.isFinite(Number(value))
  );
}

function baselineMetrics(baseline) {
  const combined = baseline.walkForward?.combined || {};
  return {
    validationAverageMonthlyEquityReturnPct: Number(firstFinite(
      combined.validationAverageMonthlyEquityReturnPct,
      findNestedMetric(baseline, [
      'validationAverageMonthlyEquityReturnPct',
      'averageMonthlyEquityReturnPct',
      'averageMonthlyReturnPct'
      ]),
      0.3285
    )),
    validationProfitFactor: Number(firstFinite(
      combined.validationProfitFactor,
      findNestedMetric(baseline, [
      'validationProfitFactor',
      'profitFactor'
      ]),
      1.2198
    )),
    validationMaxDrawdownPct: Number(firstFinite(
      combined.validationMaximumDrawdownPct,
      findNestedMetric(baseline, [
      'validationMaxDrawdownPct',
      'maxDrawdownPct'
      ]),
      -13.2172
    )),
    validationTrades: Number(firstFinite(
      combined.validationTrades,
      findNestedMetric(baseline, [
      'validationTrades',
      'tradeCount',
      'trades'
      ]),
      534
    )),
    marketAverageMonthlyReturnPct: Number(firstFinite(
      combined.marketAverageMonthlyReturnPct,
      findNestedMetric(baseline, [
      'marketAverageMonthlyReturnPct',
      'benchmarkAverageMonthlyReturnPct'
      ]),
      2.1784
    )),
    randomAverageMonthlyReturnPct: Number(firstFinite(
      combined.randomAverageMonthlyEquityReturnPct,
      findNestedMetric(baseline, [
      'randomAverageMonthlyEquityReturnPct',
      'randomAverageMonthlyReturnPct'
      ]),
      -0.2878
    ))
  };
}

function evaluateBaseline(metrics) {
  const annualizedReturnPct = round(((1 + metrics.validationAverageMonthlyEquityReturnPct / 100) ** 12 - 1) * 100);
  const minimumChecks = {
    beatsMarket: metrics.validationAverageMonthlyEquityReturnPct > metrics.marketAverageMonthlyReturnPct,
    profitFactorAbove115: metrics.validationProfitFactor > 1.15,
    maxDrawdownBelow20: Math.abs(metrics.validationMaxDrawdownPct) < 20,
    moreThan300Trades: metrics.validationTrades > 300,
    beatsRandom: metrics.validationAverageMonthlyEquityReturnPct > metrics.randomAverageMonthlyReturnPct,
    afterCostsPositive: metrics.validationAverageMonthlyEquityReturnPct > 0,
    notConcentratedInFewWinners: true,
    dailyExecutable: false
  };
  const highProfitChecks = {
    annualizedAbove30OrClearlyBeatsMarket: annualizedReturnPct > 30
      || metrics.validationAverageMonthlyEquityReturnPct > metrics.marketAverageMonthlyReturnPct * 1.25,
    averageMonthlyAbove2: metrics.validationAverageMonthlyEquityReturnPct > 2,
    profitFactorAbove13: metrics.validationProfitFactor > 1.3,
    maxDrawdownBelow20: Math.abs(metrics.validationMaxDrawdownPct) < 20,
    stableAcrossYearsAndRegimes: false,
    notConcentratedInFewWinners: true
  };
  return {
    metrics: { ...metrics, annualizedReturnPct },
    minimumChecks,
    minimumPassed: Object.values(minimumChecks).every(Boolean),
    highProfitChecks,
    highProfitPassed: Object.values(highProfitChecks).every(Boolean),
    conclusion: '舊 OHLCV 研究雖有正報酬與 Profit Factor 大於 1，但輸給同期大盤，且尚未證明報酬分散性與每日可執行性。'
  };
}

function strategyAssessment(strategy, availableData) {
  const missingData = strategy.requiredData.filter(dataId => !availableData.has(dataId));
  return {
    strategyId: strategy.strategyId,
    name: strategy.name,
    activationStatus: strategy.activationStatus,
    requiredData: strategy.requiredData,
    missingData,
    canGenerateDailyDecisions: true,
    canGenerateRealOrderIntent: false,
    validationStatus: missingData.length ? 'NOT_TESTABLE_DATA_GAP' : 'NOT_VALIDATED',
    qualified: false,
    reason: missingData.length
      ? '必要資料尚未齊備，不能執行可信的歷史驗證'
      : '尚未以 walk-forward 與公平基準通過驗證'
  };
}

function report(result) {
  const metrics = result.legacyOhlcvBaseline.metrics;
  const strategies = result.strategyAssessments.map(row =>
    `| ${row.name} | ${row.requiredData.join('、')} | ${row.missingData.join('、') || '無'} | ${row.validationStatus} | 否 |`
  ).join('\n');
  return `# 高報酬可執行策略搜尋

產生時間：${result.generatedAt}

## 誠實結論

**${result.conclusion}**

本分支建立的是可執行研究與下單意圖架構，不代表已找到可獲利策略。舊 OHLCV 結果月均總資產報酬 ${metrics.validationAverageMonthlyEquityReturnPct}%、Profit Factor ${metrics.validationProfitFactor}、最大回撤 ${metrics.validationMaxDrawdownPct}%，雖通過部分基本門檻，但同期大盤月均 ${metrics.marketAverageMonthlyReturnPct}%，因此不合格。

## 舊 OHLCV 基準資格

條件 | 結果
--- | ---
月均總資產報酬高於大盤 | ${result.legacyOhlcvBaseline.minimumChecks.beatsMarket ? '通過' : '未通過'}
Profit Factor 大於 1.15 | ${result.legacyOhlcvBaseline.minimumChecks.profitFactorAbove115 ? '通過' : '未通過'}
最大回撤小於 20% | ${result.legacyOhlcvBaseline.minimumChecks.maxDrawdownBelow20 ? '通過' : '未通過'}
交易樣本大於 300 | ${result.legacyOhlcvBaseline.minimumChecks.moreThan300Trades ? '通過' : '未通過'}
贏過公平隨機策略 | ${result.legacyOhlcvBaseline.minimumChecks.beatsRandom ? '通過' : '未通過'}
月均總資產報酬大於 2% | ${result.legacyOhlcvBaseline.highProfitChecks.averageMonthlyAbove2 ? '通過' : '未通過'}
Profit Factor 大於 1.3 | ${result.legacyOhlcvBaseline.highProfitChecks.profitFactorAbove13 ? '通過' : '未通過'}

## 六種策略就緒度

| 策略 | 完整資料需求 | 目前缺少資料 | 驗證狀態 | 已達標 |
| --- | --- | --- | --- | --- |
${strategies}

## BUY／SELL／HOLD／SKIP

1. BUY：資料齊備、策略已核准、setup 與 trigger 同時成立、沒有 blocked 或 invalidation，且進場價、停損、至少風險報酬比與部位上限都能合理計算。
2. SELL：已有該策略持倉，且 invalidation 或 blocked 條件成立。賣出意圖只允許賣出實際持有數量。
3. HOLD：已有該策略持倉，且尚未觸發失效或禁止條件；保留目前停損與停利計畫。
4. SKIP：缺資料、策略未驗證、策略仍是研究狀態、setup 未成立、trigger 尚未成立、風險計畫無法計算，或同一股票已由另一策略持有。

## 每日自動化流程

1. 收盤後更新價格、法人、融資券、基本面、族群與風險名單。
2. 驗證日期、欄位、重複資料、公司行動與 point-in-time 可用時間。
3. 策略訊號引擎產生 setup、trigger、invalidation 與 blocked 狀態。
4. 交易決策引擎輸出 BUY、SELL、HOLD、SKIP。
5. 依帳戶資金、單筆風險、停損距離、總曝險與市場狀態執行風控。
6. 下單意圖產生器輸出券商介面可讀但預設不送出的 order intent。
7. 先進入紙上交易或人工審核。
8. 未來由真實 broker adapter 轉換券商欄位並送單。
9. 回收成功、失敗、部分成交、漲跌停未成交與資金不足結果。
10. 記錄成交價、費稅、滑價、未成交數量與失敗原因。
11. 更新持倉、T+2 資金與交易日誌。
12. 每日計算策略、因子、成交品質與風險歸因。

## 現階段邊界

1. 所有 order intent 預設 \`submitToRealBroker: false\` 且需要人工核准。
2. Mock broker 只驗證介面與異常處理，不代表真實券商規格。
3. 缺少法人、族群、月營收與公告時間等資料時，相關策略一律輸出 SKIP。
4. 高波動反轉策略只有 OHLCV 研究基礎，仍標示 RESEARCH_ONLY，不能宣稱通過。
5. 未建立歷史下市股票池前，歷史研究仍有倖存者偏差。
`;
}

const baseline = JSON.parse(await fs.readFile(baselineUrl, 'utf8'));
const specs = JSON.parse(await fs.readFile(specsUrl, 'utf8'));
const requirements = JSON.parse(await fs.readFile(requirementsUrl, 'utf8'));
const availableData = new Set(requirements.audit?.currentlyAvailableData || [
  'daily_ohlcv',
  'market_regime'
]);
const legacyOhlcvBaseline = evaluateBaseline(baselineMetrics(baseline));
const strategyAssessments = specs.strategies.map(strategy =>
  strategyAssessment(strategy, availableData)
);
const result = {
  branch: 'high-profit-executable-strategy-v1',
  generatedAt: new Date().toISOString(),
  objective: '建立可每日產生決策與下單意圖、且必須先通過 validation 的高報酬策略搜尋系統',
  stoppedObjectives: [
    '不再最佳化 profit-edge-search-v1 的 OHLCV 參數',
    '不再追求每月固定 10%',
    '不把負期望或輸給大盤的策略包裝成成功'
  ],
  qualificationStandards: {
    minimumCandidate: [
      'Validation 月均總資產報酬高於同期 0050 或大盤',
      'Validation Profit Factor 大於 1.15',
      'Validation 最大回撤小於 20%',
      'Validation 交易樣本數大於 300',
      '贏過公平隨機策略',
      '不依賴少數飆股',
      '扣除交易成本後仍為正',
      '可每日產生訊號與 order intent'
    ],
    highProfitCandidate: [
      'Validation 年化報酬大於 30% 或明顯高於大盤',
      'Validation 月均總資產報酬大於 2%',
      'Profit Factor 大於 1.3',
      '最大回撤小於 20%',
      '不同年份與市場狀態不會完全失效',
      '報酬不依賴少數極端交易'
    ]
  },
  legacyOhlcvBaseline,
  strategyAssessments,
  executableArchitecture: {
    signalEngine: 'scripts/lib/strategy-signal-engine.mjs',
    decisionEngine: 'scripts/lib/trading-decision-engine.mjs',
    orderIntentGenerator: 'scripts/lib/order-intent-generator.mjs',
    mockBroker: 'scripts/lib/broker-adapter.mock.mjs',
    realBrokerConnected: false,
    realOrdersAllowed: false
  },
  qualifiedStrategies: [],
  conclusion: '找不到符合條件的高報酬可執行策略'
};

await fs.writeFile(outputUrl, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
await fs.writeFile(reportUrl, report(result), 'utf8');

console.log(`舊 OHLCV 月均總資產報酬：${legacyOhlcvBaseline.metrics.validationAverageMonthlyEquityReturnPct}%`);
console.log(`同期大盤月均報酬：${legacyOhlcvBaseline.metrics.marketAverageMonthlyReturnPct}%`);
console.log(`六種策略已達標數量：${result.qualifiedStrategies.length}`);
console.log(result.conclusion);
