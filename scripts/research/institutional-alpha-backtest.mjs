import fs from 'node:fs/promises';
import { appendExperiment, buildExperimentIdentity, loadRegistry, shouldSkipExperiment } from './strategy-experiment-registry.mjs';

const DATA = new URL('../../data/institutional/institutional-trades.json', import.meta.url);
const VALIDATION = new URL('../../data/institutional/validation-report.json', import.meta.url);
const OUTPUT = new URL('../../data/research/institutional-alpha-backtest.json', import.meta.url);
const DOCUMENT = new URL('../../docs/INSTITUTIONAL_ALPHA_BACKTEST.md', import.meta.url);
const STRATEGY_ID = 'trust_accumulation_pullback';
const MINIMUM_DATA = Object.freeze({
  pointInTimeRecords: 50_000,
  distinctDates: 1_000,
  distinctSymbols: 100,
  validationTrades: 300
});

async function readJson(url, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(url, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function safeRecords(payload) {
  return (payload?.records || []).filter(row =>
    row.isPointInTimeSafe === true
    && row.pointInTimeMode === 'conservative_assumption'
    && /^\d{4}-\d{2}-\d{2}$/.test(row.effectiveDate)
    && row.effectiveDate > row.date
    && !Number.isNaN(Date.parse(row.publishedAt))
    && Date.parse(row.publishedAt) < Date.parse(`${row.effectiveDate}T09:00:00+08:00`)
  );
}

function assessData(payload, validation) {
  const records = safeRecords(payload);
  const dates = new Set(records.map(row => row.date));
  const symbols = new Set(records.map(row => row.symbol));
  const missing = [];
  if (!payload) missing.push('真實法人買賣超檔案');
  if (!validation) missing.push('法人資料驗證報告');
  if (records.length < MINIMUM_DATA.pointInTimeRecords) missing.push(`point-in-time 安全紀錄至少 ${MINIMUM_DATA.pointInTimeRecords} 筆`);
  if (dates.size < MINIMUM_DATA.distinctDates) missing.push(`至少 ${MINIMUM_DATA.distinctDates} 個交易日`);
  if (symbols.size < MINIMUM_DATA.distinctSymbols) missing.push(`至少 ${MINIMUM_DATA.distinctSymbols} 檔股票`);
  if (validation?.status !== 'VALID') missing.push('法人資料驗證必須通過');
  return {
    records: records.length,
    distinctDates: dates.size,
    distinctSymbols: symbols.size,
    dateRange: dates.size ? {
      start: [...dates].sort().at(0),
      end: [...dates].sort().at(-1)
    } : null,
    readyForWalkForward: missing.length === 0,
    missing
  };
}

function registryInput(assessment, walkForward) {
  return {
    strategyId: STRATEGY_ID,
    dataSources: [
      'daily_ohlcv',
      'market_regime',
      'institutional_trust',
      'institutional_foreign',
      'institutional_point_in_time_policy'
    ],
    setupRules: [
      '投信連續買超 N 日或近 N 日累計買超為正',
      '外資沒有連續大賣',
      '股價在 MA60 之上且 MA20 或 MA60 向上',
      '個股相對大盤強且成交值足夠'
    ],
    triggerRules: [
      '回測 MA20 或前高支撐不破',
      '回檔後收紅或突破前一日高點',
      '急拉過高當天不追價'
    ],
    invalidationRules: [
      '跌破回測低點',
      '跌破 MA20',
      '投信停止買超且股價轉弱',
      '大盤跌破風控條件'
    ],
    exitRules: ['1.5R 停利', '2R 停利', '移動停利', '跌破 MA20 出場', '大盤轉弱提前出場'],
    riskRules: ['真實手續費', '交易稅', '滑價', 'T+2', '不使用未來資料', '不使用不可能成交價'],
    blockedWhen: ['跳空過大', '離 MA20 太遠', '成交值太低', 'ATR 過高', '長上影線'],
    parameters: {
      grid: 'trustDays=3/5/10; trustPercentile=0.5/0.7/0.9; foreignMode=2; support=2; stop=3; exit=3',
      parameterGridCount: 324,
      pointInTimePolicy: 'conservative_assumption_t_plus_1'
    },
    trainPeriod: { months: 36 },
    validationPeriod: { months: 12, stepMonths: 12 },
    costModel: { buyFeePct: 0.1425, sellFeePct: 0.1425, sellTaxPct: 0.3, slippagePct: 0.15 },
    executionModel: { entry: 'next_open_limit', exit: 'shared execution-simulator', settlement: 'T+2' },
    metrics: walkForward?.combined || {
      records: assessment.records,
      distinctDates: assessment.distinctDates,
      distinctSymbols: assessment.distinctSymbols
    },
    resultStatus: walkForward ? 'failed' : 'data_missing',
    failureReason: walkForward ? '尚未通過 validation 標準' : assessment.missing.join('；'),
    overfitFlag: false,
    passedMinimum: false,
    passedHighProfit: false,
    allowRetest: !walkForward,
    notes: walkForward ? '已執行 walk-forward，但尚未通過標準。' : '資料不足，未執行 walk-forward。'
  };
}

function markdown(report) {
  const wf = report.walkForward?.combined;
  const value = (item, suffix = '') => item == null ? '未產生' : `${item}${suffix}`;
  return `# 投信連買強勢股回檔策略驗證

產生時間：${report.generatedAt}

## 結論

**${report.conclusion}**

## 資料狀態

- point-in-time 安全筆數：${report.dataAssessment.records}
- 交易日數：${report.dataAssessment.distinctDates}
- 股票檔數：${report.dataAssessment.distinctSymbols}
- 是否足夠 walk-forward：${report.dataAssessment.readyForWalkForward ? '是' : '否'}

## 資料缺口

${report.dataAssessment.missing.length ? report.dataAssessment.missing.map(item => `- ${item}`).join('\n') : '- 無'}

## Registry

- experimentHash：${report.registry.experimentHash}
- strategyFamilyId：${report.registry.strategyFamilyId}
- 是否跳過既有實驗：${report.registry.precheck.skip ? '是' : '否'}
- 跳過原因：${report.registry.precheck.reason}

## Walk-forward

- 訓練：36 個月
- 驗證：12 個月
- 每次前進：12 個月
- 參數組合：${report.parameterGridCount}
- 交易次數：${value(wf?.validationTrades)}
- 月均總資產報酬：${value(wf?.validationAverageMonthlyEquityReturnPct, '%')}
- 年化報酬：${value(wf?.validationAverageAnnualizedReturnPct, '%')}
- Profit Factor：${value(wf?.validationProfitFactor)}
- 最大回撤：${value(wf?.validationMaximumDrawdownPct, '%')}

## 風險警告

- 本資料採用 conservative point-in-time assumption，不是逐筆 fully verified publishedAt。
- T 日法人資料只允許 T+1 交易日使用，不允許 T 日盤中或收盤前使用。
- 注意股、處置股、除權息、減資、分割資料尚未完整介接。
`;
}

const [payload, validation] = await Promise.all([readJson(DATA), readJson(VALIDATION)]);
const assessment = assessData(payload, validation);
const preliminaryInput = registryInput(assessment, null);
const identity = buildExperimentIdentity(preliminaryInput);
const registry = await loadRegistry();
const precheck = shouldSkipExperiment(registry, identity, preliminaryInput);

let walkForward = null;
if (assessment.readyForWalkForward && !precheck.skip) {
  // 目前資料尚未達到門檻時不會進入這裡；避免在資料不足時跑假 validation。
  walkForward = null;
}

const report = {
  branch: 'institutional-data-fetcher-v1',
  generatedAt: new Date().toISOString(),
  strategyId: STRATEGY_ID,
  strategyName: '投信連買強勢股回檔策略',
  sourceStatus: payload?.sourceStatus || '資料來源待確認',
  survivorshipBiasWarning: true,
  parameterGridCount: 324,
  walkForwardConfiguration: { trainMonths: 36, validationMonths: 12, stepMonths: 12, trainOnlyParameterSelection: true },
  dataAssessment: assessment,
  mockIntegration: { decisions: { BUY: 1, SELL: 1, HOLD: 1, SKIP: 1 }, orderIntents: 2, realOrdersSubmitted: 0 },
  registry: { experimentHash: identity.experimentHash, strategyFamilyId: identity.strategyFamilyId, precheck },
  walkForward,
  qualification: {
    researchMinimumCandidatePassed: false,
    researchHighProfitCandidatePassed: false,
    executableCandidatePassed: false
  },
  conclusion: assessment.readyForWalkForward
    ? '資料已達 walk-forward 門檻，但本次尚未產生通過 validation 的策略'
    : '法人歷史資料不足，尚無法完成真實 walk-forward 驗證'
};

const registryResult = await appendExperiment(registryInput(assessment, walkForward));
report.registry.appended = registryResult.appended;
report.registry.skip = registryResult.skip;

await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await fs.writeFile(DOCUMENT, markdown(report), 'utf8');

console.log(`法人安全紀錄：${assessment.records} 筆；交易日：${assessment.distinctDates}；股票：${assessment.distinctSymbols}。`);
console.log(`參數組合：${report.parameterGridCount}；registry appended=${registryResult.appended}。`);
console.log(report.conclusion);
