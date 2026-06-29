import fs from 'node:fs/promises';
import {
  buyExecution,
  sellExecution
} from '../lib/execution-simulator.mjs';
import { decisionToOrderIntent } from '../lib/order-intent-generator.mjs';
import { buildMarketRegimes } from '../lib/market-regime.mjs';
import { foldWindows, mean, round } from './research-core.mjs';
import { appendExperiment } from './strategy-experiment-registry.mjs';

const CACHE = new URL('../../data/research/deployable-etf-history.json', import.meta.url);
const EXISTING_MARKET = new URL('../../data/market-regime-history-10y.json', import.meta.url);
const OUTPUT = new URL('../../data/research/deployable-etf-hunter-v1.json', import.meta.url);
const REPORT = new URL('../../docs/DEPLOYABLE_ETF_HUNTER_V1.md', import.meta.url);
const READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);

const START_DATE = '2015-06-01';
const INITIAL_CAPITAL = 1_000_000;
const TARGET_MONTHLY = 10;
const SETTLEMENT_DAYS = 2;
const EXECUTION_COSTS = Object.freeze({
  buyFeePct: 0.1425,
  sellFeePct: 0.1425,
  sellTaxPct: 0.3,
  buySlippagePct: 0.15,
  sellSlippagePct: 0.15,
  minimumFee: 20,
  boardLotShares: 1000
});
const SYMBOLS = Object.freeze({
  benchmark: '0050.TW',
  leveraged: '00631L.TW',
  inverse: '00632R.TW'
});

const pct = (value, base) => Number.isFinite(value) && base ? (value / base - 1) * 100 : null;
const average = (rows, index, days) => index >= days - 1
  ? mean(rows.slice(index - days + 1, index + 1).map(row => row.close))
  : null;
