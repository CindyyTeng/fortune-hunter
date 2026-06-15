import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildMarketRegimes, MARKET_REGIMES } from './lib/market-regime.mjs';
import {
  ACTIVE_STRATEGIES,
  DEFAULT_REGIME_STRATEGY_MAP,
  STRATEGIES,
  strategyFor
} from './lib/strategy-engine.mjs';
import { loadOhlcvDataset } from './lib/ohlcv-dataset.mjs';
import {
  simulateEntry,
  simulateExit,
  trailingStopPrice
} from './lib/execution-simulator.mjs';
import {
  beginPortfolioDay,
  closePosition,
  createPortfolio,
  markPosition,
  openPosition,
  portfolioEquity,
  portfolioExposure,
  recordEquity,
  settleCash
} from './lib/portfolio-simulator.mjs';

const INPUT = new URL('../data/tw-backtest-10y.json', import.meta.url);
const MARKET_INPUT = new URL('../data/market-regime-history-10y.json', import.meta.url);
const UNIVERSE_MANIFEST = new URL('../data/historical-universe/manifest.json', import.meta.url);
const OUTPUT = new URL('../data/regime-ensemble-backtest-10y.json', import.meta.url);
const REPORT = new URL('../docs/REGIME_ENSEMBLE_BACKTEST.md', import.meta.url);

const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const monthKey = date => String(date).slice(0, 7);

