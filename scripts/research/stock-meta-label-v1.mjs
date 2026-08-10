import fs from 'node:fs/promises';
import { loadResearchContext, simulateSignalMap } from './research-core.mjs';
import { generateOrderIntents } from '../lib/order-intent-generator.mjs';
import { appendExperiment, buildExperimentIdentity, loadRegistry, shouldSkipExperiment } from './strategy-experiment-registry.mjs';
import { eligible, fitModel, modelScore, signalMap, stockOnly } from '../lib/stock-meta-label-engine.mjs';

const INPUT = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const ETF = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-meta-label-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_META_LABEL_V1.md', import.meta.url);
const STRESS = process.argv.includes('--stress');
const STRESS_OUTPUT = new URL('../../data/research/stock-meta-label-v1-stress.json', import.meta.url);
const STRESS_REPORT = new URL('../../docs/STOCK_META_LABEL_V1_STRESS.md', import.meta.url);
const PAPER_OUTPUT = new URL('../../data/research/stock-meta-label-paper-snapshot-v1.json', import.meta.url);
const INITIAL_CAPITAL = 1_000_000;
const TARGET_MONTHLY = 5;
const COSTS = { buyFeePct: 0.1425, sellFeePct: 0.1425, sellTaxPct: 0.3, buySlippagePct: STRESS ? 0.3 : 0.15, sellSlippagePct: STRESS ? 0.3 : 0.15, minimumFee: 20, boardLotShares: 1 };
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const monthKey = date => String(date).slice(0, 7);

function folds(monthList) {
  const result = [];
  for (let index = 0; index + 72 <= monthList.length; index += 12) result.push({ trainStart: monthList[index], trainEnd: monthList[index + 59], validationStart: monthList[index + 60], validationEnd: monthList[index + 71] });
  return result;
}

function exactPf(foldsResult) {
  let gains = 0; let losses = 0; let trades = 0;
  for (const fold of foldsResult) for (const trade of fold.validationTrades) { trades += 1; if (trade.realizedPnl > 0) gains += trade.realizedPnl; else losses += Math.abs(trade.realizedPnl || 0); }
  return { trades, pf: losses ? gains / losses : gains ? null : 0 };
}

function merge(foldsResult) {
  const monthly = new Map();
  for (const fold of foldsResult) for (const row of fold.validation.monthly || []) monthly.set(row.month, row.equityReturnPct);
  const values = [...monthly.values()]; const pf = exactPf(foldsResult);
  return { months: values.length, averageMonthlyEquityReturnPct: round(mean(values)), annualizedReturnPct: round(((values.reduce((total, value) => total * (1 + value / 100), 1) ** (12 / Math.max(1, values.length))) - 1) * 100), maximumDrawdownPct: round(Math.min(...foldsResult.map(row => row.validation.maximumDrawdownPct), 0)), trades: pf.trades, profitFactor: round(pf.pf), winRatePct: round(foldsResult.reduce((sum, row) => sum + row.validation.winRatePct * row.validation.trades, 0) / Math.max(1, pf.trades)), negativeMonths: values.filter(value => value < 0).length, monthly: [...monthly].map(([month, returnPct]) => ({ month, returnPct })) };
}

function qualityDiagnostics(foldsResult) {
  const trades = foldsResult.flatMap(row => row.validationTrades || []);
  const returns = trades.map(row => row.accountReturnPct).filter(Number.isFinite).sort((a, b) => a - b);
  const symbolCounts = new Map();
  for (const trade of trades) symbolCounts.set(trade.symbol, (symbolCounts.get(trade.symbol) || 0) + 1);
  const gains = trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const sortedGains = trades.filter(row => row.realizedPnl > 0).map(row => row.realizedPnl).sort((a, b) => b - a);
  const topFiveGains = sortedGains.slice(0, 5).reduce((sum, value) => sum + value, 0);
  return {
    uniqueSymbols: symbolCounts.size,
    topSymbolSharePct: round(Math.max(...symbolCounts.values(), 0) / Math.max(1, trades.length) * 100),
    medianTradeReturnPct: returns.length ? round(returns[Math.floor(returns.length / 2)]) : null,
    worstTradeReturnPct: returns.length ? round(returns[0]) : null,
    bestTradeReturnPct: returns.length ? round(returns.at(-1)) : null,
    topFiveProfitContributionPct: gains ? round(topFiveGains / gains * 100) : null
  };
}

