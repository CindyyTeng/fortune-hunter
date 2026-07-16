import fs from 'node:fs/promises';
import {
  deterministicScore,
  foldWindows,
  hasHistoricalPriceAnomaly,
  loadResearchContext,
  round,
  simulateSignalMap
} from './research-core.mjs';
import { buildExperimentIdentity, loadRegistry, shouldSkipExperiment } from './strategy-experiment-registry.mjs';

const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/stock-intraday-momentum-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_INTRADAY_MOMENTUM_V1.md', import.meta.url);
const STRATEGY_ID = 'stock_intraday_momentum_v1';
const CAPITAL = 1_000_000;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const pct = (value, base) => base ? (value / base - 1) * 100 : 0;
const compact = summary => {
  const { monthly, ...metrics } = summary;
  return metrics;
};

function prefix(values) {
  const sums = new Float64Array(values.length + 1);
  for (let index = 0; index < values.length; index += 1) sums[index + 1] = sums[index] + values[index];
  return sums;
}

function windowSum(sums, index, days) {
  return sums[index + 1] - sums[index + 1 - days];
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
  for (const formationDays of [20, 60, 120]) {
    for (const scoreMode of ['intraday', 'intraday_minus_overnight', 'intraday_quality']) {
      for (const marketMode of ['risk_on', 'non_crash']) {
        for (const rebalanceDays of [5, 20]) {
          for (const topN of [5, 10]) {
            for (const holdingDays of [20, 60]) {
              rows.push({ formationDays, scoreMode, marketMode, rebalanceDays, topN, holdingDays });
            }
          }
        }
      }
    }
  }
  return rows;
}

function buildRows(context) {
  const dateOrder = new Map(context.marketHistory.map((row, index) => [row.date, index]));
  const rows = [];
  for (const { stock, history } of context.ohlcv.stocks) {
    if (!/^\d{4}$/.test(String(stock.symbol)) || Number(stock.symbol) < 1000) continue;
    const returns = history.map((day, index) => index ? day.close / history[index - 1].close - 1 : 0);
    const intraday = history.map(day => Math.log(day.close / day.open));
    const overnight = history.map((day, index) => index ? Math.log(day.open / history[index - 1].close) : 0);
    const positiveIntraday = intraday.map(value => value > 0 ? 1 : 0);
    const volumes = history.map(day => day.volume);
    const intradayPrefix = prefix(intraday);
    const overnightPrefix = prefix(overnight);
    const positivePrefix = prefix(positiveIntraday);
    const volumePrefix = prefix(volumes);
    for (let index = 130; index + 61 < history.length; index += 1) {
      const day = history[index];
      const order = dateOrder.get(day.date);
      if (order === undefined || order % 5 !== 0) continue;
      const market = context.marketByDate.get(day.date);
      if (!market || hasHistoricalPriceAnomaly(returns, index)) continue;
      const averageVolume20 = windowSum(volumePrefix, index, 20) / 20;
      const transactionValue = day.close * averageVolume20;
      if (day.close < 10 || transactionValue < 30_000_000) continue;
      const factors = {};
      for (const days of [20, 60, 120]) {
        factors[`intraday${days}`] = (Math.exp(windowSum(intradayPrefix, index, days)) - 1) * 100;
        factors[`overnight${days}`] = (Math.exp(windowSum(overnightPrefix, index, days)) - 1) * 100;
        factors[`positive${days}`] = windowSum(positivePrefix, index, days) / days;
      }
      const ma60 = mean(history.slice(index - 59, index + 1).map(row => row.close));
      const trueRanges = history.slice(index - 13, index + 1).map((row, offset) => {
        const prior = history[index - 14 + offset];
        return Math.max(row.high - row.low, Math.abs(row.high - prior.close), Math.abs(row.low - prior.close));
      });
      rows.push({
        stock,
        history,
        index,
        date: day.date,
        entryDate: history[index + 1].date,
        order,
        day,
        market,
        ma60,
        atrPct: mean(trueRanges) / day.close * 100,
        transactionValue,
        ...factors
      });
    }
  }
  return rows;
}

function allowed(row, config) {
  const regimeAllowed = config.marketMode === 'risk_on'
    ? row.market.close > row.market.ma60 && ['BULL_TREND', 'THEME_MOMENTUM', 'BULL_PULLBACK'].includes(row.market.regime)
    : !['HIGH_VOLATILITY', 'BEAR_DEFENSE'].includes(row.market.regime);
  return regimeAllowed
    && row.order % config.rebalanceDays === 0
    && row.atrPct >= 1
    && row.atrPct <= 7
    && row[`intraday${config.formationDays}`] > 0
    && row[`positive${config.formationDays}`] >= 0.45;
}

