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
const MARKET = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const CACHE = new URL('../../.cache/buyback/', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-buyback-alpha-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_BUYBACK_ALPHA_V1.md', import.meta.url);
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

function text(value) {
  return String(value)
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function number(value) {
  const parsed = Number(String(value).replaceAll(',', '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function rocDate(value) {
  const [year, month, day] = String(value).split('/').map(Number);
  if (!year || !month || !day) return '';
  return `${year + 1911}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseRows(html, market) {
  const result = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(match => text(match[1]));
    if (cells.length !== 20 || !/^\d{4}$/.test(cells[1])) continue;
    result.push({
      symbol: `${cells[1]}${market === 'sii' ? '.TW' : '.TWO'}`,
      name: cells[2],
      decisionDate: rocDate(cells[3]),
      purpose: number(cells[4]),
      plannedShares: number(cells[6]),
      priceLow: number(cells[7]),
      priceHigh: number(cells[8]),
      plannedStart: rocDate(cells[9]),
      plannedEnd: rocDate(cells[10]),
      // 下列欄位只做事後品質稽核，不得當成進場條件。
      completed: cells[11] === 'Y',
      actualShares: number(cells[13]),
      executionRatePct: number(cells[15])
    });
  }
  return result;
}

async function fetchMarket(market) {
  const file = new URL(`${market}-2022-2025.html`, CACHE);
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    // 首次下載後即快取，避免重複請求官方服務。
  }
  const body = new URLSearchParams({
    step: '1',
    firstin: '1',
    off: '1',
    TYPEK: market,
    d1: '1110101',
    d2: '1141231',
    RD: '1'
  });
  const response = await fetch('https://mopsov.twse.com.tw/mops/web/ajax_t35sc09', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'fortune-hunter-research/1.0',
      referer: 'https://mopsov.twse.com.tw/mops/web/t35sc09'
    },
    body
  });
  if (!response.ok) throw new Error(`MOPS ${market} HTTP ${response.status}`);
  const html = await response.text();
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(file, html, 'utf8');
  return html;
}

async function histories() {
  const stocks = new Map();
  for (const year of ['2022', '2023', '2024', '2025']) {
    const payload = JSON.parse(zlib.gunzipSync(await fs.readFile(new URL(`${year}.json.gz`, PROCESSED))));
    for (const [symbol, sourceRows] of Object.entries(payload.symbols || {})) {
      const commonStock = /^\d{4}\.(TW|TWO)$/.test(symbol) && !symbol.startsWith('00');
      if (!commonStock) continue;
      const rows = sourceRows.filter(row => !row.corporateActionSuspected);
      stocks.set(symbol, (stocks.get(symbol) || []).concat(rows));
    }
  }
  for (const rows of stocks.values()) rows.sort((a, b) => a.date.localeCompare(b.date));
  return stocks;
}

function netReturn(entry, exit) {
  const buy = buyExecution(entry, 1000, COSTS).total;
  const sell = sellExecution(exit, 1000, COSTS).net;
  return (sell / buy - 1) * 100;
}

function observations(stocks, events) {
  const result = [];
  for (const event of events) {
    const rows = stocks.get(event.symbol);
    if (!rows) continue;
    const index = rows.findIndex(row => row.date >= event.decisionDate);
    if (index < 60 || index + 21 >= rows.length) continue;
    const decisionDay = rows[index];
    const entry = rows[index + 1];
    const averageVolume20 = mean(rows.slice(index - 19, index + 1).map(row => row.volume));
    const ma20 = mean(rows.slice(index - 19, index + 1).map(row => row.close));
    const ma60 = mean(rows.slice(index - 59, index + 1).map(row => row.close));
    const returns = {};
    for (const holdDays of [5, 10, 20]) {
      returns[holdDays] = netReturn(entry.open, rows[index + 1 + holdDays].close);
    }
    result.push({
      ...event,
      effectiveDate: entry.date,
      plannedVolumeDays: averageVolume20 ? event.plannedShares / averageVolume20 : 0,
      priceHighPremiumPct: event.priceHigh ? (event.priceHigh / decisionDay.close - 1) * 100 : 0,
      momentum20Pct: (decisionDay.close / rows[index - 20].close - 1) * 100,
      aboveMa20: decisionDay.close >= ma20,
      ma20AboveMa60: ma20 >= ma60,
      tradeValue20: mean(rows.slice(index - 19, index + 1).map(row => row.tradeValue)),
      returns
    });
  }
  return result;
}

function stats(rows, holdDays) {
  const values = rows.map(row => row.returns[holdDays]).filter(Number.isFinite);
  const sorted = [...values].sort((a, b) => a - b);
  const gains = values.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter(value => value <= 0).reduce((sum, value) => sum + value, 0));
  const topCount = Math.max(1, Math.ceil(values.length * 0.05));
  const topGain = [...values].sort((a, b) => b - a).slice(0, topCount).reduce((sum, value) => sum + value, 0);
  return {
    samples: values.length,
    averageReturnPct: round(mean(values)),
    medianReturnPct: round(sorted[Math.floor(sorted.length / 2)] || 0),
    winRatePct: round(values.filter(value => value > 0).length / Math.max(1, values.length) * 100),
    profitFactor: losses ? round(gains / losses) : null,
    top5PctProfitContributionPct: gains ? round(topGain / gains * 100) : null
  };
}

function configs() {
  return ['all', 1, 3].flatMap(purpose =>
    [0, 2, 5, 10].flatMap(minPlannedVolumeDays =>
      [-100, -10, 0, 5].flatMap(minMomentum20Pct =>
        [-100, 0, 10].flatMap(minPriceHighPremiumPct =>
          [10_000_000, 30_000_000, 50_000_000].flatMap(minTradeValue20 =>
            [false, true].flatMap(requireTrend =>
              [5, 10, 20].map(holdDays => ({
                purpose,
                minPlannedVolumeDays,
                minMomentum20Pct,
                minPriceHighPremiumPct,
                minTradeValue20,
                requireTrend,
                holdDays
              }))
            )
          )
        )
      )
    )
  );
}

function passes(row, config) {
  return (config.purpose === 'all' || row.purpose === config.purpose)
    && row.plannedVolumeDays >= config.minPlannedVolumeDays
    && row.momentum20Pct >= config.minMomentum20Pct
    && row.tradeValue20 >= config.minTradeValue20
    && row.priceHighPremiumPct >= config.minPriceHighPremiumPct
    && (!config.requireTrend || (row.aboveMa20 && row.ma20AboveMa60));
}

function fairRandom(stocks, selected, holdDays) {
  return selected.map((event, sequence) => {
    const candidates = [];
    for (const [symbol, rows] of stocks) {
      if (symbol.startsWith('00')) continue;
      const index = rows.findIndex(row => row.date >= event.decisionDate);
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

function benchmarkRows(rows, selected, holdDays) {
  return selected.map(event => {
    const index = rows.findIndex(row => row.date >= event.decisionDate);
    if (index < 0 || index + holdDays + 1 >= rows.length) return { returns: {} };
    return {
      returns: {
        [holdDays]: netReturn(rows[index + 1].open, rows[index + 1 + holdDays].close)
      }
    };
  });
}

const experiment = {
  strategyId: 'stock_buyback_alpha_v1',
  dataSources: ['official_mops_t35sc09_buyback', 'official_ohlcv'],
  setupRules: ['董事會決議買回庫藏股', '預定買回量相對近期成交量', '決議時價格趨勢'],
  triggerRules: ['董事會決議日後下一交易日開盤'],
  invalidationRules: ['不得使用日後才知道的實際買回股數或執行率'],
  exitRules: ['固定持有 5、10、20 個交易日進行因子驗證'],
  riskRules: { diagnosticOnly: true, minimumTradeValue20: 50_000_000 },
  blockedWhen: ['ETF', '未來資料', '成交值不足'],
  parameters: { configurations: configs() },
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

const [stocks, twseHtml, tpexHtml, marketHistory] = await Promise.all([
  histories(),
  fetchMarket('sii'),
  fetchMarket('otc'),
  fs.readFile(MARKET, 'utf8').then(JSON.parse)
]);
const events = [...parseRows(twseHtml, 'sii'), ...parseRows(tpexHtml, 'otc')];
const rows = observations(stocks, events);
for (const holdDays of [5, 10, 20]) {
  const randomRows = fairRandom(stocks, rows, holdDays);
  rows.forEach((row, index) => {
    row.randomReturns ||= {};
    row.randomReturns[holdDays] = randomRows[index].returns[holdDays];
  });
}
const trainRows = rows.filter(row => row.decisionDate >= TRAIN[0] && row.decisionDate <= TRAIN[1]);
const validationRows = rows.filter(row => row.decisionDate >= VALIDATION[0] && row.decisionDate <= VALIDATION[1]);
const gatingDiagnostics = {
  firstDecisionDate: rows.map(row => row.decisionDate).sort()[0] || null,
  lastDecisionDate: rows.map(row => row.decisionDate).sort().at(-1) || null,
  trainRows: trainRows.length,
  validationRows: validationRows.length,
  trainLiquidRows: trainRows.filter(row => row.tradeValue20 >= 50_000_000).length,
  trainWithVolumeDays: trainRows.filter(row => Number.isFinite(row.plannedVolumeDays)).length,
  trainWithPricePremium: trainRows.filter(row => Number.isFinite(row.priceHighPremiumPct)).length
};
const tested = configs().map(config => {
  const selectedRows = trainRows.filter(row => passes(row, config));
  const train = stats(selectedRows, config.holdDays);
  const trainRandom = stats(
    selectedRows.map(row => ({ returns: row.randomReturns })),
    config.holdDays
  );
  return {
    config,
    train,
    trainRandom,
    trainExcessPct: round(train.averageReturnPct - trainRandom.averageReturnPct)
  };
}).filter(row => row.train.samples >= 40)
  .sort((a, b) => b.trainExcessPct - a.trainExcessPct);
const selected = tested.find(row =>
  row.train.averageReturnPct > 0
  && row.train.medianReturnPct > 0
  && row.train.profitFactor > 1.15
  && row.trainExcessPct >= 0.5
) || tested[0];
const selectedRows = selected ? validationRows.filter(row => passes(row, selected.config)) : [];
const validation = selected ? stats(selectedRows, selected.config.holdDays) : stats([], 5);
const random = selected
  ? stats(selectedRows.map(row => ({ returns: row.randomReturns })), selected.config.holdDays)
  : stats([], 5);
const benchmark0050 = selected
  ? stats(benchmarkRows(marketHistory.benchmark || [], selectedRows, selected.config.holdDays), selected.config.holdDays)
  : stats([], 5);
const alphaPassed = validation.samples >= 100
  && validation.averageReturnPct > 0
  && validation.medianReturnPct > 0
  && validation.profitFactor > 1.15
  && validation.averageReturnPct >= random.averageReturnPct + 0.5
  && validation.averageReturnPct >= benchmark0050.averageReturnPct + 0.5
  && validation.medianReturnPct > random.medianReturnPct
  && validation.top5PctProfitContributionPct < 50;
const conclusion = alphaPassed
  ? '庫藏股事件通過初步樣本外 alpha 門檻，下一步需做完整投組與滾動驗證。'
  : '庫藏股事件未通過完整樣本外門檻，不接入正式選股。';
const output = {
  generatedAt: new Date().toISOString(),
  strategyId: experiment.strategyId,
  ...identity,
  universe: 'TWSE_TPEX_COMMON_STOCKS_ONLY',
  pointInTimeRule: '董事會決議資訊僅於下一交易日使用；實際執行率不參與選股。',
  trainPeriod: TRAIN,
  validationPeriod: VALIDATION,
  sourceEvents: events.length,
  observations: rows.length,
  gatingDiagnostics,
  testedConfigurations: tested.length,
  selected: selected || null,
  validation,
  fairRandom: random,
  benchmark0050,
  alphaPassed,
  fullPortfolioBacktestRequired: alphaPassed,
  conclusion
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 庫藏股事件 alpha v1

- 資料：公開資訊觀測站 t35sc09，上市與上櫃公司庫藏股案件。
- 防止偷看：只用董事會決議當時可知的預定資料；實際買回結果不作為進場條件。
- 範圍：普通股，不含 ETF；訓練 ${TRAIN.join(' 至 ')}，驗證 ${VALIDATION.join(' 至 ')}。
- 成本：手續費、交易稅、雙邊滑價與最低手續費均已納入。
- 案件：${events.length} 件，可配對價格資料 ${rows.length} 件。
- 驗證：${validation.samples} 筆，平均 ${validation.averageReturnPct}%，中位數 ${validation.medianReturnPct}%，PF ${validation.profitFactor}。
- 公平隨機：平均 ${random.averageReturnPct}%，0050 同期平均 ${benchmark0050.averageReturnPct}%。
- 結論：${conclusion}
`, 'utf8');
await appendExperiment({
  ...experiment,
  metrics: { train: selected?.train || null, validation, fairRandom: random, benchmark0050 },
  resultStatus: alphaPassed ? 'passed' : 'failed',
  failureReason: alphaPassed ? null : conclusion,
  passedMinimum: false,
  passedHighProfit: false,
  allowRetest: false,
  notes: '免費官方庫藏股事件因子；通過初步門檻仍不代表可實盤。'
});
console.log(JSON.stringify({
  sourceEvents: events.length,
  observations: rows.length,
  gatingDiagnostics,
  selected: selected?.config || null,
  train: selected?.train || null,
  validation,
  fairRandom: random,
  benchmark0050,
  alphaPassed,
  conclusion
}, null, 2));
