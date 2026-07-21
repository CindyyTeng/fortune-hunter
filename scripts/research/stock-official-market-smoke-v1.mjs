import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const YEARS = ['2018', '2019', '2020', '2021'];
const OUTPUT = new URL('../../data/research/stock-official-market-smoke-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_OFFICIAL_MARKET_SMOKE_V1.md', import.meta.url);
const PROCESSED = new URL('../../data/market-history/processed/', import.meta.url);
const TRAIN = ['2018-01-01', '2019-12-31'];
const VALIDATION = ['2020-01-01', '2021-12-31'];
const COST_PCT = 0.585;

const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const monthKey = date => String(date).slice(0, 7);

async function readYear(year) {
  try {
    const buffer = await fs.readFile(new URL(`${year}.json.gz`, PROCESSED));
    return JSON.parse(zlib.gunzipSync(buffer));
  } catch {
    return { symbols: {} };
  }
}

async function loadHistories() {
  const bySymbol = new Map();
  const coverage = [];
  for (const year of YEARS) {
    const payload = await readYear(year);
    const tpexDates = new Set();
    const twseDates = new Set();
    for (const [symbol, rows] of Object.entries(payload.symbols || {})) {
      for (const row of rows) {
        if (row.market === 'TPEX') tpexDates.add(row.date);
        if (row.market === 'TWSE') twseDates.add(row.date);
        if (row.corporateActionSuspected) continue;
        if (!bySymbol.has(symbol)) bySymbol.set(symbol, []);
        bySymbol.get(symbol).push(row);
      }
    }
    coverage.push({ year, tpexDates: tpexDates.size, twseDates: twseDates.size });
  }
  for (const rows of bySymbol.values()) rows.sort((a, b) => a.date.localeCompare(b.date));
  return { bySymbol, coverage };
}

function buildSignals(bySymbol) {
  const signals = [];
  for (const [symbol, rows] of bySymbol) {
    if (rows.length < 120) continue;
    for (let i = 60; i < rows.length - 11; i += 1) {
      const row = rows[i];
      const next = rows[i + 1];
      const ma20 = average(rows.slice(i - 19, i + 1).map(item => item.close));
      const high20 = Math.max(...rows.slice(i - 20, i).map(item => item.high));
      const value20 = average(rows.slice(i - 19, i + 1).map(item => item.tradeValue));
      const atr20 = average(rows.slice(i - 19, i + 1).map(item => (item.high - item.low) / item.close * 100));
      signals.push({
        symbol,
        name: row.name,
        market: row.market,
        signalDate: row.date,
        entryDate: next.date,
        momentum20Pct: (row.close / rows[i - 20].close - 1) * 100,
        momentum60Pct: (row.close / rows[i - 60].close - 1) * 100,
        volumeRatio20: row.tradeValue / Math.max(1, value20),
        atr20Pct: atr20,
        breakout20: row.close > high20,
        distanceToMa20Pct: (row.close / ma20 - 1) * 100,
        gapPct: (next.open / row.close - 1) * 100,
        tradeValue: row.tradeValue,
        exit5Date: rows[i + 6].date,
        exit10Date: rows[i + 11].date,
        ret5: (rows[i + 6].open / next.open - 1) * 100 - COST_PCT,
        ret10: (rows[i + 11].open / next.open - 1) * 100 - COST_PCT
      });
    }
  }
  return signals;
}

