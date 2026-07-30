import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { buyExecution, sellExecution } from '../lib/execution-simulator.mjs';
import {
  appendExperiment,
  buildExperimentIdentity,
  loadRegistry,
  shouldSkipExperiment
} from './strategy-experiment-registry.mjs';

const BACKTEST = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const PROCESSED = new URL('../../data/market-history/processed/', import.meta.url);
const CACHE = new URL('../../.cache/day-trading/', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-daytrade-risk-overlay-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_DAYTRADE_RISK_OVERLAY_V1.md', import.meta.url);
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
const number = value => Number(String(value ?? '').replaceAll(',', '').trim()) || 0;

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
  return {
    samples: values.length,
    averageReturnPct: round(mean(values)),
    medianReturnPct: round(sorted[Math.floor(sorted.length / 2)] || 0),
    winRatePct: round(values.filter(value => value > 0).length / Math.max(1, values.length) * 100),
    profitFactor: losses ? round(gains / losses) : null
  };
}

async function marketVolumes() {
  const volumes = new Map();
  const dates = new Set();
  for (const year of ['2022', '2023', '2024', '2025']) {
    const payload = JSON.parse(zlib.gunzipSync(await fs.readFile(new URL(`${year}.json.gz`, PROCESSED))));
    for (const [symbol, rows] of Object.entries(payload.symbols || {})) {
      if (!/^\d{4}\.(TW|TWO)$/.test(symbol) || symbol.startsWith('00')) continue;
      for (const row of rows) {
        if (row.corporateActionSuspected) continue;
        dates.add(row.date);
        volumes.set(`${row.date}|${symbol.slice(0, 4)}`, row.volume);
      }
    }
  }
  return { volumes, dates: [...dates].sort() };
}

function parse(payload, date) {
  return (payload?.tables?.[1]?.data || []).map(row => {
    const symbol = String(row[0]).trim();
    return /^\d{4}$/.test(symbol)
      ? { date, symbol, dayTradeShares: number(row[3]) }
      : null;
  }).filter(Boolean);
}

async function dayTradeRanks(volumes, tradingDates) {
  const byDate = new Map();
  for (const market of ['TWSE', 'TPEX']) {
    const directory = new URL(`${market}/`, CACHE);
    let files = [];
    try {
      files = await fs.readdir(directory);
    } catch {
      continue;
    }
    for (const file of files.filter(name => name.endsWith('.json'))) {
      const date = file.slice(0, 10);
      if (date < TRAIN[0] || date > VALIDATION[1]) continue;
      const payload = JSON.parse(await fs.readFile(new URL(file, directory), 'utf8'));
      const rows = parse(payload, date);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(...rows);
    }
  }
  const effective = new Map();
  for (const [date, rows] of byDate) {
    const tradingIndex = tradingDates.findIndex(item => item >= date);
    if (tradingIndex < 0 || tradingIndex + 3 >= tradingDates.length) continue;
    const effectiveDate = tradingDates[tradingIndex + 3];
    const ranked = rows.map(row => ({
      ...row,
      ratio: row.dayTradeShares / Math.max(1, volumes.get(`${date}|${row.symbol}`) || 0)
    })).filter(row => Number.isFinite(row.ratio) && row.ratio > 0)
      .sort((left, right) => left.ratio - right.ratio);
    ranked.forEach((row, index) => {
      effective.set(`${effectiveDate}|${row.symbol}`, index / Math.max(1, ranked.length - 1));
    });
  }
  return {
    ranks: effective,
    effectiveDates: [...new Set([...effective.keys()].map(key => key.slice(0, 10)))].sort(),
    sourceDates: byDate.size
  };
}

function latestRank(trade, rankData) {
  const date = [...rankData.effectiveDates].reverse().find(item =>
    item <= trade.signalDate && Date.parse(trade.signalDate) - Date.parse(item) <= 10 * 86_400_000
  );
  return date ? rankData.ranks.get(`${date}|${trade.symbol}`) : null;
}

function configurations() {
  return [0.7, 0.8, 0.9].flatMap(maxDayTradeRank =>
    [65, 70, 75].flatMap(minScore =>
      [false, true].flatMap(requireTrend =>
        [5, 10, 20].map(holdDays => ({ maxDayTradeRank, minScore, requireTrend, holdDays }))
      )
    )
  );
}

function baseEligible(trade, config) {
  return trade.signalScore >= config.minScore
    && trade.avg20TradeValue >= 10_000_000
    && (!config.requireTrend || (trade.ma20Rising && trade.directionalTrendUp))
    && Number.isFinite(netReturn(trade, config.holdDays));
}

