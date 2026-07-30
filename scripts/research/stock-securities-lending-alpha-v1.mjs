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
const CACHE = new URL('../../.cache/securities-lending/', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-securities-lending-alpha-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_SECURITIES_LENDING_ALPHA_V1.md', import.meta.url);
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
  const weeklyDates = [...dates].sort().filter((_, index) => index % 5 === 0);
  return { stocks, weeklyDates };
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
    const compact = date.replaceAll('-', '');
    const url = market === 'TWSE'
      ? `https://wwwc.twse.com.tw/rwd/zh/afterTrading/TWTASU?date=${compact}&response=json`
      : `https://www.tpex.org.tw/www/zh-tw/margin/sbl?date=${date.replaceAll('-', '/')}&response=json`;
    const payload = await fetchJson(url);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(payload)}\n`, 'utf8');
    return payload;
  }
}

function parseTwse(payload, date) {
  return (payload?.data || []).map(row => {
    const match = String(row[0]).trim().match(/^(\d{4})\s+/);
    return match ? {
      date,
      symbol: `${match[1]}.TW`,
      borrowedSellShares: number(row[3]),
      borrowedSellValue: number(row[4]),
      balanceChangePct: null
    } : null;
  }).filter(Boolean);
}

function parseTpex(payload, date) {
  return (payload?.tables?.[0]?.data || []).map(row => {
    const symbol = String(row[0]).trim();
    const previous = number(row[8]);
    const balance = number(row[12]);
    return /^\d{4}$/.test(symbol) ? {
      date,
      symbol: `${symbol}.TWO`,
      borrowedSellShares: number(row[9]) * 1000,
      borrowedSellValue: null,
      balanceChangePct: previous ? (balance / previous - 1) * 100 : 0
    } : null;
  }).filter(Boolean);
}

async function lendingRows(dates) {
  const result = [];
  const failures = [];
  for (let offset = 0; offset < dates.length; offset += 1) {
    const batch = dates.slice(offset, offset + 1);
    const payloads = await Promise.all(batch.flatMap(date => [
      cached('TWSE', date).then(payload => parseTwse(payload, date)).catch(error => {
        failures.push({ date, market: 'TWSE', error: error.message });
        return [];
      }),
      cached('TPEX', date).then(payload => parseTpex(payload, date)).catch(error => {
        failures.push({ date, market: 'TPEX', error: error.message });
        return [];
      })
    ]));
    result.push(...payloads.flat());
    if (offset % 25 === 0) console.log(`借券資料進度：${Math.min(offset + 1, dates.length)}/${dates.length}`);
    await sleep(300);
  }
  return { rows: result, failures };
}

function buildObservations(stocks, flows) {
  const byDate = new Map();
  for (const flow of flows) {
    if (!byDate.has(flow.date)) byDate.set(flow.date, []);
    byDate.get(flow.date).push(flow);
  }
  const result = [];
  for (const [date, dailyFlows] of byDate) {
    const dayRows = [];
    for (const flow of dailyFlows) {
      const rows = stocks.get(flow.symbol);
      if (!rows) continue;
      const index = rows.findIndex(row => row.date === date);
      if (index < 60 || index + 22 >= rows.length) continue;
      const day = rows[index];
      const entry = rows[index + 1];
      const ma20 = mean(rows.slice(index - 19, index + 1).map(row => row.close));
      const ma60 = mean(rows.slice(index - 59, index + 1).map(row => row.close));
      const tradeValue20 = mean(rows.slice(index - 19, index + 1).map(row => row.tradeValue));
      const pressure = flow.borrowedSellValue != null
        ? flow.borrowedSellValue / Math.max(1, day.tradeValue) * 100
        : flow.borrowedSellShares / Math.max(1, day.volume) * 100;
      const returns = {};
      for (const holdDays of [5, 10, 20]) {
        const exit = rows[index + 1 + holdDays];
        const buy = buyExecution(entry.open, 1000, COSTS).total;
        const sell = sellExecution(exit.close, 1000, COSTS).net;
        returns[holdDays] = (sell / buy - 1) * 100;
      }
      dayRows.push({
        ...flow,
        pressure,
        mom20Pct: (day.close / rows[index - 20].close - 1) * 100,
        aboveMa20: day.close >= ma20,
        ma20AboveMa60: ma20 >= ma60,
        tradeValue20,
        atr20Pct: mean(rows.slice(index - 19, index + 1).map(row => (row.high - row.low) / row.close * 100)),
        returns
      });
    }
    const sorted = dayRows.map(row => row.pressure).sort((a, b) => a - b);
    for (const row of dayRows) {
      let low = 0;
      let high = sorted.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (sorted[middle] <= row.pressure) low = middle + 1;
        else high = middle;
      }
      result.push({ ...row, pressureRank: low / Math.max(1, sorted.length) });
    }
  }
  return result;
}

function configurations() {
  return ['low_pressure_momentum', 'high_pressure_contrarian', 'covering_momentum'].flatMap(mode =>
    [0.1, 0.2, 0.3].flatMap(tail =>
      [0, 5, 10].flatMap(minimumMomentum =>
        [5, 10, 20].map(holdDays => ({ mode, tail, minimumMomentum, holdDays }))
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
  if (config.mode === 'low_pressure_momentum') return row.pressureRank <= config.tail;
  if (config.mode === 'high_pressure_contrarian') return row.pressureRank >= 1 - config.tail;
  return row.symbol.endsWith('.TWO') && row.balanceChangePct < 0 && row.pressureRank <= 0.5;
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
    return sameDate[(Number(row.symbol.slice(0, 4)) * 31 + index * 17) % Math.max(1, sameDate.length)] || row;
  }).map(row => ({ returns: { [holdDays]: row.returns[holdDays] } }));
}

const experiment = {
  strategyId: 'stock_securities_lending_alpha_v1',
  dataSources: ['official_twse_twtasu', 'official_tpex_sbl', 'official_ohlcv'],
  setupRules: ['借券賣出壓力橫斷面排名', '上櫃借券餘額下降', '中期動能與流動性'],
  triggerRules: ['T 日收盤資料於 T+1 開盤成交並計入滑價'],
  invalidationRules: ['高 ATR、低成交值、ETF 與疑似公司行動排除'],
  exitRules: ['固定持有 5、10、20 個交易日進行 Alpha 診斷'],
  riskRules: { diagnosticOnly: true, weeklySampling: true },
  blockedWhen: ['資料不是官方來源', 'ETF'],
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

const { stocks, weeklyDates } = await histories();
const lending = await lendingRows(weeklyDates);
const observations = buildObservations(stocks, lending.rows);
const trainPool = observations.filter(row => row.date >= TRAIN[0] && row.date <= TRAIN[1]);
const validationPool = observations.filter(row => row.date >= VALIDATION[0] && row.date <= VALIDATION[1]);
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
  ? stats(randomMatch(validationPool, selectedRows, selected.config.holdDays), selected.config.holdDays)
  : stats([], 5);
const alphaPassed = validation.samples >= 150
  && validation.averageReturnPct > 0
  && validation.medianReturnPct > 0
  && validation.profitFactor > 1.15
  && validation.averageReturnPct > fairRandom.averageReturnPct
  && validation.top5ContributionPct < 50;
const conclusion = alphaPassed
  ? '借券流量通過跨期正期望門檻，可進入完整投組回測。'
  : '借券流量未通過跨期正期望門檻，不建立可實盤策略。';
const output = {
  generatedAt: new Date().toISOString(),
  strategyId: experiment.strategyId,
  ...identity,
  universe: 'TWSE_TPEX_COMMON_STOCKS_ONLY',
  sampling: '每五個交易日取樣一次',
  pointInTimeRule: 'T 日收盤後借券資料只能於 T+1 使用',
  trainPeriod: TRAIN,
  validationPeriod: VALIDATION,
  sourceDates: weeklyDates.length,
  downloadFailures: lending.failures,
  observations: observations.length,
  testedConfigurations: tested.length,
  selected: selected || null,
  validation,
  fairRandom,
  alphaPassed,
  fullPortfolioBacktestRequired: alphaPassed,
  conclusion
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 純個股借券流量 Alpha v1

- 範圍：上市與上櫃普通股，不含 ETF 與疑似公司行動資料。
- 訓練：${TRAIN.join(' 至 ')}；驗證：${VALIDATION.join(' 至 ')}。
- 官方來源：TWSE TWTASU、TPEx 融券借券賣出餘額。
- 資料規則：T 日收盤後資料只能於 T+1 使用；每五個交易日取樣以降低官方端點負載。
- 候選觀察值：${observations.length}；通過訓練樣本門檻組合：${tested.length}。
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
  sourceDates: weeklyDates.length,
  observations: observations.length,
  testedConfigurations: tested.length,
  selected: selected?.config || null,
  train: selected?.train || null,
  validation,
  fairRandom,
  alphaPassed
}, null, 2));