function configs() {
  const base = [
    { id: 'all_strength_top5_hold5', top: 5, hold: 5, minValue: 10_000_000, minMomentum20: 5, minMomentum60: 10, maxAtr20: 8, minVolumeRatio: 1, maxGap: 8, maxDistanceToMa20: 20, breakoutOnly: false, exposure: 1.2 },
    { id: 'all_breakout_top5_hold5', top: 5, hold: 5, minValue: 10_000_000, minMomentum20: 5, minMomentum60: 10, maxAtr20: 8, minVolumeRatio: 1.2, maxGap: 8, maxDistanceToMa20: 15, breakoutOnly: true, exposure: 1.2 },
    { id: 'all_strength_top10_hold10', top: 10, hold: 10, minValue: 10_000_000, minMomentum20: 0, minMomentum60: 10, maxAtr20: 10, minVolumeRatio: 0.8, maxGap: 10, maxDistanceToMa20: 25, breakoutOnly: false, exposure: 1.0 },
    { id: 'all_liquid_breakout_top3_hold5', top: 3, hold: 5, minValue: 30_000_000, minMomentum20: 10, minMomentum60: 20, maxAtr20: 8, minVolumeRatio: 1, maxGap: 5, maxDistanceToMa20: 12, breakoutOnly: true, exposure: 1.4 },
    { id: 'all_low_atr_strength_top5_hold10', top: 5, hold: 10, minValue: 10_000_000, minMomentum20: 5, minMomentum60: 15, maxAtr20: 6, minVolumeRatio: 0.8, maxGap: 6, maxDistanceToMa20: 15, breakoutOnly: false, exposure: 1.3 }
  ];
  return base.flatMap(config => [1, 1.25, 1.5].map(scale => ({
    ...config,
    id: `${config.id}_x${scale}`,
    exposure: round(config.exposure * scale, 3)
  })));
}

function passes(signal, config) {
  return signal.tradeValue >= config.minValue
    && signal.momentum20Pct >= config.minMomentum20
    && signal.momentum60Pct >= config.minMomentum60
    && signal.atr20Pct <= config.maxAtr20
    && signal.volumeRatio20 >= config.minVolumeRatio
    && signal.gapPct <= config.maxGap
    && signal.distanceToMa20Pct <= config.maxDistanceToMa20
    && (!config.breakoutOnly || signal.breakout20);
}

function score(signal) {
  return signal.momentum20Pct + signal.momentum60Pct * 0.5 + signal.volumeRatio20 * 3 - signal.atr20Pct;
}

function evaluate(signals, config, [start, end]) {
  const byDate = new Map();
  const tradableSignals = signals.filter(signal => signal.entryDate >= start && signal.entryDate <= end);
  for (const signal of tradableSignals) {
    if (!passes(signal, config)) continue;
    if (!byDate.has(signal.entryDate)) byDate.set(signal.entryDate, []);
    byDate.get(signal.entryDate).push(signal);
  }
  const dates = [...new Set([
    ...tradableSignals.map(signal => signal.entryDate),
    ...signals.map(signal => config.hold === 5 ? signal.exit5Date : signal.exit10Date).filter(date => date >= start && date <= end)
  ])].sort();
  const monthlyMap = new Map();
  const open = [];
  let trades = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const date of dates) {
    for (let index = open.length - 1; index >= 0; index -= 1) {
      if (open[index].exitDate > date) continue;
      const position = open.splice(index, 1)[0];
      monthlyMap.set(monthKey(position.exitDate), (monthlyMap.get(monthKey(position.exitDate)) || 0) + position.accountReturn);
      trades += 1;
      if (position.accountReturn > 0) {
        wins += 1;
        grossProfit += position.accountReturn;
      } else {
        grossLoss += Math.abs(position.accountReturn);
      }
    }
    if (open.length >= config.top) continue;
    const picks = (byDate.get(date) || []).sort((a, b) => score(b) - score(a)).slice(0, config.top);
    for (const pick of picks) {
      if (open.length >= config.top) break;
      const rawReturn = config.hold === 5 ? pick.ret5 : pick.ret10;
      open.push({
        exitDate: config.hold === 5 ? pick.exit5Date : pick.exit10Date,
        accountReturn: rawReturn * config.exposure / config.top
      });
    }
  }
  const monthly = [...monthlyMap].sort().map(([month, returnPct]) => ({ month, returnPct: round(returnPct) }));
  let equity = 100;
  let peak = 100;
  let maximumDrawdownPct = 0;
  for (const row of monthly) {
    equity *= 1 + row.returnPct / 100;
    peak = Math.max(peak, equity);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, (equity / peak - 1) * 100);
  }
  return {
    trades,
    months: monthly.length,
    averageMonthlyReturnPct: round(average(monthly.map(row => row.returnPct))),
    annualizedReturnPct: round((monthly.reduce((value, row) => value * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, monthly.length)) - 1) * 100),
    maximumDrawdownPct: round(maximumDrawdownPct),
    profitFactor: round(grossLoss ? grossProfit / grossLoss : 0),
    winRatePct: round(trades ? wins / trades * 100 : 0),
    negativeMonths: monthly.filter(row => row.returnPct < 0).length
  };
}

