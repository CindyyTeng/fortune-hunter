import fs from 'node:fs/promises';
import { netReturnPct as sharedNetReturnPct } from './lib/execution-simulator.mjs';

const INPUT = new URL('../data/tw-backtest-2y.json', import.meta.url);
const OUTPUT = new URL('../data/risk-rule-comparison.json', import.meta.url);
const BUY_SIGNAL = '\u8cb7\u5165\u5019\u9078';
const INITIAL_CAPITAL = 1_000_000;
const MAX_OPEN_POSITIONS = 8;
const TRAIN_END = '2025-05';

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function monthKeys(startDate, endDate) {
  const [startYear, startMonth] = startDate.split('-').map(Number);
  const [endYear, endMonth] = endDate.split('-').map(Number);
  const keys = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    keys.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month === 13) {
      year += 1;
      month = 1;
    }
  }
  return keys;
}

function buildDays(trades) {
  const days = new Map();
  const dayOf = date => {
    if (!days.has(date)) days.set(date, { entries: [], exits: [], marks: [] });
    return days.get(date);
  };
  for (const trade of trades) {
    dayOf(trade.entryDate).entries.push(trade);
    dayOf(trade.exitDate).exits.push(trade);
    for (const mark of trade.markPrices || []) {
      dayOf(mark.date).marks.push({ tradeId: trade.tradeId, price: mark.price });
    }
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function netMarkedReturnPct(trade, price, assumptions) {
  return sharedNetReturnPct(trade.entryPrice, price, {
    buyFeePct: assumptions.buyFeePct,
    sellFeePct: assumptions.sellFeePct,
    sellTaxPct: assumptions.sellTaxPct,
    buySlippagePct: assumptions.buySlippagePct,
    sellSlippagePct: assumptions.sellSlippagePct
  });
}

function applyExitRule(trades, assumptions, rule) {
  if (!rule) return trades;
  return trades.map(trade => {
    let active = false;
    let peakReturnPct = -Infinity;
    const marks = trade.markPrices || [];
    for (let index = 0; index < marks.length - 1; index += 1) {
      const mark = marks[index];
      const returnPct = netMarkedReturnPct(trade, mark.price, assumptions);
      peakReturnPct = Math.max(peakReturnPct, returnPct);
      if (peakReturnPct >= rule.triggerPct) active = true;
      const floorPct = Math.max(rule.lockPct, peakReturnPct - rule.trailPct);
      if (active && returnPct <= floorPct) {
        return {
          ...trade,
          exitDate: mark.date,
          exitPrice: mark.price,
          exitReason: `close_trail_${rule.triggerPct}_${rule.trailPct}_${rule.lockPct}`,
          netReturnPct: round(returnPct),
          holdingDays: index + 1,
          markPrices: marks.slice(0, index + 1)
        };
      }
    }
    return trade;
  });
}

function applyNoFollowRule(trades, assumptions, rule) {
  if (!rule) return trades;
  return trades.map(trade => {
    const marks = trade.markPrices || [];
    let maxHigh = trade.entryPrice;
    for (let index = 0; index < marks.length - 1; index += 1) {
      const mark = marks[index];
      maxHigh = Math.max(maxHigh, mark.high ?? mark.price);
      if (index + 1 < rule.days) continue;
      const maxAdvancePct = (maxHigh / trade.entryPrice - 1) * 100;
      if (maxAdvancePct >= rule.minMfePct) return trade;
      return {
        ...trade,
        exitDate: mark.date,
        exitPrice: mark.price,
        exitReason: `no_follow_${rule.days}_${rule.minMfePct}`,
        netReturnPct: round(netMarkedReturnPct(trade, mark.price, assumptions)),
        holdingDays: index + 1,
        markPrices: marks.slice(0, index + 1)
      };
    }
    return trade;
  });
}

function priceForNetReturn(trade, netReturnPct, assumptions) {
  const entryCost = trade.entryPrice * (1 + (
    assumptions.buyFeePct + assumptions.buySlippagePct
  ) / 100);
  const sellCostRate = (
    assumptions.sellFeePct + assumptions.sellTaxPct + assumptions.sellSlippagePct
  ) / 100;
  return entryCost * (1 + netReturnPct / 100) / (1 - sellCostRate);
}

function applyIntradayTrailRule(trades, assumptions, rule) {
  return trades.map(trade => {
    const marks = trade.markPrices || [];
    let priorPeakNetPct = -Infinity;
    for (let index = 0; index < marks.length - 1; index += 1) {
      const mark = marks[index];
      if (priorPeakNetPct >= rule.triggerPct) {
        const floorPct = Math.max(rule.lockPct, priorPeakNetPct - rule.trailPct);
        const stopPrice = priceForNetReturn(trade, floorPct, assumptions);
        if ((mark.low ?? mark.price) <= stopPrice) {
          const exitPrice = Math.min(stopPrice, mark.price);
          return {
            ...trade,
            exitDate: mark.date,
            exitPrice: round(exitPrice),
            exitReason: `intraday_trail_${rule.triggerPct}_${rule.trailPct}_${rule.lockPct}`,
            netReturnPct: round(netMarkedReturnPct(trade, exitPrice, assumptions)),
            holdingDays: index + 1,
            markPrices: marks.slice(0, index + 1)
          };
        }
      }
      priorPeakNetPct = Math.max(
        priorPeakNetPct,
        netMarkedReturnPct(trade, mark.high ?? mark.price, assumptions)
      );
    }
    return trade;
  });
}

function confirmationCount(trade) {
  return [
    trade.marketMovePct >= 0.25,
    trade.themeMovePct >= 0.25,
    trade.globalCompositePct >= 0,
    trade.asiaCompositePct >= 0,
    trade.gapUpPct >= 0.5
  ].filter(Boolean).length;
}

function isWatchFallback(trade, config) {
  return config.watchFallbackPositionPct > 0
    && trade.signal !== BUY_SIGNAL
    && confirmationCount(trade) === 3
    && trade.signalScore >= 85
    && trade.gapUpPct >= 0.5;
}

function currentPositionPct(trade, config = {}) {
  if (trade.globalCompositePct <= -1.5 || trade.asiaCompositePct <= -1.2) return 0;
  if (trade.marketMovePct <= -1 || trade.themeMovePct <= -1) return 0;
  if (trade.gapUpPct < 0) return 0;
  if (isWatchFallback(trade, config)) return config.watchFallbackPositionPct;
  let positionPct = trade.signal !== BUY_SIGNAL
    ? config.currentExploratoryPositionPct ?? 20
    : trade.strictRisk
      ? config.currentDefensivePositionPct ?? 20
      : config.currentStandardPositionPct ?? 44;
  if (trade.marketMovePct >= 1 && trade.themeMovePct >= 1) {
    positionPct = Math.min(60, positionPct * 1.5);
  }
  if (config.currentAccountRiskCapPct) {
    const stopDistancePct = (
      (trade.entryPrice - trade.stopLoss) / trade.entryPrice
    ) * 100;
    if (stopDistancePct > 0) {
      positionPct = Math.min(
        positionPct,
        config.currentAccountRiskCapPct * 100 / stopDistancePct
      );
    }
  }
  return positionPct;
}

function passesEntryFilter(trade, config) {
  const confirmations = confirmationCount(trade);
  const requiredConfirmations = trade.signal === BUY_SIGNAL
    ? config.buyConfirmCount ?? 2
    : config.explorationConfirmCount ?? 4;
  if (confirmations < requiredConfirmations && !isWatchFallback(trade, config)) return false;
  return trade.gapUpPct >= (config.minGapUpPct ?? -Infinity)
    && trade.std20Pct >= (config.minStd20Pct ?? -Infinity)
    && trade.avg20TradeValue >= (config.minAvg20TradeValue ?? 0);
}

function optimizedPositionPct(trade, config, monthReturnPct) {
  if (config.profitLockPct !== null && monthReturnPct >= config.profitLockPct) return 0;
  if (config.lossBrakePct !== null && monthReturnPct <= config.lossBrakePct) return 0;
  if (trade.globalCompositePct <= -1.5 || trade.asiaCompositePct <= -1.2) return 0;
  if (trade.marketMovePct <= -1 || trade.themeMovePct <= -1 || trade.gapUpPct < 0) return 0;

  const weak = [
    trade.marketMovePct <= config.marketWeakPct,
    trade.themeMovePct <= config.themeWeakPct,
    trade.globalCompositePct <= config.globalWeakPct,
    trade.asiaCompositePct <= config.asiaWeakPct,
    trade.gapUpPct < 0
  ].filter(Boolean).length;
  if (weak >= config.cashRiskCount) return 0;

  let positionPct = trade.signal === BUY_SIGNAL
    ? config.standardPositionPct
    : config.exploratoryPositionPct;
  if (trade.strictRisk || weak >= config.defensiveRiskCount) {
    positionPct = Math.min(positionPct, config.defensivePositionPct);
  }

  const strong = trade.marketMovePct >= 1
    && trade.themeMovePct >= 1
    && trade.globalCompositePct > config.globalWeakPct
    && trade.asiaCompositePct > config.asiaWeakPct;
  if (strong) positionPct = Math.min(60, positionPct * config.strongBoost);
  return positionPct;
}

function summarize(monthly, finalCapital, maxDrawdownPct, trades) {
  const returns = monthly.map(row => row.returnPct);
  const train = monthly.filter(row => row.month <= TRAIN_END);
  const test = monthly.filter(row => row.month > TRAIN_END);
  const average = rows => rows.reduce((sum, row) => sum + row.returnPct, 0) / Math.max(1, rows.length);
  return {
    finalCapital: round(finalCapital, 0),
    portfolioReturnPct: round((finalCapital / INITIAL_CAPITAL - 1) * 100),
    avgMonthlyReturnPct: round(average(monthly)),
    trainAvgMonthlyReturnPct: round(average(train)),
    testAvgMonthlyReturnPct: round(average(test)),
    monthsHitTarget: returns.filter(value => value >= 10).length,
    monthsBelowZero: returns.filter(value => value < 0).length,
    worstMonthPct: round(Math.min(...returns)),
    maxDrawdownPct: round(maxDrawdownPct),
    executedTrades: trades
  };
}

function rankEntries(entries, mode = 'current') {
  const value = (trade, key) => Number(trade[key]) || 0;
  const signal = trade => trade.signal === BUY_SIGNAL ? 1 : 0;
  const comparators = {
    current: (a, b) => value(b, 'signalScore') - value(a, 'signalScore'),
    buyFirst: (a, b) => signal(b) - signal(a)
      || value(b, 'signalScore') - value(a, 'signalScore'),
    confirmations: (a, b) => confirmationCount(b) - confirmationCount(a)
      || signal(b) - signal(a)
      || value(b, 'signalScore') - value(a, 'signalScore'),
    liquidity: (a, b) => value(b, 'avg20TradeValue') - value(a, 'avg20TradeValue')
      || signal(b) - signal(a),
    gap: (a, b) => value(b, 'gapUpPct') - value(a, 'gapUpPct')
      || signal(b) - signal(a),
    stable: (a, b) => Number(a.strictRisk) - Number(b.strictRisk)
      || signal(b) - signal(a)
      || confirmationCount(b) - confirmationCount(a),
    quality: (a, b) => (
      signal(b) * 20 + confirmationCount(b) * 5 + value(b, 'signalScore')
        + Math.min(5, value(b, 'gapUpPct'))
    ) - (
      signal(a) * 20 + confirmationCount(a) * 5 + value(a, 'signalScore')
        + Math.min(5, value(a, 'gapUpPct'))
    )
  };
  const comparator = comparators[mode] || comparators.current;
  return [...entries].sort((a, b) => comparator(a, b) || a.symbol.localeCompare(b.symbol));
}

function simulate(days, months, assumptions, config) {
  let cash = INITIAL_CAPITAL;
  let equity = INITIAL_CAPITAL;
  let peak = INITIAL_CAPITAL;
  let maxDrawdownPct = 0;
  let open = [];
  let executedTrades = 0;
  let activeMonth = months[0];
  let monthStartCapital = INITIAL_CAPITAL;
  const monthly = [];
  const normalEntriesByMonth = new Map();
  const fallbackEntriesByMonth = new Map();

  const closeMonthsBefore = month => {
    while (activeMonth && activeMonth < month) {
      monthly.push({
        month: activeMonth,
        returnPct: round((equity / monthStartCapital - 1) * 100)
      });
      monthStartCapital = equity;
      activeMonth = months[months.indexOf(activeMonth) + 1];
    }
  };

  for (const [date, day] of days) {
    const month = date.slice(0, 7);
    closeMonthsBefore(month);

    for (const trade of day.exits) {
      const position = open.find(item => item.trade.tradeId === trade.tradeId);
      if (!position) continue;
      open = open.filter(item => item.trade.tradeId !== trade.tradeId);
      cash += position.allocation * (1 + trade.netReturnPct / 100);
      executedTrades += 1;
    }

    equity = cash + open.reduce((sum, item) => sum + item.markValue, 0);
    for (const trade of rankEntries(day.entries, config.entryRankMode)) {
      if (open.length >= MAX_OPEN_POSITIONS) continue;
      if (!passesEntryFilter(trade, config)) continue;
      const fallback = isWatchFallback(trade, config);
      if (fallback) {
        if (config.watchFallbackOnlyWithoutNormal
          && (normalEntriesByMonth.get(month) || 0) > 0) continue;
        if (config.watchFallbackMaxPerMonth !== undefined
          && (fallbackEntriesByMonth.get(month) || 0) >= config.watchFallbackMaxPerMonth) continue;
      }
      const monthReturnPct = (equity / monthStartCapital - 1) * 100;
      if (config.currentLossBrakePct !== undefined
        && monthReturnPct <= config.currentLossBrakePct) continue;
      if (config.currentProfitLockPct !== undefined
        && monthReturnPct >= config.currentProfitLockPct) continue;
      const positionPct = config.current
        ? currentPositionPct(trade, config)
        : optimizedPositionPct(trade, config, monthReturnPct);
      const allocation = Math.min(cash, equity * positionPct / 100);
      if (allocation <= 0) continue;
      cash -= allocation;
      open.push({ trade, allocation, markValue: allocation });
      const counter = fallback ? fallbackEntriesByMonth : normalEntriesByMonth;
      counter.set(month, (counter.get(month) || 0) + 1);
    }

    for (const mark of day.marks) {
      const position = open.find(item => item.trade.tradeId === mark.tradeId);
      if (!position) continue;
      const markedReturnPct = netMarkedReturnPct(position.trade, mark.price, assumptions);
      position.markValue = position.allocation * (1 + markedReturnPct / 100);
    }
    equity = cash + open.reduce((sum, item) => sum + item.markValue, 0);
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.min(maxDrawdownPct, (equity / peak - 1) * 100);
  }

  while (activeMonth) {
    monthly.push({
      month: activeMonth,
      returnPct: round((equity / monthStartCapital - 1) * 100)
    });
    monthStartCapital = equity;
    activeMonth = months[months.indexOf(activeMonth) + 1];
  }
  return { config, monthly, ...summarize(monthly, equity, maxDrawdownPct, executedTrades) };
}

function compare(a, b) {
  return b.monthsHitTarget - a.monthsHitTarget
    || a.monthsBelowZero - b.monthsBelowZero
    || Math.min(b.trainAvgMonthlyReturnPct, b.testAvgMonthlyReturnPct)
      - Math.min(a.trainAvgMonthlyReturnPct, a.testAvgMonthlyReturnPct)
    || b.worstMonthPct - a.worstMonthPct
    || b.avgMonthlyReturnPct - a.avgMonthlyReturnPct
    || b.maxDrawdownPct - a.maxDrawdownPct;
}

function configurations() {
  const riskPresets = [
    { key: 'deep', marketWeakPct: -1, themeWeakPct: -1, globalWeakPct: -1.5, asiaWeakPct: -1.2 },
    { key: 'negative', marketWeakPct: 0, themeWeakPct: 0, globalWeakPct: -0.5, asiaWeakPct: -0.4 }
  ];
  const configs = [];
  for (const preset of riskPresets) {
    for (const standardPositionPct of [40, 50, 52, 55, 58, 60]) {
      for (const defensivePositionPct of [12, 20]) {
        for (const exploratoryPositionPct of [8, 12]) {
          for (const cashRiskCount of [2, 3, 4]) {
            for (const defensiveRiskCount of [1, 2]) {
              if (defensiveRiskCount >= cashRiskCount) continue;
              for (const strongBoost of [1, 1.5]) {
                for (const profitLockPct of [null, 12, 15]) {
                  for (const lossBrakePct of [null, -3]) {
                    configs.push({
                      riskPreset: preset.key,
                      ...preset,
                      standardPositionPct,
                      defensivePositionPct,
                      exploratoryPositionPct,
                      cashRiskCount,
                      defensiveRiskCount,
                      strongBoost,
                      profitLockPct,
                      lossBrakePct
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return configs;
}

function entryFilters() {
  const filters = [];
  for (const minGapUpPct of [0, 0.5, 1, 1.5]) {
    for (const minStd20Pct of [2, 2.5, 3]) {
      for (const minAvg20TradeValue of [30_000_000, 100_000_000, 300_000_000]) {
        filters.push({ minGapUpPct, minStd20Pct, minAvg20TradeValue });
      }
    }
  }
  return filters;
}

function exitRules() {
  const rules = [];
  for (const triggerPct of [3, 5, 8]) {
    for (const trailPct of [3, 5]) {
      for (const lockPct of [0, 1]) rules.push({ triggerPct, trailPct, lockPct });
    }
  }
  return rules;
}

async function main() {
  const payload = JSON.parse(await fs.readFile(INPUT, 'utf8'));
  const trades = payload.candidateTrades || [];
  if (!trades.length) throw new Error('Run npm run backtest:tw2y first to generate candidateTrades.');
  const days = buildDays(trades);
  const months = monthKeys(payload.startDate, payload.endDate);
  const baseline = simulate(days, months, payload.assumptions, {
    current: true,
    entryRankMode: 'gap',
    currentAccountRiskCapPct: 2
  });
  const explorationFilterResults = [0, 4, 8, 12].flatMap(currentExploratoryPositionPct => (
    [0, 2, 3, 4, 5, 6].map(explorationConfirmCount => (
      simulate(days, months, payload.assumptions, {
        current: true,
        currentExploratoryPositionPct,
        explorationConfirmCount
      })
    ))
  ))
    .sort(compare);
  const currentRiskControlResults = [0, 4].flatMap(explorationConfirmCount => (
    [8, 12].flatMap(currentExploratoryPositionPct => (
      [undefined, -0.5, -1, -2].flatMap(currentLossBrakePct => (
        [undefined, 10, 12, 15].map(currentProfitLockPct => (
          simulate(days, months, payload.assumptions, {
            current: true,
            currentExploratoryPositionPct,
            explorationConfirmCount,
            currentLossBrakePct,
            currentProfitLockPct
          })
        ))
      ))
    ))
  )).sort(compare);
  const buyConfirmationResults = [0, 1, 2, 3, 4, 5]
    .map(buyConfirmCount => simulate(days, months, payload.assumptions, {
      current: true,
      explorationConfirmCount: 4,
      buyConfirmCount
    }))
    .sort(compare);
  const noFollowResults = [2, 3].flatMap(daysWithoutFollow => (
    [1, 1.5, 2, 3, 4].map(minMfePct => {
      const rule = { days: daysWithoutFollow, minMfePct };
      const adjustedDays = buildDays(applyNoFollowRule(trades, payload.assumptions, rule));
      return { ...simulate(adjustedDays, months, payload.assumptions, { current: true }), rule };
    })
  )).sort(compare);
  const intradayTrailResults = [3, 5, 8].flatMap(triggerPct => (
    [3, 4, 5].flatMap(trailPct => (
      [0, 1].map(lockPct => {
        const rule = { triggerPct, trailPct, lockPct };
        const adjustedDays = buildDays(applyIntradayTrailRule(
          trades,
          payload.assumptions,
          rule
        ));
        return { ...simulate(adjustedDays, months, payload.assumptions, { current: true }), rule };
      })
    ))
  )).sort(compare);
  const watchFallbackResults = [4, 6, 8, 10, 12].map(watchFallbackPositionPct => (
    simulate(days, months, payload.assumptions, {
      current: true,
      buyConfirmCount: 2,
      explorationConfirmCount: 4,
      watchFallbackPositionPct
    })
  )).sort(compare);
  const sparseMonthFallbackResults = [4, 6, 8, 10, 12].flatMap(watchFallbackPositionPct => (
    [1, 2, 3].flatMap(watchFallbackMaxPerMonth => (
      [false, true].map(watchFallbackOnlyWithoutNormal => (
        simulate(days, months, payload.assumptions, {
          current: true,
          entryRankMode: 'gap',
          watchFallbackPositionPct,
          watchFallbackMaxPerMonth,
          watchFallbackOnlyWithoutNormal
        })
      ))
    ))
  )).sort(compare);
  const entryRankingResults = [
    'current',
    'buyFirst',
    'confirmations',
    'liquidity',
    'gap',
    'stable',
    'quality'
  ].map(entryRankMode => simulate(days, months, payload.assumptions, {
    current: true,
    entryRankMode
  })).sort(compare);
  const gapSizingResults = [40, 42, 43, 44, 45, 50, 55, 60].flatMap(currentStandardPositionPct => (
    [12, 14, 16, 20].flatMap(currentDefensivePositionPct => (
      [8, 12, 16].map(currentExploratoryPositionPct => (
        simulate(days, months, payload.assumptions, {
          current: true,
          entryRankMode: 'gap',
          currentStandardPositionPct,
          currentDefensivePositionPct,
          currentExploratoryPositionPct
        })
      ))
    ))
  )).sort(compare);
  const accountRiskCapResults = [1, 1.25, 1.5, 1.75, 2, 2.5, 3].map(
    currentAccountRiskCapPct => simulate(days, months, payload.assumptions, {
      current: true,
      entryRankMode: 'gap',
      currentStandardPositionPct: 44,
      currentDefensivePositionPct: 12,
      currentExploratoryPositionPct: 12,
      currentAccountRiskCapPct
    })
  ).sort(compare);
  const riskCappedSizingResults = [44, 50, 60, 80, 100].flatMap(
    currentStandardPositionPct => [12, 16, 20, 30].flatMap(
      currentDefensivePositionPct => [12, 16, 20].map(
        currentExploratoryPositionPct => simulate(days, months, payload.assumptions, {
          current: true,
          entryRankMode: 'gap',
          currentStandardPositionPct,
          currentDefensivePositionPct,
          currentExploratoryPositionPct,
          currentAccountRiskCapPct: 2
        })
      )
    )
  ).sort(compare);
  const filterResults = entryFilters()
    .map(config => simulate(days, months, payload.assumptions, { current: true, ...config }))
    .filter(result => result.executedTrades >= 60)
    .sort(compare);
  const filterLeaders = filterResults.slice(0, 6).map(result => {
    const { current, ...filter } = result.config;
    return filter;
  });
  const riskConfigurations = filterLeaders.flatMap(filter => (
    configurations().map(config => ({ ...config, ...filter }))
  ));
  const results = riskConfigurations
    .map(config => simulate(days, months, payload.assumptions, config))
    .filter(result => (
      result.executedTrades >= 60
      && result.trainAvgMonthlyReturnPct > 0
      && result.testAvgMonthlyReturnPct > 0
    ))
    .sort(compare);
  const aggressiveConfig = {
    riskPreset: 'deep',
    marketWeakPct: -1,
    themeWeakPct: -1,
    globalWeakPct: -1.5,
    asiaWeakPct: -1.2,
    standardPositionPct: 60,
    defensivePositionPct: 20,
    exploratoryPositionPct: 12,
    cashRiskCount: 2,
    defensiveRiskCount: 1,
    strongBoost: 1.5,
    profitLockPct: null,
    lossBrakePct: null,
    minGapUpPct: 0,
    minStd20Pct: 2,
    minAvg20TradeValue: 100_000_000
  };
  const exitRuleResults = exitRules().flatMap(rule => {
    const adjustedTrades = applyExitRule(trades, payload.assumptions, rule);
    const adjustedDays = buildDays(adjustedTrades);
    return [
      { ...simulate(adjustedDays, months, payload.assumptions, { current: true }), rule, mode: 'baseline' },
      { ...simulate(adjustedDays, months, payload.assumptions, aggressiveConfig), rule, mode: 'aggressive' }
    ];
  }).sort(compare);
  const focusedExitRules = [
    { triggerPct: 3, trailPct: 5, lockPct: 1 },
    { triggerPct: 5, trailPct: 5, lockPct: 0 },
    { triggerPct: 8, trailPct: 5, lockPct: 0 }
  ];
  const exitPositionResults = focusedExitRules.flatMap(rule => {
    const adjustedDays = buildDays(applyExitRule(trades, payload.assumptions, rule));
    return [40, 50, 52, 55, 58, 60].flatMap(standardPositionPct => (
      [30_000_000, 100_000_000].map(minAvg20TradeValue => {
        const config = { ...aggressiveConfig, standardPositionPct, minAvg20TradeValue };
        return { ...simulate(adjustedDays, months, payload.assumptions, config), rule };
      })
    ));
  }).sort((a, b) => (
    b.avgMonthlyReturnPct - a.avgMonthlyReturnPct
    || b.maxDrawdownPct - a.maxDrawdownPct
  ));
  const output = {
    generatedAt: new Date().toISOString(),
    trainEnd: TRAIN_END,
    candidates: trades.length,
    testedEntryFilters: entryFilters().length,
    testedConfigurations: riskConfigurations.length,
    baseline,
    explorationFilterResults,
    currentRiskControlResults,
    buyConfirmationResults,
    noFollowResults,
    intradayTrailResults,
    watchFallbackResults,
    sparseMonthFallbackResults,
    entryRankingResults,
    gapSizingResults,
    accountRiskCapResults,
    riskCappedSizingResults,
    entryFilterTop: filterResults.slice(0, 20),
    top: results.slice(0, 30),
    averageLeaders: [...results]
      .filter(result => (
        result.monthsBelowZero <= baseline.monthsBelowZero
        && result.maxDrawdownPct >= baseline.maxDrawdownPct
      ))
      .sort((a, b) => b.avgMonthlyReturnPct - a.avgMonthlyReturnPct)
      .slice(0, 30),
    drawdownLeaders: [...results]
      .filter(result => result.avgMonthlyReturnPct >= 9)
      .sort((a, b) => b.maxDrawdownPct - a.maxDrawdownPct)
      .slice(0, 30),
    exitRuleTop: exitRuleResults.slice(0, 30),
    exitPositionTop: exitPositionResults.slice(0, 40)
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    output: OUTPUT.pathname,
    candidates: trades.length,
    testedConfigurations: output.testedConfigurations,
    baseline: summarize(baseline.monthly, baseline.finalCapital, baseline.maxDrawdownPct, baseline.executedTrades),
    best: output.top[0]
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
