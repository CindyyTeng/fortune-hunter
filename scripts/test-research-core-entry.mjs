import assert from 'node:assert/strict';
import { simulateSignalMap } from './research/research-core.mjs';

const dates = ['2026-01-05', '2026-01-06', '2026-01-07'];
const context = {
  startDate: dates[0],
  endDate: dates.at(-1),
  marketHistory: dates.map(date => ({ date })),
  marketByDate: new Map(dates.map(date => [date, { regime: 'BULL_TREND' }]))
};

function run(high) {
  return simulateSignalMap(context, new Map([[dates[0], [{
    signalDate: dates[0],
    entryDate: dates[1],
    symbol: '2330',
    name: '測試股',
    score: 100,
    entryMode: 'resistance_breakout',
    triggerPrice: 105,
    futureBars: [
      { date: dates[1], open: 108, high, low: 107, close: 109, price: 109 },
      { date: dates[2], open: 109, high: 110, low: 108, close: 109, price: 109 }
    ],
    stopDistancePct: 5,
    rewardRisk: 0,
    maxHoldingDays: 2,
    positionPct: 10,
    accountRiskPct: 0.5
  }]]]), {
    strategyId: '突破成交整合測試',
    startDate: dates[0],
    endDate: dates.at(-1),
    maxOpenPositions: 1
  });
}

const gapFill = run(110);
assert.equal(gapFill.trades.length, 1, '隔日高點突破時應建立交易');
assert.ok(gapFill.trades[0].entryPrice >= 108, '跳空突破不可用低於開盤價的觸發價成交');
assert.equal(run(104).trades.length, 0, '隔日高點未達觸發價時不得成交');

console.log('研究核心突破成交整合測試通過');