function addMonths(dateText, count) {
  const date = new Date(`${dateText.slice(0, 7)}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + count);
  return date.toISOString().slice(0, 10);
}

function themeMap(candidates) {
  const grouped = new Map();
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.themeMovePct)) continue;
    const row = grouped.get(candidate.signalDate) || [];
    row.push(candidate.themeMovePct - (candidate.marketMovePct || 0));
    grouped.set(candidate.signalDate, row);
  }
  return new Map([...grouped].map(([date, values]) => [date, {
    strength: mean(values),
    count: values.length
  }]));
}

function rawThemeBreadth(stocks, preliminaryRegimes) {
  const regimeByDate = new Map(preliminaryRegimes.map(row => [row.date, row]));
  const grouped = new Map();
  for (const { stock, history } of stocks) {
    const themes = (stock.themes || []).filter(theme => theme && theme !== '一般');
    if (!themes.length) continue;
    for (let index = 5; index < history.length; index += 1) {
      const day = history[index];
      const market = regimeByDate.get(day.date);
      if (!market || !history[index - 5]?.close) continue;
      const return5 = (day.close / history[index - 5].close - 1) * 100;
      const excess = return5 - (market.mom5 || 0);
      for (const theme of themes) {
        const key = `${day.date}|${theme}`;
        const row = grouped.get(key) || { date: day.date, theme, sum: 0, count: 0 };
        row.sum += excess;
        row.count += 1;
        grouped.set(key, row);
      }
    }
  }
  const bestByDate = new Map();
  for (const row of grouped.values()) {
    if (row.count < 5) continue;
    const strength = row.sum / row.count;
    const current = bestByDate.get(row.date);
    if (!current || strength > current.strength) {
      bestByDate.set(row.date, { strength, count: row.count, theme: row.theme });
    }
  }
  return bestByDate;
}

function scanRawCandidates(stocks, regimes, startDate, endDate) {
  const regimeByDate = new Map(regimes.map(row => [row.date, row]));
  const themeByDate = rawThemeBreadth(stocks, regimes);
  const candidates = [];
  for (const { stock, history } of stocks) {
    const startIndex = Math.max(200, history.findIndex(day => day.date >= startDate));
    for (let index = startIndex; index < history.length - 1; index += 1) {
      const day = history[index];
      if (day.date > endDate) break;
      const regime = regimeByDate.get(day.date);
      if (!regime) continue;
      for (const strategy of ACTIVE_STRATEGIES) {
        if (!strategy.regimes.includes(regime.regime)) continue;
        const leadingTheme = themeByDate.get(day.date);
        const belongsToLeadingTheme = leadingTheme?.theme
          && (stock.themes || []).includes(leadingTheme.theme);
        const row = strategy.screen({
          history,
          index,
          stock,
          regime,
          themeStrength: leadingTheme?.strength || 0,
          themeStrengthRank: belongsToLeadingTheme ? 1 : 2
        });
        if (!row) continue;
        delete row.history;
        delete row.index;
        candidates.push({
          ...row,
          regime: regime.regime,
          regimeReason: regime.reason
        });
      }
    }
  }
  return candidates;
}

async function historicalUniverse() {
  const manifest = JSON.parse(await fs.readFile(UNIVERSE_MANIFEST, 'utf8'));
  const cache = new Map();
  return {
    warning: manifest.survivorshipBiasWarning !== false,
    note: manifest.note,
    async allows(date, candidate) {
      if (!manifest.available) return true;
      const month = monthKey(date);
      if (!cache.has(month)) {
        try {
          const file = new URL(`../data/historical-universe/${month}.json`, import.meta.url);
          const row = JSON.parse(await fs.readFile(file, 'utf8'));
          cache.set(month, new Set(row.symbols || []));
        } catch {
          cache.set(month, null);
        }
      }
      const set = cache.get(month);
      if (!set) return false;
      const suffix = String(candidate.market).includes('上櫃') ? 'TWO' : 'TW';
      return set.has(`${candidate.symbol}.${suffix}`) || set.has(candidate.symbol);
    }
  };
}

function entryPlan(candidate, strategy) {
  const entry = strategy.entry(candidate);
  const nextDay = candidate.forwardPrices?.[0];
  if (!entry || !nextDay) return null;
  const fill = simulateEntry({
    ...entry,
    signalDay: { close: candidate.latest.close },
    nextDay
  });
  if (!fill) return null;
  const stopLoss = strategy.stopLoss({ ...candidate, entryPrice: fill.price });
  if (!Number.isFinite(stopLoss) || stopLoss >= fill.price) return null;
  return {
    tradeId: `${candidate.symbol}-${candidate.signalDate}-${strategy.name}`,
    symbol: candidate.symbol,
    name: candidate.name,
    signalDate: candidate.signalDate,
    entryDate: nextDay.date,
    entryPrice: fill.price,
    entryReason: fill.reason,
    entryMode: entry.mode,
    entryGapPct: round((nextDay.open / candidate.latest.close - 1) * 100, 4),
    nearLimitUp: nextDay.open >= candidate.latest.close * 1.085
      || fill.price >= candidate.latest.close * 1.085,
    avgTradeValue20: candidate.avgTradeValue20,
    atr14Pct: candidate.atr14Pct,
    rsi14: candidate.rsi14,
    distanceToMa20Pct: candidate.distanceToMa20Pct,
    distanceToMa60Pct: candidate.distanceToMa60Pct,
    themeStrength: candidate.themeStrength,
    themeStrengthRank: candidate.themeStrengthRank,
    stopLoss,
    takeProfit: strategy.takeProfit({ ...candidate, entryPrice: fill.price }),
    maxHoldingDays: strategy.maxHoldingDays(candidate),
    positionPct: strategy.positionSizing(candidate),
    strategy: strategy.name,
    candidate,
    bars: candidate.forwardPrices
  };
}

function maxDrawdown(curve) {
  let peak = -Infinity;
  let drawdown = 0;
  for (const row of curve) {
    peak = Math.max(peak, row.equity);
    drawdown = Math.min(drawdown, peak ? (row.equity / peak - 1) * 100 : 0);
  }
  return round(drawdown);
}

function tradeStats(trades) {
  const wins = trades.filter(trade => trade.tradeReturnPct > 0);
  const gains = wins.reduce((sum, trade) => sum + trade.realizedPnl, 0);
  const losses = Math.abs(trades.filter(trade => trade.realizedPnl <= 0)
    .reduce((sum, trade) => sum + trade.realizedPnl, 0));
  let capital = 100;
  let peak = capital;
  let drawdown = 0;
  for (const trade of trades.sort((a, b) => a.exitDate.localeCompare(b.exitDate))) {
    capital *= 1 + trade.accountReturnPct / 100;
    peak = Math.max(peak, capital);
    drawdown = Math.min(drawdown, (capital / peak - 1) * 100);
  }
  return {
    trades: trades.length,
    winRatePct: round(wins.length / Math.max(1, trades.length) * 100),
    averageReturnPct: round(mean(trades.map(trade => trade.tradeReturnPct))),
    profitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    maxDrawdownPct: round(drawdown)
  };
}

function monthlyReport(portfolio, startDate, endDate) {
  const equityByMonth = new Map();
  for (const row of portfolio.equityCurve) equityByMonth.set(monthKey(row.date), row);
  const realized = new Map();
  const closed = new Map();
  for (const trade of portfolio.closedTrades) {
    const month = monthKey(trade.exitDate);
    realized.set(month, (realized.get(month) || 0) + trade.realizedPnl);
    closed.set(month, (closed.get(month) || 0) + 1);
  }
  const months = [];
  let cursor = `${startDate.slice(0, 7)}-01`;
  let previousEquity = portfolio.initialCapital;
  let realizedCapital = portfolio.initialCapital;
  while (cursor <= endDate) {
    const month = monthKey(cursor);
    const end = equityByMonth.get(month);
    const pnl = realized.get(month) || 0;
    const equity = end?.equity ?? previousEquity;
    const realizedReturnPct = realizedCapital ? pnl / realizedCapital * 100 : 0;
    const equityReturnPct = previousEquity ? (equity / previousEquity - 1) * 100 : 0;
    months.push({
      month,
      realizedPnl: round(pnl, 0),
      realizedReturnPct: round(realizedReturnPct),
      equityReturnPct: round(equityReturnPct),
      endingEquity: round(equity, 0),
      openPositions: end?.openPositions ?? 0,
      tradesClosed: closed.get(month) || 0,
      hitTenPercent: realizedReturnPct >= 10
    });
    realizedCapital += pnl;
    previousEquity = equity;
    cursor = addMonths(cursor, 1);
  }
  return months;
}

function strategyContext(config, strategyName) {
  return config.strategyParameters?.[strategyName] || {};
}

function passesOptimizedParameters(candidate, parameters = {}) {
  if (Number.isFinite(parameters.minScore) && candidate.score < parameters.minScore) return false;
  if (Number.isFinite(parameters.minVolumeRatio)
    && candidate.volumeRatio < parameters.minVolumeRatio) return false;
  return true;
}

function candidateDiagnostics(funnel, regimeDays) {
  return Object.entries(funnel.byStrategy).map(([strategy, row]) => {
    let reason = '候選充足；實際進場較少主要來自同日排序、持倉上限、現金與 T+2，以及同股票不可重複持有。';
    if (strategy === 'cashDefenseStrategy') {
      reason = '防守策略刻意不產生新倉；市場進入空頭或高波動時，回測會關閉既有部位降低曝險。';
    } else if (row.candidates < 2000) {
      reason = strategy === 'oversoldReboundStrategy'
        ? '短線急跌、放量下影線與當日轉強必須同時成立，因此候選自然較少；完整組合中還會與主要策略競爭資金。'
        : '候選偏少，主因是適用市場狀態天數較少或篩選條件較嚴格。';
    } else if (row.entryTriggered / Math.max(1, row.candidates) < 0.4) {
      reason = '候選不少，但隔日限價、回測或突破條件不易成交，主要瓶頸在進場觸發。';
    }
    return {
      strategy,
      ...row,
      reason,
      applicableRegimeDays: strategy === 'breakoutMomentumStrategy'
        ? (regimeDays.BULL_TREND || 0) + (regimeDays.THEME_MOMENTUM || 0)
        : strategy === 'pullbackTrendStrategy'
          ? regimeDays.BULL_PULLBACK || 0
          : strategy === 'rangeReversionStrategy'
            ? regimeDays.RANGE_BOUND || 0
            : strategy === 'oversoldReboundStrategy'
              ? (regimeDays.BULL_PULLBACK || 0) + (regimeDays.RANGE_BOUND || 0)
              : (regimeDays.BEAR_DEFENSE || 0) + (regimeDays.HIGH_VOLATILITY || 0)
    };
  });
}

export async function loadRegimeDataset() {
  const [backtest, market] = await Promise.all([
    fs.readFile(INPUT, 'utf8').then(JSON.parse),
    fs.readFile(MARKET_INPUT, 'utf8').then(JSON.parse)
  ]);
  const ohlcv = await loadOhlcvDataset(backtest, {
    startDate: '2015-06-01',
    endDate: market.benchmark?.at(-1)?.date
  });
  const preliminaryRegimes = buildMarketRegimes(market.benchmark || []);
  const themes = rawThemeBreadth(ohlcv.stocks, preliminaryRegimes);
  const regimes = buildMarketRegimes(market.benchmark || [], { themeByDate: themes });
  const startDate = addMonths(market.benchmark?.at(-1)?.date, -120);
  return {
    candidates: scanRawCandidates(ohlcv.stocks, regimes, startDate, market.benchmark?.at(-1)?.date),
    marketHistory: market.benchmark || [],
    regimes,
    ohlcv: {
      source: ohlcv.source,
      universeSource: ohlcv.universeSource,
      sourceUniverseBiasWarning: ohlcv.sourceUniverseBiasWarning,
      requestedSymbols: ohlcv.requestedSymbols,
      loadedSymbols: ohlcv.loadedSymbols,
      failures: ohlcv.failures.length
    },
    source: {
      candidateGeneratedAt: new Date().toISOString(),
      marketGeneratedAt: market.generatedAt,
      originalRange: backtest.range,
      candidateMethod: 'each strategy scans raw OHLCV independently'
    }
  };
}

export async function runRegimeBacktest(dataset, config = {}) {
  const endDate = config.endDate || dataset.marketHistory.at(-1)?.date;
  const startDate = config.startDate || addMonths(endDate, -120);
  const candidates = dataset.candidates.filter(candidate => (
    candidate.signalDate >= startDate && candidate.signalDate <= endDate
  ));
  const marketHistory = dataset.marketHistory.filter(day => day.date >= addMonths(startDate, -8)
    && day.date <= endDate);
  const regimes = (dataset.regimes || buildMarketRegimes(marketHistory))
    .filter(row => row.date >= addMonths(startDate, -8) && row.date <= endDate);
  const regimeByDate = new Map(regimes.map(row => [row.date, row]));
  const universe = await historicalUniverse();
  const portfolio = createPortfolio({
    initialCapital: config.initialCapital ?? 1_000_000,
    settlementDays: 2,
    maxOpenPositions: config.maxOpenPositions ?? 6,
    executionCosts: config.executionCosts,
    riskControls: config.riskControls !== false,
    riskRules: config.riskRules
  });
  const entries = new Map();
  const candidateCounts = {};
  const triggeredCounts = {};
  const enteredCounts = {};
  const increment = (target, regime, strategy) => {
    target.byRegime ||= {};
    target.byStrategy ||= {};
    target.byRegime[regime] = (target.byRegime[regime] || 0) + 1;
    target.byStrategy[strategy] = (target.byStrategy[strategy] || 0) + 1;
  };

  for (const candidate of candidates) {
    if (!(await universe.allows(candidate.signalDate, candidate))) continue;
    const regime = regimeByDate.get(candidate.signalDate);
    if (!regime) continue;
    const enabled = config.enabledStrategies || Object.keys(STRATEGIES);
    if (!enabled.includes(candidate.strategy)) continue;
    const mapped = (config.regimeStrategyMap || DEFAULT_REGIME_STRATEGY_MAP)[regime.regime]
      || DEFAULT_REGIME_STRATEGY_MAP[regime.regime];
    const oversoldAllowed = candidate.strategy === 'oversoldReboundStrategy'
      && config.allowOversold !== false;
    if (candidate.strategy !== mapped && !oversoldAllowed) continue;
    const strategy = strategyFor(regime.regime, candidate, config);
    if (!passesOptimizedParameters(candidate, strategyContext(config, strategy.name))) continue;
    increment(candidateCounts, regime.regime, strategy.name);
    const plan = entryPlan(candidate, strategy);
    if (!plan) continue;
    increment(triggeredCounts, regime.regime, strategy.name);
    plan.regime = regime.regime;
    plan.regimeReason = regime.reason;
    const rows = entries.get(plan.entryDate) || [];
    rows.push(plan);
    entries.set(plan.entryDate, rows);
  }

  const dates = dataset.marketHistory
    .map(day => day.date)
    .filter(date => date >= startDate && date <= endDate);
  const switchLog = [];
  let previousRegime = null;

  for (let dayIndex = 0; dayIndex < dates.length; dayIndex += 1) {
    const date = dates[dayIndex];
    settleCash(portfolio, dayIndex);
    const regime = regimeByDate.get(date);
    beginPortfolioDay(portfolio, date, dayIndex, regime?.regime);
    if (regime?.regime !== previousRegime) {
      switchLog.push({
        date,
        from: previousRegime,
        to: regime?.regime,
        strategy: DEFAULT_REGIME_STRATEGY_MAP[regime?.regime],
        reason: regime?.reason
      });
      previousRegime = regime?.regime;
    }

    for (const position of [...portfolio.positions]) {
      const heldDays = dayIndex - position.entryDayIndex + 1;
      const bar = position.bars.find(item => item.date === date);
      if (!bar) continue;
      markPosition(portfolio, position.tradeId, bar.price);
      const bearDefense = regime?.regime === MARKET_REGIMES.BEAR_DEFENSE;
      const highVolatility = regime?.regime === MARKET_REGIMES.HIGH_VOLATILITY;
      const mustReduceHighVolatility = highVolatility
        && portfolio.riskControlsEnabled
        && portfolioExposure(portfolio) > portfolioEquity(portfolio) * 0.2;
      const legacyDefensiveExit = !portfolio.riskControlsEnabled
        && (bearDefense || highVolatility)
        && heldDays > 1;
      if (bearDefense || mustReduceHighVolatility || legacyDefensiveExit) {
        closePosition(portfolio, position, {
          date,
          price: bar.open ?? bar.price,
          reason: `市場防守降曝險：${regime.regime}`,
          type: 'defense'
        }, dayIndex);
        continue;
      }
      const strategy = strategyFor(position.regime, position.candidate, config);
      const exitRules = strategy.exit(position.candidate, position);
      const trailingStop = trailingStopPrice(position.entryPrice, position.peakPrice, exitRules.trailingRule);
      const exit = simulateExit({
        day: bar,
        stopLoss: exitRules.stopLoss,
        takeProfit: exitRules.takeProfit,
        trailingStop,
        peakPrice: position.peakPrice
      });
      if (exit?.price) {
        closePosition(portfolio, position, { ...exit, date }, dayIndex);
      } else if (heldDays >= position.maxHoldingDays || bar === position.bars.at(-1)) {
        closePosition(portfolio, position, {
          date,
          price: bar.price,
          reason: heldDays >= position.maxHoldingDays ? '策略持有期限到期' : '可用歷史路徑結束'
        }, dayIndex);
      }
    }

    if (portfolio.riskControlsEnabled) {
      const exposureLimitPct = portfolio.riskRules.exposureLimits[regime?.regime] ?? 0;
      for (const position of [...portfolio.positions].sort((a, b) => b.markValue - a.markValue)) {
        if (portfolioExposure(portfolio) <= portfolioEquity(portfolio) * exposureLimitPct / 100) break;
        const bar = position.bars.find(item => item.date === date);
        if (!bar) continue;
        closePosition(portfolio, position, {
          date,
          price: bar.price,
          reason: `總曝險超過 ${exposureLimitPct}% 上限`,
          type: 'exposure_reduction'
        }, dayIndex);
      }
    }

    const dayEntries = [...(entries.get(date) || [])].sort((a, b) => (
      b.candidate.signalScore - a.candidate.signalScore
      || (b.candidate.avg20TradeValue || 0) - (a.candidate.avg20TradeValue || 0)
    ));
    for (const plan of dayEntries) {
      const position = openPosition(portfolio, plan, dayIndex, {
        positionPct: plan.positionPct,
        accountRiskPct: config.accountRiskPct ?? 1.5,
        regime: regime?.regime
      });
      if (position) increment(enteredCounts, plan.regime, plan.strategy);
    }
    recordEquity(portfolio, date, { dayIndex, regime: regime?.regime });
  }

  const finalDate = dates.at(-1);
  const finalIndex = dates.length - 1;
  for (const position of [...portfolio.positions]) {
    closePosition(portfolio, position, {
      date: finalDate,
      price: position.markPrice,
      reason: '回測區間結束'
    }, finalIndex);
  }
  portfolio.equityCurve.pop();
  portfolio.previousEquity = portfolio.equityCurve.at(-1)?.equity ?? portfolio.initialCapital;
  recordEquity(portfolio, finalDate, {
    dayIndex: finalIndex,
    regime: regimeByDate.get(finalDate)?.regime
  });

  const monthly = monthlyReport(portfolio, startDate, endDate);
  const regimeDays = Object.fromEntries(Object.values(MARKET_REGIMES).map(key => [
    key,
    regimes.filter(row => row.date >= startDate && row.date <= endDate && row.regime === key).length
  ]));
  const regimePerformance = Object.fromEntries(Object.values(MARKET_REGIMES).map(key => {
    const trades = portfolio.closedTrades.filter(trade => trade.regime === key);
    return [key, {
      configuredStrategy: (config.regimeStrategyMap || DEFAULT_REGIME_STRATEGY_MAP)[key]
        || DEFAULT_REGIME_STRATEGY_MAP[key],
      strategiesUsed: [...new Set(trades.map(trade => trade.strategy))],
      ...tradeStats(trades)
    }];
  }));
  const equityReturns = monthly.map(row => row.equityReturnPct);
  const realizedReturns = monthly.map(row => row.realizedReturnPct);
  const overallTradeStats = tradeStats(portfolio.closedTrades);
  const concentration = portfolio.closedTrades.length
    ? Math.max(...Object.values(Object.groupBy
      ? Object.groupBy(portfolio.closedTrades, trade => trade.symbol)
      : portfolio.closedTrades.reduce((groups, trade) => {
        (groups[trade.symbol] ||= []).push(trade);
        return groups;
      }, {})).map(rows => rows.length)) / portfolio.closedTrades.length
    : 0;
  const candidateFunnel = {
    candidates: candidateCounts,
    entryTriggered: triggeredCounts,
    entered: enteredCounts,
    byStrategy: Object.fromEntries(Object.keys(STRATEGIES).map(strategy => {
      const candidateCount = candidateCounts.byStrategy?.[strategy] || 0;
      const triggered = triggeredCounts.byStrategy?.[strategy] || 0;
      const entered = enteredCounts.byStrategy?.[strategy] || 0;
      return [strategy, {
        candidates: candidateCount,
        entryTriggered: triggered,
        entered,
        candidateToEntryPct: round(entered / Math.max(1, candidateCount) * 100)
      }];
    })),
    byRegime: Object.fromEntries(Object.values(MARKET_REGIMES).map(regime => {
      const candidateCount = candidateCounts.byRegime?.[regime] || 0;
      const triggered = triggeredCounts.byRegime?.[regime] || 0;
      const entered = enteredCounts.byRegime?.[regime] || 0;
      return [regime, {
        candidates: candidateCount,
        entryTriggered: triggered,
        entered,
        candidateToEntryPct: round(entered / Math.max(1, candidateCount) * 100)
      }];
    }))
  };

  return {
    generatedAt: new Date().toISOString(),
    startDate,
    endDate,
    survivorshipBiasWarning: universe.warning,
    survivorshipBiasNote: universe.note,
    assumptions: {
      noFutureData: true,
      settlement: 'T+2',
      initialCapital: portfolio.initialCapital,
      entryAndExitExecution: 'scripts/lib/execution-simulator.mjs',
      portfolioAccounting: 'cash + unsettled cash + mark-to-market positions'
    },
    dataSource: dataset.ohlcv,
    config,
    summary: {
      trades: portfolio.closedTrades.length,
      endingEquity: round(portfolioEquity(portfolio), 0),
      totalEquityReturnPct: round((portfolioEquity(portfolio) / portfolio.initialCapital - 1) * 100),
      equityAverageMonthlyReturnPct: round(mean(equityReturns)),
      realizedAverageMonthlyReturnPct: round(mean(realizedReturns)),
      negativeEquityMonths: monthly.filter(row => row.equityReturnPct < 0).length,
      negativeRealizedMonths: monthly.filter(row => row.realizedReturnPct < 0).length,
      tenPercentRealizedMonths: monthly.filter(row => row.realizedReturnPct >= 10).length,
      maxDrawdownPct: maxDrawdown(portfolio.equityCurve),
      concentrationPct: round(concentration * 100),
      winRatePct: overallTradeStats.winRatePct,
      profitFactor: overallTradeStats.profitFactor,
      averageTradeReturnPct: overallTradeStats.averageReturnPct
    },
    regimeDays,
    candidateFunnel,
    candidateDiagnostics: candidateDiagnostics(candidateFunnel, regimeDays),
    regimeStrategyMap: { ...DEFAULT_REGIME_STRATEGY_MAP, ...(config.regimeStrategyMap || {}) },
    regimePerformance,
    monthly,
    strategySwitches: switchLog,
    trades: portfolio.closedTrades.map(trade => ({
      tradeId: trade.tradeId,
      symbol: trade.symbol,
      name: trade.name,
      regime: trade.regime,
      strategy: trade.strategy,
      signalDate: trade.signalDate,
      entryDate: trade.entryDate,
      entryPrice: round(trade.buy.fillPrice),
      entryMode: trade.entryMode,
      entryGapPct: trade.entryGapPct,
      nearLimitUp: trade.nearLimitUp,
      avgTradeValue20: round(trade.avgTradeValue20, 0),
      atr14Pct: round(trade.atr14Pct, 4),
      rsi14: round(trade.rsi14, 2),
      distanceToMa20Pct: round(trade.distanceToMa20Pct, 4),
      distanceToMa60Pct: round(trade.distanceToMa60Pct, 4),
      themeStrength: round(trade.themeStrength, 4),
      themeStrengthRank: trade.themeStrengthRank,
      exitDate: trade.exitDate,
      exitPrice: trade.exitPrice,
      exitReason: trade.exitReason,
      exitType: trade.exitType,
      holdingDays: trade.holdingDays,
      quantity: trade.quantity,
      realizedPnl: trade.realizedPnl,
      tradeReturnPct: trade.tradeReturnPct,
      accountReturnPct: trade.accountReturnPct
    })),
    regimeHistory: regimes.filter(row => row.date >= startDate && row.date <= endDate),
    equityCurve: portfolio.equityCurve,
    riskRules: portfolio.riskRules,
    riskEvents: portfolio.riskEvents,
    rejectedEntries: portfolio.rejectedEntries
  };
}

export function compositeScore(result) {
  const summary = result.summary;
  const maxDrawdownPenalty = Math.abs(Math.min(0, summary.maxDrawdownPct));
  const lowTradeCountPenalty = Math.max(0, 60 - summary.trades) / 10;
  const concentrationPenalty = Math.max(0, summary.concentrationPct - 25) / 5;
  return round(
    summary.equityAverageMonthlyReturnPct * 3
      + summary.realizedAverageMonthlyReturnPct
      - summary.negativeEquityMonths * 3
      - maxDrawdownPenalty * 2
      - lowTradeCountPenalty
      - concentrationPenalty,
    4
  );
}

function markdown(result) {
  const s = result.summary;
  const regimeRows = Object.entries(result.regimePerformance).map(([regime, row]) => (
    `| ${regime} | ${result.regimeDays[regime]} | ${row.configuredStrategy} | ${row.strategiesUsed.join('、') || '-'} | ${row.trades} | ${row.winRatePct}% | ${row.averageReturnPct}% | ${row.profitFactor ?? '-'} | ${row.maxDrawdownPct}% |`
  )).join('\n');
  const monthlyRows = result.monthly.map(row => (
    `| ${row.month} | ${row.realizedReturnPct}% | ${row.equityReturnPct}% | ${row.openPositions} | ${row.tradesClosed} | ${row.hitTenPercent ? '是' : '否'} |`
  )).join('\n');
  const switches = result.strategySwitches.slice(-100).map(row => (
    `| ${row.date} | ${row.from || '-'} | ${row.to} | ${row.strategy} | ${row.reason} |`
  )).join('\n');
  const regimeFunnelRows = Object.entries(result.candidateFunnel.byRegime).map(([regime, row]) => (
    `| ${regime} | ${result.regimeDays[regime]} | ${row.candidates} | ${row.entryTriggered} | ${row.entered} | ${row.candidateToEntryPct}% |`
  )).join('\n');
  const strategyFunnelRows = Object.entries(result.candidateFunnel.byStrategy).map(([strategy, row]) => (
    `| ${strategy} | ${row.candidates} | ${row.entryTriggered} | ${row.entered} | ${row.candidateToEntryPct}% |`
  )).join('\n');
  const diagnostics = result.candidateDiagnostics.map(row => (
    `- **${row.strategy}**：適用狀態共 ${row.applicableRegimeDays} 天；候選 ${row.candidates}、進場 ${row.entered}。${row.reason}`
  )).join('\n');
  return `# 市場狀態切換策略 10 年回測

> 倖存者偏差警告：**${result.survivorshipBiasWarning ? '是' : '否'}**
> ${result.survivorshipBiasNote}
> 原始 OHLCV 股票清單偏差警告：**${result.dataSource?.sourceUniverseBiasWarning ? '是' : '否'}**。目前股票清單來自舊 10 年資料中曾出現過候選的股票代碼，但候選日期與策略訊號已全部改由原始 OHLCV 重新獨立計算。

## 摘要

- 區間：${result.startDate} 至 ${result.endDate}
- 交易筆數：${s.trades}
- 總資產報酬：${s.totalEquityReturnPct}%
- 平均月總資產報酬：${s.equityAverageMonthlyReturnPct}%
- 平均月已實現報酬：${s.realizedAverageMonthlyReturnPct}%
- 負總資產月份：${s.negativeEquityMonths}
- 月已實現報酬達 10%：${s.tenPercentRealizedMonths}
- 最大回撤：${s.maxDrawdownPct}%
- 勝率：${s.winRatePct}%
- Profit Factor：${s.profitFactor ?? '-'}

## 候選到成交漏斗

| 市場狀態 | 出現天數 | 候選股數量 | 進場條件觸發 | 實際進場 | 候選轉交易 |
|---|---:|---:|---:|---:|---:|
${regimeFunnelRows}

| 策略 | 候選股數量 | 進場條件觸發 | 實際進場 | 候選轉交易 |
|---|---:|---:|---:|---:|
${strategyFunnelRows}

候選與實際成交的差距主要來自：同日候選競爭、最大持倉數、現金與 T+2 限制、同股票已有持倉，以及限價或突破條件未成交。

### 候選數量診斷

${diagnostics}

## 各市場狀態績效

| 市場狀態 | 天數 | 設定策略 | 實際使用策略 | 交易筆數 | 勝率 | 平均報酬 | Profit Factor | 最大回撤 |
|---|---:|---|---|---:|---:|---:|---:|---:|
${regimeRows}

## 每月報酬

| 月份 | 已實現報酬 | 總資產報酬 | 月底持倉 | 平倉筆數 | 已實現達 10% |
|---|---:|---:|---:|---:|---|
${monthlyRows}

## 最近 100 次策略切換

| 日期 | 前狀態 | 新狀態 | 策略 | 原因 |
|---|---|---|---|---|
${switches}
`;
}

async function main() {
  const dataset = await loadRegimeDataset();
  const result = await runRegimeBacktest(dataset);
  result.compositeScore = compositeScore(result);
  await fs.writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, markdown(result), 'utf8');
  console.log(JSON.stringify({
    output: fileURLToPath(OUTPUT),
    report: fileURLToPath(REPORT),
    summary: result.summary,
    compositeScore: result.compositeScore
  }, null, 2));
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
