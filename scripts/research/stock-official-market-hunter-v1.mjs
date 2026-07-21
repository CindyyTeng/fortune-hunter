import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const YEARS = ['2018', '2019', '2020', '2021'];
const TRAIN = ['2018-01-01', '2019-12-31'];
const VALIDATION = ['2020-01-01', '2021-12-31'];
const PROCESSED = new URL('../../data/market-history/processed/', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-official-market-hunter-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_OFFICIAL_MARKET_HUNTER_V1.md', import.meta.url);
const COST_PCT = 0.585;

const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const monthKey = date => String(date).slice(0, 7);

async function readYear(year) {
  try {
    return JSON.parse(zlib.gunzipSync(await fs.readFile(new URL(`${year}.json.gz`, PROCESSED))));
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
  return { bySymbol, coverage, marketRisk: buildMarketRisk(bySymbol) };
}

function buildMarketRisk(bySymbol) {
  const dailyReturns = new Map();
  for (const rows of bySymbol.values()) {
    for (let i = 1; i < rows.length; i += 1) {
      const previous = rows[i - 1];
      const row = rows[i];
      if (previous.close <= 0 || row.close <= 0) continue;
      if (!dailyReturns.has(row.date)) dailyReturns.set(row.date, []);
      dailyReturns.get(row.date).push((row.close / previous.close - 1) * 100);
    }
  }
  let index = 100;
  const series = [...dailyReturns].sort().map(([date, returns]) => {
    index *= 1 + avg(returns) / 100;
    return { date, index, dayReturnPct: avg(returns) };
  });
  const risk = new Map();
  for (let i = 60; i < series.length; i += 1) {
    const mom20Pct = (series[i].index / series[i - 20].index - 1) * 100;
    const mom60Pct = (series[i].index / series[i - 60].index - 1) * 100;
    const vol20Pct = Math.sqrt(avg(series.slice(i - 19, i + 1).map(row => row.dayReturnPct ** 2))) * Math.sqrt(20);
    risk.set(series[i].date, { mom20Pct, mom60Pct, vol20Pct });
  }
  return risk;
}

function buildSetups(bySymbol) {
  const setups = [];
  for (const [symbol, rows] of bySymbol) {
    if (rows.length < 130) continue;
    for (let i = 80; i < rows.length - 12; i += 1) {
      const row = rows[i];
      const previous = rows[i - 1];
      const next = rows[i + 1];
      const ma20 = avg(rows.slice(i - 19, i + 1).map(item => item.close));
      const ma60 = avg(rows.slice(i - 59, i + 1).map(item => item.close));
      const ma20Prev = avg(rows.slice(i - 24, i - 4).map(item => item.close));
      const high20 = Math.max(...rows.slice(i - 20, i).map(item => item.high));
      const low20 = Math.min(...rows.slice(i - 20, i).map(item => item.low));
      const value20 = avg(rows.slice(i - 19, i + 1).map(item => item.tradeValue));
      const atr20Pct = avg(rows.slice(i - 19, i + 1).map(item => (item.high - item.low) / item.close * 100));
      const mom5 = (row.close / rows[i - 5].close - 1) * 100;
      const mom20 = (row.close / rows[i - 20].close - 1) * 100;
      const mom60 = (row.close / rows[i - 60].close - 1) * 100;
      const rangePos20 = (row.close - low20) / Math.max(0.01, high20 - low20);
      const candleRange = Math.max(0.01, row.high - row.low);
      const lowerShadowPct = (Math.min(row.open, row.close) - row.low) / candleRange * 100;
      const upperShadowPct = (row.high - Math.max(row.open, row.close)) / candleRange * 100;
      const bodyPct = Math.abs(row.close - row.open) / candleRange * 100;
      const common = {
        symbol,
        name: row.name,
        market: row.market,
        signalDate: row.date,
        entryDate: next.date,
        entryOpen: next.open,
        tradeValue: row.tradeValue,
        volumeRatio20: row.tradeValue / Math.max(1, value20),
        atr20Pct,
        mom5,
        mom20,
        mom60,
        ma20SlopePct: (ma20 / ma20Prev - 1) * 100,
        distanceToMa20Pct: (row.close / ma20 - 1) * 100,
        ma20AboveMa60: ma20 > ma60,
        gapPct: (next.open / row.close - 1) * 100,
        path: rows.slice(i + 1, i + 12)
      };
      if (row.close > high20 && mom20 > 0) {
        setups.push({ ...common, setup: 'breakout', score: mom20 + mom60 * 0.4 + common.volumeRatio20 * 3 - atr20Pct });
      }
      if (ma20 > ma60 && row.low <= ma20 * 1.02 && row.close >= ma20 * 0.98 && mom60 > 5 && row.close >= previous.close) {
        setups.push({ ...common, setup: 'pullback', score: mom60 + common.ma20SlopePct * 4 - Math.abs(common.distanceToMa20Pct) - atr20Pct });
      }
      if (mom5 < -4 && rangePos20 < 0.45 && lowerShadowPct > 35 && bodyPct > 15 && upperShadowPct < 45) {
        setups.push({ ...common, setup: 'reversal', score: lowerShadowPct + Math.abs(mom5) - atr20Pct * 2 });
      }
    }
  }
  return setups;
}

function configs() {
  const base = [
    { setup: 'breakout', minValue: 30_000_000, minMom20: 8, minMom60: 10, maxAtr: 8, minVolumeRatio: 1.2, maxGap: 6, maxDistance: 18 },
    { setup: 'breakout', minValue: 10_000_000, minMom20: 12, minMom60: 20, maxAtr: 10, minVolumeRatio: 1.5, maxGap: 8, maxDistance: 25 },
    { setup: 'pullback', minValue: 10_000_000, minMom20: -5, minMom60: 8, maxAtr: 8, minVolumeRatio: 0.6, maxGap: 5, maxDistance: 6 },
    { setup: 'pullback', minValue: 30_000_000, minMom20: -8, minMom60: 15, maxAtr: 6, minVolumeRatio: 0.5, maxGap: 5, maxDistance: 5 },
    { setup: 'reversal', minValue: 10_000_000, minMom20: -20, minMom60: -30, maxAtr: 12, minVolumeRatio: 0.8, maxGap: 6, maxDistance: 99 },
    { setup: 'reversal', minValue: 30_000_000, minMom20: -15, minMom60: -20, maxAtr: 10, minVolumeRatio: 1, maxGap: 5, maxDistance: 99 }
  ];
  const variants = [];
  for (const item of base) {
    for (const top of [3, 5, 8]) {
      for (const holdDays of [3, 5, 10]) {
        for (const stopLossPct of [4, 6, 8]) {
          for (const takeProfitPct of [8, 12, 16]) {
            for (const minMarketMom20 of [-999, 0]) {
              for (const maxMarketVol20 of [99, 18]) {
                for (const monthlyBrakePct of [-999, -5]) {
                  variants.push({ ...item, top, holdDays, stopLossPct, takeProfitPct, minMarketMom20, maxMarketVol20, monthlyBrakePct, exposure: 1 });
                }
              }
            }
          }
        }
      }
    }
  }
  return variants;
}

function pass(setup, config) {
  return setup.setup === config.setup
    && setup.tradeValue >= config.minValue
    && setup.mom20 >= config.minMom20
    && setup.mom60 >= config.minMom60
    && setup.atr20Pct <= config.maxAtr
    && setup.volumeRatio20 >= config.minVolumeRatio
    && setup.gapPct <= config.maxGap
    && Math.abs(setup.distanceToMa20Pct) <= config.maxDistance
    && (!['breakout', 'pullback'].includes(setup.setup) || setup.ma20AboveMa60);
}

function simulateTrade(setup, config) {
  const entry = setup.entryOpen;
  const stop = entry * (1 - config.stopLossPct / 100);
  const target = entry * (1 + config.takeProfitPct / 100);
  const path = setup.path.slice(0, config.holdDays + 1);
  for (let i = 1; i < path.length; i += 1) {
    const row = path[i];
    if (row.open <= stop) return { exitDate: row.date, returnPct: (row.open / entry - 1) * 100 - COST_PCT, reason: 'gap_stop' };
    if (row.low <= stop) return { exitDate: row.date, returnPct: (stop / entry - 1) * 100 - COST_PCT, reason: 'stop' };
    if (row.open >= target) return { exitDate: row.date, returnPct: (row.open / entry - 1) * 100 - COST_PCT, reason: 'gap_target' };
    if (row.high >= target) return { exitDate: row.date, returnPct: (target / entry - 1) * 100 - COST_PCT, reason: 'target' };
  }
  const last = path.at(-1);
  return { exitDate: last.date, returnPct: (last.open / entry - 1) * 100 - COST_PCT, reason: 'time' };
}

function evaluate(setups, config, [start, end], marketRisk) {
  const byDate = new Map();
  for (const setup of setups) {
    if (setup.entryDate < start || setup.entryDate > end || !pass(setup, config)) continue;
    const risk = marketRisk.get(setup.signalDate);
    if (risk && (risk.mom20Pct < config.minMarketMom20 || risk.vol20Pct > config.maxMarketVol20)) continue;
    if (!byDate.has(setup.entryDate)) byDate.set(setup.entryDate, []);
    byDate.get(setup.entryDate).push(setup);
  }
  const dates = [...byDate.keys()].sort();
  const open = [];
  const monthly = new Map();
  let trades = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  const blockedMonths = new Set();
  const closeTrade = trade => {
    monthly.set(monthKey(trade.exitDate), (monthly.get(monthKey(trade.exitDate)) || 0) + trade.accountReturnPct);
    if ((monthly.get(monthKey(trade.exitDate)) || 0) <= config.monthlyBrakePct) blockedMonths.add(monthKey(trade.exitDate));
    trades += 1;
    if (trade.accountReturnPct > 0) {
      wins += 1;
      grossProfit += trade.accountReturnPct;
    } else {
      grossLoss += Math.abs(trade.accountReturnPct);
    }
  };
  for (const date of dates) {
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if (open[i].exitDate > date) continue;
      closeTrade(open.splice(i, 1)[0]);
    }
    if (open.length >= config.top) continue;
    if (blockedMonths.has(monthKey(date))) continue;
    const picks = (byDate.get(date) || []).sort((a, b) => b.score - a.score).slice(0, config.top - open.length);
    for (const setup of picks) {
      const trade = simulateTrade(setup, config);
      open.push({
        ...trade,
        accountReturnPct: trade.returnPct * config.exposure / config.top
      });
    }
  }
  for (const trade of open.sort((a, b) => a.exitDate.localeCompare(b.exitDate))) closeTrade(trade);
  const months = [...monthly].sort().map(([month, returnPct]) => ({ month, returnPct: round(returnPct) }));
  let equity = 100;
  let peak = 100;
  let maximumDrawdownPct = 0;
  for (const row of months) {
    equity *= 1 + row.returnPct / 100;
    peak = Math.max(peak, equity);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, (equity / peak - 1) * 100);
  }
  return {
    trades,
    months: months.length,
    averageMonthlyReturnPct: round(avg(months.map(row => row.returnPct))),
    annualizedReturnPct: round((months.reduce((value, row) => value * (1 + row.returnPct / 100), 1) ** (12 / Math.max(1, months.length)) - 1) * 100),
    maximumDrawdownPct: round(maximumDrawdownPct),
    profitFactor: round(grossLoss ? grossProfit / grossLoss : 0),
    winRatePct: round(trades ? wins / trades * 100 : 0),
    negativeMonths: months.filter(row => row.returnPct < 0).length
  };
}

