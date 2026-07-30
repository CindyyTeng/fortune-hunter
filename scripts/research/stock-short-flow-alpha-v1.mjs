import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { buyExecution, sellExecution } from '../lib/execution-simulator.mjs';
import {
  appendExperiment,
  buildExperimentIdentity,
  loadRegistry,
  shouldSkipExperiment
} from './strategy-experiment-registry.mjs';

const PROCESSED = new URL('../../data/market-history/processed/', import.meta.url);
const RAW = new URL('../../data/margin/raw/tpex/', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-short-flow-alpha-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_SHORT_FLOW_ALPHA_V1.md', import.meta.url);
const TRAIN = ['2022-03-01', '2023-12-31'];
const VALIDATION = ['2024-01-01', '2025-12-31'];
const COSTS = {
  buyFeePct: 0.1425,
  sellFeePct: 0.1425,
  sellTaxPct: 0.3,
  buySlippagePct: 0.1,
  sellSlippagePct: 0.1,
  minimumFee: 20,
  boardLotShares: 1000
};
const round = (value, digits = 4) => Number(value.toFixed(digits));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const number = value => Number(String(value ?? '').replaceAll(',', '').trim()) || 0;

function stats(rows, holdDays) {
  const values = rows.map(row => row.returns[holdDays]).filter(Number.isFinite);
  const sorted = [...values].sort((a, b) => a - b);
  const gains = values.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter(value => value <= 0).reduce((sum, value) => sum + value, 0));
  return {
    samples: values.length,
    averageReturnPct: round(mean(values)),
    medianReturnPct: round(sorted[Math.floor(sorted.length / 2)] || 0),
    winRatePct: round(values.filter(value => value > 0).length / Math.max(1, values.length) * 100),
    profitFactor: losses ? round(gains / losses) : null,
    top5ContributionPct: gains ? round(
      sorted.slice(Math.floor(sorted.length * 0.95))
        .reduce((sum, value) => sum + Math.max(0, value), 0) / gains * 100
    ) : 0
  };
}

async function histories() {
  const result = new Map();
  for (const year of ['2022', '2023', '2024', '2025']) {
    const payload = JSON.parse(zlib.gunzipSync(await fs.readFile(new URL(`${year}.json.gz`, PROCESSED))));
    for (const [symbol, rows] of Object.entries(payload.symbols || {})) {
      const stockNo = symbol.endsWith('.TWO') ? symbol.slice(0, -4) : '';
      if (!/^\d{4}$/.test(stockNo) || stockNo.startsWith('00')) continue;
      result.set(stockNo, (result.get(stockNo) || []).concat(
        rows.filter(row => !row.corporateActionSuspected)
      ));
    }
  }
  return result;
}

async function marginFlows() {
  const files = (await fs.readdir(RAW))
    .filter(name => name.endsWith('.json') && name.slice(0, 10) >= TRAIN[0] && name.slice(0, 10) <= VALIDATION[1]);
  const bySymbol = new Map();
  for (const file of files) {
    const date = file.slice(0, 10);
    const payload = JSON.parse(await fs.readFile(new URL(file, RAW), 'utf8'));
    const rows = (payload.tables?.[0]?.data || []).map(value => {
      const marginPrevious = number(value[2]);
      const shortPrevious = number(value[10]);
      const shortSell = number(value[11]);
      const shortBuy = number(value[12]);
      const stockRepayment = number(value[13]);
      return {
        date,
        symbol: String(value[0]).trim(),
        marginFlowPct: (number(value[3]) - number(value[4]) - number(value[5])) / Math.max(1, marginPrevious) * 100,
        shortSellPct: shortSell / Math.max(1, shortPrevious) * 100,
        coverPct: (shortBuy + stockRepayment - shortSell) / Math.max(1, shortPrevious) * 100
      };
    }).filter(row => /^\d{4}$/.test(row.symbol) && !row.symbol.startsWith('00'));

    for (const key of ['coverPct', 'shortSellPct']) {
      const sorted = rows.map(row => row[key]).sort((a, b) => a - b);
      for (const row of rows) {
        let low = 0;
        let high = sorted.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (sorted[middle] <= row[key]) low = middle + 1;
          else high = middle;
        }
        row[key === 'coverPct' ? 'coverRank' : 'shortSellRank'] = low / Math.max(1, sorted.length);
      }
    }
    for (const row of rows) {
      if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
      bySymbol.get(row.symbol).push(row);
    }
  }
  return bySymbol;
}

