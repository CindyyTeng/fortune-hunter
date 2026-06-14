export const DEFAULT_EXECUTION_COSTS = Object.freeze({
  buyFeePct: 0.1425,
  sellFeePct: 0.1425,
  sellTaxPct: 0.3,
  buySlippagePct: 0.15,
  sellSlippagePct: 0.15,
  minimumFee: 20,
  boardLotShares: 1000
});

const number = value => Number.isFinite(Number(value)) ? Number(value) : null;

export function orderFee(price, quantity, feePct, options = {}) {
  const minimumFee = options.minimumFee ?? DEFAULT_EXECUTION_COSTS.minimumFee;
  const boardLotShares = options.boardLotShares ?? DEFAULT_EXECUTION_COSTS.boardLotShares;
  const feeFor = shares => shares > 0
    ? Math.max(minimumFee, Math.ceil(price * shares * feePct / 100))
    : 0;
  const boardShares = Math.floor(quantity / boardLotShares) * boardLotShares;
  return feeFor(boardShares) + feeFor(quantity - boardShares);
}

export function buyExecution(price, quantity, options = {}) {
  const costs = { ...DEFAULT_EXECUTION_COSTS, ...options };
  const fillPrice = price * (1 + (options.applySlippage === false ? 0 : costs.buySlippagePct) / 100);
  const tradeValue = fillPrice * quantity;
  const fee = orderFee(fillPrice, quantity, costs.buyFeePct, costs);
  return { fillPrice, tradeValue, fee, total: tradeValue + fee };
}

export function sellExecution(price, quantity, options = {}) {
  const costs = { ...DEFAULT_EXECUTION_COSTS, ...options };
  const fillPrice = price * (1 - (options.applySlippage === false ? 0 : costs.sellSlippagePct) / 100);
  const tradeValue = fillPrice * quantity;
  const fee = orderFee(fillPrice, quantity, costs.sellFeePct, costs);
  const tax = Math.ceil(tradeValue * costs.sellTaxPct / 100);
  return { fillPrice, tradeValue, fee, tax, net: tradeValue - fee - tax };
}

export function netReturnPct(entryPrice, exitPrice, options = {}) {
  const buy = buyExecution(entryPrice, 1, { ...options, minimumFee: 0 });
  const sell = sellExecution(exitPrice, 1, { ...options, minimumFee: 0 });
  return (sell.net / buy.total - 1) * 100;
}

export function affordableQuantity(entryPrice, stopPrice, cashBudget, riskBudget, options = {}) {
  const minimumOrderValue = options.minimumOrderValue ?? 20_000;
  let low = 0;
  let high = Math.max(0, Math.floor(cashBudget / entryPrice));
  while (low < high) {
    const quantity = Math.ceil((low + high) / 2);
    const buy = buyExecution(entryPrice, quantity, options);
    const stop = sellExecution(stopPrice, quantity, options);
    if (buy.total <= cashBudget && buy.total - stop.net <= riskBudget) low = quantity;
    else high = quantity - 1;
  }
  return low > 0 && buyExecution(entryPrice, low, options).tradeValue >= minimumOrderValue ? low : 0;
}

export function simulateEntry({
  mode,
  signalDay,
  nextDay,
  triggerPrice,
  limitPrice,
  limitFloor,
  pullbackPrice,
  pullbackFloor,
  closePrice
}) {
  if (!nextDay) return null;
  const open = number(nextDay.open);
  const high = number(nextDay.high ?? nextDay.price);
  const low = number(nextDay.low ?? nextDay.price);
  const close = number(nextDay.close ?? nextDay.price);
  if (![open, high, low, close].every(Number.isFinite)) return null;

  if (mode === 'next_open_market' || mode === 'next_open') {
    return { price: open, referencePrice: open, mode, reason: '隔日開盤市價' };
  }
  if (mode === 'close_confirm') {
    const trigger = number(triggerPrice);
    if (trigger && (close < trigger || close < open)) return null;
    return { price: closePrice ?? close, referencePrice: close, mode, reason: '收盤確認' };
  }
  if (mode === 'next_open_limit') {
    const limit = number(limitPrice);
    const floor = number(limitFloor) ?? 0;
    if (!limit || low > limit || high < floor) return null;
    const price = open <= limit && open >= floor ? open : Math.max(floor, limit);
    return { price, referencePrice: limit, mode, reason: '隔日限價' };
  }
  if (mode === 'pullback_entry') {
    const target = number(pullbackPrice);
    const floor = number(pullbackFloor) ?? 0;
    if (!target || low > target || high < floor) return null;
    const price = open <= target && open >= floor ? open : Math.max(floor, target);
    return { price, referencePrice: target, mode, reason: '回測承接' };
  }
  if (mode === 'resistance_breakout' || mode === 'intraday_breakout') {
    const trigger = number(triggerPrice);
    if (!trigger || high < trigger) return null;
    // A gap above the trigger cannot be filled at the lower trigger price.
    const price = Math.max(open, trigger);
    return { price, referencePrice: trigger, mode, reason: '壓力突破' };
  }
  throw new Error(`Unsupported entry mode: ${mode}`);
}

export function simulateExit({
  day,
  stopLoss,
  takeProfit,
  trailingStop,
  peakPrice,
  closeStop = false
}) {
  if (!day) return null;
  const open = number(day.open ?? day.price);
  const high = number(day.high ?? day.price);
  const low = number(day.low ?? day.price);
  const close = number(day.close ?? day.price);
  if (![open, high, low, close].every(Number.isFinite)) return null;

  const stop = number(stopLoss);
  if (stop) {
    if (closeStop && close <= stop) {
      return { price: close, referencePrice: stop, type: 'stop_loss', reason: '收盤跌破停損' };
    }
    if (!closeStop && open <= stop) {
      return { price: open, referencePrice: stop, type: 'stop_loss', reason: '跳空跌破停損' };
    }
    if (!closeStop && low <= stop) {
      return { price: stop, referencePrice: stop, type: 'stop_loss', reason: '盤中跌破停損' };
    }
  }

  const trail = number(trailingStop);
  if (trail) {
    if (open <= trail) {
      return { price: open, referencePrice: trail, type: 'trailing_stop', reason: '跳空跌破移動停利' };
    }
    if (low <= trail) {
      return { price: trail, referencePrice: trail, type: 'trailing_stop', reason: '觸發移動停利' };
    }
  }

  const target = number(takeProfit);
  if (target) {
    if (open >= target) {
      return { price: open, referencePrice: target, type: 'take_profit', reason: '跳空越過停利' };
    }
    if (high >= target) {
      return { price: target, referencePrice: target, type: 'take_profit', reason: '觸發停利' };
    }
  }

  return {
    price: null,
    type: null,
    reason: null,
    peakPrice: Math.max(number(peakPrice) ?? -Infinity, high)
  };
}

export function trailingStopPrice(entryPrice, peakPrice, rule) {
  if (!rule || !Number.isFinite(peakPrice)) return null;
  const peakReturnPct = (peakPrice / entryPrice - 1) * 100;
  if (peakReturnPct < rule.triggerPct) return null;
  const lockedReturnPct = Math.max(rule.lockPct ?? 0, peakReturnPct - rule.givebackPct);
  return entryPrice * (1 + lockedReturnPct / 100);
}