function benchmark(series, start, end) {
  const closes = [...new Map(series.filter(row => row.date >= start && row.date <= end).map(row => [monthKey(row.date), row.close]))].sort();
  return { averageMonthlyReturnPct: round(mean(closes.slice(1).map(([, close], index) => (close / closes[index][1] - 1) * 100))), months: Math.max(0, closes.length - 1) };
}

const [input, context, etf] = await Promise.all([fs.readFile(INPUT, 'utf8').then(JSON.parse), loadResearchContext(), fs.readFile(ETF, 'utf8').then(JSON.parse)]);
const rows = (input.candidateTrades || []).filter(row => stockOnly(row) && row.forwardPrices?.length >= 12);
const monthList = [...new Set(rows.map(row => monthKey(row.entryDate)))].sort();
const experiment = { strategyId: 'stock-meta-label-v1', dataSources: ['OHLCV 個股特徵', '市場狀態'], setupRules: ['訓練期因子分箱', '流動性與波動排除', '市場順風'], triggerRules: ['模型分數排名進場'], invalidationRules: ['收盤停損'], exitRules: ['風險報酬停利', '移動停利', '持有期限'], riskRules: { maxSinglePositionPct: 10, maxExposurePct: 80, accountRiskPct: 0.5, leverage: 1 }, blockedWhen: ['資料不足', '高波動', '跳空過大'], parameters: { trainMonths: 60, validationMonths: 12, stepMonths: 12, model: 'train-only-quantile-forward-return', noLeverage: true }, trainPeriod: [monthList[0], monthList[59]], validationPeriod: [monthList[60], monthList.at(-1)], costModel: COSTS, executionModel: 'execution-simulator + portfolio-simulator' };
const identity = buildExperimentIdentity(experiment);
const check = shouldSkipExperiment(await loadRegistry(), identity, { ...experiment, coreRulesChanged: true });
if (check.skip && !process.argv.includes('--force')) { console.log(`已依策略實驗登錄表跳過：${check.reason}`); process.exit(0); }

const configs = [];
for (const featureMode of ['all', 'momentum']) for (const regimeGate of ['all', 'bull', 'trend']) for (const exit of [{ holdDays: 3, stopLossPct: 3, rewardRisk: 1.5, trailingStop: false }, { holdDays: 5, stopLossPct: 4, rewardRisk: 1.5, trailingStop: false }, { holdDays: 7, stopLossPct: 4, rewardRisk: 2, trailingStop: true }]) configs.push({ featureMode, regimeGate, ...exit, maxEntriesPerDay: 3, positionPct: 8, maxOpenPositions: 10 });

