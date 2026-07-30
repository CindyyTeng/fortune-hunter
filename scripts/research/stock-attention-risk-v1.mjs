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
const CACHE = new URL('../../.cache/attention/', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-attention-risk-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_ATTENTION_RISK_V1.md', import.meta.url);
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
    profitFactor: losses ? round(gains / losses) : null
  };
}

async function histories() {
  const stocks = new Map();
  for (const year of ['2022', '2023', '2024', '2025']) {
    const payload = JSON.parse(zlib.gunzipSync(await fs.readFile(new URL(`${year}.json.gz`, PROCESSED))));
    for (const [symbol, rows] of Object.entries(payload.symbols || {})) {
      if (!/^\d{4}\.(TW|TWO)$/.test(symbol) || symbol.startsWith('00')) continue;
      stocks.set(symbol, (stocks.get(symbol) || []).concat(
        rows.filter(row => !row.corporateActionSuspected)
      ));
    }
  }
  return stocks;
}

async function fetchJson(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'fortune-hunter-research/1.0' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === 2) throw error;
      await sleep(800 * (attempt + 1));
    }
  }
  return null;
}

function monthRanges() {
  const result = [];
  for (let year = 2022; year <= 2025; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      const start = `${year}-${String(month).padStart(2, '0')}-01`;
      const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
      result.push({ start, end });
    }
  }
  return result;
}

function rocToIso(value) {
  const parts = String(value).trim().split(/[./]/).map(Number);
  if (parts.length !== 3) return '';
  return `${parts[0] + 1911}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}`;
}

function reasonCategory(value) {
  const reason = String(value);
  if (reason.includes('當日沖銷')) return 'day_trading';
  if (reason.includes('借券') || reason.includes('券資比')) return 'short_flow';
  if (reason.includes('集中度')) return 'concentration';
  if (reason.includes('週轉率')) return 'turnover';
  if (reason.includes('成交量')) return 'volume';
  if (reason.includes('漲幅') || reason.includes('收盤價')) return 'price_momentum';
  return 'other';
}

async function attentionEvents() {
  const events = [];
  const failures = [];
  for (const { start, end } of monthRanges()) {
    for (const market of ['TWSE', 'TPEX']) {
      const directory = new URL(`${market}/`, CACHE);
      const file = new URL(`${start.slice(0, 7)}.json`, directory);
      let payload;
      try {
        payload = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {
        const url = market === 'TWSE'
          ? `https://wwwc.twse.com.tw/announcement/notice?response=json&querytype=1&startDate=${start.replaceAll('-', '')}&endDate=${end.replaceAll('-', '')}`
          : `https://www.tpex.org.tw/www/zh-tw/bulletin/attention?startDate=${start.replaceAll('-', '/')}&endDate=${end.replaceAll('-', '/')}&type=all&order=date&response=json`;
        try {
          payload = await fetchJson(url);
          await fs.mkdir(directory, { recursive: true });
          await fs.writeFile(file, `${JSON.stringify(payload)}\n`, 'utf8');
        } catch (error) {
          failures.push({ market, start, error: error.message });
          continue;
        }
        await sleep(250);
      }
      const rows = market === 'TWSE' ? payload?.data || [] : payload?.tables?.[0]?.data || [];
      for (const row of rows) {
        const symbol = String(row[1]).trim();
        const date = rocToIso(row[5]);
        if (/^\d{4}$/.test(symbol) && date) {
          events.push({
            date,
            symbol: `${symbol}${market === 'TWSE' ? '.TW' : '.TWO'}`,
            count: Number(row[3]) || 0,
            category: reasonCategory(row[4])
          });
        }
      }
    }
  }
  return { events, failures };
}

function observations(stocks, events) {
  const result = [];
  for (const event of events) {
    const rows = stocks.get(event.symbol);
    if (!rows) continue;
    const index = rows.findIndex(row => row.date === event.date);
    if (index < 60 || index + 22 >= rows.length) continue;
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
      ...event,
      mom20Pct: (day.close / rows[index - 20].close - 1) * 100,
      aboveMa20: day.close >= ma20,
      ma20AboveMa60: ma20 >= ma60,
      tradeValue20: mean(rows.slice(index - 19, index + 1).map(row => row.tradeValue)),
      atr20Pct: mean(rows.slice(index - 19, index + 1).map(row => (row.high - row.low) / row.close * 100)),
      returns
    });
  }
  return result;
}

function configurations() {
  return ['all', 'day_trading', 'short_flow', 'concentration', 'turnover', 'volume', 'price_momentum']
    .flatMap(category => [0, 5, 10].flatMap(minimumMomentum =>
      [1, 3, 5].flatMap(minimumCount =>
        [5, 10, 20].map(holdDays => ({ category, minimumMomentum, minimumCount, holdDays }))
      )
    )
  );
}

function passes(row, config) {
  return row.aboveMa20 && row.ma20AboveMa60 && row.mom20Pct >= config.minimumMomentum
    && row.count >= config.minimumCount && row.tradeValue20 >= 50_000_000 && row.atr20Pct <= 8
    && (config.category === 'all' || row.category === config.category);
}

