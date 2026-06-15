import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  buyExecution,
  sellExecution
} from '../lib/execution-simulator.mjs';
import {
  buildSignalMaps,
  fixedBenchmarkDefinitions,
  loadResearchContext,
  pct,
  round,
  simulateSignalMap,
  summarizeCurveAndTrades
} from './research-core.mjs';

const OUTPUT = new URL('../../data/research/benchmark-comparison.json', import.meta.url);
const REPORT = new URL('../../docs/BENCHMARK_COMPARISON.md', import.meta.url);
const REGIME_RESULT = new URL('../../data/regime-ensemble-backtest-10y.json', import.meta.url);
const INITIAL_CAPITAL = 1_000_000;

function cashBenchmark(context) {
  const dates = context.marketHistory
    .filter(row => row.date >= context.startDate && row.date <= context.endDate);
  const curve = dates.map(row => ({
    date: row.date,
    equity: INITIAL_CAPITAL,
    dailyReturnPct: 0
  }));
  return {
    id: 'cash',
    label: '不交易，持有現金',
    summary: summarizeCurveAndTrades(
      curve,
      [],
      INITIAL_CAPITAL,
      context.startDate,
      context.endDate
    )
  };
}

function buyAndHoldBenchmark(context) {
  const history = context.marketHistory
    .filter(row => row.date >= context.startDate && row.date <= context.endDate);
  const first = history[0];
  let quantity = Math.floor(INITIAL_CAPITAL / first.open);
  while (quantity > 0 && buyExecution(first.open, quantity).total > INITIAL_CAPITAL) quantity -= 1;
  const adjustedBuy = buyExecution(first.open, quantity);
  const cash = INITIAL_CAPITAL - adjustedBuy.total;
  let previousEquity = INITIAL_CAPITAL;
  const curve = history.map(row => {
    const equity = cash + sellExecution(row.close, quantity).net;
    const dailyReturnPct = pct(equity, previousEquity);
    previousEquity = equity;
    return { date: row.date, equity: round(equity, 0), dailyReturnPct };
  });
  const finalSell = sellExecution(history.at(-1).close, quantity);
  const realizedPnl = finalSell.net - adjustedBuy.total;
  const trades = [{
    symbol: '0050',
    entryDate: first.date,
    exitDate: history.at(-1).date,
    realizedPnl,
    tradeReturnPct: pct(finalSell.net, adjustedBuy.total)
  }];
  return {
    id: 'buy_and_hold_market',
    label: '買進持有 0050',
    summary: summarizeCurveAndTrades(
      curve,
      trades,
      INITIAL_CAPITAL,
      context.startDate,
      context.endDate
    )
  };
}

function regimeBenchmark(result) {
  const curve = result.equityCurve.map(row => ({
    date: row.date,
    equity: row.equity,
    dailyReturnPct: row.dailyReturnPct
  }));
  return {
    id: 'regime_ensemble',
    label: '目前市場狀態組合策略',
    summary: summarizeCurveAndTrades(
      curve,
      result.trades,
      result.assumptions.initialCapital,
      result.startDate,
      result.endDate
    )
  };
}

function comparisonNotes(results) {
  const byId = Object.fromEntries(results.map(row => [row.id, row]));
  const regime = byId.regime_ensemble.summary;
  const market = byId.buy_and_hold_market.summary;
  const random = byId.random_selection.summary;
  const cash = byId.cash.summary;
  const notes = [];
  notes.push(regime.annualizedReturnPct > market.annualizedReturnPct
    ? '目前策略年化報酬高於 0050 買進持有。'
    : '目前策略年化報酬輸給 0050 買進持有。');
  notes.push(regime.averageMonthlyEquityReturnPct > random.averageMonthlyEquityReturnPct
    ? '目前策略月均總資產報酬高於隨機選股。'
    : '目前策略月均總資產報酬輸給隨機選股。');
  notes.push(regime.annualizedReturnPct > cash.annualizedReturnPct
    ? '目前策略年化報酬高於持有現金。'
    : '目前策略年化報酬輸給持有現金。');
  return notes;
}

function markdown(report) {
  const rows = report.results.map(row => {
    const summary = row.summary;
    return `| ${row.label} | ${summary.annualizedReturnPct}% | ${summary.averageMonthlyEquityReturnPct}% | ${summary.maximumDrawdownPct}% | ${summary.negativeMonths} | ${summary.winRatePct}% | ${summary.profitFactor ?? '-'} | ${summary.sharpeLike} | ${summary.trades} |`;
  }).join('\n');
  return `# 基準策略比較

> 本報告使用相同十年區間。選股型基準共用成交模擬器、交易成本、持有五日與投資組合風控；0050 買進持有則作為被動市場基準。
> 歷史股票池仍存在倖存者偏差：**${report.survivorshipBiasWarning ? '是' : '否'}**。

## 比較結果

| 方法 | 年化報酬 | 月均總資產報酬 | 最大回撤 | 負月份 | 勝率 | Profit Factor | Sharpe 類似指標 | 交易次數 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${rows}

## 明確判定

${report.comparisonNotes.map(note => `- ${note}`).join('\n')}

## 研究限制

- 隨機選股使用固定雜湊種子，因此每次重跑結果一致，不會挑最好的一次。
- 低波動與高成交值只是單因子基準，不代表完整策略。
- 目前市場狀態組合策略若輸給現金、隨機或 0050，報告會直接標示，不視為成功。
`;
}

async function main() {
  const context = await loadResearchContext();
  const regimeResult = JSON.parse(await fs.readFile(REGIME_RESULT, 'utf8'));
  const definitions = fixedBenchmarkDefinitions();
  const signalMaps = buildSignalMaps(context, definitions, { dailyLimit: 8 });
  const activeBenchmarks = definitions.map(definition => ({
    id: definition.id,
    label: definition.label,
    summary: simulateSignalMap(context, signalMaps[definition.id], {
      strategyId: definition.label,
      holdingDays: 5
    }).summary
  }));
  const results = [
    cashBenchmark(context),
    buyAndHoldBenchmark(context),
    ...activeBenchmarks.slice(0, 1),
    regimeBenchmark(regimeResult),
    ...activeBenchmarks.slice(1)
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    startDate: context.startDate,
    endDate: context.endDate,
    survivorshipBiasWarning: context.survivorshipBiasWarning,
    methodology: {
      activeStrategyHoldingDays: 5,
      executionSimulator: 'scripts/lib/execution-simulator.mjs',
      portfolioSimulator: 'scripts/lib/portfolio-simulator.mjs',
      randomSeed: '固定字串雜湊',
      corporateActionFilter: '選股觀測前 120 日至後 20 日內單日絕對報酬超過 15% 即排除',
      initialCapital: INITIAL_CAPITAL
    },
    results,
    comparisonNotes: comparisonNotes(results)
  };
  await fs.mkdir(new URL('../../data/research/', import.meta.url), { recursive: true });
  await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, markdown(report), 'utf8');
  console.log(JSON.stringify({
    output: fileURLToPath(OUTPUT),
    report: fileURLToPath(REPORT),
    comparisonNotes: report.comparisonNotes,
    results: Object.fromEntries(results.map(row => [row.id, {
      annualizedReturnPct: row.summary.annualizedReturnPct,
      averageMonthlyEquityReturnPct: row.summary.averageMonthlyEquityReturnPct,
      maximumDrawdownPct: row.summary.maximumDrawdownPct,
      profitFactor: row.summary.profitFactor,
      trades: row.summary.trades
    }]))
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