const { bySymbol, coverage } = await loadHistories();
const signals = buildSignals(bySymbol);
const results = configs().map(config => ({
  config,
  train: evaluate(signals, config, TRAIN),
  validation: evaluate(signals, config, VALIDATION)
}));

const practicalScore = result => {
  if (result.train.trades < 250 || result.validation.trades < 250) return -Infinity;
  if (result.train.maximumDrawdownPct < -30 || result.validation.maximumDrawdownPct < -30) return -Infinity;
  return result.validation.averageMonthlyReturnPct * 3
    + result.validation.profitFactor
    + result.validation.maximumDrawdownPct / 20
    + Math.min(result.validation.trades, 500) / 500;
};
const bestByMonthly = [...results].sort((a, b) => b.validation.averageMonthlyReturnPct - a.validation.averageMonthlyReturnPct)[0];
const best = [...results].sort((a, b) => practicalScore(b) - practicalScore(a))[0] || bestByMonthly;
const passed = best.validation.averageMonthlyReturnPct >= 5
  && best.validation.trades >= 300
  && best.validation.maximumDrawdownPct >= -20
  && best.train.maximumDrawdownPct >= -20
  && best.validation.profitFactor > 1.15;

const output = {
  generatedAt: new Date().toISOString(),
  strategyId: 'stock_official_market_smoke_v1',
  universe: 'TWSE_TPEX_OFFICIAL_MARKET_HISTORY_2018_2021',
  dataWarning: '目前官方個股 OHLCV 已補齊 2018-2021 的上市與上櫃主要交易日；仍不是 10 年完整 walk-forward，不可直接實盤。',
  periods: { train: TRAIN, validation: VALIDATION },
  coverage,
  symbols: bySymbol.size,
  signals: signals.length,
  testedConfigurations: results.length,
  bestByMonthly,
  best,
  targetMonthlyReturnPct: 5,
  targetGapPct: round(5 - best.validation.averageMonthlyReturnPct),
  passed,
  paperTradingReady: false,
  liveTradingReady: false,
  conclusion: passed
    ? 'Smoke test 達標，但仍需補齊更長年份並重新做完整 walk-forward，暫不可實盤。'
    : 'Smoke test 尚未找到月均 5% 可實盤策略；真正進展是官方 OHLCV 已可支援上市+上櫃新候選池搜尋。'
};

await fs.mkdir(new URL('../../data/research/', import.meta.url), { recursive: true });
await fs.mkdir(new URL('../../docs/', import.meta.url), { recursive: true });
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 官方個股 OHLCV Smoke Test v1

- 宇宙：上市+上櫃個股，使用目前已補齊較完整的官方 OHLCV。
- 訓練期：${TRAIN.join(' ~ ')}
- 驗證期：${VALIDATION.join(' ~ ')}
- 股票數：${output.symbols}
- 訊號數：${output.signals}
- 測試組合：${output.testedConfigurations}
- 最佳策略：${best.config.id}
- 驗證交易：${best.validation.trades}
- 驗證月均：${best.validation.averageMonthlyReturnPct}%
- 驗證最大回撤：${best.validation.maximumDrawdownPct}%
- 驗證 Profit Factor：${best.validation.profitFactor}
- 是否達月均 5%：${passed}

## 資料限制

目前資料區間是 2018-2021，因此這份只可視為官方個股池 smoke test，不能宣稱是全台股 10 年可實盤策略。

## 結論

${output.conclusion}
`, 'utf8');

console.log(JSON.stringify({ output: OUTPUT.pathname, report: REPORT.pathname, best, passed }, null, 2));