const monthSpan = (startDate, endDate) => {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  return (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
};

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const number = value => Number(String(value).replaceAll(',', ''));

function marketMonths() {
  const rows = [];
  const cursor = new Date(`${START_DATE}T00:00:00Z`);
  const end = new Date();
  cursor.setUTCDate(1);
  while (cursor <= end) {
    rows.push(`${cursor.getUTCFullYear()}${String(cursor.getUTCMonth() + 1).padStart(2, '0')}01`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return rows;
}

async function fetchTwseMonth(stockNo, date, attempt = 1) {
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${date}&stockNo=${stockNo}`;
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' },
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return payload.stat === 'OK' ? payload.data || [] : [];
  } catch (error) {
    if (attempt >= 3) throw new Error(`${stockNo} ${date} 下載失敗：${error.message}`);
    await wait(500 * attempt);
    return fetchTwseMonth(stockNo, date, attempt + 1);
  }
}

function adjustSplits(rows) {
  const adjusted = rows.map(row => ({ ...row }));
  for (let index = 1; index < adjusted.length; index += 1) {
    const ratio = adjusted[index].open / adjusted[index - 1].close;
    if (ratio >= 0.4) continue;
    const divisor = Math.round(1 / ratio);
    if (divisor < 2 || divisor > 30) continue;
    for (let prior = 0; prior < index; prior += 1) {
      for (const field of ['open', 'high', 'low', 'close']) adjusted[prior][field] /= divisor;
    }
  }
  return adjusted;
}

async function fetchHistory(symbol) {
  const stockNo = symbol.replace('.TW', '');
  const months = marketMonths();
  const raw = [];
  for (let index = 0; index < months.length; index += 4) {
    const batch = months.slice(index, index + 4);
    const payloads = await Promise.all(batch.map(date => fetchTwseMonth(stockNo, date)));
    for (const data of payloads) raw.push(...data);
    await wait(150);
  }
  const unique = new Map();
  for (const row of raw) {
    const [year, month, day] = row[0].split('/').map(Number);
    const item = {
      date: `${year + 1911}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      open: number(row[3]),
      high: number(row[4]),
      low: number(row[5]),
      close: number(row[6])
    };
    if ([item.open, item.high, item.low, item.close].every(Number.isFinite)) unique.set(item.date, item);
  }
  return adjustSplits([...unique.values()].sort((left, right) => left.date.localeCompare(right.date)));
}

async function loadHistory() {
  if (process.env.REFRESH_ETF_DATA !== '1') {
    try {
      const cached = JSON.parse(await fs.readFile(CACHE, 'utf8'));
      if (Object.values(SYMBOLS).every(symbol => cached.series?.[symbol]?.length >= 2_000)) return cached;
    } catch {
      // 首次執行或快取不完整時才連線下載。
    }
  }
  const existing = JSON.parse(await fs.readFile(EXISTING_MARKET, 'utf8'));
  const normalize = rows => rows.map(row => ({
    ...row,
    high: row.high ?? Math.max(row.open, row.close),
    low: row.low ?? Math.min(row.open, row.close)
  }));
  const leveraged = await fetchHistory(SYMBOLS.leveraged);
  const payload = {
    generatedAt: new Date().toISOString(),
    source: '專案既有 0050／00632R 日線 + TWSE 官方 00631L 月行情（研究用途）',
    symbols: SYMBOLS,
    series: {
      [SYMBOLS.benchmark]: normalize(existing.benchmark),
      [SYMBOLS.leveraged]: leveraged,
      [SYMBOLS.inverse]: normalize(existing.inverse)
    }
  };
  await fs.writeFile(CACHE, `${JSON.stringify(payload)}\n`, 'utf8');
  return payload;
}

function enrich(payload) {
  const benchmark = payload.series[SYMBOLS.benchmark];
  const leveraged = new Map(payload.series[SYMBOLS.leveraged].map(row => [row.date, row]));
  const inverse = new Map(payload.series[SYMBOLS.inverse].map(row => [row.date, row]));
  const regimes = buildMarketRegimes(benchmark);
  return regimes.map((row, index) => ({
    ...row,
    index,
    ma5: average(regimes, index, 5),
    ma10: average(regimes, index, 10),
    mom60: index >= 60 ? pct(row.close, regimes[index - 60].close) : null,
    bars: {
      benchmark: benchmark[index],
      leveraged: leveraged.get(row.date),
      inverse: inverse.get(row.date)
    }
  })).filter(row => row.date >= START_DATE
    && row.ma200
    && row.bars.benchmark
    && row.bars.leveraged
    && row.bars.inverse);
}

function buildConfigs() {
  const rows = [];
  for (const baseMa of ['ma120', 'ma200']) {
    for (const baseMomentum of [-6, -2]) {
      for (const strongMomentum of [2, 5]) {
        for (const maxStrongVol of [24, 28, 32]) {
          for (const leveragedPct of [60, 80, 100]) {
            for (const targetVol of [25, 35]) {
              for (const drawdownGuardPct of [8, 10]) {
              rows.push({
                id: `${baseMa}_m${baseMomentum}_strong${strongMomentum}_vol${maxStrongVol}_lev${leveragedPct}_tv${targetVol}_dd${drawdownGuardPct}`,
                name: `趨勢波動縮放 ${baseMa.toUpperCase()}／正2 ${leveragedPct}%／目標波動 ${targetVol}%`,
                baseMa,
                baseMomentum,
                strongMomentum,
                maxStrongVol,
                leveragedPct,
                targetVol,
                benchmarkPct: 100,
                inversePct: 0,
                drawdownGuardPct
              });
              }
            }
          }
        }
      }
    }
  }
  for (const baseMa of ['ma60', 'ma120', 'ma200']) {
    for (const baseMomentum of [-6, -2, 2]) {
      for (const benchmarkPct of [90, 100]) {
        for (const drawdownGuardPct of [8, 10, 99]) {
        rows.push({
          id: `benchmark_only_${baseMa}_m${baseMomentum}_pct${benchmarkPct}_dd${drawdownGuardPct}`,
          name: `純 0050 趨勢 ${baseMa.toUpperCase()}／曝險 ${benchmarkPct}%`,
          baseMa,
          baseMomentum,
          strongMomentum: 99,
          maxStrongVol: 0,
          leveragedPct: 0,
          targetVol: 20,
          benchmarkPct,
          inversePct: 0,
          drawdownGuardPct,
          benchmarkOnly: true
        });
        }
      }
    }
  }
  return rows;
}

const configs = buildConfigs();

function desiredTarget(row, config, risk) {
  if (risk.cooldown > 0 || (!config.legacyMode && risk.monthlyBlocked)) return { side: null, positionPct: 0, reason: '帳戶風控熔斷' };
  const strongTrend = row.close > row.ma20
    && row.ma20 > row.ma60
    && row.ma60Slope > 0
    && row.mom20 >= config.strongMomentum
    && row.mom60 > 0
    && row.vol20 <= config.maxStrongVol
    && !['BEAR_DEFENSE', 'HIGH_VOLATILITY'].includes(row.regime);
  if (strongTrend && !config.benchmarkOnly) {
    const targetPosition = config.targetVol / Math.max(12, row.vol20 * 2) * 100;
    const positionPct = Math.max(30, Math.round(Math.min(config.leveragedPct, targetPosition) / 5) * 5);
    return { side: 'leveraged', positionPct, reason: '低波動強趨勢，受控持有台灣50正2' };
  }
  const holdingRiskAsset = Boolean(risk.position) && !config.legacyMode;
  const baseThreshold = config.legacyMode ? 1 : holdingRiskAsset ? 0.98 : 1.01;
  const momentumThreshold = config.legacyMode ? config.baseMomentum : holdingRiskAsset ? config.baseMomentum - 2 : config.baseMomentum;
  const baseTrend = row.close > row[config.baseMa] * baseThreshold
    && row.mom20 >= momentumThreshold
    && row.mom60 > -8
    && row.regime !== 'HIGH_VOLATILITY';
  if (baseTrend) {
    const volatilityScale = Math.min(1, (config.baseTargetVol ?? 20) / Math.max(12, row.vol20));
    const positionPct = Math.max(40, Math.round(config.benchmarkPct * volatilityScale / 5) * 5);
    return { side: 'benchmark', positionPct, reason: '中長期趨勢仍正向，持有 0050' };
  }
  return { side: null, positionPct: 0, reason: '趨勢或波動條件不允許進場' };
}

function markEquity(state, row, field = 'close') {
  const unsettled = state.unsettled.reduce((sum, item) => sum + item.amount, 0);
  const positionValue = state.position
    ? state.position.quantity * row.bars[state.position.side][field]
    : 0;
  return state.cash + unsettled + positionValue;
}

function sellPosition(state, row, quantity, reason) {
  if (!state.position || quantity <= 0) return;
  const sell = sellExecution(row.bars[state.position.side].open, quantity, EXECUTION_COSTS);
  const cost = state.position.averageCost * quantity;
  const pnl = sell.net - cost;
  state.unsettled.push({ releaseIndex: row.index + SETTLEMENT_DAYS, amount: sell.net });
  state.trades.push({
    symbol: SYMBOLS[state.position.side],
    side: state.position.side,
    entryDate: state.position.entryDate,
    exitDate: row.date,
    quantity,
    pnl: round(pnl),
    reason
  });
  if (state.emitIntents) state.intents.push(makeIntent(row.date, SYMBOLS[state.position.side], 'SELL', state.config.id, sell.fillPrice, 0, reason));
  state.position.quantity -= quantity;
  if (state.position.quantity <= 0) state.position = null;
}

function buyPosition(state, row, side, budget, reason) {
  const open = row.bars[side].open;
  let quantity = Math.floor(Math.min(state.cash, budget) / (open * (1 + 0.004)));
  while (quantity > 0 && buyExecution(open, quantity, EXECUTION_COSTS).total > Math.min(state.cash, budget)) quantity -= 1;
  if (quantity <= 0) return;
  const buy = buyExecution(open, quantity, EXECUTION_COSTS);
  const priorQuantity = state.position?.quantity || 0;
  const priorCost = state.position ? state.position.averageCost * priorQuantity : 0;
  state.cash -= buy.total;
  state.position = {
    side,
    quantity: priorQuantity + quantity,
    averageCost: (priorCost + buy.total) / (priorQuantity + quantity),
    entryDate: state.position?.entryDate || row.date
  };
  if (state.emitIntents) {
    state.intents.push(makeIntent(row.date, SYMBOLS[side], 'BUY', state.config.id, buy.fillPrice, budget / Math.max(1, markEquity(state, row, 'open')) * 100, reason));
  }
}

function makeIntent(date, symbol, action, strategyId, referencePrice, positionPct, reason) {
  return decisionToOrderIntent({
    date,
    symbol,
    action,
    strategyId: `deployable_etf_hunter_v1:${strategyId}`,
    setup: ['台灣50趨勢與波動度分級'],
    trigger: ['T 日收盤確認，T+1 開盤以可成交限價執行'],
    invalidation: ['趨勢失效、波動升高或帳戶回撤熔斷'],
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
      positionBudget: INITIAL_CAPITAL * positionPct / 100,
      riskBudget: INITIAL_CAPITAL * 0.005
    },
    reason,
    warnings: ['研究用 order intent；通過紙上交易前禁止實盤']
  }, { account: { equity: INITIAL_CAPITAL, availableCash: INITIAL_CAPITAL } });
}

