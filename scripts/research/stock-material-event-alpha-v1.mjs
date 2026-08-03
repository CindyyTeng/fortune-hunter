import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { buyExecution, sellExecution } from '../lib/execution-simulator.mjs';

const EVENTS = new URL('../../data/material-information/processed/history-liquid-universe.json.gz', import.meta.url);
const MARKET = new URL('../../data/market-history/processed/', import.meta.url);
const BENCHMARK = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-material-event-alpha-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_MATERIAL_EVENT_ALPHA_V1.md', import.meta.url);
const TRAIN = ['2021-01-01', '2023-12-31'];
const VALIDATION = ['2024-01-01', '2025-12-31'];
const COSTS = { buyFeePct: 0.1425, sellFeePct: 0.1425, sellTaxPct: 0.3, buySlippagePct: 0.1, sellSlippagePct: 0.1, minimumFee: 20 };
const CATEGORIES = [
  ['buyback', /買回.*股份|庫藏股/],
  ['earnings', /自結.*(?:損益|盈餘)|稅後.*淨利|每股盈餘|EPS/i],
  ['order_contract', /取得.*訂單|新訂單|簽訂.*合約|得標|承攬/],
  ['capacity_product', /量產|擴產|新廠|產能|新產品|產品通過.*認證/],
  ['dividend', /股利|配息|除息/],
  ['capital_cash_raise', /現金增資/],
  ['capital_convertible_bond', /可轉換公司債|轉換公司債/],
  ['capital_private_placement', /私募/],
  ['leadership', /董事長|總經理|重要人事/],
  ['negative_event', /重大損失|虧損|減損|災害|火災|停工|訴訟|裁罰|違約|詐騙|掏空/],
  ['investor_conference', /法人說明會/]
];
const round = (value, digits = 4) => Number(Number(value || 0).toFixed(digits));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function category(subject) {
  return CATEGORIES.find(([, pattern]) => pattern.test(subject || ''))?.[0] || 'other';
}

function netReturn(entry, exit) {
  const buy = buyExecution(entry, 1000, COSTS).total;
  const sell = sellExecution(exit, 1000, COSTS).net;
  return (sell / buy - 1) * 100;
}

async function histories() {
  const stocks = new Map();
  for (const year of [2021, 2022, 2023, 2024, 2025]) {
    const payload = JSON.parse(zlib.gunzipSync(await fs.readFile(new URL(`${year}.json.gz`, MARKET))));
    for (const [symbol, sourceRows] of Object.entries(payload.symbols || {})) {
      if (!/^\d{4}\.(TW|TWO)$/.test(symbol)) continue;
      const rows = sourceRows.filter(row => !row.corporateActionSuspected);
      stocks.set(symbol, (stocks.get(symbol) || []).concat(rows));
    }
  }
  for (const rows of stocks.values()) {
    rows.sort((a, b) => a.date.localeCompare(b.date));
    rows.dateIndex = new Map(rows.map((row, index) => [row.date, index]));
  }
  return stocks;
}

function deterministicIndex(value, size) {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return Math.abs(hash) % Math.max(1, size);
}

