import fs from 'node:fs/promises';
import {
  deterministicScore,
  foldWindows,
  loadResearchContext,
  mean,
  round,
  simulateSignalMap
} from './research-core.mjs';

const OUTPUT = new URL('../../data/research/stock-second-strength-hunter-v1.json', import.meta.url);
const REPORT = new URL('../../docs/STOCK_SECOND_STRENGTH_HUNTER_V1.md', import.meta.url);
const ETF_HISTORY = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const STRATEGY_ID = 'stock_second_strength_hunter_v1';
const INITIAL_CAPITAL = 1_000_000;

function ma(rows, end, days, field = 'close') {
  if (end + 1 < days) return null;
  return mean(rows.slice(end + 1 - days, end + 1).map(row => row[field]));
}

function priorHigh(rows, end, days) {
  if (end < days) return null;
  return Math.max(...rows.slice(end - days, end).map(row => row.high));
}

function tradeValue20(rows, index) {
  return ma(rows, index, 20, 'volume') * rows[index].close;
}

function buildCandidates(context) {
  const byDate = new Map();
  for (const { stock, history } of context.ohlcv.stocks) {
    if (!/^\d{4}$/.test(stock.symbol)) continue;
    for (let eventIndex = 80; eventIndex + 12 < history.length; eventIndex += 1) {
      const event = history[eventIndex];
      const prior = history[eventIndex - 1];
      const ma20 = ma(history, eventIndex, 20);
      const ma60 = ma(history, eventIndex, 60);
      const avgVolume20 = ma(history, eventIndex - 1, 20, 'volume');
      const volumeRatio = avgVolume20 ? event.volume / avgVolume20 : 0;
      const eventReturnPct = (event.close / prior.close - 1) * 100;
      const high20 = priorHigh(history, eventIndex, 20);
      const breakout = high20 && event.close > high20;
      const liquid = tradeValue20(history, eventIndex) >= 80_000_000;
      if (!liquid || event.close < 10 || !ma20 || !ma60) continue;
      if (!(eventReturnPct >= 4.5 || breakout) || volumeRatio < 1.2) continue;
      if (event.close < ma20 || ma20 < ma60) continue;
      const support = Math.max(ma20, high20 || ma20, event.low);
      for (let triggerIndex = eventIndex + 2; triggerIndex <= eventIndex + 8; triggerIndex += 1) {
        const trigger = history[triggerIndex];
        const previous = history[triggerIndex - 1];
        const triggerMa20 = ma(history, triggerIndex, 20);
        const pullbackLow = Math.min(...history.slice(eventIndex + 1, triggerIndex + 1).map(row => row.low));
        const compactHigh = Math.max(...history.slice(eventIndex + 1, triggerIndex).map(row => row.high));
        const distanceToMa20Pct = triggerMa20 ? (trigger.close / triggerMa20 - 1) * 100 : 99;
        const noSupportBreak = pullbackLow >= support * 0.94;
        const secondStrength = trigger.close > previous.high || trigger.close > compactHigh;
        const notOverChase = distanceToMa20Pct <= 10;
        const noUpperWick = (trigger.high - Math.max(trigger.open, trigger.close))
          / Math.max(0.01, trigger.high - trigger.low) <= 0.45;
        if (!noSupportBreak || !secondStrength || !notOverChase || !noUpperWick) continue;
        const entry = history[triggerIndex + 1];
        if (!entry?.open) continue;
        const futureBars = history.slice(triggerIndex + 1, triggerIndex + 31).map(row => ({
          date: row.date,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          price: row.close
        }));
        const score = eventReturnPct
          + Math.min(4, volumeRatio) * 3
          + (breakout ? 8 : 0)
          - Math.abs(distanceToMa20Pct)
          + (tradeValue20(history, triggerIndex) >= 150_000_000 ? 4 : 0);
        const candidate = {
          signalDate: trigger.date,
          entryDate: entry.date,
          symbol: stock.symbol,
          name: stock.name,
          market: stock.market,
          close: trigger.close,
          score,
          atrPct: Math.max(2, Math.min(8, (event.high - event.low) / event.close * 100)),
          stopLossPrice: Math.min(pullbackLow, trigger.low),
          stopDistancePct: Math.max(3.5, Math.min(8, (trigger.close / Math.min(pullbackLow, trigger.low) - 1) * 100)),
          futureBars,
          setup: ['爆量長紅或突破後整理不破'],
          trigger: ['整理 2~8 天後重新站上整理高點或前一日高點'],
          invalidation: ['跌破整理低點或收盤停損'],
          exitPlan: '固定持有或 1.5R/2R 停利，搭配共用成交模擬器',
          reason: '不追第一根強勢 K，等二次轉強才隔日開盤進場',
          orderIntent: { action: 'BUY', orderType: 'MARKET', timeInForce: 'DAY', earliestDate: entry.date }
        };
        const rows = byDate.get(trigger.date) || [];
        rows.push(candidate);
        byDate.set(trigger.date, rows);
        break;
      }
    }
  }
  for (const [date, rows] of byDate) rows.sort((a, b) => b.score - a.score);
  return byDate;
}