function summarize(state, initialCapital, startDate, endDate) {
  const monthEnd = new Map();
  for (const row of state.equityCurve) monthEnd.set(row.date.slice(0, 7), row.equity);
  let prior = initialCapital;
  const monthly = [...monthEnd].map(([month, equity]) => {
    const equityReturnPct = pct(equity, prior);
    prior = equity;
    return { month, equity: round(equity, 0), equityReturnPct: round(equityReturnPct) };
  });
  const gains = state.trades.filter(row => row.pnl > 0).reduce((sum, row) => sum + row.pnl, 0);
  const losses = Math.abs(state.trades.filter(row => row.pnl <= 0).reduce((sum, row) => sum + row.pnl, 0));
  let peak = initialCapital;
  let maximumDrawdownPct = 0;
  for (const row of state.equityCurve) {
    peak = Math.max(peak, row.equity);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, pct(row.equity, peak));
  }
  const compounded = monthly.reduce((value, row) => value * (1 + row.equityReturnPct / 100), 1);
  return {
    startDate,
    endDate,
    endingEquity: round(state.equityCurve.at(-1)?.equity ?? initialCapital, 0),
    averageMonthlyEquityReturnPct: round(mean(monthly.map(row => row.equityReturnPct)) || 0),
    annualizedReturnPct: round(monthly.length ? (compounded ** (12 / monthly.length) - 1) * 100 : 0),
    profitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    maximumDrawdownPct: round(maximumDrawdownPct),
    winRatePct: round(state.trades.filter(row => row.pnl > 0).length / Math.max(1, state.trades.length) * 100),
    trades: state.trades.length,
    negativeMonths: monthly.filter(row => row.equityReturnPct < 0).length,
    monthly
  };
}

