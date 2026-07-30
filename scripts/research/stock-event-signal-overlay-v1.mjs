import fs from 'node:fs/promises';
import { buyExecution, sellExecution } from '../lib/execution-simulator.mjs';
import {
  appendExperiment,
  buildExperimentIdentity,
  loadRegistry,
  shouldSkipExperiment
} from './strategy-experiment-registry.mjs';

const BACKTEST = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const CACHE = new URL('../../.cache/buyback/', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-event-signal-overlay-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_EVENT_SIGNAL_OVERLAY_V1.md', import.meta.url);
const TRAIN = ['2022-01-01', '2023-12-31'];
const VALIDATION = ['2024-01-01', '2025-12-31'];
const COSTS = {
  buyFeePct: 0.1425,
  sellFeePct: 0.1425,
  sellTaxPct: 0.3,
  buySlippagePct: 0.15,
  sellSlippagePct: 0.15,
  minimumFee: 20,
  boardLotShares: 1000
};
const round = (value, digits = 4) => Number(value.toFixed(digits));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function text(value) {
  return String(value).replace(/<[^>]+>/g, ' ').replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&').replace(/\s+/g, ' ').trim();
}

function rocDate(value) {
  const [year, month, day] = String(value).split('/').map(Number);
  return year && month && day
    ? `${year + 1911}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    : '';
}

function parseEvents(html) {
  const events = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(match => text(match[1]));
    if (cells.length !== 20 || !/^\d{4}$/.test(cells[1])) continue;
    events.push({
      symbol: cells[1],
      decisionDate: rocDate(cells[3]),
      purpose: Number(cells[4]) || 0
    });
  }
  return events;
}

function netReturn(trade, holdDays) {
  const exit = trade.forwardPrices?.[holdDays];
  if (!exit) return null;
  const buy = buyExecution(trade.entryPrice, 1000, COSTS).total;
  const sell = sellExecution(exit.price, 1000, COSTS).net;
  return (sell / buy - 1) * 100;
}

function stats(rows, holdDays) {
  const values = rows.map(row => netReturn(row, holdDays)).filter(Number.isFinite);
  const sorted = [...values].sort((a, b) => a - b);
  const gains = values.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter(value => value <= 0).reduce((sum, value) => sum + value, 0));
  const topCount = Math.max(1, Math.ceil(values.length * 0.05));
  const topGains = [...values].sort((a, b) => b - a).slice(0, topCount)
    .reduce((sum, value) => sum + Math.max(0, value), 0);
  return {
    samples: values.length,
    averageReturnPct: round(mean(values)),
    medianReturnPct: round(sorted[Math.floor(sorted.length / 2)] || 0),
    winRatePct: round(values.filter(value => value > 0).length / Math.max(1, values.length) * 100),
    profitFactor: losses ? round(gains / losses) : null,
    top5PctProfitContributionPct: gains ? round(topGains / gains * 100) : null
  };
}

function configurations() {
  return ['all', 1, 3].flatMap(purpose =>
    [10, 20, 40, 90].flatMap(maxEventAgeDays =>
      [65, 70, 75].flatMap(minScore =>
        [false, true].flatMap(requireTrend =>
          [5, 10, 20].map(holdDays => ({
            purpose,
            maxEventAgeDays,
            minScore,
            requireTrend,
            holdDays
          }))
        )
      )
    )
  );
}

function daysBetween(left, right) {
  return (Date.parse(right) - Date.parse(left)) / 86_400_000;
}

function latestEvent(eventsBySymbol, trade, config) {
  const events = eventsBySymbol.get(String(trade.symbol)) || [];
  return events.filter(event =>
    event.decisionDate <= trade.signalDate
    && daysBetween(event.decisionDate, trade.signalDate) <= config.maxEventAgeDays
    && (config.purpose === 'all' || event.purpose === config.purpose)
  ).at(-1);
}

function eligible(trade, config) {
  return trade.signalScore >= config.minScore
    && trade.avg20TradeValue >= 10_000_000
    && (!config.requireTrend || (trade.ma20Rising && trade.directionalTrendUp))
    && Number.isFinite(netReturn(trade, config.holdDays));
}

function matchedControls(pool, selected, config, eventsBySymbol) {
  const byDate = new Map();
  for (const trade of pool) {
    if (!eligible(trade, config) || latestEvent(eventsBySymbol, trade, config)) continue;
    if (!byDate.has(trade.entryDate)) byDate.set(trade.entryDate, []);
    byDate.get(trade.entryDate).push(trade);
  }
  return selected.map((trade, sequence) => {
    const candidates = byDate.get(trade.entryDate) || [];
    candidates.sort((left, right) => {
      const leftDistance = Math.abs(left.signalScore - trade.signalScore)
        + Math.abs(Math.log(Math.max(1, left.avg20TradeValue) / Math.max(1, trade.avg20TradeValue)));
      const rightDistance = Math.abs(right.signalScore - trade.signalScore)
        + Math.abs(Math.log(Math.max(1, right.avg20TradeValue) / Math.max(1, trade.avg20TradeValue)));
      return leftDistance - rightDistance || String(left.symbol).localeCompare(String(right.symbol));
    });
    return candidates[sequence % Math.max(1, Math.min(5, candidates.length))] || null;
  }).filter(Boolean);
}

const configs = configurations();
const experiment = {
  strategyId: 'stock_buyback_signal_overlay_v1',
  dataSources: ['official_mops_t35sc09_buyback', 'existing_point_in_time_stock_signals'],
  setupRules: ['既有技術候選股', '訊號日前 10 至 90 日曾公告庫藏股'],
  triggerRules: ['既有訊號確認後下一交易日開盤'],
  invalidationRules: ['實際買回結果不得作為條件', '驗證期不得選參數'],
  exitRules: ['固定持有 5、10、20 個交易日進行增量診斷'],
  riskRules: { diagnosticOnly: true, minimumTradeValue: 10_000_000 },
  blockedWhen: ['ETF', '未來資料', '成交值不足'],
  parameters: { configurations: configs },
  trainPeriod: TRAIN,
  validationPeriod: VALIDATION,
  costModel: COSTS,
  executionModel: 'existing_signal_next_open_with_costs'
};
const identity = buildExperimentIdentity(experiment);
const skip = shouldSkipExperiment(await loadRegistry(), identity, { ...experiment, coreRulesChanged: true });
if (skip.skip && !process.argv.includes('--force')) {
  console.log(`策略實驗已存在，略過：${skip.reason}`);
  process.exit(0);
}

const [backtest, twseHtml, tpexHtml] = await Promise.all([
  fs.readFile(BACKTEST, 'utf8').then(JSON.parse),
  fs.readFile(new URL('sii-2022-2025.html', CACHE), 'utf8'),
  fs.readFile(new URL('otc-2022-2025.html', CACHE), 'utf8')
]);
const events = [...parseEvents(twseHtml), ...parseEvents(tpexHtml)].sort((a, b) =>
  a.decisionDate.localeCompare(b.decisionDate)
);
const eventsBySymbol = new Map();
for (const event of events) {
  if (!eventsBySymbol.has(event.symbol)) eventsBySymbol.set(event.symbol, []);
  eventsBySymbol.get(event.symbol).push(event);
}
const trades = (backtest.candidateTrades || []).filter(trade =>
  /^\d{4}$/.test(String(trade.symbol))
  && trade.signalDate >= TRAIN[0]
  && trade.signalDate <= VALIDATION[1]
);
const trainPool = trades.filter(trade => trade.signalDate <= TRAIN[1]);
const validationPool = trades.filter(trade => trade.signalDate >= VALIDATION[0]);

const tested = configs.map(config => {
  const selected = trainPool.filter(trade => eligible(trade, config)
    && latestEvent(eventsBySymbol, trade, config));
  const controls = matchedControls(trainPool, selected, config, eventsBySymbol);
  const train = stats(selected, config.holdDays);
  const control = stats(controls, config.holdDays);
  return {
    config,
    train,
    control,
    excessReturnPct: round(train.averageReturnPct - control.averageReturnPct)
  };
}).filter(row => row.train.samples >= 20 && row.control.samples >= row.train.samples * 0.8)
  .sort((a, b) => b.excessReturnPct - a.excessReturnPct);

const selected = tested.find(row =>
  row.train.averageReturnPct > 0
  && row.train.medianReturnPct > 0
  && row.train.profitFactor > 1.15
  && row.excessReturnPct >= 0.5
) || tested[0];
const validationSelected = selected
  ? validationPool.filter(trade => eligible(trade, selected.config)
    && latestEvent(eventsBySymbol, trade, selected.config))
  : [];
const validationControls = selected
  ? matchedControls(validationPool, validationSelected, selected.config, eventsBySymbol)
  : [];
const validation = selected ? stats(validationSelected, selected.config.holdDays) : stats([], 5);
const control = selected ? stats(validationControls, selected.config.holdDays) : stats([], 5);
const incrementalPassed = validation.samples >= 50
  && control.samples >= validation.samples * 0.8
  && validation.averageReturnPct >= control.averageReturnPct + 0.5
  && validation.medianReturnPct > control.medianReturnPct
  && validation.profitFactor > 1.15
  && validation.top5PctProfitContributionPct < 50;
const conclusion = incrementalPassed
  ? '庫藏股事件對既有技術訊號有樣本外增量價值，仍需完整投組驗證。'
  : '庫藏股事件未改善既有技術訊號，不接入正式選股。';
const output = {
  generatedAt: new Date().toISOString(),
  strategyId: experiment.strategyId,
  ...identity,
  trainPeriod: TRAIN,
  validationPeriod: VALIDATION,
  sourceEvents: events.length,
  candidateTrades: trades.length,
  testedConfigurations: tested.length,
  selected: selected || null,
  validation,
  matchedControl: control,
  validationExcessReturnPct: round(validation.averageReturnPct - control.averageReturnPct),
  incrementalPassed,
  conclusion
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 庫藏股事件與既有訊號增量測試

- 訓練：${TRAIN.join(' 至 ')}；驗證：${VALIDATION.join(' 至 ')}。
- 成本：手續費、交易稅、雙邊滑價與最低手續費均已納入。
- 事件：${events.length} 件；同期既有候選交易 ${trades.length} 筆。
- 驗證事件組：${validation.samples} 筆，平均 ${validation.averageReturnPct}%，PF ${validation.profitFactor}。
- 同日相近分數與流動性對照組：${control.samples} 筆，平均 ${control.averageReturnPct}%，PF ${control.profitFactor}。
- 增量差異：${round(validation.averageReturnPct - control.averageReturnPct)} 個百分點。
- 結論：${conclusion}
`, 'utf8');
await appendExperiment({
  ...experiment,
  metrics: { train: selected?.train || null, validation, matchedControl: control },
  resultStatus: incrementalPassed ? 'passed' : 'failed',
  failureReason: incrementalPassed ? null : conclusion,
  passedMinimum: false,
  passedHighProfit: false,
  allowRetest: false,
  notes: '只檢查事件對既有訊號的增量價值；未通過時不得加入正式策略。'
});
console.log(JSON.stringify({
  sourceEvents: events.length,
  candidateTrades: trades.length,
  testedConfigurations: tested.length,
  selected: selected?.config || null,
  train: selected?.train || null,
  trainControl: selected?.control || null,
  validation,
  matchedControl: control,
  validationExcessReturnPct: round(validation.averageReturnPct - control.averageReturnPct),
  incrementalPassed,
  conclusion
}, null, 2));