function observations(priceRows, flows) {
  const result = [];
  for (const [symbol, rows] of priceRows) {
    const indexes = new Map(rows.map((row, index) => [row.date, index]));
    for (const flow of flows.get(symbol) || []) {
      const index = indexes.get(flow.date);
      if (index == null || index < 60 || index + 22 >= rows.length) continue;
      const day = rows[index];
      const ma20 = mean(rows.slice(index - 19, index + 1).map(row => row.close));
      const ma60 = mean(rows.slice(index - 59, index + 1).map(row => row.close));
      const entry = rows[index + 1];
      const returns = {};
      for (const holdDays of [5, 10, 20]) {
        const exit = rows[index + 1 + holdDays];
        const buy = buyExecution(entry.open, 1000, COSTS).total;
        const sell = sellExecution(exit.close, 1000, COSTS).net;
        returns[holdDays] = (sell / buy - 1) * 100;
      }
      result.push({
        ...flow,
        entryDate: entry.date,
        mom20Pct: (day.close / rows[index - 20].close - 1) * 100,
        aboveMa20: day.close >= ma20,
        ma20AboveMa60: ma20 >= ma60,
        tradeValue20: mean(rows.slice(index - 19, index + 1).map(row => row.tradeValue)),
        atr20Pct: mean(rows.slice(index - 19, index + 1).map(row => (row.high - row.low) / row.close * 100)),
        returns
      });
    }
  }
  return result;
}

function configurations() {
  return ['covering', 'avoid_short_selling', 'covering_with_financing_unwind'].flatMap(mode =>
    [0.7, 0.8, 0.9].flatMap(rankCutoff =>
      [0, 5, 10].flatMap(minimumMomentum =>
        [5, 10, 20].map(holdDays => ({ mode, rankCutoff, minimumMomentum, holdDays }))
      )
    )
  );
}

function basePasses(row, minimumMomentum) {
  return row.aboveMa20 && row.ma20AboveMa60
    && row.tradeValue20 >= 50_000_000 && row.atr20Pct <= 8
    && row.mom20Pct >= minimumMomentum;
}

function passes(row, config) {
  if (!basePasses(row, config.minimumMomentum)) return false;
  if (config.mode === 'covering') return row.coverRank >= config.rankCutoff && row.coverPct > 0;
  if (config.mode === 'avoid_short_selling') return row.shortSellRank <= 1 - config.rankCutoff;
  return row.coverRank >= config.rankCutoff && row.coverPct > 0 && row.marginFlowPct < 0;
}

function randomMatch(pool, selected, holdDays) {
  const eligibleByDate = new Map();
  for (const row of pool) {
    if (!basePasses(row, 0)) continue;
    if (!eligibleByDate.has(row.date)) eligibleByDate.set(row.date, []);
    eligibleByDate.get(row.date).push(row);
  }
  return selected.map((row, index) => {
    const sameDate = eligibleByDate.get(row.date) || [];
    return sameDate[(Number(row.symbol) * 31 + index * 17) % Math.max(1, sameDate.length)] || row;
  }).map(row => ({ returns: { [holdDays]: row.returns[holdDays] } }));
}

const experiment = {
  strategyId: 'stock_short_flow_alpha_v1',
  dataSources: ['official_tpex_ohlcv', 'tpex_daily_margin_short_flow_t_plus_1'],
  setupRules: ['融券回補或放空賣出流量異常', 'MA20 高於 MA60', '股價在 MA20 之上'],
  triggerRules: ['T 日收盤後資料於 T+1 開盤成交並計入滑價'],
  invalidationRules: ['高 ATR、低成交值與 ETF 排除'],
  exitRules: ['固定持有 5、10、20 個交易日進行 alpha 診斷'],
  riskRules: { diagnosticOnly: true },
  blockedWhen: ['資料不符合 point-in-time', 'ETF'],
  parameters: { configurations: configurations() },
  trainPeriod: TRAIN,
  validationPeriod: VALIDATION,
  costModel: COSTS,
  executionModel: 'next_open_with_slippage'
};
const identity = buildExperimentIdentity(experiment);
const skip = shouldSkipExperiment(await loadRegistry(), identity, { ...experiment, coreRulesChanged: true });
if (skip.skip && !process.argv.includes('--force')) {
  console.log(`策略實驗已存在，略過：${skip.reason}`);
  process.exit(0);
}

