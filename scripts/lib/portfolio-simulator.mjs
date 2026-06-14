import {
  affordableQuantity,
  buyExecution,
  sellExecution
} from './execution-simulator.mjs';

const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

export function createPortfolio(options = {}) {
  return {
    initialCapital: options.initialCapital ?? 1_000_000,
    availableCash: options.initialCapital ?? 1_000_000,
    unsettled: [],
    positions: [],
    closedTrades: [],
    equityCurve: [],
    settlementDays: options.settlementDays ?? 2,
    maxOpenPositions: options.maxOpenPositions ?? 6,
    executionCosts: options.executionCosts || {}
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

export function openPosition(portfolio, trade, dayIndex, options = {}) {
  if (portfolio.positions.length >= portfolio.maxOpenPositions) return null;
  if (portfolio.positions.some(position => position.symbol === trade.symbol)) return null;
  const equity = portfolioEquity(portfolio);
  const allocation = Math.min(
    portfolio.availableCash,
    equity * (options.positionPct ?? trade.positionPct ?? 15) / 100
  );
  const riskBudget = equity * (options.accountRiskPct ?? 1.5) / 100;
  const quantity = affordableQuantity(
    trade.entryPrice,
    trade.stopLoss,
    allocation,
    riskBudget,
    portfolio.executionCosts
  );
  if (!quantity) return null;
  const buy = buyExecution(trade.entryPrice, quantity, portfolio.executionCosts);
  portfolio.availableCash -= buy.total;
  const position = {
    ...trade,
    quantity,
    buy,
    entryDayIndex: dayIndex,
    entryEquity: equity,
    peakPrice: trade.entryPrice,
    markPrice: trade.entryPrice,
    markValue: sellExecution(trade.entryPrice, quantity, portfolio.executionCosts).net
  };
  portfolio.positions.push(position);
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
    sell,
    realizedPnl: round(realizedPnl, 0),
    tradeReturnPct: round(realizedPnl / position.buy.total * 100),
    accountReturnPct: round(realizedPnl / position.entryEquity * 100)
  };
  portfolio.closedTrades.push(closed);
  return closed;
}

export function recordEquity(portfolio, date) {
  const equity = portfolioEquity(portfolio);
  portfolio.equityCurve.push({
    date,
    equity: round(equity, 0),
    availableCash: round(portfolio.availableCash, 0),
    unsettledCash: round(portfolio.unsettled.reduce((sum, item) => sum + item.amount, 0), 0),
    openPositions: portfolio.positions.length
  });
  return equity;
}