const resultFolds = [];
for (const fold of folds(monthList)) {
  const trainRuns = [];
  for (const config of configs) {
    const model = fitModel(rows, config, fold.trainEnd);
    const train = simulateSignalMap(context, signalMap(rows, model, config, context), { initialCapital: INITIAL_CAPITAL, maxOpenPositions: config.maxOpenPositions, startDate: `${fold.trainStart}-01`, endDate: `${fold.trainEnd}-31`, strategyId: 'stock-meta-label-v1', executionCosts: COSTS });
    const score = train.summary.averageMonthlyEquityReturnPct * 3 + Math.min(3, train.summary.profitFactor || 0) + Math.min(1, train.summary.trades / 300) + Math.max(-3, train.summary.maximumDrawdownPct / 8) - train.summary.negativeMonths / Math.max(1, train.summary.monthly?.length || 1);
    trainRuns.push({ config, model, train, score });
  }
  trainRuns.sort((a, b) => b.score - a.score);
  const selected = trainRuns[0];
  const validation = simulateSignalMap(context, signalMap(rows, selected.model, selected.config, context), { initialCapital: INITIAL_CAPITAL, maxOpenPositions: selected.config.maxOpenPositions, startDate: `${fold.validationStart}-01`, endDate: `${fold.validationEnd}-31`, strategyId: 'stock-meta-label-v1', executionCosts: COSTS });
  const random = simulateSignalMap(context, signalMap(rows, selected.model, selected.config, context, true), { initialCapital: INITIAL_CAPITAL, maxOpenPositions: selected.config.maxOpenPositions, startDate: `${fold.validationStart}-01`, endDate: `${fold.validationEnd}-31`, strategyId: '公平隨機基準', executionCosts: COSTS });
  resultFolds.push({ trainPeriod: [fold.trainStart, fold.trainEnd], validationPeriod: [fold.validationStart, fold.validationEnd], selectedConfig: selected.config, train: selected.train.summary, validation: validation.summary, validationTrades: validation.trades, random: random.summary });
}
const validation = merge(resultFolds); const randomMonthly = round(mean(resultFolds.map(row => row.random.averageMonthlyEquityReturnPct))); const validationStart = resultFolds[0]?.validationPeriod[0] || monthList[60]; const validationEnd = resultFolds.at(-1)?.validationPeriod[1] || monthList.at(-1); const benchmark0050 = benchmark(etf.series['0050.TW'] || [], `${validationStart}-01`, `${validationEnd}-31`);
const passed = validation.trades > 300 && validation.averageMonthlyEquityReturnPct >= TARGET_MONTHLY && validation.profitFactor > 1.15 && validation.maximumDrawdownPct > -20 && validation.averageMonthlyEquityReturnPct > benchmark0050.averageMonthlyReturnPct && validation.averageMonthlyEquityReturnPct > randomMonthly;
const report = {
  generatedAt: new Date().toISOString(),
  strategyId: 'stock-meta-label-v1',
  dataPeriod: [monthList[0], monthList.at(-1)],
  rollingValidation: { trainMonths: 60, validationMonths: 12, stepMonths: 12, folds: resultFolds.length },
  universe: { individualStocksOnly: true, etfExcluded: true, candidateRows: rows.length },
  dataQuality: {
    survivorshipBiasWarning: context.survivorshipBiasWarning,
    note: '目前資料以現有股票池回溯，尚非完整歷史上市／下市股票池。'
  },
  transactionCostsIncluded: COSTS,
  noLeverage: true,
  testedConfigurations: configs.length,
  validation,
  validationQuality: qualityDiagnostics(resultFolds),
  randomValidationAverageMonthlyReturnPct: randomMonthly,
  benchmark0050,
  folds: resultFolds.map(({ validationTrades, ...fold }) => fold),
  passed,
  paperTradingAllowed: passed,
  liveTradingAllowed: false,
  conclusion: passed
    ? '已達研究門檻，可進入受限紙上交易驗證；因資料偏差與尚未完成紙上驗證，不可直接實盤。'
    : `尚未找到月均 ${TARGET_MONTHLY}% 的可實盤個股策略，目前最佳月均 ${validation.averageMonthlyEquityReturnPct}%。`
};
const outputPath = STRESS ? STRESS_OUTPUT : OUTPUT;
const reportPath = STRESS ? STRESS_REPORT : REPORT;
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const registryResult = await appendExperiment({ ...experiment, metrics: { validation, randomMonthly, benchmark0050 }, resultStatus: passed ? 'passed' : 'failed', failureReason: passed ? null : 'meta-label rolling validation 未達月均 5% 或未勝過基準。', passedMinimum: passed, passedHighProfit: false, allowRetest: false, coreRulesChanged: true, notes: '訓練期因子分箱只使用當時可知資料，驗證期固定模型。' });
report.registryAppended = registryResult.appended;
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await fs.writeFile(reportPath, `# 個股 Meta-label 策略 v1${STRESS ? ' 成本壓力測試' : ''}\n\n- 回測期間：${report.dataPeriod[0]} 至 ${report.dataPeriod[1]}。\n- Rolling validation：訓練 60 個月、驗證 12 個月、每次前進 12 個月，共 ${resultFolds.length} 段。\n- 每段只用訓練資料計算因子分箱與未來報酬，驗證期不調參；只交易個股，含成本、滑價、T+2，無槓桿。\n- 驗證交易 ${validation.trades} 筆，月均 ${validation.averageMonthlyEquityReturnPct}%，年化 ${validation.annualizedReturnPct}%，PF ${validation.profitFactor}，最大回撤 ${validation.maximumDrawdownPct}%。\n- 0050 同期月均 ${benchmark0050.averageMonthlyReturnPct}%，公平隨機 ${randomMonthly}%。\n- 成本情境：買賣滑價各 ${COSTS.buySlippagePct}%。\n- 結論：${report.conclusion}\n`, 'utf8');
if (!STRESS) {
  const paperConfig = resultFolds.at(-1)?.selectedConfig;
  let latestDate = null;
  let latestCandidates = [];
  for (const date of [...new Set(rows.map(row => row.signalDate))].sort().reverse()) {
    const model = fitModel(rows, paperConfig, date);
    const candidates = rows
      .filter(row => row.signalDate === date && eligible(row, paperConfig))
      .map(row => ({ ...row, metaLabelScore: modelScore(row, model, paperConfig) }))
      .filter(row => row.metaLabelScore > -900)
      .sort((left, right) => right.metaLabelScore - left.metaLabelScore)
      .slice(0, paperConfig.maxEntriesPerDay);
    if (candidates.length) {
      latestDate = date;
      latestCandidates = candidates;
      break;
    }
  }
  const decisions = latestCandidates.map(row => {
    const entry = Number(row.entryPrice);
    const stop = entry * (1 - paperConfig.stopLossPct / 100);
    return {
      date: latestDate,
      symbol: row.symbol,
      action: 'BUY',
      strategyId: 'stock-meta-label-v1',
      setup: ['訓練期因子分箱分數為正', '個股流動性與波動通過'],
      trigger: ['模型分數進入當日候選前段', '隔日開盤成交'],
      invalidation: [`收盤跌破停損 ${round(stop)}`],
      entryPlan: { referencePrice: entry, maximumAcceptablePrice: entry * 1.005, orderType: 'MARKET', timeInForce: 'ROD', session: 'REGULAR' },
      riskPlan: { stopPrice: stop, targetPrice: entry + (entry - stop) * paperConfig.rewardRisk, riskPerShare: entry - stop, rewardPerShare: (entry - stop) * paperConfig.rewardRisk, riskRewardRatio: paperConfig.rewardRisk, accountRiskPct: 0.5, riskBudget: INITIAL_CAPITAL * 0.005, maxPositionPct: paperConfig.positionPct, positionBudget: INITIAL_CAPITAL * paperConfig.positionPct / 100 },
      reason: `meta-label 分數 ${round(row.metaLabelScore)}`,
      warnings: ['歷史 paper dry-run；尚未取得當日即時報價', '需要人工審核，不送出真實券商'],
      signalStatus: 'READY'
    };
  });
  const intents = generateOrderIntents({ decisions, account: { equity: INITIAL_CAPITAL, availableCash: INITIAL_CAPITAL }, positions: [], executionCosts: COSTS });
  await fs.writeFile(PAPER_OUTPUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), date: latestDate, strategyId: 'stock-meta-label-v1', mode: 'paper_dry_run', noFutureDataAttestation: true, source: 'tw-backtest-10y candidate features', actionCounts: { BUY: intents.length, SELL: 0, HOLD: 0, SKIP: Math.max(0, latestCandidates.length - intents.length) }, candidates: latestCandidates.map(row => ({ symbol: row.symbol, name: row.name, score: round(row.metaLabelScore) })), orderIntents: intents, submitToRealBroker: false, humanApprovalRequired: true }, null, 2)}\n`, 'utf8');
}
console.log(`${report.conclusion}；期間 ${report.dataPeriod[0]}..${report.dataPeriod[1]}；交易 ${validation.trades}；月均 ${validation.averageMonthlyEquityReturnPct}%；PF ${validation.profitFactor}；回撤 ${validation.maximumDrawdownPct}%；0050 ${benchmark0050.averageMonthlyReturnPct}%；隨機 ${randomMonthly}%。`);
