import assert from 'node:assert/strict';
import { simulateEntry, simulateExit } from './lib/execution-simulator.mjs';
import { buildMarketRegimes } from './lib/market-regime.mjs';
import { STRATEGIES } from './lib/strategy-engine.mjs';

const gapBreakout = simulateEntry({
  mode: 'resistance_breakout',
  nextDay: { open: 108, high: 110, low: 107, close: 109 },
  triggerPrice: 105
});
assert.equal(gapBreakout.price, 108, '跳空突破必須以開盤價而非較低觸發價成交');

const touchedBreakout = simulateEntry({
  mode: 'resistance_breakout',
  nextDay: { open: 102, high: 106, low: 101, close: 105 },
  triggerPrice: 105
});
assert.equal(touchedBreakout.price, 105, '盤中突破可在觸發價成交');

const gapStop = simulateExit({
  day: { open: 91, high: 94, low: 89, close: 92 },
  stopLoss: 95
});
assert.equal(gapStop.price, 91, '跳空跌破停損必須以較差開盤價成交');

const touchedStop = simulateExit({
  day: { open: 98, high: 99, low: 94, close: 96 },
  stopLoss: 95
});
assert.equal(touchedStop.price, 95, '盤中觸發停損可在停損價成交');

const history = Array.from({ length: 240 }, (_, index) => ({
  date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
  close: 100 + index * 0.1 + Math.sin(index / 5)
}));
const full = buildMarketRegimes(history);
const prefix = buildMarketRegimes(history.slice(0, 220));
assert.deepEqual(full[219], prefix[219], '市場狀態不可因未來資料改變');
for (const strategy of Object.values(STRATEGIES)) {
  for (const method of [
    'screen', 'entry', 'exit', 'positionSizing', 'maxHoldingDays', 'stopLoss', 'takeProfit'
  ]) {
    assert.equal(typeof strategy[method], 'function', `${strategy.name} 缺少 ${method}()`);
  }
}

console.log('execution, no-look-ahead, and strategy interface tests passed');
