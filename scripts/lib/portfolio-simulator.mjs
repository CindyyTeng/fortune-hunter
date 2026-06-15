import {
  affordableQuantity,
  buyExecution,
  sellExecution
} from './execution-simulator.mjs';

const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const monthKey = date => String(date).slice(0, 7);

export const DEFAULT_RISK_RULES = Object.freeze({
  maxAccountRiskPct: 0.5,
  maxSinglePositionPct: 10,
  exposureLimits: Object.freeze({
    BULL_TREND: 80,
    THEME_MOMENTUM: 80,
    BULL_PULLBACK: 60,
    RANGE_BOUND: 40,
    HIGH_VOLATILITY: 20,
    BEAR_DEFENSE: 0
  }),
  drawdownBlockPct: 8,
  drawdownBlockDays: 20,
  monthlyLossBlockPct: 5,
  dailyLossBlockPct: 2,
  dailyLossBlockDays: 1,
  losingStreakCount: 5,
  losingStreakBlockDays: 10
});

function mergedRiskRules(overrides = {}) {
  return {
    ...DEFAULT_RISK_RULES,
    ...overrides,
    exposureLimits: {
      ...DEFAULT_RISK_RULES.exposureLimits,
      ...(overrides.exposureLimits || {})
    }
  };
}

export function createPortfolio(options = {}) {
  const initialCapital = options.initialCapital ?? 1_000_000;
  return {
    initialCapital,
    availableCash: initialCapital,
    unsettled: [],
    positions: [],
    closedTrades: [],
    equityCurve: [],
    riskEvents: [],
    rejectedEntries: [],
    settlementDays: options.settlementDays ?? 2,
    maxOpenPositions: options.maxOpenPositions ?? 6,
    executionCosts: options.executionCosts || {},
    riskControlsEnabled: options.riskControls !== false,
    riskRules: mergedRiskRules(options.riskRules),
    peakEquity: initialCapital,
    previousEquity: initialCapital,
    activeMonth: null,
    monthStartEquity: initialCapital,
    monthlyEntryBlocked: false,
    drawdownBlockUntil: -1,
    dailyBlockUntil: -1,
    lossStreakBlockUntil: -1,
    losingStreak: 0,
    currentDay: null
  };
}

export function settleCash(portfolio, dayIndex) {
  const ready = portfolio.unsettled.filter(item => item.releaseIndex <= dayIndex);
  portfolio.availableCash += ready.reduce((sum, item) => sum + item.amount, 0);
  portfolio.unsettled = portfolio.unsettled.filter(item => item.releaseIndex > dayIndex);
}

export function portfolioEquity(portfolio) {
  return portfolio.availableCash
    + portfolio.unsettled.reduce((sum, item) => sum + item.amount, 0)
    + portfolio.positions.reduce((sum, item) => sum + item.markValue, 0);
}

export function portfolioExposure(portfolio) {
  return portfolio.positions.reduce((sum, item) => sum + item.markValue, 0);
}

function activeBlockReasons(portfolio, dayIndex, regime) {
  if (!portfolio.riskControlsEnabled) return [];
  const reasons = [];
  if ((portfolio.riskRules.exposureLimits[regime] ?? 0) <= 0) reasons.push('市場狀態禁止新倉');
  if (dayIndex <= portfolio.drawdownBlockUntil) reasons.push('帳戶回撤熔斷');
  if (dayIndex <= portfolio.dailyBlockUntil) reasons.push('前一交易日虧損熔斷');
  if (dayIndex <= portfolio.lossStreakBlockUntil) reasons.push('連續虧損交易熔斷');
  if (portfolio.monthlyEntryBlocked) reasons.push('單月虧損熔斷');
  return reasons;
}

export function beginPortfolioDay(portfolio, date, dayIndex, regime) {
  const month = monthKey(date);
  if (portfolio.activeMonth !== month) {
    portfolio.activeMonth = month;
    portfolio.monthStartEquity = portfolioEquity(portfolio);
    portfolio.monthlyEntryBlocked = false;
  }
  portfolio.currentDay = {
    date,
    dayIndex,
    regime,
    entries: [],
    exits: [],
    stopLosses: [],
    realizedPnl: 0,
    entryBlockReasons: activeBlockReasons(portfolio, dayIndex, regime)
  };
  return portfolio.currentDay;
}

