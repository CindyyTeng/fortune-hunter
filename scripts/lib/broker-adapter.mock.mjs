import { buyExecution, sellExecution } from './execution-simulator.mjs';

function deterministicRatio(text) {
  let hash = 2166136261;
  for (const character of String(text)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

export class MockBrokerAdapter {
  constructor(options = {}) {
    this.options = {
      failureRate: options.failureRate ?? 0.05,
      partialFillRate: options.partialFillRate ?? 0.15,
      executionCosts: options.executionCosts || {}
    };
    this.orders = [];
  }

  submitOrderIntent(intent, market, account) {
    const submittedAt = new Date().toISOString();
    const base = {
      orderId: `MOCK-${intent.intentId}`,
      intentId: intent.intentId,
      symbol: intent.symbol,
      side: intent.side,
      requestedQuantity: intent.quantity,
      submittedAt,
      isMock: true
    };
    if (intent.status === 'BLOCKED' || !intent.quantity) {
      return this.#record({
        ...base,
        status: 'REJECTED',
        filledQuantity: 0,
        reason: intent.blockReasons?.join('、') || '下單意圖不可執行'
      });
    }

    const scenario = intent.simulationScenario;
    const marketPrice = Number(market?.price);
    if (!Number.isFinite(marketPrice) || marketPrice <= 0) {
      return this.#record({
        ...base,
        status: 'REJECTED',
        filledQuantity: 0,
        reason: '缺少有效市場價格'
      });
    }
    if (scenario === 'FAILURE') {
      return this.#record({
        ...base,
        status: 'REJECTED',
        filledQuantity: 0,
        reason: '模擬券商拒絕委託'
      });
    }
    if (scenario === 'LIMIT_LOCKED'
      || (intent.side === 'BUY' && market.atUpperLimit && !market.askAvailable)
      || (intent.side === 'SELL' && market.atLowerLimit && !market.bidAvailable)) {
      return this.#record({
        ...base,
        status: 'UNFILLED',
        filledQuantity: 0,
        reason: intent.side === 'BUY' ? '漲停無賣單，無法成交' : '跌停無買單，無法成交'
      });
    }

    const limitPrice = intent.limitPrice == null ? null : Number(intent.limitPrice);
    if (Number.isFinite(limitPrice)
      && ((intent.side === 'BUY' && marketPrice > limitPrice)
        || (intent.side === 'SELL' && marketPrice < limitPrice))) {
      return this.#record({
        ...base,
        status: 'UNFILLED',
        filledQuantity: 0,
        reason: intent.side === 'BUY' ? '市價高於買進限價' : '市價低於賣出限價'
      });
    }
    const expectedPrice = marketPrice;
    const requestedExecution = intent.side === 'BUY'
      ? buyExecution(expectedPrice, intent.quantity, this.options.executionCosts)
      : sellExecution(expectedPrice, intent.quantity, this.options.executionCosts);
    if (intent.side === 'BUY'
      && (scenario === 'INSUFFICIENT_FUNDS'
        || requestedExecution.total > Number(account?.availableCash || 0))) {
      return this.#record({
        ...base,
        status: 'REJECTED',
        filledQuantity: 0,
        reason: '可用資金不足',
        requiredCash: requestedExecution.total,
        availableCash: Number(account?.availableCash || 0)
      });
    }

    const random = deterministicRatio(intent.intentId);
    if (random < this.options.failureRate) {
      return this.#record({
        ...base,
        status: 'REJECTED',
        filledQuantity: 0,
        reason: '模擬連線或券商端錯誤'
      });
    }
    const partial = scenario === 'PARTIAL_FILL'
      || random < this.options.failureRate + this.options.partialFillRate;
    const filledQuantity = partial
      ? Math.max(1, Math.floor(intent.quantity / 2))
      : intent.quantity;
    const execution = intent.side === 'BUY'
      ? buyExecution(expectedPrice, filledQuantity, this.options.executionCosts)
      : sellExecution(expectedPrice, filledQuantity, this.options.executionCosts);
    return this.#record({
      ...base,
      status: partial ? 'PARTIALLY_FILLED' : 'FILLED',
      filledQuantity,
      remainingQuantity: intent.quantity - filledQuantity,
      fillPrice: execution.fillPrice,
      fee: execution.fee,
      tax: execution.tax ?? 0,
      cashImpact: intent.side === 'BUY' ? -execution.total : execution.net,
      reason: partial ? '模擬部分成交' : '模擬全部成交'
    });
  }

  submitOrderIntents(intents, marketBySymbol, account) {
    return intents.map(intent => this.submitOrderIntent(
      intent,
      marketBySymbol[intent.symbol],
      account
    ));
  }

  #record(result) {
    this.orders.push(result);
    return result;
  }
}

export function createMockBroker(options = {}) {
  return new MockBrokerAdapter(options);
}
