import assert from 'node:assert/strict';
import { createPortfolio, recordEquity } from './lib/portfolio-simulator.mjs';

const portfolio = createPortfolio({
  riskRules: {
    dailyLossBlockPct: 100,
    monthlyLossBlockPct: 100,
    drawdownBlockPct: 8,
    drawdownBlockDays: 20
  }
});

portfolio.availableCash = 910_000;
for (let dayIndex = 0; dayIndex <= 25; dayIndex += 1) {
  recordEquity(portfolio, `2026-01-${String(dayIndex + 1).padStart(2, '0')}`, {
    dayIndex,
    regime: 'BULL_TREND'
  });
}

assert.equal(
  portfolio.riskEvents.filter(event => event.type === '帳戶回撤熔斷').length,
  1,
  '持續位於回撤門檻外時，不應每日重新延長熔斷期'
);
assert.equal(
  portfolio.equityCurve.at(-1).defenseReasons.includes('帳戶回撤熔斷'),
  false,
  '固定冷卻期結束後應允許策略恢復評估新倉'
);

portfolio.availableCash = 930_000;
recordEquity(portfolio, '2026-01-27', { dayIndex: 26, regime: 'BULL_TREND' });
portfolio.availableCash = 910_000;
recordEquity(portfolio, '2026-01-28', { dayIndex: 27, regime: 'BULL_TREND' });

assert.equal(
  portfolio.riskEvents.filter(event => event.type === '帳戶回撤熔斷').length,
  2,
  '回撤回到門檻內後再次跌破，應重新觸發熔斷'
);

console.log('投組模擬器回撤熔斷測試通過');
