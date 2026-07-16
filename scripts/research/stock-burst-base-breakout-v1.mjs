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
const OUTPUT = new URL('../../data/research/stock-burst-base-breakout-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_BURST_BASE_BREAKOUT_V1.md', import.meta.url);
const STRATEGY_ID = 'stock_burst_base_breakout_v1';
const CAPITAL = 1_000_000;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const pct = (value, base) => base ? (value / base - 1) * 100 : 0;
const compact = summary => {
  const { monthly, ...metrics } = summary;
  return metrics;
};

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
  for (const burstReturnPct of [5, 7]) {
    for (const burstVolumeRatio of [2, 3]) {
      for (const maxBaseDays of [5, 10]) {
        for (const supportMode of ['burst_midpoint', 'base_low']) {
          for (const topN of [3, 5]) {
            for (const holdingDays of [10, 20, 40]) {
              rows.push({ burstReturnPct, burstVolumeRatio, maxBaseDays, supportMode, topN, holdingDays });
            }
          }
        }
      }
    }
  }
  return rows;
}

function average(history, start, end, key) {
  const values = history.slice(Math.max(0, start), end + 1).map(row => row[key]).filter(Number.isFinite);
  return mean(values);
}

function trueRangeAverage(history, index, days = 14) {
  const values = [];
  for (let cursor = Math.max(1, index - days + 1); cursor <= index; cursor += 1) {
    const day = history[cursor];
    const prior = history[cursor - 1];
    values.push(Math.max(day.high - day.low, Math.abs(day.high - prior.close), Math.abs(day.low - prior.close)));
  }
  return mean(values);
}

function broadEvents(context) {
  const events = [];
  for (const { stock, history } of context.ohlcv.stocks) {
    if (!/^\d{4}$/.test(String(stock.symbol)) || Number(stock.symbol) < 1000) continue;
    const returns = history.map((day, index) => index ? day.close / history[index - 1].close - 1 : 0);
    for (let index = 130; index + 41 < history.length; index += 1) {
      const day = history[index];
      const market = context.marketByDate.get(day.date);
      if (!market || !['BULL_TREND', 'THEME_MOMENTUM', 'BULL_PULLBACK'].includes(market.regime)) continue;
      if (hasHistoricalPriceAnomaly(returns, index)) continue;
      const ma20 = average(history, index - 19, index, 'close');
      const ma60 = average(history, index - 59, index, 'close');
      if (!(day.close > ma20 && ma20 > ma60 && market.close > market.ma60)) continue;
      const transactionValue = day.close * day.volume;
      if (transactionValue < 30_000_000) continue;
      let best = null;
      for (let burstIndex = index - 2; burstIndex >= index - 10; burstIndex -= 1) {
        const burst = history[burstIndex];
        const prior = history[burstIndex - 1];
        const burstReturn = pct(burst.close, prior.close);
        const priorVolume = average(history, burstIndex - 20, burstIndex - 1, 'volume');
        const volumeRatio = priorVolume ? burst.volume / priorVolume : 0;
        const range = Math.max(burst.high - burst.low, burst.close * 0.001);
        const closeLocation = (burst.close - burst.low) / range;
        if (burstReturn < 4.5 || volumeRatio < 1.7 || burst.close <= burst.open || closeLocation < 0.65) continue;
        const base = history.slice(burstIndex + 1, index + 1);
        const baseLow = Math.min(...base.map(row => row.low));
        const baseHigh = Math.max(...base.map(row => row.high));
        const burstMidpoint = (burst.open + burst.close) / 2;
        const baseVolumeRatio = mean(base.map(row => row.volume)) / Math.max(1, burst.volume);
        if (baseLow < burst.low * 0.99 || baseVolumeRatio > 0.95 || day.close > burst.close * 1.15) continue;
        const candidate = { burstIndex, burst, burstReturn, volumeRatio, base, baseLow, baseHigh, burstMidpoint, baseVolumeRatio };
        if (!best || burstReturn + volumeRatio * 2 > best.burstReturn + best.volumeRatio * 2) best = candidate;
      }
      if (!best) continue;
      const market20 = market.mom20 || 0;
      const stock20 = pct(day.close, history[index - 20].close);
      const atrPct = trueRangeAverage(history, index) / day.close * 100;
      if (atrPct < 1.3 || atrPct > 7 || stock20 - market20 < 0) continue;
      events.push({
        stock,
        history,
        index,
        date: day.date,
        entryDate: history[index + 1].date,
        day,
        market,
        ma20,
        ma60,
        atrPct,
        relativeMarket20: stock20 - market20,
        transactionValue,
        ...best
      });
    }
  }
  return events;
}