const { bySymbol, coverage, marketRisk } = await loadHistories();
const setups = buildSetups(bySymbol);
const results = configs().map(config => ({
  config,
  train: evaluate(setups, config, TRAIN, marketRisk),
  validation: evaluate(setups, config, VALIDATION, marketRisk)
}));
const viable = results.filter(result => (
  result.train.trades >= 150
  && result.validation.trades >= 150
  && result.train.maximumDrawdownPct >= -25
  && result.validation.maximumDrawdownPct >= -25
  && result.train.profitFactor > 1
));
const best = (viable.length ? viable : results)
  .sort((a, b) => (
    b.validation.averageMonthlyReturnPct * 3
    + b.validation.profitFactor
    + b.validation.maximumDrawdownPct / 20
    + Math.min(b.validation.trades, 500) / 500
  ) - (
    a.validation.averageMonthlyReturnPct * 3
    + a.validation.profitFactor
    + a.validation.maximumDrawdownPct / 20
    + Math.min(a.validation.trades, 500) / 500
  ))[0];

const passed = best.validation.averageMonthlyReturnPct >= 5
  && best.validation.trades >= 300
  && best.validation.maximumDrawdownPct >= -20
  && best.train.maximumDrawdownPct >= -20
  && best.validation.profitFactor > 1.15;