const [priceRows, flows] = await Promise.all([histories(), marginFlows()]);
const all = observations(priceRows, flows);
const trainPool = all.filter(row => row.date >= TRAIN[0] && row.date <= TRAIN[1]);
const validationPool = all.filter(row => row.date >= VALIDATION[0] && row.date <= VALIDATION[1]);
const tested = configurations().map(config => {
  const trainRows = trainPool.filter(row => passes(row, config));
  return { config, train: stats(trainRows, config.holdDays) };
}).filter(row => row.train.samples >= 150)
  .sort((a, b) => b.train.averageReturnPct - a.train.averageReturnPct);
const selected = tested.find(row =>
  row.train.averageReturnPct > 0 && row.train.medianReturnPct > 0 && row.train.profitFactor > 1.1
) || tested[0];
const validationRows = selected ? validationPool.filter(row => passes(row, selected.config)) : [];
const validation = selected ? stats(validationRows, selected.config.holdDays) : stats([], 5);
const random = selected ? stats(
  randomMatch(validationPool, validationRows, selected.config.holdDays),
  selected.config.holdDays
) : stats([], 5);
const alphaPassed = validation.samples >= 150
  && validation.averageReturnPct > 0
  && validation.medianReturnPct > 0
  && validation.profitFactor > 1.15
  && validation.averageReturnPct > random.averageReturnPct
  && validation.top5ContributionPct < 50;
const conclusion = alphaPassed
  ? '融券流量具有跨期正期望，可進入完整投組回測。'
  : '融券流量未通過跨期正期望門檻，不建立可實盤策略。';
const output = {
  generatedAt: new Date().toISOString(),
  strategyId: experiment.strategyId,
  ...identity,
  universe: 'TPEX_COMMON_STOCKS_ONLY',
  pointInTimeRule: 'T 日收盤後融資融券資料只能於 T+1 使用',
  trainPeriod: TRAIN,
  validationPeriod: VALIDATION,
  observations: all.length,
  testedConfigurations: tested.length,
  selected: selected || null,
  validation,
  fairRandom: random,
  alphaPassed,
  fullPortfolioBacktestRequired: alphaPassed,
  conclusion
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 純個股融券流量 Alpha v1

- 範圍：上櫃普通股，不含 ETF 與疑似公司行動資料。
- 訓練：${TRAIN.join(' 至 ')}；驗證：${VALIDATION.join(' 至 ')}。
- 資料規則：T 日收盤後融資融券資料，只能於 T+1 使用。
- 通過最低訓練樣本門檻的組合數：${tested.length}。
- 訓練期選定規則：${selected ? JSON.stringify(selected.config) : '無'}。
- 驗證樣本：${validation.samples}；平均 ${validation.averageReturnPct}%；中位數 ${validation.medianReturnPct}%；PF ${validation.profitFactor}。
- 公平隨機平均：${random.averageReturnPct}%。
- 結論：${conclusion}
`, 'utf8');
await appendExperiment({
  ...experiment,
  metrics: { train: selected?.train || null, validation, fairRandom: random },
  resultStatus: alphaPassed ? 'passed' : 'failed',
  failureReason: alphaPassed ? null : conclusion,
  passedMinimum: false,
  passedHighProfit: false,
  allowRetest: false,
  notes: '僅完成前瞻報酬診斷；未通過時不進入完整投組回測。'
});
console.log(JSON.stringify({
  testedConfigurations: tested.length,
  observations: all.length,
  selected: selected?.config || null,
  train: selected?.train || null,
  validation,
  fairRandom: random,
  alphaPassed
}, null, 2));