function compactSummary(summary) {
  const { monthly, ...metrics } = summary;
  return metrics;
}

function simulate(rows, schedule, startDate, endDate, initialCapital = INITIAL_CAPITAL, emitIntents = false) {
  const state = {
    cash: initialCapital,
    unsettled: [],
    position: null,
    trades: [],
    intents: [],
    equityCurve: [],
    peakEquity: initialCapital,
    cooldown: 0,
    currentMonth: null,
    monthStartEquity: initialCapital,
    monthlyBlocked: false,
    config: schedule(startDate),
    emitIntents
  };
  const slice = rows.filter(row => row.date >= startDate && row.date <= endDate);
  for (let offset = 1; offset < slice.length; offset += 1) {
    const signalRow = slice[offset - 1];
    const row = slice[offset];
    state.config = schedule(signalRow.date);
    const released = state.unsettled.filter(item => item.releaseIndex <= row.index);
    state.cash += released.reduce((sum, item) => sum + item.amount, 0);
    state.unsettled = state.unsettled.filter(item => item.releaseIndex > row.index);
    const priorEquity = markEquity(state, signalRow);
    const signalMonth = signalRow.date.slice(0, 7);
    if (state.currentMonth !== signalMonth) {
      state.currentMonth = signalMonth;
      state.monthStartEquity = priorEquity;
      state.monthlyBlocked = false;
    } else if (!state.config.legacyMode && pct(priorEquity, state.monthStartEquity) <= -3) {
      state.monthlyBlocked = true;
    }
    state.peakEquity = Math.max(state.peakEquity, priorEquity);
    const drawdownPct = pct(priorEquity, state.peakEquity);
    if (state.cooldown > 0) {
      state.cooldown -= 1;
      if (state.cooldown === 0) state.peakEquity = priorEquity;
    } else if (drawdownPct <= -state.config.drawdownGuardPct) {
      state.cooldown = 20;
    }
    const target = desiredTarget(signalRow, state.config, state);
    const openEquity = markEquity(state, row, 'open');

    if (state.position && state.position.side !== target.side) {
      sellPosition(state, row, state.position.quantity, target.reason);
    } else if (state.position && target.side) {
      const currentValue = state.position.quantity * row.bars[target.side].open;
      const desiredValue = openEquity * target.positionPct / 100;
      if (currentValue > desiredValue * 1.15) {
        const quantity = Math.min(state.position.quantity, Math.floor((currentValue - desiredValue) / row.bars[target.side].open));
        sellPosition(state, row, quantity, '波動升高，降低曝險');
      } else if (currentValue < desiredValue * 0.85) {
        buyPosition(state, row, target.side, desiredValue - currentValue, '波動降低且趨勢有效，補足曝險');
      }
    } else if (!state.position && target.side) {
      buyPosition(state, row, target.side, openEquity * target.positionPct / 100, target.reason);
    }
    state.equityCurve.push({ date: row.date, equity: markEquity(state, row) });
  }
  const last = slice.at(-1);
  if (state.position && last) sellPosition(state, { ...last, index: last.index }, state.position.quantity, '驗證期結束');
  if (last) state.equityCurve.push({ date: last.date, equity: markEquity(state, last) });
  return { state, summary: summarize(state, initialCapital, startDate, endDate) };
}

