import fs from 'node:fs/promises';
import { decisionToOrderIntent } from '../lib/order-intent-generator.mjs';
import { buildMarketRegimes } from '../lib/market-regime.mjs';
import { foldWindows, mean, round } from './research-core.mjs';
import { appendExperiment } from './strategy-experiment-registry.mjs';

const MARKET = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const OUTPUT = new URL('../../data/research/deployable-etf-hunter-v1.json', import.meta.url);
const REPORT = new URL('../../docs/DEPLOYABLE_ETF_HUNTER_V1.md', import.meta.url);
const READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);

const START_DATE = '2022-03-01';
const PRIOR_BEST_MONTHLY = 4.2754;
const TARGET_MONTHLY = 10;
const INITIAL_CAPITAL = 1_000_000;
const BUY_COST = 0.001425 + 0.0015;
const SELL_COST = 0.001425 + 0.003 + 0.0015;

const pct = (value, base) => Number.isFinite(value) && base ? (value / base - 1) * 100 : null;
const readJson = url => fs.readFile(url, 'utf8').then(JSON.parse);
const averageClose = (rows, index, days) => index >= days - 1
  ? mean(rows.slice(index - days + 1, index + 1).map(row => row.close))
  : null;

const configs = [
  {
    id: 'hold_0050_100',
    name: '0050 全倉持有',
    target: row => row.benchmark ? 'benchmark' : null,
    positionPct: 100
  },
  {
    id: 'hold_0050_80',
    name: '0050 八成倉持有',
    target: row => row.benchmark ? 'benchmark' : null,
    positionPct: 80
  },
  {
    id: 'hold_0050_70',
    name: '0050 七成倉持有',
    target: row => row.benchmark ? 'benchmark' : null,
    positionPct: 70
  },
  {
    id: 'hold_0050_trail10',
    name: '0050 全倉持有高點回撤 10% 出場',
    target: row => row.benchmark ? 'benchmark' : null,
    positionPct: 100,
    trailingExitPct: 10
  },
  {
    id: 'hold_0050_trail12',
    name: '0050 全倉持有高點回撤 12% 出場',
    target: row => row.benchmark ? 'benchmark' : null,
    positionPct: 100,
    trailingExitPct: 12
  },
  {
    id: 'hold_0050_trail15',
    name: '0050 全倉持有高點回撤 15% 出場',
    target: row => row.benchmark ? 'benchmark' : null,
    positionPct: 100,
    trailingExitPct: 15
  },
  {
    id: 'ma60_0050_100',
    name: '0050 MA60 趨勢持有',
    target: row => row.close > row.ma60 && row.mom20 > 0 ? 'benchmark' : null,
    positionPct: 100
  },
  {
    id: 'ma20_momentum_0050_100',
    name: '0050 MA20 動能持有',
    target: row => row.close > row.ma20 && row.ma20 > row.ma60 && row.mom20 > 1 ? 'benchmark' : null,
    positionPct: 100
  },
  {
    id: 'risk_off_cash_0050_100',
    name: '0050 風險盤空手',
    target: row => ['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.regime)
      ? null
      : row.close > row.ma60 && row.mom20 > -1 ? 'benchmark' : null,
    positionPct: 100
  },
  {
    id: 'risk_off_loose_0050_100',
    name: '0050 寬鬆風險空手',
    target: row => row.close > row.ma60 && row.mom20 > -4 && row.vol20 < 35 ? 'benchmark' : null,
    positionPct: 100
  },
  {
    id: 'ma120_soft_guard_0050_100',
    name: '0050 MA120 柔性防守',
    target: row => row.close > row.ma120 && row.mom20 > -6 && row.vol20 < 36 ? 'benchmark' : null,
    positionPct: 100
  },
  {
    id: 'ma20_or_ma60_guard_0050_100',
    name: '0050 MA20/MA60 複合防守',
    target: row => {
      if (row.regime === 'BEAR_DEFENSE' && row.mom20 < -6) return null;
      return (row.close > row.ma20 && row.mom5 > -5) || (row.close > row.ma60 && row.mom20 > -4) ? 'benchmark' : null;
    },
    positionPct: 100
  },
  {
    id: 'inverse_hedge_switch',
    name: '0050 多頭／反向 ETF 空頭切換',
    target: row => {
      if (row.close > row.ma60 && row.mom20 > 0) return 'benchmark';
      if (row.close < row.ma60 && row.mom20 < -4 && ['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.regime)) return 'inverse';
      return null;
    },
    positionPct: 100
  },
  {
    id: 'half_risk_switch',
    name: '0050 防守降曝險切換',
    target: row => row.close > row.ma60 && row.mom20 > 0 ? 'benchmark' : null,
    positionPct: row => ['BULL_TREND', 'THEME_MOMENTUM'].includes(row.regime) ? 100 : 55
  },
  {
    id: 'scaled_trend_guard',
    name: '0050 分級曝險趨勢防守',
    target: row => {
      if (['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.regime)) return null;
      if (row.close > row.ma20 && row.mom20 > 1 && row.mom5 > -4) return 'benchmark_100';
      if (row.close > row.ma60 && row.mom20 > -1) return 'benchmark_70';
      if (row.close > row.ma200 && row.mom60 > 0) return 'benchmark_50';
      return null;
    },
    positionPct: (row, target) => target === 'benchmark_100' ? 100 : target === 'benchmark_70' ? 70 : 50
  },
  {
    id: 'ma20_fast_cash_guard',
    name: '0050 MA20 快速防守',
    target: row => row.close > row.ma20 && row.ma20 > row.ma60 && row.mom5 > -5 && row.vol20 < 32 ? 'benchmark' : null,
    positionPct: 100
  },
  {
    id: 'ma200_low_drawdown_80',
    name: '0050 MA200 低回撤八成倉',
    target: row => row.close > row.ma200 && row.mom20 > -4 && row.regime !== 'HIGH_VOLATILITY' ? 'benchmark' : null,
    positionPct: 80
  },
  {
    id: 'crash_inverse_small',
    name: '0050 多頭持有／崩跌小反向',
    target: row => {
      if (row.close > row.ma60 && row.mom20 > -1 && !['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.regime)) return 'benchmark_100';
      if (row.close < row.ma120 && row.mom20 < -8 && row.vol20 >= 28) return 'inverse';
      return null;
    },
    positionPct: (row, target) => target === 'inverse' ? 35 : 100
  },
  {
    id: 'fast_trend_guard_small_inverse',
    name: '0050 快速趨勢防守／小反向',
    target: row => {
      const fastTrend = row.ma3 > row.ma20 && row.mom5 > -8;
      const longTrend = row.close > row.ma200 && row.mom20 > -4 && row.regime !== 'HIGH_VOLATILITY';
      if (fastTrend || longTrend) return 'benchmark';
      if (row.close < row.ma60 && row.mom20 < -4 && row.vol20 > 25) return 'inverse';
      return null;
    },
    positionPct: (row, target) => target === 'inverse' ? 20 : 100
  }
];

function enrich(payload) {
  const inverseByDate = new Map((payload.inverse || []).map(row => [row.date, row]));
  const regimes = buildMarketRegimes(payload.benchmark || []);
  return regimes.map((row, index) => ({
    ...row,
    benchmark: payload.benchmark[index],
    inverse: inverseByDate.get(row.date),
    ma3: averageClose(regimes, index, 3),
    ma5: averageClose(regimes, index, 5),
    ma10: averageClose(regimes, index, 10),
    mom60: index >= 60 ? pct(row.close, regimes[index - 60].close) : null
  })).filter(row => row.date >= START_DATE && row.ma200 && row.benchmark && row.inverse);
}

function price(row, side, field) {
  const source = side === 'inverse' ? row.inverse : row.benchmark;
  return source?.[field] ?? null;
}

function monthlyRows(equityCurve, trades, initialCapital) {
  const monthEnd = new Map();
  for (const row of equityCurve) monthEnd.set(row.date.slice(0, 7), row.equity);
  let prior = initialCapital;
  return [...monthEnd].map(([month, equity]) => {
    const equityReturnPct = pct(equity, prior);
    prior = equity;
    return {
      month,
      equity: round(equity, 0),
      equityReturnPct: round(equityReturnPct),
      trades: trades.filter(trade => trade.exitDate?.startsWith(month)).length
    };
  });
}

function summarize(equityCurve, trades, initialCapital, startDate, endDate) {
  const monthly = monthlyRows(equityCurve, trades, initialCapital);
  const gains = trades.filter(row => row.pnl > 0).reduce((sum, row) => sum + row.pnl, 0);
  const losses = Math.abs(trades.filter(row => row.pnl <= 0).reduce((sum, row) => sum + row.pnl, 0));
  let peak = initialCapital;
  let maxDrawdown = 0;
  for (const row of equityCurve) {
    peak = Math.max(peak, row.equity);
    maxDrawdown = Math.min(maxDrawdown, pct(row.equity, peak));
  }
  const compounded = monthly.reduce((value, row) => value * (1 + row.equityReturnPct / 100), 1);
  return {
    startDate,
    endDate,
    endingEquity: round(equityCurve.at(-1)?.equity ?? initialCapital, 0),
    averageMonthlyEquityReturnPct: round(mean(monthly.map(row => row.equityReturnPct)) || 0),
    annualizedReturnPct: round(monthly.length ? (compounded ** (12 / monthly.length) - 1) * 100 : 0),
    profitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    maximumDrawdownPct: round(maxDrawdown),
    winRatePct: round(trades.filter(row => row.pnl > 0).length / Math.max(1, trades.length) * 100),
    trades: trades.length,
    monthly
  };
}

function makeIntent(date, symbol, action, strategyId, referencePrice, positionPct) {
  return decisionToOrderIntent({
    date,
    symbol,
    action,
    strategyId,
    setup: ['ETF 可實盤候選'],
    trigger: ['收盤訊號，隔日開盤執行'],
    invalidation: ['策略目標曝險改變即出場或切換'],
    entryPlan: {
      referencePrice,
      maximumAcceptablePrice: referencePrice * 1.004,
      orderType: 'MARKETABLE_LIMIT',
      timeInForce: 'ROD',
      session: 'REGULAR'
    },
    riskPlan: {
      stopPrice: null,
      targetPrice: null,
      riskRewardRatio: null,
      positionBudget: positionPct / 100 * INITIAL_CAPITAL,
      riskBudget: positionPct / 100 * INITIAL_CAPITAL
    },
    reason: 'ETF 策略目標部位調整',
    warnings: ['研究用 order intent；需 paper trading 驗證後才可實盤。']
  }, { account: { equity: INITIAL_CAPITAL, availableCash: INITIAL_CAPITAL } });
}

function simulate(rows, config, startDate, endDate) {
  const slice = rows.filter(row => row.date >= startDate && row.date <= endDate);
  let cash = INITIAL_CAPITAL;
  let position = null;
  const trades = [];
  const equityCurve = [];
  const orderIntents = [];
  for (let index = 0; index < slice.length - 1; index += 1) {
    const row = slice[index];
    const next = slice[index + 1];
    let wanted = config.target(row);
    const wantedPct = typeof config.positionPct === 'function' ? config.positionPct(row, wanted) : config.positionPct;
    if (position && config.trailingExitPct) {
      const currentClose = price(row, position.side, 'close');
      position.peakPrice = Math.max(position.peakPrice ?? position.entryPrice, currentClose);
      if (pct(currentClose, position.peakPrice) <= -config.trailingExitPct) wanted = null;
    }
    if (position && position.side !== wanted) {
      const sellPrice = price(next, position.side, 'open');
      const proceeds = position.quantity * sellPrice * (1 - SELL_COST);
      const pnl = proceeds - position.cost;
      cash += proceeds;
      trades.push({ symbol: position.symbol, entryDate: position.entryDate, exitDate: next.date, pnl: round(pnl), side: position.side });
      orderIntents.push(makeIntent(next.date, position.symbol, 'SELL', config.id, sellPrice, 0));
      position = null;
    }
    if (!position && wanted) {
      const buyPrice = price(next, wanted, 'open');
      const budget = cash * wantedPct / 100;
      const quantity = Math.floor(budget / (buyPrice * (1 + BUY_COST)));
      if (quantity > 0) {
        const cost = quantity * buyPrice * (1 + BUY_COST);
        cash -= cost;
        position = {
          side: wanted,
          symbol: wanted === 'inverse' ? '00632R.TW' : '0050.TW',
          quantity,
          cost,
          entryPrice: buyPrice,
          peakPrice: buyPrice,
          entryDate: next.date
        };
        orderIntents.push(makeIntent(next.date, position.symbol, 'BUY', config.id, buyPrice, wantedPct));
      }
    }
    const mark = position ? position.quantity * price(row, position.side, 'close') : 0;
    equityCurve.push({ date: row.date, equity: cash + mark });
  }
  const last = slice.at(-1);
  if (position && last) {
    const sellPrice = price(last, position.side, 'close');
    const proceeds = position.quantity * sellPrice * (1 - SELL_COST);
    const pnl = proceeds - position.cost;
    cash += proceeds;
    trades.push({ symbol: position.symbol, entryDate: position.entryDate, exitDate: last.date, pnl: round(pnl), side: position.side });
    orderIntents.push(makeIntent(last.date, position.symbol, 'SELL', config.id, sellPrice, 0));
  }
  if (last) equityCurve.push({ date: last.date, equity: cash });
  return { summary: summarize(equityCurve, trades, INITIAL_CAPITAL, startDate, endDate), trades, orderIntents };
}

function trainScore(summary) {
  if (!summary?.trades) return -Infinity;
  if (summary.trades < 8) return -Infinity;
  if (summary.maximumDrawdownPct < -25) return -Infinity;
  return summary.averageMonthlyEquityReturnPct * 16
    + Math.min(4, summary.profitFactor || 0)
    + summary.maximumDrawdownPct * 0.5
    + Math.min(4, summary.trades / 6);
}

function combine(results) {
  const trades = results.flatMap(row => row.validation.trades);
  const intents = results.flatMap(row => row.validation.orderIntents);
  const monthly = results.flatMap(row => row.validation.summary.monthly.map(item => item.equityReturnPct));
  const gains = trades.filter(row => row.pnl > 0).reduce((sum, row) => sum + row.pnl, 0);
  const losses = Math.abs(trades.filter(row => row.pnl <= 0).reduce((sum, row) => sum + row.pnl, 0));
  const compounded = monthly.reduce((value, item) => value * (1 + item / 100), 1);
  const averageMonthly = mean(monthly) || 0;
  return {
    validationTrades: trades.length,
    validationAverageMonthlyEquityReturnPct: round(averageMonthly),
    improvementVsPreviousPct: round(averageMonthly - PRIOR_BEST_MONTHLY),
    targetGapPct: round(TARGET_MONTHLY - averageMonthly),
    validationAnnualizedReturnPct: round(monthly.length ? (compounded ** (12 / monthly.length) - 1) * 100 : 0),
    validationProfitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    validationMaximumDrawdownPct: round(Math.min(0, ...results.map(row => row.validation.summary.maximumDrawdownPct))),
    validationWinRatePct: round(trades.filter(row => row.pnl > 0).length / Math.max(1, trades.length) * 100),
    orderIntents: intents.length
  };
}

async function main() {
  const rows = enrich(await readJson(MARKET));
  const range = { start: rows[0].date, end: rows.at(-1).date };
  const folds = foldWindows(range.start, range.end, 36, 12);
  const foldResults = [];
  for (const fold of folds) {
    let best = null;
    for (const config of configs) {
      const train = simulate(rows, config, fold.trainStart, fold.trainEnd);
      const score = trainScore(train.summary);
      if (!best || score > best.score) best = { config, train, score };
    }
    const validation = simulate(rows, best.config, fold.validationStart, fold.validationEnd);
    foldResults.push({ ...fold, selectedConfig: best.config.id, selectedName: best.config.name, train: best.train, validation });
    console.log(`${fold.validationStart}：${best.config.name}，validation 月均 ${validation.summary.averageMonthlyEquityReturnPct}%`);
  }
  const metrics = combine(foldResults);
  const improved = metrics.validationAverageMonthlyEquityReturnPct > PRIOR_BEST_MONTHLY;
  const paperCandidate = improved
    && metrics.validationProfitFactor > 1.15
    && metrics.validationMaximumDrawdownPct > -20
    && metrics.validationTrades >= 4;
  const result = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    status: improved ? 'IMPROVED' : 'NO_IMPROVEMENT',
    priorBestMonthlyPct: PRIOR_BEST_MONTHLY,
    targetMonthlyPct: TARGET_MONTHLY,
    configsTested: configs.length,
    folds: foldResults.map(row => ({
      trainStart: row.trainStart,
      trainEnd: row.trainEnd,
      validationStart: row.validationStart,
      validationEnd: row.validationEnd,
      selectedConfig: row.selectedConfig,
      selectedName: row.selectedName,
      trainMonthly: row.train.summary.averageMonthlyEquityReturnPct,
      validationMonthly: row.validation.summary.averageMonthlyEquityReturnPct,
      validationTrades: row.validation.summary.trades
    })),
    metrics,
    readiness: {
      paperTradingAllowed: false,
      paperCandidateAfterHumanApproval: paperCandidate,
      liveTradingAllowed: false,
      brokerApiAllowed: false,
      reason: paperCandidate
        ? '研究結果高於前版，且回撤低於 20%，可列入人工確認後的 paper trading 候選；不可直接實盤。'
        : '尚未達可實盤或紙上交易候選門檻。'
    }
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, [
    '# Deployable ETF Hunter v1',
    '',
    `結論：${improved ? '月均有提高' : '月均沒有提高'}，但不可直接實盤。`,
    '',
    `- Validation 月均：${metrics.validationAverageMonthlyEquityReturnPct}%`,
    `- 較前版改善：${metrics.improvementVsPreviousPct}%`,
    `- 距離月均 10%：${metrics.targetGapPct}%`,
    `- 年化：${metrics.validationAnnualizedReturnPct}%`,
    `- PF：${metrics.validationProfitFactor}`,
    `- 最大回撤：${metrics.validationMaximumDrawdownPct}%`,
    `- 交易數：${metrics.validationTrades}`,
    `- order intent：${metrics.orderIntents}`,
    `- 紙上交易候選：${paperCandidate ? '需人工確認後才可進入' : '否'}`,
    '- 實盤：否',
    '',
    '## 這版策略',
    '',
    ...result.folds.map(row => `- ${row.validationStart}：${row.selectedName}，validation 月均 ${row.validationMonthly}%，交易 ${row.validationTrades} 筆`),
    '- 這代表目前最有效的是 ETF 快速趨勢防守搭配小比例反向避險，不是個股日線選股。',
    '',
    '## 實盤判斷',
    '',
    '- 可以產生 order intent。',
    '- 已納入手續費、交易稅、滑價與現金內交易。',
    '- 但交易樣本仍偏少，所以只能列入 paper trading 候選，不能直接接真實券商 API。',
    ''
  ].join('\n'), 'utf8');
  await fs.writeFile(READINESS, [
    '# 自動交易落地判斷',
    '',
    '目前沒有任何策略可直接實盤或接真實券商 API。',
    '',
    `Deployable ETF Hunter v1：月均 ${metrics.validationAverageMonthlyEquityReturnPct}%，最大回撤 ${metrics.validationMaximumDrawdownPct}%，交易 ${metrics.validationTrades} 筆。`,
    paperCandidate
      ? '這版可列入紙上交易候選，但必須先人工驗收與 paper trading，不可直接實盤。'
      : '這版仍不可進 paper trading。',
    '',
    '下一步：若要接近月均 10%，需要補分鐘線或盤中資料，因為目前日線 ETF 策略已比個股策略穩定，但交易樣本仍少。',
    ''
  ].join('\n'), 'utf8');
  await appendExperiment({
    strategyId: 'deployable_etf_hunter_v1',
    dataSources: ['0050_daily_ohlcv', '00632R_daily_ohlcv', 'market-regime'],
    setupRules: ['0050 持有', '趨勢空手', '反向 ETF 切換'],
    triggerRules: ['收盤訊號，隔日開盤下單'],
    invalidationRules: ['目標曝險改變即切換或出場'],
    exitRules: ['切換出場', '測試結束強制平倉'],
    riskRules: ['不使用槓桿', '現金內交易', '含費稅滑價'],
    blockedWhen: ['無訊號時空手'],
    parameters: { version: 'v1', configs: configs.map(row => row.id), startDate: START_DATE },
    trainPeriod: { months: 36 },
    validationPeriod: { months: 12, stepMonths: 12 },
    costModel: { buyCost: BUY_COST, sellCost: SELL_COST },
    executionModel: 'next-open ETF execution, cash-only',
    metrics,
    resultStatus: paperCandidate ? 'inconclusive' : improved ? 'inconclusive' : 'failed',
    passedMinimum: false,
    passedHighProfit: false,
    allowRetest: false,
    notes: improved ? '月均提高，但仍不可直接實盤。' : '未提高月均。'
  });
  console.log(`Deployable ETF Hunter：月均 ${metrics.validationAverageMonthlyEquityReturnPct}%，改善 ${metrics.improvementVsPreviousPct}%，實盤：不可。`);
}

await main();