function configs() {
  const rows = [];
  for (const top of [5, 8, 10]) {
    for (const holdingDays of [5, 10, 15]) {
      for (const rewardRisk of [1.5, 2, 0]) {
        for (const accountRiskPct of [0.5, 0.75]) {
          rows.push({
            id: `second_strength_top${top}_hold${holdingDays}_rr${rewardRisk || 'trail'}_risk${accountRiskPct}`,
            top,
            holdingDays,
            rewardRisk,
            accountRiskPct,
            positionPct: top === 5 ? 12 : top === 8 ? 8 : 6
          });
        }
      }
    }
  }
  return rows;
}

function signalMap(candidates, config, random = false) {
  return new Map([...candidates].map(([date, rows]) => [
    date,
    rows.map(row => ({
      ...row,
      score: random ? deterministicScore(`${date}|${row.symbol}|second-strength`) : row.score,
      positionPct: config.positionPct,
      accountRiskPct: config.accountRiskPct,
      maxHoldingDays: config.holdingDays,
      rewardRisk: config.rewardRisk,
      trailingStopRule: config.rewardRisk ? null : { triggerPct: 8, givebackPct: 5, lockPct: 2 },
      stopLossMode: 'close',
      entryGapRange: { minimumPct: -4, maximumPct: 5 }
    })).sort((a, b) => b.score - a.score).slice(0, config.top)
  ]).filter(([, rows]) => rows.length));
}