function eligible(row, config) {
  const baseDays = row.index - row.burstIndex;
  const support = config.supportMode === 'burst_midpoint' ? row.burstMidpoint : row.baseLow;
  const riskPct = pct(row.baseHigh, support);
  return row.burstReturn >= config.burstReturnPct
    && row.volumeRatio >= config.burstVolumeRatio
    && baseDays >= 2
    && baseDays <= config.maxBaseDays
    && row.baseVolumeRatio <= 0.8
    && row.day.close >= support
    && row.day.close > row.day.open
    && row.day.close >= row.history[row.index - 1].close
    && riskPct >= 2
    && riskPct <= 9;
}

function score(row) {
  return row.burstReturn * 1.8
    + Math.min(5, row.volumeRatio) * 5
    + row.relativeMarket20 * 1.5
    - row.baseVolumeRatio * 10
    - row.atrPct;
}

function buildMap(events, config, random = false) {
  const byDate = new Map();
  for (const row of events) {
    if (!eligible(row, config)) continue;
    const rows = byDate.get(row.date) || [];
    rows.push(row);
    byDate.set(row.date, rows);
  }
  const map = new Map();
  for (const [date, rows] of byDate) {
    const selected = [...rows].sort((left, right) => random
      ? deterministicScore(`${date}|${left.stock.symbol}|burst`) - deterministicScore(`${date}|${right.stock.symbol}|burst`)
      : score(right) - score(left)).slice(0, config.topN);
    map.set(date, selected.map(row => {
      const support = config.supportMode === 'burst_midpoint' ? row.burstMidpoint : row.baseLow;
      return {
        signalDate: row.date,
        entryDate: row.entryDate,
        symbol: row.stock.symbol,
        name: row.stock.name,
        market: row.stock.market,
        regime: row.market.regime,
        score: random ? deterministicScore(`${date}|${row.stock.symbol}|fair`) : score(row),
        entryMode: 'resistance_breakout',
        triggerPrice: row.baseHigh,
        maxEntryOverTriggerPct: 3,
        stopLossPrice: support * 0.99,
        stopLossMode: 'close',
        rewardRisk: 0,
        maxHoldingDays: config.holdingDays,
        trailingStopRule: config.holdingDays >= 20 ? { triggerPct: 10, lockPct: 2, givebackPct: 6 } : null,
        positionPct: config.topN === 3 ? 15 : 10,
        accountRiskPct: 0.5,
        futureBars: row.history.slice(row.index + 1, row.index + config.holdingDays + 2).map(bar => ({
          date: bar.date, open: bar.open, high: bar.high, low: bar.low, close: bar.close, price: bar.close
        })),
        setup: `爆量長紅後整理 ${row.index - row.burstIndex} 日，量縮至爆量日 ${round(row.baseVolumeRatio * 100)}%`,
        trigger: `突破整理高點 ${round(row.baseHigh)}；跳空超過觸發價 3% 放棄`,
        invalidation: `收盤跌破已知支撐 ${round(support * 0.99)}，次日開盤退出`,
        exitPlan: `最多持有 ${config.holdingDays} 日${config.holdingDays >= 20 ? '，另採移動停利' : ''}`,
        reason: random ? '同日同候選池公平隨機' : '爆量長紅、量縮守支撐、整理後再攻',
        orderIntent: { action: 'BUY', orderType: 'STOP_LIMIT', triggerPrice: row.baseHigh, timeInForce: 'DAY', earliestDate: row.entryDate }
      };
    }));
  }
  return map;
}

