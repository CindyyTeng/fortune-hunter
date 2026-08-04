import assert from 'node:assert/strict';
import { evaluateStrategyEvidence, evaluateTradeReturns } from './lib/strategy-statistical-validator.mjs';

const stablePositive = Array.from({ length: 400 }, (_, index) => 0.6 + (index % 9) * 0.05);
const negative = Array.from({ length: 400 }, (_, index) => -0.6 + (index % 7) * 0.02);
const concentrated = Array.from({ length: 400 }, (_, index) => index < 20 ? 10 : 0.01);

assert.equal(evaluateTradeReturns(stablePositive).verdict, 'statistical_edge');
assert.equal(evaluateTradeReturns(negative).verdict, 'negative_expectancy');
assert.equal(evaluateTradeReturns(stablePositive.slice(0, 30)).verdict, 'insufficient');
assert.equal(evaluateTradeReturns(concentrated).verdict, 'fragile_edge');
assert.equal(evaluateStrategyEvidence([], []).passed, false);

console.log('策略統計驗證器測試通過。');
