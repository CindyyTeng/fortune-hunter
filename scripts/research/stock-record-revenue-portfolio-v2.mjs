import fs from 'node:fs/promises';
import {
  deterministicScore,
  foldWindows,
  loadResearchContext,
  round,
  simulateSignalMap
} from './research-core.mjs';
import { buildExperimentIdentity, loadRegistry, shouldSkipExperiment } from './strategy-experiment-registry.mjs';

const REVENUE = new URL('../../data/revenue/monthly-revenue.json', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-record-revenue-portfolio-v2.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_RECORD_REVENUE_PORTFOLIO_V2.md', import.meta.url);
const STRATEGY_ID = 'stock_record_revenue_portfolio_v2';
const CAPITAL = 1_000_000;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const pct = (value, base) => base ? (value / base - 1) * 100 : 0;
const compact = summary => {
  const { monthly, ...metrics } = summary;
  return metrics;
};

function movingAverage(history, index, days) {
  return mean(history.slice(index - days + 1, index + 1).map(row => row.close));
}

function firstIndexOnOrAfter(history, date) {
  let low = 0;
  let high = history.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (history[middle].date < date) low = middle + 1;
    else high = middle;
  }
  return low < history.length ? low : -1;
}

function shiftMonth(date, months) {
  const value = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + months);
  return value.toISOString().slice(0, 7);
}