function run(context, events, config, startDate, endDate, random = false) {
  return simulateSignalMap(context, buildMap(events, config, random), {
    strategyId: `${STRATEGY_ID}${random ? '_random' : ''}`,
    startDate,
    endDate,
    initialCapital: CAPITAL,
    maxOpenPositions: config.topN,
    accountRiskPct: 0.5,
    riskRules: {
      maxAccountRiskPct: 0.5,
      maxSinglePositionPct: 15,
      exposureLimits: { BULL_TREND: 75, THEME_MOMENTUM: 75, BULL_PULLBACK: 55, RANGE_BOUND: 0, HIGH_VOLATILITY: 0, BEAR_DEFENSE: 0 },
      drawdownBlockPct: 8,
      drawdownBlockDays: 20,
      monthlyLossBlockPct: 5,
      dailyLossBlockPct: 2,
      losingStreakCount: 4,
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

async function writeReport(output) {
  const lines = [
    '# 純個股爆量整理再攻研究', '',
    `- 驗證區間：${output.validationPeriod}`,
    `- 原始型態事件：${output.sourceEvents} 筆；設定：${output.configurationsTested} 組`,
    `- 月均總資產報酬：${output.metrics.averageMonthlyReturnPct}%（距 5%：${output.gapToTargetPct}%）`,
    `- 年化報酬：${output.metrics.annualizedReturnPct}%`,
    `- 最大回撤：${output.metrics.maximumDrawdownPct}%`,
    `- 交易：${output.metrics.trades} 筆；勝率：${output.metrics.winRatePct}%；PF：${output.metrics.profitFactor}`,
    `- 公平隨機月均：${output.fairRandom.averageMonthlyReturnPct}%；0050 月均：${output.benchmark0050.averageMonthlyReturnPct}%`,
    `- 結論：${output.conclusion}`, '',
    '0050 僅作比較，交易標的全部為四碼普通股。成交使用共用模擬器，突破跳空採較差開盤價，追價超過 3% 放棄；支撐停損為訊號日已知價格。'
  ];
  await fs.writeFile(REPORT, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const configs = configurations();
  const identityInput = {
    strategyId: STRATEGY_ID,
    dataSources: ['個股 OHLCV', '市場狀態', '成交值', '相對大盤強度'],
    setupRules: ['爆量長紅後整理 2 至 10 日', '量縮且守住爆量 K 支撐'],
    triggerRules: ['隔日突破整理高點才成交', '跳空追價超過 3% 放棄'],
    invalidationRules: ['收盤跌破爆量 K 中線或整理低點，隔日開盤退出'],
    exitRules: ['10／20／40 日與移動停利'],
    riskRules: { accountRiskPct: 0.5, maximumPositionPct: 15, tPlusTwo: true },
    blockedWhen: ['震盪、空頭或高波動市場', '成交值不足', 'ATR 過高'],
    parameters: { trainMonths: 54, validationMonths: 18, configs },
    trainPeriod: 'rolling 54 months',
    validationPeriod: 'rolling 18 months',
    costModel: '共用成交模擬器：手續費、交易稅、滑價',
    executionModel: '真實壓力突破、跳空不利成交、絕對支撐停損、T+2'
  };
  const identity = buildExperimentIdentity(identityInput);
  const decision = shouldSkipExperiment(await loadRegistry(), identity, { ...identityInput, newDataSources: ['爆量整理型態事件'], coreRulesChanged: true });
  if (decision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...decision, ...identity }, null, 2));
    return;
  }
  const [context, etfHistory] = await Promise.all([
    loadResearchContext(),
    fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)
  ]);
  const events = broadEvents(context);
  const validations = [];
  const randoms = [];
  const folds = [];
  for (const fold of foldWindows(context.startDate, context.endDate, 54, 18)) {
    const trained = [];
    const diagnostics = [];
    let initialPass = 0;
    for (const config of configs) {
      const result = run(context, events, config, fold.trainStart, fold.trainEnd);
      diagnostics.push({ config, summary: compact(result.summary) });
      if (result.trades.length < 50 || result.summary.profitFactor < 1 || result.summary.maximumDrawdownPct < -20) continue;
      initialPass += 1;
      const segments = [0, 18, 36].map(offset => run(
        context,
        events,
        config,
        `${shiftMonth(fold.trainStart, offset)}-01`,
        dayBeforeMonth(shiftMonth(fold.trainStart, offset + 18))
      ));
      if (segments.some(row => row.trades.length < 10)) continue;
      const segmentReturns = segments.map(row => row.summary.averageMonthlyEquityReturnPct).sort((a, b) => a - b);
      trained.push({
        config,
        result,
        score: result.summary.averageMonthlyEquityReturnPct * 0.4
          + segmentReturns[1] * 0.7
          + segmentReturns[0]
          + result.summary.maximumDrawdownPct * 0.12
      });
    }
    const selected = trained.sort((left, right) => right.score - left.score)[0];
    if (!selected) {
      folds.push({
        ...fold,
        status: '訓練證據不足，持有現金',
        initialPass,
        stablePass: trained.length,
        bestTrainingDiagnostics: diagnostics.sort((left, right) => (
          right.summary.averageMonthlyEquityReturnPct + right.summary.maximumDrawdownPct * 0.03
          - left.summary.averageMonthlyEquityReturnPct - left.summary.maximumDrawdownPct * 0.03
        )).slice(0, 3)
      });
      continue;
    }
    const validation = run(context, events, selected.config, fold.validationStart, fold.validationEnd);
    const random = run(context, events, selected.config, fold.validationStart, fold.validationEnd, true);
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
    sourceEvents: events.length,
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
      ? '達到研究候選門檻，但仍須先做紙上交易，不可直接實盤。'
      : metrics.months
        ? `找不到月均 5% 的可實盤純個股爆量整理再攻策略；目前 ${metrics.averageMonthlyReturnPct}%。`
        : '所有訓練設定皆未達 PF 1，策略為負期望，因此不進入 validation。'
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await writeReport(output);
  console.log(JSON.stringify({ validationPeriod: output.validationPeriod, sourceEvents: events.length, metrics, fairRandom, benchmark0050, targetMet, conclusion: output.conclusion }, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
