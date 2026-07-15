import fs from 'node:fs/promises';
import {
  deterministicScore,
  foldWindows,
  loadResearchContext,
  round,
  simulateSignalMap
} from './research-core.mjs';
import {
  buildExperimentIdentity,
  loadRegistry,
  shouldSkipExperiment
} from './strategy-experiment-registry.mjs';

const OUTPUT = new URL('../../data/research/stock-shock-stabilization-v1.json', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const STRATEGY_ID = 'stock_shock_stabilization_v1';
const INITIAL_CAPITAL = 1_000_000;
const COST_PCT = 0.6;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

function summarize(values) {
  const average = mean(values);
  const variance = mean(values.map(value => (value - average) ** 2));
  const gains = values.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter(value => value <= 0).reduce((sum, value) => sum + value, 0));
  return {
    samples: values.length,
    netMeanPct: round(average),
    netMedianPct: round(median(values)),
    winRatePct: round(values.filter(value => value > 0).length / Math.max(1, values.length) * 100),
    profitFactor: losses ? round(gains / losses) : null,
    tStat: variance && values.length ? round(average / Math.sqrt(variance / values.length)) : 0
  };
}

function configurations() {
  const rows = [];
  for (const setup of ['bullish_no_new_low', 'volume_contract_no_new_low']) {
    for (const holdingDays of [5, 10]) {
      for (const topN of [5, 10, 20]) {
        for (const stopDistancePct of [10, 12]) {
          for (const maximumEntryGapPct of [2, 4]) {
            rows.push({ setup, holdingDays, topN, stopDistancePct, maximumEntryGapPct });
          }
        }
      }
    }
  }
  return rows;
}

function signalMap(events, config, random = false) {
  const result = new Map();
  for (const [date, rows] of events) {
    const matchesSetup = row => config.setup === 'bullish_no_new_low'
      ? row.bullish && row.noNewLow
      : row.volumeContract && row.noNewLow;
    const candidates = rows.filter(row => random || matchesSetup(row))
      .map(row => ({
        ...row,
        entryGapRange: { minimumPct: -5, maximumPct: config.maximumEntryGapPct },
        score: random
          ? deterministicScore(`${date}|${row.symbol}|急跌止穩公平隨機`)
          : -row.shockPct * 2 + row.lowerShadowRatio * 5 + (row.volumeContract ? 3 : 0),
        stopDistancePct: config.stopDistancePct,
        stopLossMode: 'close',
        rewardRisk: 0,
        maxHoldingDays: config.holdingDays,
        positionPct: 10,
        accountRiskPct: 0.5,
        setup: config.setup === 'bullish_no_new_low'
          ? '接近跌停後隔日收紅且不破低'
          : '接近跌停後隔日量縮且不破低',
        trigger: '止穩日收盤確認，下一交易日開盤且跳空不超過限制',
        invalidation: `進場價下方 ${config.stopDistancePct}%`,
        exitPlan: `停損優先，否則最多持有 ${config.holdingDays} 個交易日`,
        reason: '極端急跌後等待止穩確認，不在急跌當日接刀',
        orderIntent: {
          action: 'BUY',
          orderType: 'MARKET',
          timeInForce: 'DAY',
          earliestDate: row.entryDate
        }
      })).sort((left, right) => right.score - left.score).slice(0, config.topN);
    if (candidates.length) result.set(date, candidates);
  }
  return result;
}

