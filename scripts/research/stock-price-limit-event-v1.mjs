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
const OUTPUT = new URL('../../data/research/stock-price-limit-event-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_PRICE_LIMIT_EVENT_V1.md', import.meta.url);
const STRATEGY_ID = 'stock_price_limit_event_v1';
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

function average(history, start, end, key) {
  return mean(history.slice(Math.max(0, start), end + 1).map(row => row[key]).filter(Number.isFinite));
}

function atrPct(history, index, days = 14) {
  const values = [];
  for (let cursor = Math.max(1, index - days + 1); cursor <= index; cursor += 1) {
    const day = history[cursor];
    const prior = history[cursor - 1];
    values.push(Math.max(day.high - day.low, Math.abs(day.high - prior.close), Math.abs(day.low - prior.close)));
  }
  return mean(values) / history[index].close * 100;
}

function configurations() {
  const rows = [];
  for (const setup of ['limit_down_reversal', 'limit_up_continuation', 'limit_up_hold_restrength']) {
    for (const marketMode of ['bull_only', 'non_bear']) {
      for (const topN of [3, 5]) {
        for (const holdingDays of [1, 3, 5, 10]) {
          for (const stopMode of ['event_low', 'atr']) rows.push({ setup, marketMode, topN, holdingDays, stopMode });
        }
      }
    }
  }
  return rows;
}

function collectEvents(context) {
  const events = [];
  for (const { stock, history } of context.ohlcv.stocks) {
    if (!/^\d{4}$/.test(String(stock.symbol)) || Number(stock.symbol) < 1000) continue;
    const returns = history.map((day, index) => index ? day.close / history[index - 1].close - 1 : 0);
    for (let index = 130; index + 12 < history.length; index += 1) {
      if (hasHistoricalPriceAnomaly(returns, index)) continue;
      const day = history[index];
      const prior = history[index - 1];
      const market = context.marketByDate.get(day.date);
      if (!market) continue;
      const transactionValue = day.close * day.volume;
      if (transactionValue < 50_000_000) continue;
      const dailyReturnPct = pct(day.close, prior.close);
      const range = Math.max(day.high - day.low, day.close * 0.001);
      const closeLocation = (day.close - day.low) / range;
      const volume20 = average(history, index - 20, index - 1, 'volume');
      const volumeRatio = day.volume / Math.max(1, volume20);
      const ma20 = average(history, index - 19, index, 'close');
      const ma60 = average(history, index - 59, index, 'close');
      const stock20 = pct(day.close, history[index - 20].close);
      const relativeMarket20 = stock20 - (market.mom20 || 0);
      const volatilityPct = atrPct(history, index);
      const common = {
        stock, history, index, date: day.date, entryDate: history[index + 1].date, day, prior, market,
        transactionValue, dailyReturnPct, closeLocation, volumeRatio, ma20, ma60, relativeMarket20, volatilityPct
      };

      if (dailyReturnPct <= -9 && closeLocation <= 0.2 && volumeRatio >= 1.2 && volatilityPct <= 9) {
        events.push({ ...common, setup: 'limit_down_reversal', eventLow: day.low, support: day.low * 0.995 });
      }
      if (dailyReturnPct >= 9 && closeLocation >= 0.8 && volumeRatio >= 1.2 && day.close > ma20 && ma20 > ma60) {
        events.push({ ...common, setup: 'limit_up_continuation', eventLow: day.low, support: Math.max(day.low, day.close * (1 - volatilityPct / 100)) });
      }

      for (let eventIndex = index - 2; eventIndex >= index - 6; eventIndex -= 1) {
        const eventDay = history[eventIndex];
        const beforeEvent = history[eventIndex - 1];
        const eventReturn = pct(eventDay.close, beforeEvent.close);
        const eventRange = Math.max(eventDay.high - eventDay.low, eventDay.close * 0.001);
        const eventCloseLocation = (eventDay.close - eventDay.low) / eventRange;
        if (eventReturn < 9 || eventCloseLocation < 0.8) continue;
        const base = history.slice(eventIndex + 1, index + 1);
        const baseLow = Math.min(...base.map(row => row.low));
        const baseVolume = mean(base.map(row => row.volume));
        if (baseLow < eventDay.low * 0.995 || baseVolume > eventDay.volume * 0.8) continue;
        if (!(day.close > day.open && day.close > prior.close && day.close > ma20 && ma20 > ma60)) continue;
        events.push({
          ...common,
          setup: 'limit_up_hold_restrength',
          dailyReturnPct: eventReturn,
          volumeRatio: eventDay.volume / Math.max(1, average(history, eventIndex - 20, eventIndex - 1, 'volume')),
          eventLow: eventDay.low,
          support: Math.max(baseLow, eventDay.low),
          baseDays: index - eventIndex,
          baseVolumeRatio: baseVolume / Math.max(1, eventDay.volume)
        });
        break;
      }
    }
  }
  return events;
}