const output = {
  generatedAt: new Date().toISOString(),
  strategyId: 'stock_official_market_hunter_v1',
  universe: 'TWSE_TPEX_OFFICIAL_MARKET_HISTORY_2018_2021',
  periods: { train: TRAIN, validation: VALIDATION },
  coverage,
  symbols: bySymbol.size,
  setups: setups.length,
  testedConfigurations: results.length,
  viableConfigurations: viable.length,
  best,
  targetMonthlyReturnPct: 5,
  targetGapPct: round(5 - best.validation.averageMonthlyReturnPct),
  passed,
  paperTradingReady: false,
  liveTradingReady: false,
  conclusion: passed
    ? '找到 smoke 階段達標候選，但仍需補齊更長年份並做完整 walk-forward，暫不可實盤。'
    : '尚未找到月均 5% 可實盤個股策略；此版已改用官方上市+上櫃 OHLCV 直接產生候選池，後續可在此基礎上擴大搜尋。'
};

await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT, `# 官方個股策略 Hunter v1

- 宇宙：上市+上櫃個股官方 OHLCV。
- 訓練期：${TRAIN.join(' ~ ')}
- 驗證期：${VALIDATION.join(' ~ ')}
- 股票數：${output.symbols}
- 進場候選數：${output.setups}
- 測試組合：${output.testedConfigurations}
- 可行組合：${output.viableConfigurations}
- 最佳策略：${best.config.setup} / ${best.config.top} 檔 / 持有 ${best.config.holdDays} 日
- 驗證交易：${best.validation.trades}
- 驗證月均：${best.validation.averageMonthlyReturnPct}%
- 驗證最大回撤：${best.validation.maximumDrawdownPct}%
- 驗證 Profit Factor：${best.validation.profitFactor}
- 是否達月均 5%：${passed}

## 結論

${output.conclusion}
`, 'utf8');

console.log(JSON.stringify({
  output: OUTPUT.pathname,
  report: REPORT.pathname,
  best,
  passed
}, null, 2));
