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
const CACHE = new URL('../../.cache/valuation/', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-value-momentum-alpha-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_VALUE_MOMENTUM_ALPHA_V1.md', import.meta.url);
const TRAIN = ['2016-03-01', '2021-12-31'];
const VALIDATION = ['2022-01-01', '2025-12-31'];
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
const number = value => {
  const parsed = Number(String(value ?? '').replaceAll(',', '').replaceAll('--', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  for (let year = 2016; year <= 2025; year += 1) {
    const payload = JSON.parse(zlib.gunzipSync(await fs.readFile(new URL(`${year}.json.gz`, PROCESSED))));
    for (const [symbol, rows] of Object.entries(payload.symbols || {})) {
      const id = symbol.replace(/\.(TW|TWO)$/, '');
      if (!/^\d{4}$/.test(id) || id.startsWith('00')) continue;
      result.set(symbol, (result.get(symbol) || []).concat(rows.filter(row => !row.corporateActionSuspected)));
    }
  }
  return result;
}

function monthEnds(priceRows) {
  const dates = new Set();
  for (const rows of priceRows.values()) {
    for (const row of rows) dates.add(row.date);
  }
  const result = new Map();
  for (const date of dates) {
    const month = date.slice(0, 7);
    if (!result.has(month) || result.get(month) < date) result.set(month, date);
  }
  return [...result.values()].filter(date => date >= TRAIN[0] && date <= VALIDATION[1]).sort();
}

function rocDate(date) {
  const [year, month, day] = date.split('-');
  return `${Number(year) - 1911}/${month}/${day}`;
}

async function fetchJson(url, cache) {
  try {
    return JSON.parse(await fs.readFile(cache, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(new URL('./', cache), { recursive: true });
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      let response = await fetch(url, {
        headers: { 'user-agent': 'fortune-hunter research/1.0' },
        redirect: 'manual'
      });
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) {
        response = await fetch(new URL(response.headers.get('location'), url), {
          headers: { 'user-agent': 'fortune-hunter research/1.0' }
        });
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      await fs.writeFile(cache, `${JSON.stringify(payload)}\n`, 'utf8');
      await wait(120);
      return payload;
    } catch (error) {
      lastError = error;
      await wait(400 * (attempt + 1));
    }
  }
  throw lastError;
}

async function valuationSnapshot(date, market) {
  const compact = date.replaceAll('-', '');
  const cache = new URL(`${market.toLowerCase()}/${date}.json`, CACHE);
  if (market === 'TWSE') {
    const payload = await fetchJson(
      `https://wwwc.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date=${compact}&selectType=ALL&response=json`,
      cache
    );
    return (payload.data || []).map(row => ({
      symbol: `${String(row[0]).trim()}.TW`,
      pe: number(row[5]),
      yieldPct: number(row[3]),
      pb: number(row[6])
    }));
  }
  const payload = await fetchJson(
    `https://www.tpex.org.tw/web/stock/aftertrading/peratio_analysis/pera_result.php?l=zh-tw&o=json&d=${rocDate(date)}&c=`,
    cache
  );
  return (payload.tables?.[0]?.data || []).map(row => ({
    symbol: `${String(row[0]).trim()}.TWO`,
    pe: number(row[2]),
    yieldPct: number(row[5]),
    pb: number(row[6])
  }));
}

async function valuations(dates) {
  const byDate = new Map();
  for (const date of dates) {
    const [twse, tpex] = await Promise.all([
      valuationSnapshot(date, 'TWSE'),
      valuationSnapshot(date, 'TPEX')
    ]);
    byDate.set(date, new Map([...twse, ...tpex].map(row => [row.symbol, row])));
  }
  return byDate;
}

const sortedValues = values => values.filter(Number.isFinite).sort((a, b) => a - b);

function percentile(valid, value, ascending = true) {
  if (!valid.length || !Number.isFinite(value)) return 0;
  let low = 0;
  let high = valid.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (valid[middle] <= value) low = middle + 1;
    else high = middle;
  }
  const rank = low / valid.length;
  return ascending ? 1 - rank : rank;
}

function observations(priceRows, valuationByDate) {
  const result = [];
  const indexedPrices = new Map([...priceRows].map(([symbol, rows]) => [
    symbol,
    { rows, indexes: new Map(rows.map((row, index) => [row.date, index])) }
  ]));
  for (const [date, snapshot] of valuationByDate) {
    const daily = [];
    for (const [symbol, valuation] of snapshot) {
      const history = indexedPrices.get(symbol);
      if (!history) continue;
      const { rows, indexes } = history;
      const index = indexes.get(date);
      if (index < 60 || index + 21 >= rows.length) continue;
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
      daily.push({
        date,
        entryDate: entry.date,
        symbol,
        market: symbol.endsWith('.TWO') ? 'TPEX' : 'TWSE',
        pe: valuation.pe,
        pb: valuation.pb,
        yieldPct: valuation.yieldPct,
        mom20Pct: (day.close / rows[index - 20].close - 1) * 100,
        mom60Pct: (day.close / rows[index - 60].close - 1) * 100,
        aboveMa20: day.close >= ma20,
        ma20AboveMa60: ma20 >= ma60,
        tradeValue20: mean(rows.slice(index - 19, index + 1).map(row => row.tradeValue)),
        atr20Pct: mean(rows.slice(index - 19, index + 1).map(row => (row.high - row.low) / row.close * 100)),
        returns
      });
    }
    const ranks = new Map();
    for (const market of ['TWSE', 'TPEX']) {
      const peers = daily.filter(row => row.market === market);
      ranks.set(market, {
        pe: sortedValues(peers.map(row => row.pe)),
        pb: sortedValues(peers.map(row => row.pb)),
        yieldPct: sortedValues(peers.map(row => row.yieldPct)),
        mom20Pct: sortedValues(peers.map(row => row.mom20Pct))
      });
    }
    for (const row of daily) {
      const peers = ranks.get(row.market);
      row.peValueRank = percentile(peers.pe, row.pe);
      row.pbValueRank = percentile(peers.pb, row.pb);
      row.yieldRank = percentile(peers.yieldPct, row.yieldPct, false);
      row.momentumRank = percentile(peers.mom20Pct, row.mom20Pct, false);
      result.push(row);
    }
  }
  return result;
}

function configurations() {
  return ['cheap_momentum', 'low_pb_momentum', 'yield_momentum', 'reasonable_pe_breakout'].flatMap(mode =>
    [0.6, 0.7, 0.8].flatMap(valueCutoff =>
      [0.6, 0.7, 0.8].flatMap(momentumCutoff =>
        [5, 10, 20].map(holdDays => ({ mode, valueCutoff, momentumCutoff, holdDays }))
      )
    )
  );
}

function basePasses(row) {
  return row.aboveMa20 && row.ma20AboveMa60
    && row.tradeValue20 >= 50_000_000
    && row.atr20Pct <= 8;
}

function passes(row, config) {
  if (!basePasses(row) || row.momentumRank < config.momentumCutoff) return false;
  if (config.mode === 'cheap_momentum') {
    return row.pe > 0 && row.peValueRank >= config.valueCutoff && row.pbValueRank >= 0.4;
  }
  if (config.mode === 'low_pb_momentum') {
    return row.pb > 0 && row.pbValueRank >= config.valueCutoff && row.pe > 0;
  }
  if (config.mode === 'yield_momentum') {
    return row.yieldPct > 0 && row.yieldRank >= config.valueCutoff && row.pe > 0;
  }
  return row.pe >= 8 && row.pe <= 30 && row.mom20Pct > 0 && row.mom60Pct > 0;
}

function randomMatch(pool, selected, holdDays) {
  const eligibleByDate = new Map();
  for (const row of pool) {
    if (!basePasses(row)) continue;
    if (!eligibleByDate.has(row.date)) eligibleByDate.set(row.date, []);
    eligibleByDate.get(row.date).push(row);
  }
  return selected.map((row, index) => {
    const sameDate = eligibleByDate.get(row.date) || [];
    return sameDate[(Number(row.symbol.slice(0, 4)) * 31 + index * 17) % Math.max(1, sameDate.length)] || row;
  }).map(row => ({ returns: { [holdDays]: row.returns[holdDays] } }));
}

const experiment = {
  strategyId: 'stock_value_momentum_alpha_v1',
  dataSources: ['official_twse_tpex_point_in_time_valuation', 'official_daily_ohlcv'],
  setupRules: ['低本益比、低股價淨值比或高殖利率', '價格與均線轉強', '流動性與波動排除'],
  triggerRules: ['月末資料於下一交易日開盤成交並計入滑價'],
  invalidationRules: ['ETF、低成交值、高 ATR 與公司行動排除'],
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

const priceRows = await histories();
const dates = monthEnds(priceRows);
const valuationByDate = await valuations(dates);
const all = observations(priceRows, valuationByDate);
const trainPool = all.filter(row => row.date >= TRAIN[0] && row.date <= TRAIN[1]);
const validationPool = all.filter(row => row.date >= VALIDATION[0] && row.date <= VALIDATION[1]);
const tested = configurations().map(config => {
  const rows = trainPool.filter(row => passes(row, config));
  return { config, train: stats(rows, config.holdDays) };
}).filter(row => row.train.samples >= 300)
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
const alphaPassed = validation.samples >= 300
  && validation.averageReturnPct > 0
  && validation.medianReturnPct > 0
  && validation.profitFactor > 1.15
  && validation.averageReturnPct > random.averageReturnPct
  && validation.top5ContributionPct < 50;
const conclusion = alphaPassed
  ? '估值與動能組合具有跨期正期望，可進入完整投組回測。'
  : '估值與動能組合未通過跨期正期望門檻，不建立可實盤策略。';
const output = {
  generatedAt: new Date().toISOString(),
  strategyId: experiment.strategyId,
  ...identity,
  universe: 'TWSE_TPEX_COMMON_STOCKS_ONLY',
  pointInTimeRule: '官方資料不回溯重算；月末資料只能於下一交易日使用',
  trainPeriod: TRAIN,
  validationPeriod: VALIDATION,
  valuationDates: valuationByDate.size,
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
await fs.writeFile(REPORT, `# 純個股估值動能 Alpha v1

- 範圍：上市、上櫃普通股，不含 ETF 與疑似公司行動資料。
- 訓練：${TRAIN.join(' 至 ')}；驗證：${VALIDATION.join(' 至 ')}。
- 估值日期：${valuationByDate.size} 個月末；觀察值：${all.length}。
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
  valuationDates: valuationByDate.size,
  observations: all.length,
  testedConfigurations: tested.length,
  selected: selected?.config || null,
  train: selected?.train || null,
  validation,
  fairRandom: random,
  alphaPassed
}, null, 2));