function observations(stocks, sourceEvents, benchmark) {
  const symbols = [...stocks.keys()].filter(symbol => !symbol.startsWith('00'));
  const seen = new Set();
  const result = [];
  for (const event of sourceEvents) {
    const eventCategory = category(event.subject);
    if (eventCategory === 'other') continue;
    const key = `${event.symbol}|${event.effectiveDate}|${eventCategory}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = stocks.get(event.symbol);
    if (!rows) continue;
    const entryIndex = rows.findIndex(row => row.date >= event.effectiveDate);
    if (entryIndex < 60 || entryIndex + 20 >= rows.length) continue;
    const entry = rows[entryIndex];
    const benchmarkIndex = benchmark?.dateIndex.get(entry.date);
    const randomStart = deterministicIndex(key, symbols.length);
    const randomEntries = [];
    for (let offset = 0; offset < symbols.length; offset += 1) {
      const candidate = stocks.get(symbols[(randomStart + offset) % symbols.length]);
      const candidateIndex = candidate?.dateIndex.get(entry.date);
      if (candidateIndex >= 60 && candidateIndex + 20 < candidate.length) {
        randomEntries.push({ rows: candidate, index: candidateIndex });
        if (randomEntries.length === 5) break;
      }
    }
    const returns = {};
    for (const days of [5, 10, 20]) {
      returns[days] = netReturn(entry.open, rows[entryIndex + days].close);
      returns[`random${days}`] = randomEntries.length
        ? mean(randomEntries.map(item => netReturn(item.rows[item.index].open, item.rows[item.index + days].close)))
        : null;
      returns[`benchmark${days}`] = benchmarkIndex !== undefined && benchmarkIndex + days < benchmark.length
        ? netReturn(benchmark[benchmarkIndex].open, benchmark[benchmarkIndex + days].close)
        : null;
    }
    result.push({ symbol: event.symbol, announcedDate: event.announcedDate, effectiveDate: entry.date, category: eventCategory, subject: event.subject, returns });
  }
  return result;
}

function stats(rows, days) {
  const values = rows.map(row => row.returns[days]).filter(Number.isFinite);
  const random = rows.map(row => row.returns[`random${days}`]).filter(Number.isFinite);
  const benchmark = rows.map(row => row.returns[`benchmark${days}`]).filter(Number.isFinite);
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
    randomAverageReturnPct: round(mean(random)),
    benchmarkAverageReturnPct: round(mean(benchmark)),
    alphaVsRandomPct: round(mean(values) - mean(random)),
    alphaVsBenchmarkPct: round(mean(values) - mean(benchmark)),
    top5PctProfitContributionPct: gains ? round(topGain / gains * 100) : null
  };
}

const stocks = await histories();
const payload = JSON.parse(zlib.gunzipSync(await fs.readFile(EVENTS)).toString('utf8'));
const benchmarkPayload = JSON.parse(await fs.readFile(BENCHMARK, 'utf8'));
const benchmark = benchmarkPayload.benchmark.filter(row => row.date >= '2021-01-01' && row.date <= '2025-12-31');
benchmark.dateIndex = new Map(benchmark.map((row, index) => [row.date, index]));
const rows = observations(stocks, payload.events || [], benchmark);
const results = [];
for (const [categoryId] of CATEGORIES) {
  for (const days of [5, 10, 20]) {
    const train = rows.filter(row => row.category === categoryId && row.effectiveDate >= TRAIN[0] && row.effectiveDate <= TRAIN[1]);
    const validation = rows.filter(row => row.category === categoryId && row.effectiveDate >= VALIDATION[0] && row.effectiveDate <= VALIDATION[1]);
    const trainStats = stats(train, days);
    const validationStats = stats(validation, days);
    results.push({
      category: categoryId,
      holdDays: days,
      train: trainStats,
      validation: validationStats,
      validationAlphaCandidate: trainStats.samples >= 100
        && validationStats.samples >= 100
        && trainStats.medianReturnPct > 0
        && validationStats.medianReturnPct > 0
        && trainStats.profitFactor > 1.1
        && validationStats.profitFactor > 1.1
        && trainStats.alphaVsRandomPct > 0
        && trainStats.alphaVsBenchmarkPct > 0
        && validationStats.alphaVsRandomPct > 0
        && validationStats.alphaVsBenchmarkPct > 0
    });
  }
}
results.sort((a, b) => b.validation.alphaVsBenchmarkPct - a.validation.alphaVsBenchmarkPct);
const candidates = results.filter(result => result.validationAlphaCandidate);
const report = {
  generatedAt: new Date().toISOString(),
  dataPeriod: ['2021-01-01', '2025-12-31'],
  trainPeriod: TRAIN,
  validationPeriod: VALIDATION,
  universe: payload.universeType,
  survivorshipBiasWarning: true,
  observations: rows.length,
  transactionCostsIncluded: true,
  methodology: '公告後下一個交易日開盤進場；固定持有；同日同市場隨機個股與 0050 比較',
  candidates,
  results,
  conclusion: candidates.length
    ? `找到 ${candidates.length} 個事件前瞻報酬候選，仍須完整投組 walk-forward 才能判斷是否可交易。`
    : '沒有事件類別同時通過樣本、中位數、Profit Factor、隨機與 0050 比較。'
};
await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const best = candidates[0] || results[0];
await fs.writeFile(REPORT, `# 重大訊息事件 Alpha 初篩\n\n- 資料：2021–2025，${rows.length} 個事件觀察；訓練 2021–2023、驗證 2024–2025。\n- 股票池：${payload.universeType}，存在倖存者偏差。\n- 成本：已計手續費、交易稅與雙邊滑價。\n- 最佳組合：${best.category}，持有 ${best.holdDays} 日，驗證 ${best.validation.samples} 筆，平均 ${best.validation.averageReturnPct}%，中位數 ${best.validation.medianReturnPct}%，PF ${best.validation.profitFactor}。\n- 相對結果：對隨機 ${best.validation.alphaVsRandomPct} 個百分點，對 0050 ${best.validation.alphaVsBenchmarkPct} 個百分點。\n- 結論：${report.conclusion}\n\n此報告只是事件 alpha 初篩，不是完整投組績效，不可直接 paper trading 或實盤。\n`, 'utf8');
console.log(`重大訊息 Alpha 初篩：${rows.length} 個觀察、${candidates.length} 個候選；最佳 ${best.category}/${best.holdDays} 日，驗證平均 ${best.validation.averageReturnPct}%。`);