export function entryPermission(portfolio, trade, dayIndex, regime, options = {}) {
  if (portfolio.positions.length >= portfolio.maxOpenPositions) {
    return { allowed: false, reasons: ['已達最大持倉檔數'] };
  }
  if (portfolio.positions.some(position => position.symbol === trade.symbol)) {
    return { allowed: false, reasons: ['已有同一股票持倉'] };
  }
  const reasons = activeBlockReasons(portfolio, dayIndex, regime);
  if (reasons.length) return { allowed: false, reasons };

  const equity = portfolioEquity(portfolio);
  const exposure = portfolioExposure(portfolio);
  const exposureLimitPct = portfolio.riskControlsEnabled
    ? portfolio.riskRules.exposureLimits[regime] ?? 0
    : 100;
  const exposureCapacity = Math.max(0, equity * exposureLimitPct / 100 - exposure);
  const requestedPositionPct = options.positionPct ?? trade.positionPct ?? 15;
  const maxPositionPct = portfolio.riskControlsEnabled
    ? portfolio.riskRules.maxSinglePositionPct * 0.9
    : requestedPositionPct;
  const allocation = Math.min(
    portfolio.availableCash,
    exposureCapacity,
    equity * Math.min(requestedPositionPct, maxPositionPct) / 100
  );
  if (allocation <= 0) {
    return { allowed: false, reasons: ['可用現金或曝險額度不足'] };
  }
  return { allowed: true, reasons: [], allocation, equity, exposureLimitPct };
}

export function openPosition(portfolio, trade, dayIndex, options = {}) {
  const regime = options.regime ?? trade.regime;
  const permission = entryPermission(portfolio, trade, dayIndex, regime, options);
  if (!permission.allowed) {
    portfolio.rejectedEntries.push({
      date: portfolio.currentDay?.date ?? trade.entryDate,
      symbol: trade.symbol,
      strategy: trade.strategy,
      regime,
      reasons: permission.reasons
    });
    return null;
  }
  const requestedRiskPct = options.accountRiskPct ?? 1.5;
  const accountRiskPct = portfolio.riskControlsEnabled
    ? Math.min(requestedRiskPct, portfolio.riskRules.maxAccountRiskPct)
    : requestedRiskPct;
  const riskBudget = permission.equity * accountRiskPct / 100;
  const quantity = affordableQuantity(
    trade.entryPrice,
    trade.stopLoss,
    permission.allocation,
    riskBudget,
    portfolio.executionCosts
  );
  if (!quantity) {
    portfolio.rejectedEntries.push({
      date: portfolio.currentDay?.date ?? trade.entryDate,
      symbol: trade.symbol,
      strategy: trade.strategy,
      regime,
      reasons: ['風險預算不足以建立最小交易單位']
    });
    return null;
  }
  const buy = buyExecution(trade.entryPrice, quantity, portfolio.executionCosts);
  if (buy.total > portfolio.availableCash) return null;
  portfolio.availableCash -= buy.total;
  const position = {
    ...trade,
    quantity,
    buy,
    entryDayIndex: dayIndex,
    entryEquity: permission.equity,
    peakPrice: trade.entryPrice,
    markPrice: trade.entryPrice,
    markValue: sellExecution(trade.entryPrice, quantity, portfolio.executionCosts).net,
    plannedRiskPct: round((buy.total - sellExecution(trade.stopLoss, quantity, portfolio.executionCosts).net)
      / permission.equity * 100, 4)
  };
  portfolio.positions.push(position);
  portfolio.currentDay?.entries.push({
    symbol: position.symbol,
    name: position.name,
    strategy: position.strategy,
    price: round(position.entryPrice),
    quantity: position.quantity,
    positionValue: round(position.buy.total, 0),
    plannedRiskPct: position.plannedRiskPct
  });
  return position;
}

export function markPosition(portfolio, tradeId, price) {
  const position = portfolio.positions.find(item => item.tradeId === tradeId);
  if (!position || !Number.isFinite(price)) return;
  position.markPrice = price;
  position.peakPrice = Math.max(position.peakPrice, price);
  position.markValue = sellExecution(price, position.quantity, portfolio.executionCosts).net;
}

export function closePosition(portfolio, position, exit, dayIndex) {
  const sell = sellExecution(exit.price, position.quantity, portfolio.executionCosts);
  const realizedPnl = sell.net - position.buy.total;
  portfolio.positions = portfolio.positions.filter(item => item.tradeId !== position.tradeId);
  portfolio.unsettled.push({
    releaseIndex: dayIndex + portfolio.settlementDays,
    amount: sell.net
  });
  const closed = {
    ...position,
    exitDate: exit.date,
    exitPrice: round(sell.fillPrice),
    exitReason: exit.reason,
    exitType: exit.type || null,
    holdingDays: dayIndex - position.entryDayIndex + 1,
    sell,
    realizedPnl: round(realizedPnl, 0),
    tradeReturnPct: round(realizedPnl / position.buy.total * 100),
    accountReturnPct: round(realizedPnl / position.entryEquity * 100)
  };
  portfolio.closedTrades.push(closed);

  if (realizedPnl < 0) portfolio.losingStreak += 1;
  else portfolio.losingStreak = 0;
  if (portfolio.riskControlsEnabled
    && portfolio.losingStreak >= portfolio.riskRules.losingStreakCount) {
    portfolio.lossStreakBlockUntil = Math.max(
      portfolio.lossStreakBlockUntil,
      dayIndex + portfolio.riskRules.losingStreakBlockDays
    );
    portfolio.riskEvents.push({
      date: exit.date,
      type: '連續虧損交易熔斷',
      value: portfolio.losingStreak,
      blockedUntilDayIndex: portfolio.lossStreakBlockUntil
    });
    portfolio.losingStreak = 0;
  }

  const exitRow = {
    symbol: closed.symbol,
    name: closed.name,
    strategy: closed.strategy,
    price: closed.exitPrice,
    quantity: closed.quantity,
    reason: closed.exitReason,
    realizedPnl: closed.realizedPnl
  };
  if (portfolio.currentDay) {
    portfolio.currentDay.exits.push(exitRow);
    portfolio.currentDay.realizedPnl += realizedPnl;
    if (exit.type === 'stop_loss' || /停損|防守/.test(exit.reason || '')) {
      portfolio.currentDay.stopLosses.push(exitRow);
    }
  }
  return closed;
}