function alphaScore(row, config) {
  const intraday = row[`intraday${config.formationDays}`];
  const overnight = row[`overnight${config.formationDays}`];
  const consistency = row[`positive${config.formationDays}`];
  if (config.scoreMode === 'intraday_minus_overnight') return intraday - overnight * 0.8;
  if (config.scoreMode === 'intraday_quality') return intraday * consistency / Math.max(1, row.atrPct);
  return intraday;
}

function buildMap(rows, config, random = false) {
  const byDate = new Map();
  for (const row of rows) {
    if (!allowed(row, config)) continue;
    const list = byDate.get(row.date) || [];
    list.push(row);
    byDate.set(row.date, list);
  }
  const map = new Map();
  for (const [date, candidates] of byDate) {
    const selected = [...candidates].sort((left, right) => random
      ? deterministicScore(`${date}|${left.stock.symbol}|imom`) - deterministicScore(`${date}|${right.stock.symbol}|imom`)
      : alphaScore(right, config) - alphaScore(left, config)).slice(0, config.topN);
    map.set(date, selected.map(row => ({
      signalDate: date,
      entryDate: row.entryDate,
      symbol: row.stock.symbol,
      name: row.stock.name,
      market: row.stock.market,
      regime: row.market.regime,
      score: random ? deterministicScore(`${date}|${row.stock.symbol}|fair`) : alphaScore(row, config),
      entryMode: 'next_open_market',
      close: row.day.close,
      entryGapRange: { minimumPct: -5, maximumPct: 4 },
      stopDistancePct: 10,
      stopLossMode: 'close',
      rewardRisk: 0,
      maxHoldingDays: config.holdingDays,
      trailingStopRule: config.holdingDays === 60 ? { triggerPct: 15, lockPct: 3, givebackPct: 8 } : null,
      positionPct: config.topN === 5 ? 15 : 8,
      accountRiskPct: 0.75,
      futureBars: row.history.slice(row.index + 1, row.index + config.holdingDays + 2).map(bar => ({
        date: bar.date, open: bar.open, high: bar.high, low: bar.low, close: bar.close, price: bar.close
      })),
      setup: `${config.formationDays} 日盤中動能排名；盤中 ${round(row[`intraday${config.formationDays}`])}%，隔夜 ${round(row[`overnight${config.formationDays}`])}%`,
      trigger: '訊號日收盤後排名，隔日開盤進場；跳空超過 -5%～4% 則放棄',
      invalidation: '收盤跌破進場價 10%，次日開盤退出',
      exitPlan: `最多持有 ${config.holdingDays} 日${config.holdingDays === 60 ? '，搭配移動停利' : ''}`,
      reason: random ? '同日同流動性池公平隨機' : '台股盤中資訊延續、隔夜情緒反轉分離排名',
      orderIntent: { action: 'BUY', orderType: 'MARKET', timeInForce: 'DAY', earliestDate: row.entryDate }
    })));
  }
  return map;
}