function eligible(row, config) {
  if (row.setup !== config.setup) return false;
  if (config.marketMode === 'bull_only' && !['BULL_TREND', 'THEME_MOMENTUM', 'BULL_PULLBACK'].includes(row.market.regime)) return false;
  if (config.marketMode === 'non_bear' && ['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.market.regime)) return false;
  if (row.setup === 'limit_down_reversal') return row.relativeMarket20 > -15;
  return row.relativeMarket20 > 0 && row.volatilityPct <= 7;
}

function score(row) {
  if (row.setup === 'limit_down_reversal') {
    return Math.abs(row.dailyReturnPct) * 2 + Math.min(4, row.volumeRatio) * 4 + row.relativeMarket20 - row.volatilityPct;
  }
  return row.dailyReturnPct * 2 + Math.min(5, row.volumeRatio) * 5 + row.relativeMarket20 * 1.5
    - row.volatilityPct - (row.baseVolumeRatio || 0) * 8;
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
      ? deterministicScore(`${date}|${left.stock.symbol}|limit`) - deterministicScore(`${date}|${right.stock.symbol}|limit`)
      : score(right) - score(left)).slice(0, config.topN);
    map.set(date, selected.map(row => {
      const atrStop = row.day.close * (1 - Math.min(8, Math.max(3, row.volatilityPct * 1.25)) / 100);
      const stopLossPrice = config.stopMode === 'event_low' ? row.support : atrStop;
      return {
        signalDate: row.date,
        entryDate: row.entryDate,
        symbol: row.stock.symbol,
        name: row.stock.name,
        market: row.stock.market,
        regime: row.market.regime,
        score: random ? deterministicScore(`${date}|${row.stock.symbol}|fair`) : score(row),
        entryMode: 'next_open_market',
        maxGapPct: row.setup === 'limit_down_reversal' ? 5 : 3,
        stopLossPrice,
        stopLossMode: 'intraday',
        rewardRisk: 0,
        maxHoldingDays: config.holdingDays,
        trailingStopRule: config.holdingDays >= 5 ? { triggerPct: 8, lockPct: 2, givebackPct: 5 } : null,
        positionPct: config.topN === 3 ? 20 : 12,
        accountRiskPct: 0.5,
        futureBars: row.history.slice(row.index + 1, row.index + config.holdingDays + 2).map(bar => ({
          date: bar.date, open: bar.open, high: bar.high, low: bar.low, close: bar.close, price: bar.close
        })),
        setup: row.setup === 'limit_down_reversal'
          ? `接近跌停 ${round(row.dailyReturnPct)}%，隔日才嘗試反轉`
          : row.setup === 'limit_up_continuation'
            ? `接近漲停 ${round(row.dailyReturnPct)}%，收在當日高檔且量能放大`
            : `接近漲停後量縮守支撐 ${row.baseDays} 日再轉強`,
        trigger: '訊號日收盤後成立，下一交易日開盤以合理滑價成交；跳空過大放棄',
        invalidation: `盤中跌破訊號日已知停損 ${round(stopLossPrice)}，跳空時使用較差開盤價`,
        exitPlan: `最多持有 ${config.holdingDays} 日${config.holdingDays >= 5 ? '，另採移動停利' : ''}`,
        reason: random ? '同日同候選池公平隨機' : '價格極限事件與後續可執行反應',
        orderIntent: { action: 'BUY', orderType: 'MARKET', timeInForce: 'DAY', earliestDate: row.entryDate }
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
      maxSinglePositionPct: 20,
      exposureLimits: { BULL_TREND: 80, THEME_MOMENTUM: 80, BULL_PULLBACK: 60, RANGE_BOUND: 40, HIGH_VOLATILITY: 0, BEAR_DEFENSE: 0 },
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

async function main() {
  const configs = configurations();
  const identityInput = {
    strategyId: STRATEGY_ID,
    dataSources: ['個股 OHLCV', '市場狀態', '成交值', '相對大盤強度', '價格極限事件'],
    setupRules: ['接近漲跌停事件', '漲停後量縮守支撐再轉強'],
    triggerRules: ['T 日收盤確認，T+1 開盤成交', '跳空過大放棄'],
    invalidationRules: ['訊號日已知低點或 ATR 停損，跳空採較差價格'],
    exitRules: ['1／3／5／10 日與移動停利'],
    riskRules: { accountRiskPct: 0.5, maximumPositionPct: 20, tPlusTwo: true },
    blockedWhen: ['空頭或高波動市場', '成交值不足', '價格異常'],
    parameters: { trainMonths: 48, validationMonths: 12, configs },
    trainPeriod: 'rolling 48 months',
    validationPeriod: 'rolling 12 months',
    costModel: '共用成交模擬器：手續費、交易稅、滑價',
    executionModel: 'T+1 開盤、跳空不利成交、絕對停損、T+2'
  };
  const identity = buildExperimentIdentity(identityInput);
  const decision = shouldSkipExperiment(await loadRegistry(), identity, { ...identityInput, newDataSources: ['價格極限事件'], coreRulesChanged: true });
  if (decision.skip && !process.argv.includes('--force')) {
    console.log(JSON.stringify({ skipped: true, ...decision, ...identity }, null, 2));
    return;
  }
  const [context, etfHistory] = await Promise.all([loadResearchContext(), fs.readFile(ETF_HISTORY, 'utf8').then(JSON.parse)]);
  const events = collectEvents(context);
  const validations = [];
  const randoms = [];
  const folds = [];
  for (const fold of foldWindows(context.startDate, context.endDate, 48, 12)) {
    const trained = [];
    for (const config of configs) {
      const result = run(context, events, config, fold.trainStart, fold.trainEnd);
      if (result.trades.length < 35 || result.summary.profitFactor < 1 || result.summary.maximumDrawdownPct < -20) continue;
      const segments = [0, 12, 24, 36].map(offset => run(context, events, config, `${shiftMonth(fold.trainStart, offset)}-01`, dayBeforeMonth(shiftMonth(fold.trainStart, offset + 12))));
      if (segments.some(row => row.trades.length < 5)) continue;
      const returns = segments.map(row => row.summary.averageMonthlyEquityReturnPct).sort((a, b) => a - b);
      trained.push({
        config,
        result,
        score: result.summary.averageMonthlyEquityReturnPct * 0.5 + returns[1] + returns[0] + result.summary.maximumDrawdownPct * 0.1
      });
    }
    const selected = trained.sort((left, right) => right.score - left.score)[0];
    if (!selected) {
      folds.push({ ...fold, status: '訓練證據不足，持有現金' });
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
  const targetMet = metrics.averageMonthlyReturnPct >= 5 && metrics.maximumDrawdownPct >= -20 && metrics.trades >= 300
    && metrics.profitFactor > 1.15 && metrics.averageMonthlyReturnPct > fairRandom.averageMonthlyReturnPct
    && metrics.averageMonthlyReturnPct > benchmark0050.averageMonthlyReturnPct;
  const output = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    experimentHash: identity.experimentHash,
    strategyFamilyId: identity.strategyFamilyId,
    universe: '純台股四碼普通股；ETF 交易占比 0%，0050 僅作比較',
    sourceEvents: Object.fromEntries(['limit_down_reversal', 'limit_up_continuation', 'limit_up_hold_restrength'].map(setup => [setup, events.filter(row => row.setup === setup).length])),
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
    survivorshipBiasWarning: true,
    conclusion: targetMet
      ? '達到研究候選門檻，但仍須先以全新期間紙上交易驗證，不可直接實盤。'
      : `找不到月均 5% 的可實盤純個股價格極限事件策略；目前 ${metrics.averageMonthlyReturnPct}%。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 純個股價格極限事件研究\n\n- 驗證區間：${output.validationPeriod}\n- 設定：${output.configurationsTested} 組\n- 月均總資產報酬：${metrics.averageMonthlyReturnPct}%（距 5%：${output.gapToTargetPct}%）\n- 年化報酬：${metrics.annualizedReturnPct}%\n- 最大回撤：${metrics.maximumDrawdownPct}%\n- 交易：${metrics.trades} 筆；勝率：${metrics.winRatePct}%；PF：${metrics.profitFactor}\n- 公平隨機月均：${fairRandom.averageMonthlyReturnPct}%；0050 月均：${benchmark0050.averageMonthlyReturnPct}%\n- 結論：${output.conclusion}\n\n所有訊號於 T 日收盤後成立，最早 T+1 開盤成交；已計入費稅、滑價、T+2、跳空不利成交及停損跳空。0050 僅作基準，交易標的全為個股。仍存在歷史股票池倖存者偏差，因此即使達標也只能先做紙上交易。\n`, 'utf8');
  console.log(JSON.stringify({ validationPeriod: output.validationPeriod, sourceEvents: output.sourceEvents, metrics, fairRandom, benchmark0050, targetMet, conclusion: output.conclusion }, null, 2));
}

await main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
