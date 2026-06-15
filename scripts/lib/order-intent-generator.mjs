import { createHash } from 'node:crypto';
import { affordableQuantity } from './execution-simulator.mjs';

function intentId(decision) {
  return createHash('sha256')
    .update(`${decision.date}|${decision.symbol}|${decision.strategyId}|${decision.action}`)
    .digest('hex')
    .slice(0, 20);
}

function baseIntent(decision) {
  return {
    intentId: intentId(decision),
    createdAt: new Date().toISOString(),
    tradeDate: decision.date,
    symbol: decision.symbol,
    strategyId: decision.strategyId,
    action: decision.action,
    status: 'PENDING_REVIEW',
    submitToRealBroker: false,
    reason: decision.reason,
    warnings: decision.warnings,
    audit: {
      setup: decision.setup,
      trigger: decision.trigger,
      invalidation: decision.invalidation,
      noFutureDataAttestation: true,
      humanApprovalRequired: true
    }
  };
}

export function decisionToOrderIntent(decision, {
  account = {},
  position = null,
  executionCosts = {}
} = {}) {
  if (!['BUY', 'SELL'].includes(decision.action)) return null;
  const intent = baseIntent(decision);

  if (decision.action === 'SELL') {
    if (!position?.quantity) {
      return {
        ...intent,
        status: 'BLOCKED',
        side: 'SELL',
        blockReasons: ['找不到可賣出的持倉數量']
      };
    }
    return {
      ...intent,
      side: 'SELL',
      quantity: position.quantity,
      orderType: 'MARKETABLE_LIMIT',
      limitPrice: position.exitLimitPrice ?? null,
      timeInForce: 'ROD',
      session: 'REGULAR',
      brokerPayload: {
        symbol: decision.symbol,
        side: 'SELL',
        quantity: position.quantity,
        orderType: 'MARKETABLE_LIMIT',
        price: position.exitLimitPrice ?? null,
        timeInForce: 'ROD'
      }
    };
  }

  const entryPrice = decision.entryPlan?.referencePrice;
  const stopPrice = decision.riskPlan?.stopPrice;
  const cashBudget = Math.min(
    Number(account.availableCash || 0),
    Number(decision.riskPlan?.positionBudget || 0)
  );
  const riskBudget = Math.min(
    Number(decision.riskPlan?.riskBudget || 0),
    Number(account.equity || 0) * 0.005
  );
  const quantity = affordableQuantity(
    entryPrice,
    stopPrice,
    cashBudget,
    riskBudget,
    executionCosts
  );
  if (!quantity) {
    return {
      ...intent,
      status: 'BLOCKED',
      side: 'BUY',
      quantity: 0,
      blockReasons: ['資金或單筆風險預算不足']
    };
  }
  const limitPrice = decision.entryPlan.maximumAcceptablePrice;
  return {
    ...intent,
    side: 'BUY',
    quantity,
    boardLotQuantity: Math.floor(quantity / 1000) * 1000,
    oddLotQuantity: quantity % 1000,
    orderType: decision.entryPlan.orderType,
    limitPrice,
    stopPrice,
    targetPrice: decision.riskPlan.targetPrice,
    riskRewardRatio: decision.riskPlan.riskRewardRatio,
    timeInForce: decision.entryPlan.timeInForce,
    session: decision.entryPlan.session,
    brokerPayload: {
      symbol: decision.symbol,
      side: 'BUY',
      quantity,
      orderType: decision.entryPlan.orderType,
      price: limitPrice,
      triggerPrice: entryPrice,
      timeInForce: decision.entryPlan.timeInForce
    }
  };
}

export function generateOrderIntents({
  decisions,
  account,
  positions = [],
  executionCosts = {}
}) {
  const positionsBySymbol = new Map(positions.map(position => [position.symbol, position]));
  return decisions
    .map(decision => decisionToOrderIntent(decision, {
      account,
      position: positionsBySymbol.get(decision.symbol),
      executionCosts
    }))
    .filter(Boolean);
}