function run(context, candidates, config, startDate, endDate, random = false) {
  return simulateSignalMap(context, signalMap(candidates, config, random), {
    strategyId: random ? `${STRATEGY_ID}_random` : STRATEGY_ID,
    startDate,
    endDate,
    initialCapital: INITIAL_CAPITAL,
    maxOpenPositions: config.top,
    holdingDays: config.holdingDays,
    accountRiskPct: config.accountRiskPct,
    riskRules: {
      maxAccountRiskPct: 0.75,
      maxSinglePositionPct: 12,
      exposureLimits: {
        BULL_TREND: 70,
        THEME_MOMENTUM: 70,
        BULL_PULLBACK: 55,
        RANGE_BOUND: 35,
        HIGH_VOLATILITY: 15,
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

function summarize(runs) {
  const monthly = runs.flatMap(row => row.summary.monthly);
  const trades = runs.flatMap(row => row.trades);
  const curve = runs.flatMap(row => row.equityCurve);
  let equity = INITIAL_CAPITAL;
  let peak = equity;
  let maximumDrawdownPct = 0;
  for (const row of curve) {
    equity *= 1 + row.dailyReturnPct / 100;
    peak = Math.max(peak, equity);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, (equity / peak - 1) * 100);
  }
  const gains = trades.filter(row => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
  const losses = Math.abs(trades.filter(row => row.realizedPnl <= 0).reduce((sum, row) => sum + row.realizedPnl, 0));
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
    negativeMonths: monthly.filter(row => row.equityReturnPct < 0).length
  };
}

function benchmark(series, startDate, endDate) {
  const rows = series.filter(row => row.date >= startDate && row.date <= endDate);
  const monthEnd = new Map(rows.map(row => [row.date.slice(0, 7), row.close]));
  let prior = [...series].reverse().find(row => row.date < startDate)?.close ?? rows[0]?.close;
  const returns = [];
  for (const close of monthEnd.values()) {
    returns.push((close / prior - 1) * 100);
    prior = close;
  }
  return { averageMonthlyReturnPct: round(mean(returns)) };
}

function trainScore(summary) {
  if (summary.trades < 20 || summary.maximumDrawdownPct < -30) return -Infinity;
  return summary.averageMonthlyEquityReturnPct * 8
    + Math.min(3, summary.profitFactor || 0) * 1.4
    + summary.maximumDrawdownPct * 0.15
    + Math.min(2, summary.trades / 120);
}

async function main() {
  const context = await loadResearchContext();
  const candidates = buildCandidates(context);
  const configRows = configs();
  const folds = foldWindows(context.startDate, context.endDate, 54, 18);
  const validations = [];
  const randoms = [];
  const foldReports = [];
  for (const fold of folds) {
    const selected = configRows.map(config => {
      const result = run(context, candidates, config, fold.trainStart, fold.trainEnd);
      return { config, result, score: trainScore(result.summary) };
    }).sort((a, b) => b.score - a.score)[0];
    if (!selected || selected.score === -Infinity) continue;
    const validation = run(context, candidates, selected.config, fold.validationStart, fold.validationEnd);
    const random = run(context, candidates, selected.config, fold.validationStart, fold.validationEnd, true);
    validations.push(validation);
    randoms.push(random);
    foldReports.push({
      validationPeriod: `${fold.validationStart}~${fold.validationEnd}`,
      selectedConfig: selected.config,
      train: selected.result.summary,
      validation: validation.summary
    });
  }
  const metrics = summarize(validations);
  const fairRandom = summarize(randoms);
  const validationStart = foldReports[0]?.validationPeriod.slice(0, 10);
  const validationEnd = foldReports.at(-1)?.validationPeriod.slice(-10);
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
    strategyId: STRATEGY_ID,
    universe: '純個股，不以 ETF 或 0050 為主要交易標的。',
    candidateDays: candidates.size,
    testedConfigurations: configRows.length,
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
    conclusion: targetMet
      ? '達到月均 5% 門檻，但仍需紙上交易驗證後才可討論實盤。'
      : `未達月均 5% 可實盤門檻；validation 月均 ${metrics.averageMonthlyReturnPct}%，不可 paper trading、不可實盤。`
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, `# 二次轉強純個股策略 v1\n\n- 驗證期間：${validationStart} 到 ${validationEnd}\n- 交易筆數：${metrics.trades}\n- 月均報酬：${metrics.averageMonthlyReturnPct}%\n- 年化報酬：${metrics.annualizedReturnPct}%\n- 最大回撤：${metrics.maximumDrawdownPct}%\n- Profit Factor：${metrics.profitFactor}\n- 勝率：${metrics.winRatePct}%\n- 0050 同期月均：${benchmark0050.averageMonthlyReturnPct}%\n- 公平隨機月均：${fairRandom.averageMonthlyReturnPct}%\n- 結論：${output.conclusion}\n\n策略邏輯：不追第一根爆量長紅或突破，等待 2 到 8 天整理不破支撐，再於二次轉強後隔日開盤進場。回測使用共用成交模擬器、費稅滑價、T+2 與風控規則。\n`, 'utf8');
  console.log(JSON.stringify({
    candidateDays: candidates.size,
    testedConfigurations: configRows.length,
    validationPeriod: `${validationStart}~${validationEnd}`,
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
