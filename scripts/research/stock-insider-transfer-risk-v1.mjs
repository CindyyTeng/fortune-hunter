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
const BACKTEST = new URL('../../data/tw-backtest-10y.json', import.meta.url);
const CACHE = new URL('../../.cache/insider-transfer/', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-insider-transfer-risk-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_INSIDER_TRANSFER_RISK_V1.md', import.meta.url);
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

function stripHtml(value) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function rocToIso(value) {
  const parts = String(value).trim().split(/[./]/).map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return '';
  return `${parts[0] + 1911}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}`;
}

function parseNumber(value) {
  const parsed = Number(String(value).replaceAll(',', '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseRows(html, market) {
  const rows = [];
  for (const rowMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(match => stripHtml(match[1]));
    if (cells.length !== 17 || !/^\d{4}$/.test(cells[1])) continue;
    const transferMethod = cells[5];
    const transferShares = parseNumber(cells[6] || cells[11]);
    const ownedShares = parseNumber(cells[9]);
    rows.push({
      date: rocToIso(cells[0]),
      symbol: `${cells[1]}${market === 'TWSE' ? '.TW' : '.TWO'}`,
      name: cells[2],
      identity: cells[3],
      transferMethod,
      transferShares,
      ownedShares,
      transferRatioPct: ownedShares ? transferShares / ownedShares * 100 : 0,
      isMarketSale: /一般交易|鉅額逐筆交易|盤後定價交易/.test(transferMethod)
    });
  }
  return rows;
}

async function fetchDaily(date, market) {
  const directory = new URL(`${market}/`, CACHE);
  const file = new URL(`${date}.json`, directory);
  try {
    return { rows: JSON.parse(await fs.readFile(file, 'utf8')), cached: true };
  } catch {
    // 官方日報表以申報日公開；只在下一個交易日後使用。
  }
  const rocYear = Number(date.slice(0, 4)) - 1911;
  const body = new URLSearchParams({
    step: '2',
    year: String(rocYear),
    month: date.slice(5, 7),
    day: date.slice(8, 10),
    report: market === 'TWSE' ? 'SY' : 'OY',
    firstin: 'true'
  });
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch('https://mopsov.twse.com.tw/mops/web/ajax_t56sb12', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'fortune-hunter-research/1.0',
          referer: `https://mopsov.twse.com.tw/mops/web/t56sb12_q${market === 'TWSE' ? '1' : '2'}`
        },
        body
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rows = parseRows(await response.text(), market);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(file, `${JSON.stringify(rows)}\n`, 'utf8');
      return { rows, cached: false };
    } catch (error) {
      lastError = error;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastError;
}

async function loadHistories() {
  const stocks = new Map();
  const dates = new Set();
  for (const year of ['2022', '2023', '2024', '2025']) {
    const payload = JSON.parse(zlib.gunzipSync(await fs.readFile(new URL(`${year}.json.gz`, PROCESSED))));
    for (const [symbol, sourceRows] of Object.entries(payload.symbols || {})) {
      if (!/^\d{4}\.(TW|TWO)$/.test(symbol) || symbol.startsWith('00')) continue;
      const rows = sourceRows.filter(row => !row.corporateActionSuspected);
      stocks.set(symbol, (stocks.get(symbol) || []).concat(rows));
      for (const row of rows) dates.add(row.date);
    }
  }
  for (const rows of stocks.values()) rows.sort((a, b) => a.date.localeCompare(b.date));
  return { stocks, dates: [...dates].sort() };
}

async function loadEvents(dates) {
  const events = [];
  const failures = [];
  let completed = 0;
  for (const date of dates) {
    for (const market of ['TWSE', 'TPEX']) {
      try {
        const fetched = await fetchDaily(date, market);
        events.push(...fetched.rows);
        if (!fetched.cached) await sleep(100);
      } catch (error) {
        failures.push({ date, market, error: error.message });
      }
      completed += 1;
      if (completed % 200 === 0) console.log(`已處理 ${completed}/${dates.length * 2} 個市場交易日`);
    }
  }
  return { events, failures };
}

function netReturn(entryPrice, exitPrice) {
  const buy = buyExecution(entryPrice, 1000, COSTS).total;
  const sell = sellExecution(exitPrice, 1000, COSTS).net;
  return (sell / buy - 1) * 100;
}

function eventObservations(stocks, events) {
  const result = [];
  for (const event of events.filter(row => row.isMarketSale && row.transferShares > 0)) {
    const rows = stocks.get(event.symbol);
    if (!rows) continue;
    const index = rows.findIndex(row => row.date === event.date);
    if (index < 60 || index + 21 >= rows.length) continue;
    const day = rows[index];
    const entry = rows[index + 1];
    const ma20 = mean(rows.slice(index - 19, index + 1).map(row => row.close));
    const ma60 = mean(rows.slice(index - 59, index + 1).map(row => row.close));
    const returns = {};
    for (const holdDays of [5, 10, 20]) {
      returns[holdDays] = netReturn(entry.open, rows[index + 1 + holdDays].close);
    }
    result.push({
      ...event,
      effectiveDate: entry.date,
      momentum20Pct: (day.close / rows[index - 20].close - 1) * 100,
      aboveMa20: day.close >= ma20,
      ma20AboveMa60: ma20 >= ma60,
      tradeValue20: mean(rows.slice(index - 19, index + 1).map(row => row.tradeValue)),
      returns
    });
  }
  return result;
}

function stats(rows, holdDays) {
  const values = rows.map(row => row.returns?.[holdDays]).filter(Number.isFinite);
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

function configurations() {
  return [0, 1, 3, 5, 10, 20].flatMap(minTransferRatioPct =>
    [5, 10, 20].flatMap(holdDays =>
      [false, true].flatMap(requireUptrend =>
        [-100, 0, 5].map(minMomentum20Pct => ({
          minTransferRatioPct,
          holdDays,
          requireUptrend,
          minMomentum20Pct
        }))
      )
    )
  );
}

function passes(row, config) {
  return row.transferRatioPct >= config.minTransferRatioPct
    && row.momentum20Pct >= config.minMomentum20Pct
    && row.tradeValue20 >= 50_000_000
    && (!config.requireUptrend || (row.aboveMa20 && row.ma20AboveMa60));
}

function fairRandom(stocks, selected, holdDays) {
  return selected.map((event, sequence) => {
    const candidates = [];
    for (const [symbol, rows] of stocks) {
      const index = rows.findIndex(row => row.date === event.date);
      if (index < 60 || index + holdDays + 1 >= rows.length) continue;
      const tradeValue20 = mean(rows.slice(index - 19, index + 1).map(row => row.tradeValue));
      if (tradeValue20 >= 50_000_000) candidates.push({ symbol, rows, index });
    }
    const picked = candidates[(Number(event.symbol.slice(0, 4)) * 31 + sequence * 17) % Math.max(1, candidates.length)];
    if (!picked) return { returns: {} };
    return {
      returns: {
        [holdDays]: netReturn(
          picked.rows[picked.index + 1].open,
          picked.rows[picked.index + 1 + holdDays].close
        )
      }
    };
  });
}

function candidateOverlay(backtest, events) {
  const eventDates = new Map();
  for (const event of events.filter(row => row.isMarketSale && row.transferRatioPct >= 1)) {
    const dates = eventDates.get(event.symbol) || [];
    dates.push(event.date);
    eventDates.set(event.symbol, dates);
  }
  const result = {};
  for (const lookbackDays of [5, 10, 20, 30]) {
    const flagged = [];
    const clean = [];
    for (const trade of backtest.candidateTrades || []) {
      if (trade.signalDate < VALIDATION[0] || trade.signalDate > VALIDATION[1]) continue;
      const exit = trade.forwardPrices?.[9];
      if (!exit) continue;
      const dates = eventDates.get(String(trade.symbol).includes('.') ? trade.symbol : `${trade.symbol}.TW`) || [];
      const signalTime = Date.parse(trade.signalDate);
      const hasRecentSale = dates.some(date => {
        const days = (signalTime - Date.parse(date)) / 86_400_000;
        return days >= 0 && days <= lookbackDays;
      });
      const row = { returns: { 10: netReturn(trade.entryPrice, exit.price) } };
      (hasRecentSale ? flagged : clean).push(row);
    }
    result[lookbackDays] = {
      flagged: stats(flagged, 10),
      clean: stats(clean, 10),
      improvementIfExcludedPct: round(stats(clean, 10).averageReturnPct - stats(flagged, 10).averageReturnPct)
    };
  }
  return result;
}

const experiment = {
  strategyId: 'stock_insider_transfer_risk_v1',
  dataSources: ['official_mops_insider_transfer_daily', 'official_ohlcv'],
  setupRules: ['內部人申報市場轉讓持股', '轉讓股數占持股比例', '個股流動性與趨勢'],
  triggerRules: ['申報日後下一交易日才可使用'],
  invalidationRules: ['贈與、信託與非市場轉讓不視為賣壓'],
  exitRules: ['固定持有 5、10、20 個交易日進行因子診斷'],
  riskRules: { diagnosticOnly: true, minimumTradeValue20: 50_000_000 },
  blockedWhen: ['ETF', '未來資料', '非市場轉讓'],
  parameters: { configurations: configurations() },
  trainPeriod: TRAIN,
  validationPeriod: VALIDATION,
  costModel: COSTS,
  executionModel: 'next_open_with_slippage'
};
const identity = buildExperimentIdentity(experiment);
const skip = shouldSkipExperiment(await loadRegistry(), identity, { ...experiment, coreRulesChanged: true });
if (skip.skip && !process.argv.includes('--force')) {
  console.log(`已跳過重複實驗：${skip.reason}`);
  process.exit(0);
}

const [{ stocks, dates }, backtest] = await Promise.all([
  loadHistories(),
  fs.readFile(BACKTEST, 'utf8').then(JSON.parse)
]);
const downloaded = await loadEvents(dates);
const observations = eventObservations(stocks, downloaded.events);
const trainRows = observations.filter(row => row.date >= TRAIN[0] && row.date <= TRAIN[1]);
const validationRows = observations.filter(row => row.date >= VALIDATION[0] && row.date <= VALIDATION[1]);
const tested = configurations().map(config => ({
  config,
  train: stats(trainRows.filter(row => passes(row, config)), config.holdDays)
})).filter(row => row.train.samples >= 60)
  .sort((a, b) => a.train.averageReturnPct - b.train.averageReturnPct);
const selected = tested.find(row =>
  row.train.averageReturnPct < 0
  && row.train.medianReturnPct < 0
  && (row.train.profitFactor || 99) < 0.9
) || tested[0];
const selectedRows = selected ? validationRows.filter(row => passes(row, selected.config)) : [];
const validation = selected ? stats(selectedRows, selected.config.holdDays) : stats([], 5);
const random = selected ? stats(fairRandom(stocks, selectedRows, selected.config.holdDays), selected.config.holdDays) : stats([], 5);
const overlay = candidateOverlay(backtest, downloaded.events);
const bestOverlay = Object.entries(overlay)
  .filter(([, value]) => value.flagged.samples >= 30)
  .sort((a, b) => b[1].improvementIfExcludedPct - a[1].improvementIfExcludedPct)[0] || null;
const riskFilterUseful = validation.samples >= 60
  && validation.averageReturnPct + 0.5 < random.averageReturnPct
  && validation.medianReturnPct < 0
  && (validation.profitFactor || 99) < 1;
const candidateOverlayUseful = Boolean(bestOverlay
  && bestOverlay[1].improvementIfExcludedPct >= 0.5
  && bestOverlay[1].flagged.profitFactor < 1);
const conclusion = riskFilterUseful || candidateOverlayUseful
  ? '內部人市場轉讓申報具負向風險訊號，可作候選股排除因子，但仍需完整投組回測。'
  : '內部人市場轉讓申報未在驗證期呈現足夠穩定的負向差異，不接入正式選股。';
const output = {
  generatedAt: new Date().toISOString(),
  strategyId: experiment.strategyId,
  ...identity,
  universe: 'TWSE_TPEX_COMMON_STOCKS_ONLY',
  pointInTimeRule: '申報日資料只在下一個交易日使用。',
  trainPeriod: TRAIN,
  validationPeriod: VALIDATION,
  tradingDatesQueried: dates.length,
  sourceEvents: downloaded.events.length,
  marketSaleEvents: downloaded.events.filter(row => row.isMarketSale).length,
  downloadFailures: downloaded.failures,
  observations: observations.length,
  testedConfigurations: tested.length,
  selected: selected || null,
  validation,
  fairRandom: random,
  candidateOverlay: overlay,
  riskFilterUseful,
  candidateOverlayUseful,
  fullPortfolioBacktestRequired: riskFilterUseful || candidateOverlayUseful,
  conclusion
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 內部人申報轉讓風險因子 v1

- 資料：公開資訊觀測站上市、上櫃內部人持股轉讓日報表。
- 時間點：申報日資料僅於下一交易日使用，未使用未來資料。
- 範圍：普通股，不含 ETF；訓練 ${TRAIN.join(' 至 ')}，驗證 ${VALIDATION.join(' 至 ')}。
- 成本：手續費、交易稅、雙邊滑價與整張最低手續費均已納入。
- 事件：${downloaded.events.length} 筆，其中市場賣出 ${output.marketSaleEvents} 筆。
- 驗證：${validation.samples} 筆，平均 ${validation.averageReturnPct}%，中位數 ${validation.medianReturnPct}%，PF ${validation.profitFactor}。
- 公平隨機：平均 ${random.averageReturnPct}%，PF ${random.profitFactor}。
- 結論：${conclusion}
`, 'utf8');
await appendExperiment({
  ...experiment,
  metrics: { train: selected?.train || null, validation, fairRandom: random, bestOverlay },
  resultStatus: riskFilterUseful || candidateOverlayUseful ? 'passed' : 'failed',
  failureReason: riskFilterUseful || candidateOverlayUseful ? null : conclusion,
  passedMinimum: false,
  passedHighProfit: false,
  allowRetest: false,
  notes: '此為免費官方事件型風險因子診斷，不是可直接下單策略。'
});
console.log(JSON.stringify({
  sourceEvents: output.sourceEvents,
  marketSaleEvents: output.marketSaleEvents,
  failures: downloaded.failures.length,
  observations: output.observations,
  selected: selected?.config || null,
  train: selected?.train || null,
  validation,
  fairRandom: random,
  bestOverlay,
  riskFilterUseful,
  candidateOverlayUseful,
  conclusion
}, null, 2));