function run(context, rows, config, startDate, endDate, random = false) {
  return simulateSignalMap(context, buildMap(rows, config, random), {
    strategyId: `${STRATEGY_ID}${random ? '_random' : ''}`,
    startDate,
    endDate,
    initialCapital: CAPITAL,
    maxOpenPositions: config.topN,
    accountRiskPct: 0.75,
    riskRules: {
      maxAccountRiskPct: 0.75,
      maxSinglePositionPct: 15,
      exposureLimits: { BULL_TREND: 75, THEME_MOMENTUM: 75, BULL_PULLBACK: 60, RANGE_BOUND: 35, HIGH_VOLATILITY: 0, BEAR_DEFENSE: 0 },
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
  const monthly = runs.flatMap(row => row.summary.monthly);
  const trades = runs.flatMap(row => row.trades);
  const curve = runs.flatMap(row => row.equityCurve);
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
    averageExposurePct: round(mean(curve.map(row => row.exposurePct || 0)))
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
    dataSources: ['個股 OHLCV', '盤中與隔夜報酬拆分', '市場狀態', '成交值'],
    setupRules: ['20／60／120 日累積盤中動能截面排名', '隔夜報酬反轉扣分', '流動性與波動排除'],
    triggerRules: ['訊號日收盤排名，隔日開盤成交', '跳空超出 -5%～4% 放棄'],
    invalidationRules: ['收盤 10% 停損，次日開盤退出'],
    exitRules: ['20／60 日持有與移動停利'],
    riskRules: { accountRiskPct: 0.75, maximumPositionPct: 15, tPlusTwo: true },
    blockedWhen: ['空頭防守或高波動盤', '成交值不足', 'ATR 過高'],
    parameters: { trainMonths: 54, validationMonths: 18, configs },
    trainPeriod: 'rolling 54 months',
    validationPeriod: 'rolling 18 months',
    costModel: '共用成交模擬器：手續費、交易稅、滑價',
    executionModel: '隔日開盤真實成交、跳空過濾、收盤停損次日退出、T+2'
  };
  const identity = buildExperimentIdentity(identityInput);
  const decision = shouldSkipExperiment(await loadRegistry(), identity, { ...identityInput, newDataSources: ['盤中與隔夜報酬拆分因子'], coreRulesChanged: true });
  if (decision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...decision, ...identity }, null, 2));
    return;
  }
  const [context, etfHistory] = await Promise.all([loadResearchContext(), fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)]);
  const rows = buildRows(context);
  const validations = [];
  const randoms = [];
  const folds = [];
  for (const fold of foldWindows(context.startDate, context.endDate, 54, 18)) {
    const trained = [];
    const diagnostics = [];
    for (const config of configs) {
      const result = run(context, rows, config, fold.trainStart, fold.trainEnd);
      diagnostics.push({ config, summary: compact(result.summary) });
      if (result.trades.length < 100 || result.summary.profitFactor < 1 || result.summary.maximumDrawdownPct < -25) continue;
      const segments = [0, 18, 36].map(offset => run(context, rows, config, `${shiftMonth(fold.trainStart, offset)}-01`, dayBeforeMonth(shiftMonth(fold.trainStart, offset + 18))));
      if (segments.some(segment => segment.trades.length < 25)) continue;
      const returns = segments.map(segment => segment.summary.averageMonthlyEquityReturnPct).sort((a, b) => a - b);
      trained.push({
        config,
        result,
        score: result.summary.averageMonthlyEquityReturnPct * 0.35
          + returns[1] * 0.8
          + returns[0]
          + result.summary.maximumDrawdownPct * 0.12
      });
    }
    const selected = trained.sort((left, right) => right.score - left.score)[0];
    if (!selected) {
      folds.push({
        ...fold,
        status: '訓練證據不足，持有現金',
        bestTrainingDiagnostics: diagnostics.sort((left, right) => right.summary.averageMonthlyEquityReturnPct - left.summary.averageMonthlyEquityReturnPct).slice(0, 3)
      });
      continue;
    }
    const validation = run(context, rows, selected.config, fold.validationStart, fold.validationEnd);
    const random = run(context, rows, selected.config, fold.validationStart, fold.validationEnd, true);
    validations.push(validation);
    randoms.push(random);
    folds.push({ ...fold, status: '已驗證', selectedConfig: selected.config, train: compact(selected.result.summary), validation: compact(validation.summary) });
    console.log(`${fold.validationStart}–${fold.validationEnd}：${validation.trades.length} 筆，月均 ${validation.summary.averageMonthlyEquityReturnPct}%`);
  }
  const metrics = aggregate(validations);
  const fairRandom = aggregate(randoms);
  const validationStart = folds.find(row => row.status === '已驗證')?.validationStart;
  const validationEnd = folds.filter(row => row.status === '已驗證').at(-1)?.validationEnd;
  const benchmark0050 = benchmark(etfHistory.series['0050.TW'] || [], validationStart, validationEnd);
  const targetMet = metrics.averageMonthlyReturnPct >= 5
    && metrics.maximumDrawdownPct >= -20
    && metrics.trades >= 300
    && metrics.profitFactor > 1.15
    && metrics.averageMonthlyReturnPct > fairRandom.averageMonthlyReturnPct
    && metrics.averageMonthlyReturnPct > benchmark0050.averageMonthlyReturnPct;
  const output = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    experimentHash: identity.experimentHash,
    strategyFamilyId: identity.strategyFamilyId,
    universe: '純台股普通股；ETF／0050 交易占比 0%，0050 僅作比較',
    methodology: '台股盤中動能與隔夜反轉分離；54 個月訓練、18 個月固定驗證。',
    observations: rows.length,
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
      ? '達到研究候選門檻，但仍須先紙上交易，不可直接實盤。'
      : `找不到月均 5% 的可實盤純個股盤中動能策略；目前 ${metrics.averageMonthlyReturnPct}%。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, [
    '# 純個股盤中動能研究', '',
    `- 驗證區間：${output.validationPeriod}`,
    `- 月均：${metrics.averageMonthlyReturnPct}%；年化：${metrics.annualizedReturnPct}%；最大回撤：${metrics.maximumDrawdownPct}%`,
    `- 交易：${metrics.trades}；勝率：${metrics.winRatePct}%；PF：${metrics.profitFactor}`,
    `- 公平隨機月均：${fairRandom.averageMonthlyReturnPct}%；0050 月均：${benchmark0050.averageMonthlyReturnPct}%`,
    `- 結論：${output.conclusion}`, '',
    '交易池只含四碼普通股，0050 僅作比較。策略把歷史盤中 open-to-close 報酬與隔夜 close-to-open 報酬分開，不使用未來資料。',
    '研究依據：https://doi.org/10.1016/j.pacfin.2023.102151'
  ].join('\n') + '\n', 'utf8');
  console.log(JSON.stringify({ validationPeriod: output.validationPeriod, observations: rows.length, metrics, fairRandom, benchmark0050, targetMet, conclusion: output.conclusion }, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