function dayBeforeMonth(month) {
  const value = new Date(`${month}-01T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function configurations() {
  const rows = [];
  for (const setup of ['record12_acceleration', 'record24_growth20']) {
    for (const priceMode of ['trend', 'pullback']) {
      for (const marketMode of ['bull', 'nonbear']) {
        for (const activeDays of [5, 15]) {
          for (const holdingDays of [20, 40, 60]) {
            for (const topN of [3, 5]) {
              for (const stopDistancePct of [8, 11]) {
                rows.push({ setup, priceMode, marketMode, activeDays, holdingDays, topN, stopDistancePct, accountRiskPct: 0.8 });
              }
            }
          }
        }
      }
    }
  }
  return rows;
}

function buildRows(context, revenueRecords) {
  const stocks = new Map(context.ohlcv.stocks
    .filter(row => /^\d{4}$/.test(row.stock.symbol) && Number(row.stock.symbol) >= 1000)
    .map(row => [row.stock.symbol, row]));
  const marketIndex = new Map(context.marketHistory.map((row, index) => [row.date, index]));
  const rows = [];
  for (const revenue of revenueRecords) {
    if (!revenue.isPointInTimeSafe || !revenue.effectiveDate) continue;
    const stockRow = stocks.get(revenue.symbol);
    if (!stockRow) continue;
    const { stock, history } = stockRow;
    const index = firstIndexOnOrAfter(history, revenue.effectiveDate);
    if (index < 130 || index + 82 >= history.length) continue;
    const eventDay = history[index];
    const returns = history.slice(index - 119, index + 1).map((value, offset, list) => (
      offset ? value.close / list[offset - 1].close - 1 : 0
    ));
    if (returns.some(value => Math.abs(value) > 0.15)) continue;
    for (let eventAgeDays = 0; eventAgeDays < 15; eventAgeDays += 1) {
      const activeIndex = index + eventAgeDays;
      if (activeIndex + 61 >= history.length) break;
      const day = history[activeIndex];
      const averageTradeValue20 = mean(history.slice(activeIndex - 19, activeIndex + 1).map(value => value.close * value.volume));
      if (day.close < 8 || averageTradeValue20 < 50_000_000) continue;
      const market = context.marketByDate.get(day.date);
      const cursor = marketIndex.get(day.date);
      if (!market || cursor < 20) continue;
      const ma20 = movingAverage(history, activeIndex, 20);
      const ma60 = movingAverage(history, activeIndex, 60);
      const return5 = pct(day.close, history[activeIndex - 5].close);
      const return20 = pct(day.close, history[activeIndex - 20].close);
      const relative20 = return20 - pct(context.marketHistory[cursor].close, context.marketHistory[cursor - 20].close);
      rows.push({
        stock,
        history,
        index: activeIndex,
        date: day.date,
        entryDate: history[activeIndex + 1].date,
        day,
        eventDay,
        eventAgeDays,
        market,
        revenue,
        ma20,
        ma60,
        return5,
        relative20,
        distanceMa20: pct(day.close, ma20),
        averageTradeValue20
      });
    }
  }
  const byDate = new Map();
  for (const row of rows) {
    const list = byDate.get(row.date) || [];
    list.push(row);
    byDate.set(row.date, list);
  }
  return byDate;
}

function setupAllowed(row, config) {
  const setup = config.setup === 'record12_acceleration'
    ? row.revenue.revenueHigh12 && row.revenue.YoY >= 20 && row.revenue.yoyAcceleration
    : row.revenue.revenueHigh24 && row.revenue.YoY >= 20;
  const market = config.marketMode === 'bull'
    ? row.market.close > row.market.ma60
      && ['BULL_TREND', 'BULL_PULLBACK', 'THEME_MOMENTUM'].includes(row.market.regime)
    : !['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.market.regime)
      && row.market.close >= row.market.ma60 * 0.97;
  const price = config.priceMode === 'trend'
    ? row.day.close > row.ma20 && row.ma20 > row.ma60 && row.relative20 > 0 && row.distanceMa20 <= 12
    : row.day.close > row.ma60 && row.ma20 > row.ma60 && row.relative20 > 0
      && row.distanceMa20 >= -3 && row.distanceMa20 <= 5 && row.return5 <= 4;
  return row.eventAgeDays < config.activeDays && setup && market && price;
}

function score(row) {
  return Math.min(60, row.revenue.YoY || 0) * 0.35
    + Math.min(30, row.revenue.threeMonthCumulativeYoY || 0) * 0.2
    + Math.min(25, row.relative20) * 0.8
    + Math.log10(Math.max(1, row.averageTradeValue20))
    + (row.revenue.revenueHigh24 ? 8 : 0)
    - row.eventAgeDays * 0.25;
}

function futureBars(context, row, config) {
  const bars = row.history.slice(row.index + 1, row.index + config.holdingDays + 2).map(value => ({
    date: value.date,
    open: value.open,
    high: value.high,
    low: value.low,
    close: value.close,
    price: value.close
  }));
  for (let offset = 1; offset < bars.length; offset += 1) {
    const priorIndex = row.index + offset;
    const heldDays = offset + 1;
    const priorStock = row.history[priorIndex];
    const priorMa20 = movingAverage(row.history, priorIndex, 20);
    const priorMarket = context.marketByDate.get(priorStock.date);
    const marketWeak = ['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(priorMarket?.regime);
    if (heldDays >= 10 && (priorStock.close < priorMa20 || marketWeak)) {
      bars[offset].forcedExit = {
        price: bars[offset].open,
        reason: marketWeak ? '前一交易日大盤轉入防守，隔日開盤出場' : '前一交易日收盤跌破 MA20，隔日開盤出場',
        type: marketWeak ? 'market_defense_exit' : 'ma20_close_exit'
      };
      break;
    }
  }
  return bars;
}

function signalMap(context, rowsByDate, config, random = false) {
  const map = new Map();
  for (const [date, rows] of rowsByDate) {
    const eligible = rows.filter(row => setupAllowed(row, config));
    const selected = [...eligible].sort((left, right) => random
      ? deterministicScore(`${date}|${left.stock.symbol}|record-random`)
        - deterministicScore(`${date}|${right.stock.symbol}|record-random`)
      : score(right) - score(left)).slice(0, config.topN);
    if (!selected.length) continue;
    map.set(date, selected.map(row => ({
      signalDate: date,
      entryDate: row.entryDate,
      symbol: row.stock.symbol,
      name: row.stock.name,
      market: row.stock.market,
      regime: row.market.regime,
      score: random ? deterministicScore(`${date}|${row.stock.symbol}|fair`) : score(row),
      close: row.day.close,
      entryMode: 'next_open_market',
      entryGapRange: { minimumPct: -5, maximumPct: 4 },
      stopDistancePct: config.stopDistancePct,
      stopLossMode: 'close',
      rewardRisk: 0,
      maxHoldingDays: config.holdingDays,
      trailingStopRule: config.holdingDays >= 60 ? { triggerPct: 18, lockPct: 4, givebackPct: 9 } : null,
      positionPct: config.topN === 3 ? 25 : 16,
      accountRiskPct: config.accountRiskPct,
      futureBars: futureBars(context, row, config),
      setup: `${config.setup}；事件後第 ${row.eventAgeDays + 1} 日；營收年增 ${round(row.revenue.YoY)}%；相對大盤 ${round(row.relative20)}%`,
      trigger: '資料於申報期限後生效，隔一交易日開盤且跳空不超過 4% 才進場',
      invalidation: `收盤停損 ${config.stopDistancePct}% 或收盤跌破 MA20，隔日開盤退出`,
      exitPlan: `最多持有 ${config.holdingDays} 日；大盤轉弱、MA20 跌破或移動停利退出`,
      reason: random ? '相同事件池公平隨機基準' : '全市場營收創高、成長加速、價格與大盤同步轉強',
      orderIntent: { action: 'BUY', orderType: 'MARKETABLE_LIMIT', timeInForce: 'DAY', earliestDate: row.entryDate }
    })));
  }
  return map;
}

function run(context, rowsByDate, config, startDate, endDate, random = false) {
  return simulateSignalMap(context, signalMap(context, rowsByDate, config, random), {
    strategyId: `${STRATEGY_ID}${random ? '_random' : ''}`,
    startDate,
    endDate,
    initialCapital: CAPITAL,
    maxOpenPositions: config.topN,
    accountRiskPct: config.accountRiskPct,
    riskRules: {
      maxAccountRiskPct: config.accountRiskPct,
      maxSinglePositionPct: config.topN === 3 ? 25 : 16,
      exposureLimits: {
        BULL_TREND: 80,
        THEME_MOMENTUM: 80,
        BULL_PULLBACK: 65,
        RANGE_BOUND: 35,
        HIGH_VOLATILITY: 0,
        BEAR_DEFENSE: 0
      },
      drawdownBlockPct: 8,
      drawdownBlockDays: 20,
      monthlyLossBlockPct: 5,
      dailyLossBlockPct: 2,
      losingStreakCount: 5,
      losingStreakBlockDays: 10
    }
  });
}

function aggregate(runs) {
  const monthly = runs.flatMap(run => run.summary.monthly);
  const trades = runs.flatMap(run => run.trades);
  const curve = runs.flatMap(run => run.equityCurve);
  let equity = CAPITAL;
  let peak = CAPITAL;
  let drawdown = 0;
  for (const row of curve) {
    equity *= 1 + (row.dailyReturnPct || 0) / 100;
    peak = Math.max(peak, equity);
    drawdown = Math.min(drawdown, pct(equity, peak));
  }
  const gains = trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(trades.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
  const symbols = new Map();
  for (const trade of trades) symbols.set(trade.symbol, (symbols.get(trade.symbol) || 0) + 1);
  return {
    months: monthly.length,
    averageMonthlyReturnPct: round(mean(monthly.map(row => row.equityReturnPct))),
    annualizedReturnPct: round(((equity / CAPITAL) ** (12 / Math.max(1, monthly.length)) - 1) * 100),
    maximumDrawdownPct: round(drawdown),
    trades: trades.length,
    winRatePct: round(trades.filter(row => row.realizedPnl > 0).length / Math.max(1, trades.length) * 100),
    profitFactor: losses ? round(gains / losses) : null,
    concentrationPct: round(Math.max(0, ...symbols.values()) / Math.max(1, trades.length) * 100),
    averageExposurePct: round(mean(curve.map(row => row.exposurePct || 0))),
    negativeMonths: monthly.filter(row => row.equityReturnPct < 0).length
  };
}

function benchmark(series, startDate, endDate) {
  const rows = series.filter(row => row.date >= startDate && row.date <= endDate);
  const ends = new Map(rows.map(row => [row.date.slice(0, 7), row.close]));
  let prior = [...series].reverse().find(row => row.date < startDate)?.close || rows[0]?.close;
  const returns = [];
  for (const close of ends.values()) {
    returns.push(pct(close, prior));
    prior = close;
  }
  return { averageMonthlyReturnPct: round(mean(returns)) };
}

async function main() {
  const configs = configurations();
  const identityInput = {
    strategyId: STRATEGY_ID,
    dataSources: ['MOPS 2015–2026 全市場月營收（保守 T+1）', '日線 OHLCV', '市場狀態'],
    setupRules: ['12 月營收創高且年增加速', '24 月營收創高且 YoY >= 20%'],
    triggerRules: ['趨勢或 MA20 拉回確認，隔日開盤進場，跳空上限 4%'],
    invalidationRules: ['收盤停損、收盤跌破 MA20 或大盤轉防守，隔日開盤出場'],
    exitRules: ['40/60/80 日、MA20、大盤防守、移動停利'],
    riskRules: { accountRiskPct: [0.5, 0.8], maxPositionPct: 16, tPlusTwo: true },
    blockedWhen: ['空頭防守', '高波動', '低成交值', '異常價格', '跳空超過 4%'],
    parameters: { trainMonths: 54, validationMonths: 18, activeCandidateDays: [5, 15], configs },
    trainPeriod: 'rolling 54 months',
    validationPeriod: 'rolling 18 months',
    costModel: '手續費、交易稅與滑價由共用投組模擬器扣除',
    executionModel: '共用成交模擬器；收盤訊號隔日開盤；T+2'
  };
  const identity = buildExperimentIdentity(identityInput);
  const decision = shouldSkipExperiment(await loadRegistry(), identity, {
    ...identityInput,
    newDataSources: ['MOPS 全市場月營收，修正舊資料按股票代碼截斷'],
    coreRulesChanged: true
  });
  if (decision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...decision, ...identity }, null, 2));
    return;
  }

  const [context, revenue, etf] = await Promise.all([
    loadResearchContext(),
    fs.readFile(REVENUE, 'utf8').then(JSON.parse),
    fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)
  ]);
  const rowsByDate = buildRows(context, revenue.records || []);
  const validations = [];
  const randoms = [];
  const folds = [];
  for (const fold of foldWindows(context.startDate, context.endDate, 54, 18)) {
    const trained = [];
    for (const config of configs) {
      const result = run(context, rowsByDate, config, fold.trainStart, fold.trainEnd);
      if (result.trades.length < 35 || result.summary.profitFactor < 1 || result.summary.maximumDrawdownPct < -25) continue;
      const segments = [0, 18, 36].map(offset => run(
        context,
        rowsByDate,
        config,
        `${shiftMonth(fold.trainStart, offset)}-01`,
        dayBeforeMonth(shiftMonth(fold.trainStart, offset + 18))
      ));
      if (segments.some(segment => segment.trades.length < 5)) continue;
      const returns = segments.map(segment => segment.summary.averageMonthlyEquityReturnPct).sort((a, b) => a - b);
      trained.push({
        config,
        result,
        score: returns[0] * 0.7 + returns[1] * 0.8
          + result.summary.averageMonthlyEquityReturnPct * 0.4
          + result.summary.maximumDrawdownPct * 0.08
      });
    }
    const selected = trained.sort((left, right) => right.score - left.score)[0];
    if (!selected) {
      folds.push({ ...fold, status: '訓練資料不足或沒有正期望組合' });
      continue;
    }
    const validation = run(context, rowsByDate, selected.config, fold.validationStart, fold.validationEnd);
    const random = run(context, rowsByDate, selected.config, fold.validationStart, fold.validationEnd, true);
    validations.push(validation);
    randoms.push(random);
    folds.push({
      ...fold,
      status: '已驗證',
      selectedConfig: selected.config,
      train: compact(selected.result.summary),
      validation: compact(validation.summary)
    });
  }

  const metrics = aggregate(validations);
  const fairRandom = aggregate(randoms);
  const completed = folds.filter(row => row.status === '已驗證');
  const validationStart = completed[0]?.validationStart;
  const validationEnd = completed.at(-1)?.validationEnd;
  const benchmark0050 = benchmark(etf.series['0050.TW'] || [], validationStart, validationEnd);
  const targetMet = metrics.averageMonthlyReturnPct >= 5
    && metrics.maximumDrawdownPct >= -20
    && metrics.trades >= 300
    && metrics.profitFactor > 1.15
    && metrics.averageMonthlyReturnPct > fairRandom.averageMonthlyReturnPct
    && metrics.averageMonthlyReturnPct > benchmark0050.averageMonthlyReturnPct;
  const output = {
    generatedAt: new Date().toISOString(),
    ...identity,
    universe: '上市與上櫃純個股；ETF 與 0050 交易占比 0%，0050 僅作基準',
    revenueCoverage: {
      records: revenue.records?.length || 0,
      symbols: new Set((revenue.records || []).map(row => row.symbol)).size,
      months: new Set((revenue.records || []).map(row => row.revenueMonth)).size
    },
    configurationsTested: configs.length,
    validationPeriod: `${validationStart || '無'}–${validationEnd || '無'}`,
    folds,
    metrics,
    fairRandom,
    benchmark0050,
    targetMonthlyReturnPct: 5,
    gapToTargetPct: round(5 - metrics.averageMonthlyReturnPct),
    targetMet,
    paperTradingReady: false,
    liveTradingReady: false,
    conclusion: targetMet
      ? '達到研究門檻，但仍只能先做紙上交易與成交驗收。'
      : `未達可信月均 5%；目前月均 ${metrics.averageMonthlyReturnPct}%，不可宣稱完成或可實盤。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, [
    '# 全市場營收創高純個股投組 v2', '',
    `- 驗證區間：${output.validationPeriod}`,
    `- 資料覆蓋：${output.revenueCoverage.symbols} 檔、${output.revenueCoverage.months} 個月份`,
    `- 月均：${metrics.averageMonthlyReturnPct}%；年化：${metrics.annualizedReturnPct}%；最大回撤：${metrics.maximumDrawdownPct}%`,
    `- 交易：${metrics.trades} 筆；勝率：${metrics.winRatePct}%；PF：${metrics.profitFactor}`,
    `- 公平隨機：${fairRandom.averageMonthlyReturnPct}%；0050：${benchmark0050.averageMonthlyReturnPct}%`,
    `- 結論：${output.conclusion}`,
    '- 注意：營收公布時間採法定期限後 T+1 的保守假設；目前歷史價格股票池仍有倖存者偏差警告。'
  ].join('\n') + '\n', 'utf8');
  console.log(JSON.stringify({
    validationPeriod: output.validationPeriod,
    coverage: output.revenueCoverage,
    configurationsTested: output.configurationsTested,
    metrics,
    fairRandom,
    benchmark0050,
    targetMet,
    conclusion: output.conclusion
  }, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