const configs = configurations();
const experiment = {
  strategyId: 'stock_daytrade_risk_overlay_v1',
  dataSources: ['official_twse_twtb4u', 'official_tpex_intraday_stat', 'existing_point_in_time_stock_signals'],
  setupRules: ['既有技術候選股', '官方當沖占比橫斷面排名'],
  triggerRules: ['當沖資料保守延後三個交易日後才可使用'],
  invalidationRules: ['驗證期不得選參數', '缺資料不得自動視為過熱'],
  exitRules: ['固定持有 5、10、20 個交易日進行排除層診斷'],
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

const [backtest, market] = await Promise.all([
  fs.readFile(BACKTEST, 'utf8').then(JSON.parse),
  marketVolumes()
]);
const rankData = await dayTradeRanks(market.volumes, market.dates);
const trades = (backtest.candidateTrades || []).filter(trade =>
  /^\d{4}$/.test(String(trade.symbol))
  && trade.signalDate >= TRAIN[0]
  && trade.signalDate <= VALIDATION[1]
).map(trade => ({ ...trade, dayTradeRank: latestRank(trade, rankData) }));
const trainPool = trades.filter(trade => trade.signalDate <= TRAIN[1]);
const validationPool = trades.filter(trade => trade.signalDate >= VALIDATION[0]);

const tested = configs.map(config => {
  const baselineRows = trainPool.filter(trade => baseEligible(trade, config) && trade.dayTradeRank !== null);
  const filteredRows = baselineRows.filter(trade => trade.dayTradeRank <= config.maxDayTradeRank);
  const baseline = stats(baselineRows, config.holdDays);
  const filtered = stats(filteredRows, config.holdDays);
  return {
    config,
    baseline,
    filtered,
    improvementPct: round(filtered.averageReturnPct - baseline.averageReturnPct)
  };
}).filter(row => row.baseline.samples >= 300 && row.filtered.samples >= 200)
  .sort((a, b) => b.improvementPct - a.improvementPct);

const selected = tested.find(row =>
  row.filtered.averageReturnPct > 0
  && row.filtered.profitFactor > 1.15
  && row.improvementPct >= 0.2
) || tested[0];
const validationBaselineRows = selected
  ? validationPool.filter(trade => baseEligible(trade, selected.config) && trade.dayTradeRank !== null)
  : [];
const validationFilteredRows = selected
  ? validationBaselineRows.filter(trade => trade.dayTradeRank <= selected.config.maxDayTradeRank)
  : [];
const validationBaseline = selected ? stats(validationBaselineRows, selected.config.holdDays) : stats([], 5);
const validationFiltered = selected ? stats(validationFilteredRows, selected.config.holdDays) : stats([], 5);
const improvementPct = round(validationFiltered.averageReturnPct - validationBaseline.averageReturnPct);
const riskOverlayPassed = validationFiltered.samples >= 300
  && improvementPct >= 0.2
  && validationFiltered.profitFactor > validationBaseline.profitFactor
  && validationFiltered.medianReturnPct > validationBaseline.medianReturnPct;
const conclusion = riskOverlayPassed
  ? '排除當沖過熱可在樣本外改善既有候選股，下一步需做完整投組驗證。'
  : '排除當沖過熱未穩定改善既有候選股，不接入正式選股。';
const output = {
  generatedAt: new Date().toISOString(),
  strategyId: experiment.strategyId,
  ...identity,
  trainPeriod: TRAIN,
  validationPeriod: VALIDATION,
  sourceDates: rankData.sourceDates,
  effectiveDates: rankData.effectiveDates.length,
  candidateTrades: trades.length,
  candidatesWithDayTradeData: trades.filter(trade => trade.dayTradeRank !== null).length,
  testedConfigurations: tested.length,
  selected: selected || null,
  validationBaseline,
  validationFiltered,
  validationImprovementPct: improvementPct,
  riskOverlayPassed,
  conclusion
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 當沖過熱排除層 v1

- 訓練：${TRAIN.join(' 至 ')}；驗證：${VALIDATION.join(' 至 ')}。
- 時間點：官方當沖資料保守延後三個交易日使用。
- 有效資料日：${rankData.effectiveDates.length}；可配對候選股 ${output.candidatesWithDayTradeData} 筆。
- 驗證基準：${validationBaseline.samples} 筆，平均 ${validationBaseline.averageReturnPct}%，PF ${validationBaseline.profitFactor}。
- 排除過熱後：${validationFiltered.samples} 筆，平均 ${validationFiltered.averageReturnPct}%，PF ${validationFiltered.profitFactor}。
- 增量差異：${improvementPct} 個百分點。
- 結論：${conclusion}
`, 'utf8');
await appendExperiment({
  ...experiment,
  metrics: { train: selected?.filtered || null, validationBaseline, validationFiltered },
  resultStatus: riskOverlayPassed ? 'passed' : 'failed',
  failureReason: riskOverlayPassed ? null : conclusion,
  passedMinimum: false,
  passedHighProfit: false,
  allowRetest: false,
  notes: '只檢查排除層的增量價值；通過後仍須完整投組驗證。'
});
console.log(JSON.stringify({
  sourceDates: rankData.sourceDates,
  effectiveDates: rankData.effectiveDates.length,
  candidatesWithDayTradeData: output.candidatesWithDayTradeData,
  selected: selected?.config || null,
  trainBaseline: selected?.baseline || null,
  trainFiltered: selected?.filtered || null,
  validationBaseline,
  validationFiltered,
  validationImprovementPct: improvementPct,
  riskOverlayPassed,
  conclusion
}, null, 2));