export function recordEquity(portfolio, date, context = {}) {
  const dayIndex = context.dayIndex ?? portfolio.currentDay?.dayIndex ?? portfolio.equityCurve.length;
  const regime = context.regime ?? portfolio.currentDay?.regime ?? null;
  const equity = portfolioEquity(portfolio);
  const exposure = portfolioExposure(portfolio);
  const unrealizedPnl = portfolio.positions.reduce(
    (sum, position) => sum + position.markValue - position.buy.total,
    0
  );
  const dailyReturnPct = portfolio.previousEquity
    ? (equity / portfolio.previousEquity - 1) * 100
    : 0;
  portfolio.peakEquity = Math.max(portfolio.peakEquity, equity);
  const drawdownPct = portfolio.peakEquity
    ? (equity / portfolio.peakEquity - 1) * 100
    : 0;
  const monthlyReturnPct = portfolio.monthStartEquity
    ? (equity / portfolio.monthStartEquity - 1) * 100
    : 0;

  if (portfolio.riskControlsEnabled) {
    if (dailyReturnPct <= -portfolio.riskRules.dailyLossBlockPct) {
      portfolio.dailyBlockUntil = Math.max(
        portfolio.dailyBlockUntil,
        dayIndex + portfolio.riskRules.dailyLossBlockDays
      );
      portfolio.riskEvents.push({
        date,
        type: '單日虧損熔斷',
        valuePct: round(dailyReturnPct),
        blockedUntilDayIndex: portfolio.dailyBlockUntil
      });
    }
    if (!portfolio.monthlyEntryBlocked
      && monthlyReturnPct <= -portfolio.riskRules.monthlyLossBlockPct) {
      portfolio.monthlyEntryBlocked = true;
      portfolio.riskEvents.push({
        date,
        type: '單月虧損熔斷',
        valuePct: round(monthlyReturnPct),
        blockedUntilMonthEnd: true
      });
    }
    if (drawdownPct <= -portfolio.riskRules.drawdownBlockPct
      && dayIndex > portfolio.drawdownBlockUntil) {
      portfolio.drawdownBlockUntil = Math.max(
        portfolio.drawdownBlockUntil,
        dayIndex + portfolio.riskRules.drawdownBlockDays
      );
      portfolio.riskEvents.push({
        date,
        type: '帳戶回撤熔斷',
        valuePct: round(drawdownPct),
        blockedUntilDayIndex: portfolio.drawdownBlockUntil
      });
    }
  }

  const blockReasons = activeBlockReasons(portfolio, dayIndex, regime);
  const row = {
    date,
    regime,
    equity: round(equity, 0),
    availableCash: round(portfolio.availableCash, 0),
    unsettledCash: round(portfolio.unsettled.reduce((sum, item) => sum + item.amount, 0), 0),
    openPositions: portfolio.positions.length,
    exposure: round(exposure, 0),
    exposurePct: round(equity ? exposure / equity * 100 : 0),
    dailyReturnPct: round(dailyReturnPct),
    monthlyReturnPct: round(monthlyReturnPct),
    drawdownPct: round(drawdownPct),
    realizedPnl: round(portfolio.currentDay?.realizedPnl || 0, 0),
    unrealizedPnl: round(unrealizedPnl, 0),
    newEntries: portfolio.currentDay?.entries || [],
    exits: portfolio.currentDay?.exits || [],
    stopLosses: portfolio.currentDay?.stopLosses || [],
    defenseTriggered: blockReasons.length > 0,
    defenseReasons: blockReasons,
    positions: portfolio.positions.map(position => ({
      symbol: position.symbol,
      strategy: position.strategy,
      markValue: round(position.markValue, 0),
      unrealizedPnl: round(position.markValue - position.buy.total, 0)
    }))
  };
  portfolio.equityCurve.push(row);
  portfolio.previousEquity = equity;
  return equity;
}