function trainScore(summary) {
  if (summary.trades < 8 || summary.maximumDrawdownPct < -25 || summary.averageMonthlyEquityReturnPct <= 0) return -Infinity;
  const pf = Number.isFinite(summary.profitFactor) ? Math.min(4, summary.profitFactor) : 4;
  return summary.averageMonthlyEquityReturnPct * 18
    + summary.maximumDrawdownPct * 0.3
    + pf
    - summary.negativeMonths * 0.08;
}

function yearlyTrainWindows(fold) {
  const rows = [];
  let start = new Date(`${fold.trainStart}T00:00:00Z`);
  const trainEnd = new Date(`${fold.trainEnd}T00:00:00Z`);
  while (start <= trainEnd) {
    const next = new Date(start);
    next.setUTCFullYear(next.getUTCFullYear() + 1);
    const end = new Date(Math.min(next.getTime() - 86_400_000, trainEnd.getTime()));
    rows.push({ start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) });
    start = next;
  }
  return rows;
}

function selectForFold(rows, fold) {
  const yearly = yearlyTrainWindows(fold);
  const evaluated = configs.map(config => {
    const result = simulate(rows, () => config, fold.trainStart, fold.trainEnd);
    const yearlyReturns = yearly.map(window => simulate(rows, () => config, window.start, window.end).summary.averageMonthlyEquityReturnPct);
    const yearlyMean = mean(yearlyReturns) || 0;
    const variance = mean(yearlyReturns.map(value => (value - yearlyMean) ** 2)) || 0;
    const stableYears = yearlyReturns.filter(value => value > 0).length;
    const stabilityScore = stableYears >= 2
      ? Math.min(...yearlyReturns) * 3 + yearlyMean * 2 - Math.sqrt(variance)
      : -Infinity;
    return { config, summary: result.summary, score: trainScore(result.summary) + stabilityScore };
  });
  const best = candidates => candidates.sort((left, right) => right.score - left.score)[0];
  const benchmark = best(evaluated.filter(row => row.config.benchmarkOnly));
  const leveraged = best(evaluated.filter(row => !row.config.benchmarkOnly));
  const leverageEarned = leveraged.summary.averageMonthlyEquityReturnPct >= 0.8
    && leveraged.summary.averageMonthlyEquityReturnPct >= benchmark.summary.averageMonthlyEquityReturnPct + 0.5
    && leveraged.summary.maximumDrawdownPct >= benchmark.summary.maximumDrawdownPct - 3;
  return leverageEarned ? leveraged : benchmark;
}