function fairRandom(stocks, selected, holdDays) {
  return selected.map((event, sequence) => {
    const candidates = [];
    for (const [symbol, rows] of stocks) {
      const index = rows.findIndex(row => row.date === event.date);
      if (index < 60 || index + 22 >= rows.length) continue;
      const day = rows[index];
      const ma20 = mean(rows.slice(index - 19, index + 1).map(row => row.close));
      const ma60 = mean(rows.slice(index - 59, index + 1).map(row => row.close));
      const tradeValue = mean(rows.slice(index - 19, index + 1).map(row => row.tradeValue));
      if (day.close >= ma20 && ma20 >= ma60 && tradeValue >= 50_000_000) candidates.push({ symbol, rows, index });
    }
    const picked = candidates[(Number(event.symbol.slice(0, 4)) * 31 + sequence * 17) % Math.max(1, candidates.length)];
    if (!picked) return event;
    const entry = picked.rows[picked.index + 1];
    const exit = picked.rows[picked.index + 1 + holdDays];
    const buy = buyExecution(entry.open, 1000, COSTS).total;
    const sell = sellExecution(exit.close, 1000, COSTS).net;
    return { returns: { [holdDays]: (sell / buy - 1) * 100 } };
  });
}

const experiment = {
  strategyId: 'stock_attention_risk_v1',
  dataSources: ['official_twse_attention_history', 'official_tpex_attention_history', 'official_ohlcv'],
  setupRules: ['注意股公告事件', '注意原因分類', '累計注意次數', '中期趨勢'],
  triggerRules: ['公告日收盤後資料於下一交易日開盤使用'],
  invalidationRules: ['高 ATR、低成交值、ETF 與疑似公司行動排除'],
  exitRules: ['固定持有 5、10、20 個交易日進行風險診斷'],
  riskRules: { diagnosticOnly: true },
  blockedWhen: ['ETF'],
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

const stocks = await histories();
const attention = await attentionEvents();
const all = observations(stocks, attention.events);
const trainPool = all.filter(row => row.date >= TRAIN[0] && row.date <= TRAIN[1]);
const validationPool = all.filter(row => row.date >= VALIDATION[0] && row.date <= VALIDATION[1]);
const tested = configurations().map(config => {
  const rows = trainPool.filter(row => passes(row, config));
  return { config, train: stats(rows, config.holdDays) };
}).filter(row => row.train.samples >= 100)
  .sort((a, b) => b.train.averageReturnPct - a.train.averageReturnPct);
const selected = tested.find(row =>
  row.train.averageReturnPct > 0 && row.train.medianReturnPct > 0 && row.train.profitFactor > 1.1
) || tested[0];
const selectedRows = selected ? validationPool.filter(row => passes(row, selected.config)) : [];
const validation = selected ? stats(selectedRows, selected.config.holdDays) : stats([], 5);
const random = selected ? stats(fairRandom(stocks, selectedRows, selected.config.holdDays), selected.config.holdDays) : stats([], 5);
const longAlphaPassed = validation.samples >= 100 && validation.averageReturnPct > 0
  && validation.medianReturnPct > 0 && validation.profitFactor > 1.15
  && validation.averageReturnPct > random.averageReturnPct;
const riskFilterUseful = validation.samples >= 100
  && validation.averageReturnPct + 0.5 < random.averageReturnPct;
const conclusion = longAlphaPassed
  ? '注意股事件具有跨期正期望，可進入完整投組回測。'
  : riskFilterUseful
    ? '注意股顯著落後同日趨勢股，值得進入既有策略排除測試。'
    : '注意股既不是正期望買點，也未證明排除後能顯著改善績效。';
const output = {
  generatedAt: new Date().toISOString(),
  strategyId: experiment.strategyId,
  ...identity,
  universe: 'TWSE_TPEX_COMMON_STOCKS_ONLY',
  pointInTimeRule: '公告日收盤後資料只能於下一交易日使用',
  trainPeriod: TRAIN,
  validationPeriod: VALIDATION,
  sourceEvents: attention.events.length,
  downloadFailures: attention.failures,
  observations: all.length,
  testedConfigurations: tested.length,
  selected: selected || null,
  validation,
  fairRandom: random,
  longAlphaPassed,
  riskFilterUseful,
  fullPortfolioBacktestRequired: longAlphaPassed || riskFilterUseful,
  conclusion
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 純個股注意股風險 v1

- 範圍：上市與上櫃普通股，不含 ETF 與疑似公司行動資料。
- 訓練：${TRAIN.join(' 至 ')}；驗證：${VALIDATION.join(' 至 ')}。
- 事件數：${attention.events.length}；有效觀察：${all.length}。
- 驗證樣本：${validation.samples}；平均 ${validation.averageReturnPct}%；中位數 ${validation.medianReturnPct}%；PF ${validation.profitFactor}。
- 同日公平隨機平均：${random.averageReturnPct}%。
- 結論：${conclusion}
`, 'utf8');
await appendExperiment({
  ...experiment,
  metrics: { train: selected?.train || null, validation, fairRandom: random },
  resultStatus: longAlphaPassed || riskFilterUseful ? 'passed' : 'failed',
  failureReason: longAlphaPassed || riskFilterUseful ? null : conclusion,
  passedMinimum: false,
  passedHighProfit: false,
  allowRetest: false,
  notes: '若只通過風險排除，仍須接到完整現金受限投組驗證。'
});
console.log(JSON.stringify({
  sourceEvents: attention.events.length,
  failures: attention.failures.length,
  observations: all.length,
  selected: selected?.config || null,
  train: selected?.train || null,
  validation,
  fairRandom: random,
  longAlphaPassed,
  riskFilterUseful
}, null, 2));
