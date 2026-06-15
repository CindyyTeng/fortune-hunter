import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { loadStrategySpecs, generateStrategySignals } from './lib/strategy-signal-engine.mjs';
import { buildTradingDecisions, summarizeDecisions } from './lib/trading-decision-engine.mjs';
import { generateOrderIntents } from './lib/order-intent-generator.mjs';
import { createMockBroker } from './lib/broker-adapter.mock.mjs';

const outputUrl = new URL('../data/research/mock-order-intents.json', import.meta.url);
const strategySpecs = await loadStrategySpecs();
const availableData = [
  'daily_ohlcv',
  'market_regime',
  'price_limit',
  'corporate_actions'
];
const date = '2026-06-15';
const baseRisk = {
  corporateActionUnadjusted: false,
  isAttention: false,
  isDisposition: false
};
const baseTechnical = {
  selloff3DayPct: -10,
  stabilizationDays: 2,
  newLowAfterSelloff: false,
  longLowerWick: true,
  closeAbovePriorHigh: true,
  closeUp: true,
  closeBelowStabilizationLow: false,
  openGapPct: 0,
  stabilizationLow: 90,
  stabilizationConfirmationHigh: 100,
  triggerPrice: 100,
  support: 90,
  atr: 4,
  atrPct: 4
};
const stocks = [
  {
    symbol: 'MOCK-BUY',
    name: '模擬買進',
    quote: { close: 99 },
    technical: baseTechnical,
    market: { regime: 'RANGE_BOUND' },
    risk: baseRisk
  },
  {
    symbol: 'MOCK-SELL',
    name: '模擬賣出',
    quote: { close: 86 },
    technical: {
      ...baseTechnical,
      closeBelowStabilizationLow: true
    },
    market: { regime: 'RANGE_BOUND' },
    risk: baseRisk
  },
  {
    symbol: 'MOCK-HOLD',
    name: '模擬續抱',
    quote: { close: 104 },
    technical: {
      ...baseTechnical,
      closeUp: false,
      longLowerWick: false,
      closeAbovePriorHigh: false
    },
    market: { regime: 'RANGE_BOUND' },
    risk: baseRisk
  },
  {
    symbol: 'MOCK-SKIP',
    name: '模擬略過',
    quote: { close: 50 },
    technical: {
      ...baseTechnical,
      selloff3DayPct: -2
    },
    market: { regime: 'RANGE_BOUND' },
    risk: baseRisk
  }
];
const approvedStrategyIds = ['high_volatility_stabilized_reversal'];
const positions = [
  {
    symbol: 'MOCK-SELL',
    strategyId: 'high_volatility_stabilized_reversal',
    quantity: 1000,
    stopPrice: 90,
    targetPrice: 108,
    exitLimitPrice: 85
  },
  {
    symbol: 'MOCK-HOLD',
    strategyId: 'high_volatility_stabilized_reversal',
    quantity: 500,
    stopPrice: 94,
    targetPrice: 112
  }
];
const account = {
  equity: 1_000_000,
  availableCash: 800_000
};

const allSignals = generateStrategySignals({
  date,
  stocks,
  strategySpecs,
  availableData,
  approvedStrategyIds,
  simulationOnly: true
});
const productionSignals = generateStrategySignals({
  date,
  stocks: [stocks[0]],
  strategySpecs,
  availableData,
  approvedStrategyIds,
  simulationOnly: false
});
const productionResearchSignal = productionSignals.find(signal =>
  signal.strategyId === 'high_volatility_stabilized_reversal'
);
assert.equal(productionResearchSignal.executable, false);
assert.equal(productionResearchSignal.status, 'RESEARCH_ONLY');

const signals = allSignals.filter(signal =>
  signal.strategyId === 'high_volatility_stabilized_reversal'
);
const decisions = buildTradingDecisions({ signals, account, positions });
const decisionSummary = summarizeDecisions(decisions);
for (const action of ['BUY', 'SELL', 'HOLD', 'SKIP']) {
  assert.equal(decisionSummary[action], 1, `缺少 ${action} 決策`);
}

const intents = generateOrderIntents({
  decisions,
  account,
  positions
});
assert.equal(intents.length, 2, 'BUY 與 SELL 應各產生一筆下單意圖');
assert.ok(intents.every(intent => intent.submitToRealBroker === false));

const buyIntent = intents.find(intent => intent.side === 'BUY');
const sellIntent = intents.find(intent => intent.side === 'SELL');
const scenarios = [
  { ...buyIntent, intentId: `${buyIntent.intentId}-SUCCESS`, simulationScenario: 'SUCCESS' },
  { ...buyIntent, intentId: `${buyIntent.intentId}-PARTIAL`, simulationScenario: 'PARTIAL_FILL' },
  { ...buyIntent, intentId: `${buyIntent.intentId}-FAIL`, simulationScenario: 'FAILURE' },
  { ...buyIntent, intentId: `${buyIntent.intentId}-LIMIT`, simulationScenario: 'LIMIT_LOCKED' },
  { ...buyIntent, intentId: `${buyIntent.intentId}-CASH`, simulationScenario: 'INSUFFICIENT_FUNDS' },
  { ...sellIntent, intentId: `${sellIntent.intentId}-SELL`, simulationScenario: 'SUCCESS' }
];
const broker = createMockBroker({
  failureRate: 0,
  partialFillRate: 0
});
const marketBySymbol = {
  'MOCK-BUY': {
    price: 100,
    atUpperLimit: false,
    askAvailable: true
  },
  'MOCK-SELL': {
    price: 86,
    atLowerLimit: false,
    bidAvailable: true
  }
};
const brokerResults = scenarios.map(intent => broker.submitOrderIntent(
  intent,
  marketBySymbol[intent.symbol],
  account
));
brokerResults.push(broker.submitOrderIntent(
  { ...buyIntent, intentId: `${buyIntent.intentId}-PRICE-MISS` },
  { price: buyIntent.limitPrice + 1, askAvailable: true },
  account
));
const statuses = new Set(brokerResults.map(result => result.status));
for (const status of ['FILLED', 'PARTIALLY_FILLED', 'REJECTED', 'UNFILLED']) {
  assert.ok(statuses.has(status), `Mock broker 缺少 ${status} 結果`);
}
assert.ok(brokerResults.some(result => result.reason === '可用資金不足'));
assert.ok(brokerResults.some(result => result.reason === '市價高於買進限價'));

const report = {
  generatedAt: new Date().toISOString(),
  branch: 'high-profit-executable-strategy-v1',
  mode: 'MOCK_ONLY',
  realBrokerConnected: false,
  realOrdersSubmitted: false,
  availableData,
  approvedStrategyIds,
  signalCount: signals.length,
  decisionSummary,
  decisions,
  orderIntents: intents,
  brokerResults,
  verifiedScenarios: [
    '委託成功',
    '部分成交',
    '委託失敗',
    '漲跌停無法成交',
    '資金不足',
    '限價未觸及'
  ]
};
await fs.writeFile(outputUrl, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`交易決策：${JSON.stringify(decisionSummary)}`);
console.log(`下單意圖：${intents.length} 筆，真實下單：0 筆。`);
console.log(`Mock broker 狀態：${[...statuses].join('、')}`);