function fixedSchedule(config) {
  return () => config;
}

async function main() {
  const payload = await loadHistory();
  const rows = enrich(payload);
  const folds = foldWindows(rows[0].date, rows.at(-1).date, 36, 12)
    .filter(fold => monthSpan(fold.validationStart, fold.validationEnd) >= 11);
  const selections = folds.map(fold => ({ ...fold, selected: selectForFold(rows, fold) }));
  const schedule = date => selections.find(row => date >= row.validationStart && date <= row.validationEnd)?.selected.config
    || selections.at(-1).selected.config;
  const validationStart = selections[0].validationStart;
  const validationEnd = selections.at(-1).validationEnd;
  const validation = simulate(rows, schedule, validationStart, validationEnd, INITIAL_CAPITAL, true);
  const frozenConfig = selections[0].selected.config;
  const frozenValidation = simulate(rows, fixedSchedule(frozenConfig), validationStart, validationEnd);
  const legacyConfig = {
    id: 'legacy_long_baseline',
    name: '前版寬趨勢低曝險基準',
    baseMa: 'ma60',
    baseMomentum: 2,
    strongMomentum: 99,
    maxStrongVol: 0,
    leveragedPct: 0,
    benchmarkPct: 100,
    inversePct: 0,
    drawdownGuardPct: 99,
    baseTargetVol: 18,
    legacyMode: true
  };
  const baseline = simulate(rows, fixedSchedule(legacyConfig), validationStart, validationEnd);
  const metrics = validation.summary;
  const baselineMetrics = baseline.summary;
  const diagnosticOnly = configs.map(config => ({
    config,
    metrics: simulate(rows, fixedSchedule(config), validationStart, validationEnd).summary
  })).filter(row => row.metrics.maximumDrawdownPct > baselineMetrics.maximumDrawdownPct)
    .sort((left, right) => right.metrics.averageMonthlyEquityReturnPct - left.metrics.averageMonthlyEquityReturnPct)
    .slice(0, 10);
  const improved = metrics.averageMonthlyEquityReturnPct > baselineMetrics.averageMonthlyEquityReturnPct
    && metrics.maximumDrawdownPct > baselineMetrics.maximumDrawdownPct
    && metrics.trades >= baselineMetrics.trades;
  const minimumPassed = metrics.trades > 50
    && metrics.profitFactor > 1.15
    && metrics.maximumDrawdownPct > -20
    && metrics.averageMonthlyEquityReturnPct > baselineMetrics.averageMonthlyEquityReturnPct;
  const result = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    evaluationMode: 'true_walk_forward_continuous_equity',
    dataRange: { start: rows[0].date, end: rows.at(-1).date },
    configsTestedPerFold: configs.length,
    validationFolds: selections.length,
    methodologyFixes: [
      '每段只用前 36 個月選設定，後 12 個月固定不調參數',
      '七段 validation 使用同一條連續資產曲線，不重設為 100 萬',
      '共用成交模擬器計算手續費、交易稅與雙邊滑價',
      '賣出款 T+2 才可再次使用',
      '00631L 只在低波動強趨勢使用，並依波動度降低部位',
      '訓練期三個年度至少兩年為正，且槓桿策略必須通過絕對與相對門檻',
      '單月總資產虧損達 3% 後，當月停止新增曝險'
    ],
    selections: selections.map(row => ({
      trainStart: row.trainStart,
      trainEnd: row.trainEnd,
      validationStart: row.validationStart,
      validationEnd: row.validationEnd,
      configId: row.selected.config.id,
      configName: row.selected.config.name,
      trainMonthlyPct: row.selected.summary.averageMonthlyEquityReturnPct,
      trainMaximumDrawdownPct: row.selected.summary.maximumDrawdownPct,
      trainTrades: row.selected.summary.trades
    })),
    metrics: {
      ...metrics,
      targetGapPct: round(TARGET_MONTHLY - metrics.averageMonthlyEquityReturnPct),
      orderIntents: validation.state.intents.length
    },
    baseline: compactSummary(baselineMetrics),
    frozenSevenYearValidation: {
      selectedOnlyFrom: `${selections[0].trainStart} 至 ${selections[0].trainEnd}`,
      configId: frozenConfig.id,
      configName: frozenConfig.name,
      metrics: compactSummary(frozenValidation.summary)
    },
    diagnosticOnlyTopFixedConfigs: {
      warning: '只用於定位策略家族問題；看過完整 validation 後排序，不可作為可實盤績效。',
      rows: diagnosticOnly.map(row => ({ id: row.config.id, name: row.config.name, metrics: compactSummary(row.metrics) }))
    },
    comparison: {
      monthlyImprovementPct: round(metrics.averageMonthlyEquityReturnPct - baselineMetrics.averageMonthlyEquityReturnPct),
      drawdownImprovementPct: round(metrics.maximumDrawdownPct - baselineMetrics.maximumDrawdownPct),
      tradeDifference: metrics.trades - baselineMetrics.trades,
      improvedMonthlyAndDrawdown: metrics.averageMonthlyEquityReturnPct > baselineMetrics.averageMonthlyEquityReturnPct
        && metrics.maximumDrawdownPct > baselineMetrics.maximumDrawdownPct,
      improvedMonthlyDrawdownAndTrades: improved
    },
    readiness: {
      minimumResearchThresholdPassed: minimumPassed,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      brokerApiAllowed: false,
      reason: minimumPassed
        ? '長期 walk-forward 已達最低研究門檻，但同一歷史區間已反覆研究，仍須先做全新期間紙上交易。'
        : '未同時通過長期報酬、回撤與交易樣本門檻，不可進入紙上交易或實盤。'
    }
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, [
    '# Deployable ETF Hunter v1',
    '',
    '## 結論',
    '',
    `- 驗證方式：${selections.length} 段 36 個月訓練／12 個月驗證，validation 資金連續。`,
    `- 月均總資產報酬：${metrics.averageMonthlyEquityReturnPct}%`,
    `- 年化報酬：${metrics.annualizedReturnPct}%`,
    `- Profit Factor：${metrics.profitFactor}`,
    `- 最大回撤：${metrics.maximumDrawdownPct}%`,
    `- 交易數：${metrics.trades}`,
    `- 勝率：${metrics.winRatePct}%`,
    `- 距離月均 10%：${result.metrics.targetGapPct} 個百分點`,
    `- 相較同區間基準月均：${result.comparison.monthlyImprovementPct} 個百分點`,
    `- 相較同區間基準回撤：${result.comparison.drawdownImprovementPct} 個百分點`,
    `- 紙上交易：${result.readiness.paperTradingAllowed ? '允許' : '不允許'}`,
    `- 實盤：${result.readiness.liveTradingAllowed ? '允許' : '不允許'}`,
    '',
    '## 可執行邏輯',
    '',
    '- T 日收盤判斷 0050 趨勢、20/60 日動能與 20 日年化波動，T+1 開盤才執行。',
    '- 低波動強趨勢才以有限部位持有 00631L；一般多頭持有 0050；趨勢失效則持有現金。',
    '- 波動升高會降低部位；帳戶回撤達訓練期選定門檻後，停止新曝險 20 個交易日。',
    '- 單月總資產回撤達 -3% 後，當月停止新增曝險；下一個月才重新評估。',
    '- 每個 36 個月 train 再拆成三個年度，至少兩年為正才可進入下一段 validation。',
    '- 所有委託包含滑價、費稅、整股／零股最低手續費與 T+2 可用資金限制。',
    '',
    '## 驗證限制',
    '',
    '- 過去版本曾在看完 validation 後挑固定策略，且每段重設資金；本版已修正，舊版 2.2737% 不再作為可信實盤基準。',
    '- 同一歷史資料已被多次研究，即使數字改善也不能直接實盤，仍需新期間 paper trading。',
    '- 00631L 為單日正向兩倍 ETF，長期有複利偏離與波動耗損，只能依規則短期持有。',
    `- Validation 交易僅 ${metrics.trades} 筆，未達 50 筆最低研究門檻，樣本不足。`,
    ''
  ].join('\n'), 'utf8');
  await fs.writeFile(READINESS, [
    '# 自動交易準備度',
    '',
    `目前長期 walk-forward：月均 ${metrics.averageMonthlyEquityReturnPct}%、年化 ${metrics.annualizedReturnPct}%、最大回撤 ${metrics.maximumDrawdownPct}%、交易 ${metrics.trades} 筆。`,
    '',
    `研究最低門檻：${minimumPassed ? '通過' : '未通過'}。`,
    'Paper trading：不允許自動啟用，須由使用者確認後另開全新期間驗證。',
    '真實券商 API：禁止下單，只能產生 order intent。',
    '',
    '原因：歷史 validation 已被反覆檢視，不再是完全未見資料；正式下單前仍需即時資料品質、委託失敗、部分成交、漲跌停與斷線復原測試。',
    ''
  ].join('\n'), 'utf8');
  await appendExperiment({
    strategyId: 'deployable_etf_hunter_v1_walk_forward',
    dataSources: ['0050_daily_ohlcv', '00631L_daily_ohlcv', '00632R_daily_ohlcv'],
    setupRules: ['趨勢狀態', '波動度縮放', '正2僅限低波動強趨勢'],
    triggerRules: ['T 日收盤確認，T+1 開盤執行'],
    invalidationRules: ['趨勢失效', '波動升高', '帳戶回撤熔斷'],
    exitRules: ['資產切換', '曝險分級調整', '驗證期結束'],
    riskRules: ['T+2', '不借款', '波動縮放', '20 日回撤冷卻'],
    blockedWhen: ['高波動且無明確趨勢'],
    parameters: { configs: configs.length, startDate: rows[0].date },
    trainPeriod: { months: 36 },
    validationPeriod: { months: 12, stepMonths: 12 },
    costModel: EXECUTION_COSTS,
    executionModel: 'T 日收盤訊號、T+1 開盤、T+2 可用資金',
    metrics: result.metrics,
    resultStatus: minimumPassed ? 'inconclusive' : 'failed',
    passedMinimum: minimumPassed,
    passedHighProfit: false,
    allowRetest: false,
    notes: minimumPassed
      ? '通過研究最低門檻，但 validation 已反覆使用，只能等待新期間紙上驗證。'
      : '未通過長期可交易門檻，不可紙上交易或實盤。'
  });
  console.log(`Deployable ETF Hunter：${selections.length} 段長期 validation，月均 ${metrics.averageMonthlyEquityReturnPct}%，最大回撤 ${metrics.maximumDrawdownPct}%，交易 ${metrics.trades} 筆。`);
}

await main();
