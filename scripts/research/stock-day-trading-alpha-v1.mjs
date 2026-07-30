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
const CACHE = new URL('../../.cache/day-trading/', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-day-trading-alpha-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_DAY_TRADING_ALPHA_V1.md', import.meta.url);
const TRAIN = ['2022-01-01', '2023-12-31'];
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  const stocks = new Map();
  const dates = new Set();
  for (const year of ['2022', '2023', '2024', '2025']) {
    const payload = JSON.parse(zlib.gunzipSync(await fs.readFile(new URL(`${year}.json.gz`, PROCESSED))));
    for (const [symbol, rows] of Object.entries(payload.symbols || {})) {
      if (!/^\d{4}\.(TW|TWO)$/.test(symbol) || symbol.startsWith('00')) continue;
      const clean = rows.filter(row => !row.corporateActionSuspected);
      stocks.set(symbol, (stocks.get(symbol) || []).concat(clean));
      for (const row of clean) dates.add(row.date);
    }
  }
  return { stocks, sampledDates: [...dates].sort().filter((_, index) => index % 5 === 0) };
}

async function fetchJson(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      let target = new URL(url);
      let response;
      for (let redirect = 0; redirect < 5; redirect += 1) {
        response = await fetch(target, {
          headers: { 'user-agent': 'fortune-hunter-research/1.0' },
          redirect: 'manual'
        });
        const location = response.headers.get('location');
        if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
        target = new URL(location, target);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} ${target}`);
      return await response.json();
    } catch (error) {
      if (attempt === 2) throw error;
      await sleep(1200 * (attempt + 1));
    }
  }
  return null;
}

async function cached(market, date) {
  const directory = new URL(`${market}/`, CACHE);
  const file = new URL(`${date}.json`, directory);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    const url = market === 'TWSE'
      ? `https://wwwc.twse.com.tw/exchangeReport/TWTB4U?date=${date.replaceAll('-', '')}&response=json&selectType=All`
      : `https://www.tpex.org.tw/www/zh-tw/intraday/stat?type=Daily&date=${date.replaceAll('-', '/')}&response=json`;
    const payload = await fetchJson(url);
    const returnedDate = String(payload?.date || '').replaceAll('/', '');
    if (returnedDate !== date.replaceAll('-', '')) {
      throw new Error(`回傳日期不符：要求 ${date}，收到 ${returnedDate || '空值'}`);
    }
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(payload)}\n`, 'utf8');
    return payload;
  }
}

function parse(payload, date, market) {
  const suffix = market === 'TWSE' ? '.TW' : '.TWO';
  return (payload?.tables?.[1]?.data || []).map(row => {
    const symbol = String(row[0]).trim();
    return /^\d{4}$/.test(symbol) ? {
      date,
      symbol: `${symbol}${suffix}`,
      dayTradeShares: number(row[3]),
      dayTradeBuyValue: number(row[4]),
      dayTradeSellValue: number(row[5])
    } : null;
  }).filter(Boolean);
}

async function flowRows(dates) {
  const rows = [];
  const failures = [];
  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    const payloads = await Promise.all(['TWSE', 'TPEX'].map(market =>
      cached(market, date)
        .then(payload => parse(payload, date, market))
        .catch(error => {
          failures.push({ date, market, error: error.message });
          return [];
        })
    ));
    rows.push(...payloads.flat());
    if (index % 25 === 0) console.log(`當沖資料進度：${index + 1}/${dates.length}`);
    await sleep(300);
  }
  return { rows, failures };
}

function observations(stocks, flows) {
  const result = [];
  const daily = new Map();
  for (const flow of flows) {
    if (!daily.has(flow.date)) daily.set(flow.date, []);
    daily.get(flow.date).push(flow);
  }
  for (const [date, dateFlows] of daily) {
    const dateRows = [];
    for (const flow of dateFlows) {
      const rows = stocks.get(flow.symbol);
      if (!rows) continue;
      const index = rows.findIndex(row => row.date === date);
      if (index < 60 || index + 24 >= rows.length) continue;
      const day = rows[index];
      const entry = rows[index + 3];
      const ma20 = mean(rows.slice(index - 19, index + 1).map(row => row.close));
      const ma60 = mean(rows.slice(index - 59, index + 1).map(row => row.close));
      const returns = {};
      for (const holdDays of [5, 10, 20]) {
        const exit = rows[index + 3 + holdDays];
        const buy = buyExecution(entry.open, 1000, COSTS).total;
        const sell = sellExecution(exit.close, 1000, COSTS).net;
        returns[holdDays] = (sell / buy - 1) * 100;
      }
      dateRows.push({
        ...flow,
        ratio: flow.dayTradeShares / Math.max(1, day.volume),
        imbalance: (flow.dayTradeBuyValue - flow.dayTradeSellValue)
          / Math.max(1, flow.dayTradeBuyValue + flow.dayTradeSellValue),
        mom20Pct: (day.close / rows[index - 20].close - 1) * 100,
        aboveMa20: day.close >= ma20,
        ma20AboveMa60: ma20 >= ma60,
        tradeValue20: mean(rows.slice(index - 19, index + 1).map(row => row.tradeValue)),
        atr20Pct: mean(rows.slice(index - 19, index + 1).map(row => (row.high - row.low) / row.close * 100)),
        returns
      });
    }
    const sorted = dateRows.map(row => row.ratio).sort((a, b) => a - b);
    for (const row of dateRows) {
      let low = 0;
      let high = sorted.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (sorted[middle] <= row.ratio) low = middle + 1;
        else high = middle;
      }
      result.push({ ...row, ratioRank: low / Math.max(1, sorted.length) });
    }
  }
  return result;
}

function configurations() {
  return ['low_churn_momentum', 'high_churn_momentum', 'moderate_churn_momentum', 'buy_imbalance_momentum']
    .flatMap(mode => [0.1, 0.2, 0.3].flatMap(tail =>
      [0, 5, 10].flatMap(minimumMomentum =>
        [5, 10, 20].map(holdDays => ({ mode, tail, minimumMomentum, holdDays }))
      )
    ));
}

function basePasses(row, minimumMomentum) {
  return row.aboveMa20 && row.ma20AboveMa60 && row.mom20Pct >= minimumMomentum
    && row.tradeValue20 >= 50_000_000 && row.atr20Pct <= 8;
}

function passes(row, config) {
  if (!basePasses(row, config.minimumMomentum)) return false;
  if (config.mode === 'low_churn_momentum') return row.ratioRank <= config.tail;
  if (config.mode === 'high_churn_momentum') return row.ratioRank >= 1 - config.tail;
  if (config.mode === 'moderate_churn_momentum') return row.ratioRank >= 0.4 && row.ratioRank <= 0.7;
  return row.ratioRank >= 1 - config.tail && row.imbalance > 0;
}

function randomRows(pool, selected, holdDays) {
  const byDate = new Map();
  for (const row of pool) {
    if (!basePasses(row, 0)) continue;
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }
  return selected.map((row, index) => {
    const choices = byDate.get(row.date) || [];
    return choices[(Number(row.symbol.slice(0, 4)) * 31 + index * 17) % Math.max(1, choices.length)] || row;
  }).map(row => ({ returns: { [holdDays]: row.returns[holdDays] } }));
}

const experiment = {
  strategyId: 'stock_day_trading_alpha_v1',
  dataSources: ['official_twse_twtb4u', 'official_tpex_intraday_stat', 'official_ohlcv'],
  setupRules: ['個股當沖占比排名', '當沖買賣金額差', '中期動能與流動性'],
  triggerRules: ['T 日資料保守延後至 T+3 開盤成交並計入滑價'],
  invalidationRules: ['高 ATR、低成交值、ETF 與疑似公司行動排除'],
  exitRules: ['固定持有 5、10、20 個交易日進行 Alpha 診斷'],
  riskRules: { diagnosticOnly: true, sampledEveryTradingDays: 5 },
  blockedWhen: ['官方回傳日期不符', 'ETF'],
  parameters: { configurations: configurations() },
  trainPeriod: TRAIN,
  validationPeriod: VALIDATION,
  costModel: COSTS,
  executionModel: 't_plus_3_next_open_with_slippage'
};
const identity = buildExperimentIdentity(experiment);
const skip = shouldSkipExperiment(await loadRegistry(), identity, { ...experiment, coreRulesChanged: true });
if (skip.skip && !process.argv.includes('--force')) {
  console.log(`策略實驗已存在，略過：${skip.reason}`);
  process.exit(0);
}

const { stocks, sampledDates } = await histories();
const flows = await flowRows(sampledDates);
const all = observations(stocks, flows.rows);
const trainPool = all.filter(row => row.date >= TRAIN[0] && row.date <= TRAIN[1]);
const validationPool = all.filter(row => row.date >= VALIDATION[0] && row.date <= VALIDATION[1]);
const tested = configurations().map(config => {
  const rows = trainPool.filter(row => passes(row, config));
  return { config, train: stats(rows, config.holdDays) };
}).filter(row => row.train.samples >= 150)
  .sort((a, b) => b.train.averageReturnPct - a.train.averageReturnPct);
const selected = tested.find(row =>
  row.train.averageReturnPct > 0 && row.train.medianReturnPct > 0 && row.train.profitFactor > 1.1
) || tested[0];
const selectedRows = selected ? validationPool.filter(row => passes(row, selected.config)) : [];
const validation = selected ? stats(selectedRows, selected.config.holdDays) : stats([], 5);
const fairRandom = selected
  ? stats(randomRows(validationPool, selectedRows, selected.config.holdDays), selected.config.holdDays)
  : stats([], 5);
const alphaPassed = validation.samples >= 150 && validation.averageReturnPct > 0
  && validation.medianReturnPct > 0 && validation.profitFactor > 1.15
  && validation.averageReturnPct > fairRandom.averageReturnPct
  && validation.top5ContributionPct < 50;
const conclusion = alphaPassed
  ? '個股當沖熱度通過跨期正期望門檻，可進入完整投組回測。'
  : '個股當沖熱度未通過跨期正期望門檻，不建立可實盤策略。';
const output = {
  generatedAt: new Date().toISOString(),
  strategyId: experiment.strategyId,
  ...identity,
  universe: 'TWSE_TPEX_COMMON_STOCKS_ONLY',
  pointInTimeRule: 'T 日當沖資料保守延後至 T+3 使用',
  trainPeriod: TRAIN,
  validationPeriod: VALIDATION,
  sourceDates: sampledDates.length,
  downloadFailures: flows.failures,
  observations: all.length,
  testedConfigurations: tested.length,
  selected: selected || null,
  validation,
  fairRandom,
  alphaPassed,
  fullPortfolioBacktestRequired: alphaPassed,
  conclusion
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 純個股當沖熱度 Alpha v1

- 範圍：上市與上櫃普通股，不含 ETF 與疑似公司行動資料。
- 訓練：${TRAIN.join(' 至 ')}；驗證：${VALIDATION.join(' 至 ')}。
- 時間點：考量櫃買資料可能更新至 T+2，統一保守延後至 T+3 開盤使用。
- 觀察值：${all.length}；訓練門檻組合：${tested.length}。
- 驗證樣本：${validation.samples}；平均 ${validation.averageReturnPct}%；中位數 ${validation.medianReturnPct}%；PF ${validation.profitFactor}。
- 公平隨機平均：${fairRandom.averageReturnPct}%。
- 結論：${conclusion}
`, 'utf8');
await appendExperiment({
  ...experiment,
  metrics: { train: selected?.train || null, validation, fairRandom },
  resultStatus: alphaPassed ? 'passed' : 'failed',
  failureReason: alphaPassed ? null : conclusion,
  passedMinimum: false,
  passedHighProfit: false,
  allowRetest: false,
  notes: '只完成前瞻報酬診斷；未通過時不進入完整投組回測。'
});
console.log(JSON.stringify({
  sourceDates: sampledDates.length,
  failures: flows.failures.length,
  observations: all.length,
  testedConfigurations: tested.length,
  selected: selected?.config || null,
  train: selected?.train || null,
  validation,
  fairRandom,
  alphaPassed
}, null, 2));