function run(context, events, config, startDate, endDate, random = false) {
  return simulateSignalMap(context, signalMap(events, config, random), {
    strategyId: random ? `${STRATEGY_ID}_random` : STRATEGY_ID,
    startDate,
    endDate,
    initialCapital: INITIAL_CAPITAL,
    maxOpenPositions: config.topN,
    holdingDays: config.holdingDays,
    accountRiskPct: 0.5,
    riskRules: {
      maxAccountRiskPct: 0.5,
      maxSinglePositionPct: 10,
      exposureLimits: {
        BULL_TREND: 60,
        BULL_PULLBACK: 50,
        RANGE_BOUND: 40,
        THEME_MOMENTUM: 60,
        HIGH_VOLATILITY: 20,
        BEAR_DEFENSE: 20
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

function summarizeRuns(runs) {
  const monthly = runs.flatMap(item => item.summary.monthly);
  const trades = runs.flatMap(item => item.trades);
  const equityCurve = runs.flatMap(item => item.equityCurve);
  let equity = INITIAL_CAPITAL;
  let peak = equity;
  let maximumDrawdownPct = 0;
  for (const day of equityCurve) {
    equity *= 1 + day.dailyReturnPct / 100;
    peak = Math.max(peak, equity);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, (equity / peak - 1) * 100);
  }
  const gains = trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(trades.filter(row => row.realizedPnl <= 0)
    .reduce((sum, row) => sum + row.realizedPnl, 0));
  const symbols = trades.reduce((map, row) => map.set(row.symbol, (map.get(row.symbol) || 0) + 1), new Map());
  return {
    months: monthly.length,
    averageMonthlyReturnPct: round(mean(monthly.map(row => row.equityReturnPct))),
    annualizedReturnPct: round((equity / INITIAL_CAPITAL) ** (12 / Math.max(1, monthly.length)) * 100 - 100),
    maximumDrawdownPct: round(maximumDrawdownPct),
    trades: trades.length,
    winRatePct: round(trades.filter(row => row.realizedPnl > 0).length / Math.max(1, trades.length) * 100),
    profitFactor: losses ? round(gains / losses) : null,
    concentrationPct: round(Math.max(0, ...symbols.values()) / Math.max(1, trades.length) * 100),
    negativeMonths: monthly.filter(row => row.equityReturnPct < 0).length,
    averageExposurePct: round(mean(equityCurve.map(row => row.exposurePct || 0))),
    investedTradingDaysPct: round(equityCurve.filter(row => row.openPositions > 0).length
      / Math.max(1, equityCurve.length) * 100),
    averageOpenPositions: round(mean(equityCurve.map(row => row.openPositions || 0)))
  };
}

function benchmark(series, startDate, endDate) {
  const rows = series.filter(row => row.date >= startDate && row.date <= endDate);
  const monthEnd = new Map();
  for (const row of rows) monthEnd.set(row.date.slice(0, 7), row.close);
  let prior = [...series].reverse().find(row => row.date < startDate)?.close ?? rows[0]?.close;
  const returns = [];
  for (const close of monthEnd.values()) {
    returns.push((close / prior - 1) * 100);
    prior = close;
  }
  return { averageMonthlyReturnPct: round(mean(returns)) };
}

async function main() {
  const identityInput = {
    strategyId: STRATEGY_ID,
    dataSources: ['台股日線 OHLCV', '市場狀態'],
    setupRules: ['普通股單日急跌 8.5% 至 12%', '急跌日不是大幅跳空', '隔日收紅或量縮且不破低'],
    triggerRules: ['止穩日收盤確認後，下一交易日開盤進場'],
    invalidationRules: ['進場價下方 10% 或 12% 停損，部位依 0.5% 帳戶風險縮小'],
    exitRules: ['最多持有 5 或 10 個交易日，由訓練期選擇'],
    riskRules: { accountRiskPct: 0.5, maxPositionPct: 10, tPlusTwo: true },
    blockedWhen: ['開盤鎖跌停', '低流動性', '帳戶熔斷'],
    parameters: {
      testedConfigurations: 48,
      forwardHorizons: [3, 5, 10, 20],
      entryGapTiming: 'after_signal_rank_at_execution'
    },
    trainPeriod: 'rolling 54 months',
    validationPeriod: 'rolling 18 months',
    costModel: '真實手續費、交易稅與滑價',
    executionModel: '止穩確認後隔日開盤成交；停損跳空採較差價格'
  };
  const identity = buildExperimentIdentity(identityInput);
  const registryDecision = shouldSkipExperiment(await loadRegistry(), identity, {
    ...identityInput,
    coreRulesChanged: true
  });
  if (registryDecision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...registryDecision, ...identity }, null, 2));
    return;
  }
  const context = await loadResearchContext();
  const market = new Map(context.marketHistory.map((row, index, rows) => [row.date, {
    aboveMa60: index >= 59 && row.close > mean(rows.slice(index - 59, index + 1).map(item => item.close))
  }]));
  const tests = new Map();
  const events = new Map();
  const setups = {
    bullish: row => row.bullish,
    bullish_no_new_low: row => row.bullish && row.noNewLow,
    lower_shadow_bullish: row => row.bullish && row.lowerShadowRatio >= 0.4,
    volume_contract_no_new_low: row => row.volumeContract && row.noNewLow
  };
  for (const setup of Object.keys(setups)) {
    for (const holdingDays of [3, 5, 10, 20]) {
      for (const marketFilter of ['all', 'above_ma60']) {
        tests.set(`${setup}_h${holdingDays}_${marketFilter}`, []);
      }
    }
  }
  for (const { stock, history } of context.ohlcv.stocks) {
    if (!/^\d{4}$/.test(stock.symbol) || Number(stock.symbol) < 1000) continue;
    for (let index = 20; index + 2 < history.length; index += 1) {
      const shock = history[index];
      const previous = history[index - 1];
      const stabilize = history[index + 1];
      const entry = history[index + 2];
      const shockPct = (shock.close / previous.close - 1) * 100;
      if (shockPct > -8.5 || shockPct < -12 || shock.close < 5) continue;
      const shockGapPct = (shock.open / previous.close - 1) * 100;
      if (shockGapPct < -5 || shockGapPct > 4) continue;
      const tradeValue = mean(history.slice(index - 19, index + 1).map(row => row.close * row.volume));
      if (tradeValue < 30_000_000) continue;
      const gapPct = (entry.open / stabilize.close - 1) * 100;
      const range = Math.max(0.01, stabilize.high - stabilize.low);
      const row = {
        bullish: stabilize.close > stabilize.open,
        noNewLow: stabilize.low >= shock.low,
        volumeContract: stabilize.volume < shock.volume,
        lowerShadowRatio: (Math.min(stabilize.open, stabilize.close) - stabilize.low) / range
      };
      const eventRows = events.get(stabilize.date) || [];
      eventRows.push({
        signalDate: stabilize.date,
        entryDate: entry.date,
        symbol: stock.symbol,
        name: stock.name,
        market: stock.market,
        shockPct,
        close: stabilize.close,
        entryGapPct: gapPct,
        ...row,
        futureBars: history.slice(index + 2, index + 24).map(bar => ({
          date: bar.date,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          price: bar.close
        }))
      });
      events.set(stabilize.date, eventRows);
      for (const [setup, predicate] of Object.entries(setups)) {
        if (!predicate(row)) continue;
        for (const holdingDays of [3, 5, 10, 20]) {
          const exit = history[index + 1 + holdingDays];
          if (!exit) continue;
          const netReturn = (exit.close / entry.open - 1) * 100 - COST_PCT;
          tests.get(`${setup}_h${holdingDays}_all`).push(netReturn);
          if (market.get(stabilize.date)?.aboveMa60) {
            tests.get(`${setup}_h${holdingDays}_above_ma60`).push(netReturn);
          }
        }
      }
    }
  }
  const results = [...tests].map(([id, values]) => ({ id, ...summarize(values) }))
    .sort((left, right) => right.netMeanPct - left.netMeanPct);
  const configs = configurations();
  const validations = [];
  const randoms = [];
  const foldReports = [];
  for (const fold of foldWindows(context.startDate, context.endDate, 54, 18)) {
    const trained = configs.map(config => ({
      config,
      result: run(context, events, config, fold.trainStart, fold.trainEnd)
    })).filter(item => item.result.summary.trades >= 20
      && item.result.summary.maximumDrawdownPct >= -25)
      .sort((left, right) => right.result.summary.averageMonthlyEquityReturnPct
        - left.result.summary.averageMonthlyEquityReturnPct)[0];
    if (!trained) {
      foldReports.push({ ...fold, status: '訓練樣本不足' });
      continue;
    }
    const validation = run(context, events, trained.config, fold.validationStart, fold.validationEnd);
    const random = run(context, events, trained.config, fold.validationStart, fold.validationEnd, true);
    validations.push(validation);
    randoms.push(random);
    foldReports.push({
      ...fold,
      status: '完成',
      selectedConfig: trained.config,
      train: trained.result.summary,
      validation: validation.summary,
      random: random.summary
    });
  }
  const metrics = summarizeRuns(validations);
  const fairRandom = summarizeRuns(randoms);
  const validationStart = foldReports.find(row => row.status === '完成')?.validationStart;
  const validationEnd = [...foldReports].reverse().find(row => row.status === '完成')?.validationEnd;
  const etfHistory = JSON.parse(await fs.readFile(ETF_HISTORY, 'utf8'));
  const benchmark0050 = benchmark(etfHistory.series['0050.TW'] || [], validationStart, validationEnd);
  const targetMet = metrics.averageMonthlyReturnPct >= 5
    && metrics.maximumDrawdownPct >= -20
    && metrics.trades >= 300
    && metrics.profitFactor > 1.15
    && metrics.averageMonthlyReturnPct > benchmark0050.averageMonthlyReturnPct
    && metrics.averageMonthlyReturnPct > fairRandom.averageMonthlyReturnPct;
  const output = {
    generatedAt: new Date().toISOString(),
    ...identity,
    universe: '台股四位數普通股，ETF／0050 交易比重 0%',
    costAssumptionPct: COST_PCT,
    testedSetups: results.length,
    forwardReturnResults: results,
    forwardReturnCandidates: results.filter(row => row.samples >= 300
      && row.netMeanPct > 0 && row.netMedianPct > 0 && row.profitFactor > 1.15),
    testedConfigurations: configs.length,
    validationPeriod: `${validationStart}～${validationEnd}`,
    trainingMonthsPerFold: 54,
    validationMonthsPerFold: 18,
    folds: foldReports,
    metrics,
    benchmark0050,
    fairRandom,
    targetMonthlyReturnPct: 5,
    targetMet,
    paperTradingReady: false,
    liveTradingReady: false,
    survivorshipBiasWarning: true,
    conclusion: targetMet
      ? '達到歷史研究門檻，但仍須完成前瞻紙上交易。'
      : `尚未達到月均 5% 與全部風險門檻；目前月均 ${metrics.averageMonthlyReturnPct}%。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    testedSetups: results.length,
    forwardBest: results.slice(0, 5),
    testedConfigurations: configs.length,
    validationPeriod: output.validationPeriod,
    metrics,
    benchmark0050,
    fairRandom,
    targetMet,
    conclusion: output.conclusion
  }, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
