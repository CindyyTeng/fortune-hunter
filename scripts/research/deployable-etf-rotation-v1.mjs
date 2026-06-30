import fs from 'node:fs/promises';
import { buyExecution, sellExecution } from '../lib/execution-simulator.mjs';
import { decisionToOrderIntent } from '../lib/order-intent-generator.mjs';
import { foldWindows, mean, round } from './research-core.mjs';
import { appendExperiment } from './strategy-experiment-registry.mjs';

const CACHE = new URL('../../data/research/deployable-etf-rotation-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/deployable-etf-rotation-v1.json', import.meta.url);
const REPORT = new URL('../../docs/DEPLOYABLE_ETF_ROTATION_V1.md', import.meta.url);
const READINESS = new URL('../../docs/AUTO_TRADING_READINESS.md', import.meta.url);
const PRIOR = new URL('../../data/research/deployable-etf-hunter-v1.json', import.meta.url);
const REGISTRY = new URL('../../data/research/strategy-experiment-registry.json', import.meta.url);

const START_DATE = '2010-01-01';
const INITIAL_CAPITAL = 1_000_000;
const SETTLEMENT_DAYS = 2;
const TARGET_MONTHLY = 10;
const TRAIN_MONTHS = 48;
const VALIDATION_MONTHS = 24;
const MIN_VALIDATION_DAYS = 660;
const COSTS = Object.freeze({
  buyFeePct: 0.1425,
  sellFeePct: 0.1425,
  sellTaxPct: 0.1,
  buySlippagePct: 0.15,
  sellSlippagePct: 0.15,
  minimumFee: 20,
  boardLotShares: 1000
});
const ASSETS = Object.freeze([
  { symbol: '0050.TW', stockNo: '0050', name: '元大台灣50', group: '台灣大型股', startMonth: '20100101' },
  { symbol: '0052.TW', stockNo: '0052', name: '富邦科技', group: '台灣科技', startMonth: '20100101' },
  { symbol: '00646.TW', stockNo: '00646', name: '元大S&P500', group: '美國大型股', startMonth: '20151201' },
  { symbol: '00662.TW', stockNo: '00662', name: '富邦NASDAQ', group: '美國科技', startMonth: '20160601' },
  { symbol: '00661.TW', stockNo: '00661', name: '元大日經225', group: '日本股票', startMonth: '20160601' },
  { symbol: '00632R.TW', stockNo: '00632R', name: '元大台灣50反1', group: '台灣反向', startMonth: '20150601' },
  { symbol: '00635U.TW', stockNo: '00635U', name: '期元大S&P黃金', group: '黃金', startMonth: '20151201' }
]);

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const number = value => Number(String(value).replaceAll(',', ''));
const pct = (value, base) => Number.isFinite(value) && base ? (value / base - 1) * 100 : null;
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function months() {
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

async function fetchMonth(stockNo, date, expectRows = false, attempt = 1) {
  const host = attempt % 2 ? 'https://wwwc.twse.com.tw' : 'https://www.twse.com.tw';
  const path = attempt % 2 ? 'rwd/zh/afterTrading/STOCK_DAY' : 'exchangeReport/STOCK_DAY';
  const url = `${host}/${path}?date=${date}&stockNo=${stockNo}&response=json`;
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' },
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const rows = payload.stat === 'OK' ? payload.data || [] : [];
    if (expectRows && !rows.length) throw new Error('歷史月份回傳空資料');
    return rows;
  } catch (error) {
    if (attempt >= 6) throw new Error(`${stockNo} ${date} 下載失敗：${error.message}`);
    await wait(5_000 * attempt);
    return fetchMonth(stockNo, date, expectRows, attempt + 1);
  }
}

function adjustSplits(rows) {
  const adjusted = rows.map(row => ({ ...row }));
  for (let index = 1; index < adjusted.length; index += 1) {
    const ratio = adjusted[index].open / adjusted[index - 1].close;
    if (ratio > 1.5) {
      const multiplier = Math.round(ratio);
      if (multiplier >= 2 && multiplier <= 30 && Math.abs(ratio - multiplier) <= 0.2 * multiplier) {
        for (let prior = 0; prior < index; prior += 1) {
          for (const field of ['open', 'high', 'low', 'close']) adjusted[prior][field] *= multiplier;
        }
      }
      continue;
    }
    if (ratio >= 0.65) continue;
    const divisor = Math.round(1 / ratio);
    if (divisor < 2 || divisor > 30) continue;
    if (Math.abs(ratio - 1 / divisor) > 0.08) continue;
    for (let prior = 0; prior < index; prior += 1) {
      for (const field of ['open', 'high', 'low', 'close']) adjusted[prior][field] /= divisor;
    }
  }
  return adjusted;
}

function appendRows(unique, raw) {
  for (const row of raw) {
    const [year, month, day] = row[0].split('/').map(Number);
    const item = {
      date: `${year + 1911}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      open: number(row[3]),
      high: number(row[4]),
      low: number(row[5]),
      close: number(row[6])
    };
    if ([item.open, item.high, item.low, item.close].every(value => Number.isFinite(value) && value > 0)) unique.set(item.date, item);
  }
}

async function fetchAsset(asset, existingRows, completedRows, saveProgress) {
  const unique = new Map(existingRows.map(row => [row.date, row]));
  const firstKnownMonth = existingRows[0] ? `${existingRows[0].date.slice(0, 7).replace('-', '')}01` : null;
  const populatedMonths = new Set(existingRows.map(row => `${row.date.slice(0, 7).replace('-', '')}01`));
  const completed = new Set(completedRows.filter(date => date < firstKnownMonth || populatedMonths.has(date)));
  const dates = months().filter(date => date >= asset.startMonth);
  let pendingSaves = 0;
  for (const date of dates) {
    if (completed.has(date)) continue;
    appendRows(unique, await fetchMonth(asset.stockNo, date, true));
    completed.add(date);
    pendingSaves += 1;
    if (pendingSaves >= 12) {
      const rows = [...unique.values()].sort((left, right) => left.date.localeCompare(right.date));
      await saveProgress(rows, [...completed]);
      pendingSaves = 0;
    }
    await wait(250);
  }
  if (pendingSaves) {
    const rows = [...unique.values()].sort((left, right) => left.date.localeCompare(right.date));
    await saveProgress(rows, [...completed]);
  }
  return adjustSplits([...unique.values()].sort((left, right) => left.date.localeCompare(right.date)));
}

function assertPriceContinuity(payload) {
  for (const [symbol, rows] of Object.entries(payload.series || {})) {
    for (let index = 1; index < rows.length; index += 1) {
      const changePct = Math.abs(rows[index].close / rows[index - 1].close - 1) * 100;
      if (changePct > 25) throw new Error(`${symbol} ${rows[index].date} 出現 ${changePct.toFixed(2)}% 異常價格跳動`);
    }
  }
}

async function loadHistory() {
  const complete = (payload, asset) => {
    const rows = payload.series?.[asset.symbol] || [];
    const firstKnownMonth = rows[0] ? `${rows[0].date.slice(0, 7).replace('-', '')}01` : null;
    const populatedMonths = new Set(rows.map(row => `${row.date.slice(0, 7).replace('-', '')}01`));
    const completed = new Set(payload.completedMonths?.[asset.symbol] || []);
    return months().filter(date => date >= asset.startMonth).every(date => (
      completed.has(date) && (date < firstKnownMonth || populatedMonths.has(date))
    ));
  };
  let payload;
  if (process.env.REBUILD_ETF_ROTATION_DATA === '1') {
    payload = {
      generatedAt: null,
      source: 'TWSE STOCK_DAY 官方月行情',
      assets: ASSETS,
      series: {},
      completedMonths: {}
    };
  }
  try {
    payload ||= JSON.parse(await fs.readFile(CACHE, 'utf8'));
    for (const [symbol, rows] of Object.entries(payload.series || {})) {
      payload.series[symbol] = rows.filter(row => [row.open, row.high, row.low, row.close].every(value => Number.isFinite(value) && value > 0));
    }
    payload.assets = ASSETS;
    if (process.env.REFRESH_ETF_ROTATION_DATA !== '1'
      && ASSETS.every(asset => complete(payload, asset))) {
      assertPriceContinuity(payload);
      return payload;
    }
  } catch {
    payload = {
      generatedAt: null,
      source: 'TWSE STOCK_DAY 官方月行情',
      assets: ASSETS,
      series: {},
      completedMonths: {}
    };
  }
  payload.completedMonths ||= {};
  payload.assets = ASSETS;
  for (const asset of ASSETS) {
    if (complete(payload, asset)) continue;
    payload.series[asset.symbol] = await fetchAsset(
      asset,
      payload.series[asset.symbol] || [],
      payload.completedMonths[asset.symbol] || [],
      async (rows, completed) => {
        payload.series[asset.symbol] = rows;
        payload.completedMonths[asset.symbol] = completed;
        payload.generatedAt = new Date().toISOString();
        await fs.writeFile(CACHE, `${JSON.stringify(payload)}\n`, 'utf8');
      }
    );
    payload.generatedAt = new Date().toISOString();
    await fs.writeFile(CACHE, `${JSON.stringify(payload)}\n`, 'utf8');
  }
  payload.generatedAt = new Date().toISOString();
  await fs.writeFile(CACHE, `${JSON.stringify(payload)}\n`, 'utf8');
  assertPriceContinuity(payload);
  return payload;
}

function volatility(returns, days = 20) {
  if (returns.length < days) return null;
  const rows = returns.slice(-days);
  const center = average(rows);
  return Math.sqrt(average(rows.map(value => (value - center) ** 2))) * Math.sqrt(252) * 100;
}

function enrichSeries(rows) {
  const closes = [];
  const returns = [];
  return rows.map((bar, index) => {
    const prior = closes.at(-1);
    closes.push(bar.close);
    if (prior) returns.push(bar.close / prior - 1);
    return {
      ...bar,
      ma60: index >= 59 ? average(closes.slice(-60)) : null,
      ma120: index >= 119 ? average(closes.slice(-120)) : null,
      ma200: index >= 199 ? average(closes.slice(-200)) : null,
      mom20: index >= 20 ? pct(bar.close, closes[index - 20]) : null,
      mom60: index >= 60 ? pct(bar.close, closes[index - 60]) : null,
      mom120: index >= 120 ? pct(bar.close, closes[index - 120]) : null,
      vol20: volatility(returns)
    };
  }).filter(row => row.ma200 && [row.mom20, row.mom60, row.mom120, row.vol20].every(Number.isFinite));
}

function buildTimeline(payload) {
  const metrics = new Map();
  const bars = new Map();
  for (const asset of ASSETS) {
    const series = payload.series[asset.symbol] || [];
    bars.set(asset.symbol, new Map(series.map(row => [row.date, row])));
    for (const row of enrichSeries(series)) {
      if (!metrics.has(row.date)) metrics.set(row.date, new Map());
      metrics.get(row.date).set(asset.symbol, row);
    }
  }
  return [...new Set(payload.series['0050.TW'].map(row => row.date))]
    .filter(date => date >= '2010-11-01')
    .map((date, index) => ({
      date,
      index,
      metrics: metrics.get(date) || new Map(),
      bars: new Map(ASSETS.map(asset => [asset.symbol, bars.get(asset.symbol).get(date)]).filter(([, bar]) => bar))
    }));
}

function buildConfigs() {
  const weights = [
    { id: 'balanced', w20: 0.2, w60: 0.4, w120: 0.4 },
    { id: 'medium', w20: 0.4, w60: 0.4, w120: 0.2 }
  ];
  const rows = [];
  for (const family of ['taiwan_satellite', 'global_tactical']) {
    for (const weighting of weights) {
      for (const coreTrendDays of [60, 120, 200]) {
        for (const coreMomentum of [-6, -2, 2]) {
          for (const rebalanceDays of [20, 40]) {
            for (const switchBuffer of [4]) {
              rows.push({
                ...weighting,
                id: `${family}_${weighting.id}_ma${coreTrendDays}_r${rebalanceDays}_m${coreMomentum}_s${switchBuffer}`,
                name: `${family}／MA${coreTrendDays}／${rebalanceDays}日檢查`,
                family,
                coreTrendDays,
                coreMomentum,
                rebalanceDays,
                targetVol: 24,
                riskPositionPct: 100,
                defensivePositionPct: 0,
                stopLossPct: 6,
                trailingStopPct: 10,
                switchBuffer,
                monthlyStopPct: 3,
                drawdownGuardPct: 8
              });
            }
          }
        }
      }
    }
  }
  for (const weighting of weights) {
    for (const coreTrendDays of [60, 120, 200]) {
      for (const coreMomentum of [-6, -2, 2]) {
        for (const rebalanceDays of [10, 20, 40]) {
          for (const defensivePositionPct of [30, 50]) {
            rows.push({
              ...weighting,
              id: `hedged_tactical_${weighting.id}_ma${coreTrendDays}_r${rebalanceDays}_m${coreMomentum}_def${defensivePositionPct}`,
              name: `hedged_tactical／MA${coreTrendDays}／反向 ${defensivePositionPct}%`,
              family: 'hedged_tactical',
              coreTrendDays,
              coreMomentum,
              rebalanceDays,
              targetVol: 24,
              riskPositionPct: 100,
              defensivePositionPct,
              stopLossPct: 6,
              trailingStopPct: 10,
              switchBuffer: 4,
              monthlyStopPct: 3,
              drawdownGuardPct: 8
            });
          }
        }
      }
    }
  }
  return rows;
}

const allConfigs = buildConfigs();
const configLimit = Number(process.env.ROTATION_CONFIG_LIMIT || 0);
const configs = configLimit > 0 ? allConfigs.slice(0, configLimit) : allConfigs;

function rankAssets(row, config, symbols, defensive = false) {
  const ranked = [];
  for (const asset of ASSETS) {
    if (!symbols.includes(asset.symbol)) continue;
    const item = row.metrics.get(asset.symbol);
    if (!item) continue;
    const trend = defensive ? item.ma120 : item[`ma${config.coreTrendDays}`];
    if (item.close <= trend || item.mom60 <= (defensive ? 0 : -8)) continue;
    ranked.push({
      asset,
      item,
      score: item.mom20 * config.w20 + item.mom60 * config.w60 + item.mom120 * config.w120 - item.vol20 * 0.08
    });
  }
  return ranked.sort((left, right) => right.score - left.score);
}

function targetFor(row, config, state) {
  if (config.forceCash) return { symbol: null, reason: '訓練期沒有合格策略，持有現金' };
  if (state.cooldown > 0 || state.monthlyBlocked) return { symbol: null, reason: '帳戶風控熔斷' };
  if (state.position) {
    const held = row.metrics.get(state.position.symbol);
    if (held) {
      const lossPct = pct(held.close, state.position.entryPrice);
      const trailingPct = pct(held.close, state.position.peakClose);
      if (lossPct <= -config.stopLossPct) return { symbol: null, reason: `收盤跌破初始停損 ${config.stopLossPct}%` };
      if (state.position.peakClose > state.position.entryPrice * 1.05 && trailingPct <= -config.trailingStopPct) {
        return { symbol: null, reason: `獲利後回落 ${config.trailingStopPct}%，執行移動停利` };
      }
    }
  }
  const core = row.metrics.get('0050.TW');
  if (!core) return { symbol: null, reason: '台股核心資料不足' };
  const coreTrend = core[`ma${config.coreTrendDays}`];
  const riskOn = core.close > coreTrend && core.mom60 > config.coreMomentum && core.mom20 > -8;
  const riskSymbols = config.family === 'taiwan_satellite'
    ? ['0050.TW', '0052.TW']
    : ['0050.TW', '0052.TW', '00646.TW', '00662.TW', '00661.TW'];
  const defensiveSymbols = config.family === 'hedged_tactical'
    ? ['00632R.TW', '00635U.TW']
    : ['00635U.TW', '00646.TW', '00661.TW'];
  if (!riskOn && config.defensivePositionPct === 0) return { symbol: null, reason: '台股趨勢轉弱，防守期持有現金' };
  const ranked = rankAssets(row, config, riskOn ? riskSymbols : defensiveSymbols, !riskOn);
  if (!ranked.length) return { symbol: null, reason: riskOn ? '風險資產趨勢不足' : '防守資產趨勢不足，持有現金' };
  const current = state.position ? ranked.find(item => item.asset.symbol === state.position.symbol) : null;
  if (current && state.holdingDays < config.rebalanceDays) return { ...current, symbol: current.asset.symbol, positionPct: state.position.positionPct, reason: '未到輪動檢查日，續抱' };
  if (current && ranked[0].score < current.score + config.switchBuffer) {
    return { ...current, symbol: current.asset.symbol, positionPct: state.position.positionPct, reason: '領先幅度不足以支付換倉成本' };
  }
  const winner = ranked[0];
  const maximumPosition = riskOn ? config.riskPositionPct : config.defensivePositionPct;
  const positionPct = Math.max(35, Math.min(maximumPosition, Math.round(config.targetVol / winner.item.vol20 * 100 / 5) * 5));
  return { ...winner, symbol: winner.asset.symbol, positionPct, reason: `相對與絕對動能第一名：${winner.asset.name}` };
}

function equity(state, row, field = 'close') {
  const unsettled = state.unsettled.reduce((sum, item) => sum + item.amount, 0);
  const bar = state.position ? row.bars.get(state.position.symbol) : null;
  const markedPrice = bar?.[field] ?? (state.position ? state.lastClose.get(state.position.symbol) : null);
  return state.cash + unsettled + (markedPrice ? state.position.quantity * markedPrice : 0);
}

function orderIntent(date, symbol, action, config, price, positionPct, reason) {
  return decisionToOrderIntent({
    date,
    symbol,
    action,
    strategyId: `deployable_etf_rotation_v1:${config.id}`,
    setup: ['台灣掛牌跨市場 ETF 相對動能輪動'],
    trigger: ['T 日收盤確認，T+1 開盤執行'],
    invalidation: ['絕對動能轉負、排名落後、市場廣度不足或帳戶風控熔斷'],
    entryPlan: { referencePrice: price, maximumAcceptablePrice: price * 1.004, orderType: 'MARKETABLE_LIMIT', timeInForce: 'ROD', session: 'REGULAR' },
    riskPlan: { stopPrice: null, targetPrice: null, riskRewardRatio: null, positionBudget: INITIAL_CAPITAL * positionPct / 100, riskBudget: INITIAL_CAPITAL * 0.005 },
    reason,
    warnings: ['研究用 order intent；未通過紙上交易前禁止實盤']
  }, { account: { equity: INITIAL_CAPITAL, availableCash: INITIAL_CAPITAL } });
}

function sell(state, row, reason) {
  if (!state.position) return;
  const bar = row.bars.get(state.position.symbol);
  if (!bar) return;
  const execution = sellExecution(bar.open, state.position.quantity, COSTS);
  const pnl = execution.net - state.position.cost;
  state.unsettled.push({ releaseIndex: row.index + SETTLEMENT_DAYS, amount: execution.net });
  state.trades.push({ symbol: state.position.symbol, entryDate: state.position.entryDate, exitDate: row.date, pnl: round(pnl), reason });
  if (state.emitIntents) state.intents.push(orderIntent(row.date, state.position.symbol, 'SELL', state.config, execution.fillPrice, 0, reason));
  state.position = null;
  state.holdingDays = 0;
}

function buy(state, row, target) {
  const bar = row.bars.get(target.symbol);
  if (!bar) return;
  const budget = state.cash * target.positionPct / 100;
  let quantity = Math.floor(budget / (bar.open * 1.004));
  let execution = buyExecution(bar.open, quantity, COSTS);
  if (execution.total > budget) {
    quantity = Math.floor(quantity * budget / execution.total);
    execution = buyExecution(bar.open, quantity, COSTS);
    if (execution.total > budget) {
      quantity -= 1;
      execution = buyExecution(bar.open, quantity, COSTS);
    }
  }
  if (!quantity) return;
  state.cash -= execution.total;
  state.position = { symbol: target.symbol, quantity, cost: execution.total, entryDate: row.date, positionPct: target.positionPct };
  state.position.entryPrice = execution.fillPrice;
  state.position.peakClose = execution.fillPrice;
  state.holdingDays = 0;
  if (state.emitIntents) state.intents.push(orderIntent(row.date, target.symbol, 'BUY', state.config, execution.fillPrice, target.positionPct, target.reason));
}

function summarize(state, initialCapital, startDate, endDate) {
  const monthEnd = new Map();
  for (const row of state.curve) monthEnd.set(row.date.slice(0, 7), row.equity);
  let prior = initialCapital;
  const monthly = [...monthEnd].map(([month, value]) => {
    const equityReturnPct = pct(value, prior);
    prior = value;
    return { month, equity: round(value, 0), equityReturnPct: round(equityReturnPct) };
  });
  const gains = state.trades.filter(row => row.pnl > 0).reduce((sum, row) => sum + row.pnl, 0);
  const losses = Math.abs(state.trades.filter(row => row.pnl <= 0).reduce((sum, row) => sum + row.pnl, 0));
  let peak = initialCapital;
  let maximumDrawdownPct = 0;
  for (const row of state.curve) {
    peak = Math.max(peak, row.equity);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, pct(row.equity, peak));
  }
  const compounded = monthly.reduce((value, row) => value * (1 + row.equityReturnPct / 100), 1);
  return {
    startDate,
    endDate,
    endingEquity: round(state.curve.at(-1)?.equity ?? initialCapital, 0),
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

function simulateBuyAndHold(rows, startDate, endDate) {
  const slice = rows.filter(row => row.date >= startDate && row.date <= endDate && row.bars.has('0050.TW'));
  const first = slice[0];
  const last = slice.at(-1);
  if (!first || !last) return null;
  let quantity = Math.floor(INITIAL_CAPITAL / (first.bars.get('0050.TW').open * 1.004));
  let entry = buyExecution(first.bars.get('0050.TW').open, quantity, COSTS);
  if (entry.total > INITIAL_CAPITAL) {
    quantity -= 1;
    entry = buyExecution(first.bars.get('0050.TW').open, quantity, COSTS);
  }
  const cash = INITIAL_CAPITAL - entry.total;
  const curve = slice.map(row => ({ date: row.date, equity: cash + quantity * row.bars.get('0050.TW').close }));
  const exit = sellExecution(last.bars.get('0050.TW').close, quantity, COSTS);
  curve[curve.length - 1].equity = cash + exit.net;
  const state = {
    curve,
    trades: [{ symbol: '0050.TW', entryDate: first.date, exitDate: last.date, pnl: exit.net - entry.total }]
  };
  return summarize(state, INITIAL_CAPITAL, startDate, endDate);
}

function yearlyFromMonthly(monthly) {
  const groups = new Map();
  for (const row of monthly) {
    const year = row.month.slice(0, 4);
    if (!groups.has(year)) groups.set(year, []);
    groups.get(year).push(row.equityReturnPct);
  }
  return [...groups].map(([year, returns]) => ({
    year,
    equityReturnPct: round((returns.reduce((value, item) => value * (1 + item / 100), 1) - 1) * 100),
    negativeMonths: returns.filter(value => value < 0).length
  }));
}

function simulate(rows, schedule, startDate, endDate, emitIntents = false) {
  const slice = rows.filter(row => row.date >= startDate && row.date <= endDate);
  const state = {
    cash: INITIAL_CAPITAL,
    unsettled: [],
    position: null,
    holdingDays: 0,
    trades: [],
    intents: [],
    curve: [],
    peak: INITIAL_CAPITAL,
    cooldown: 0,
    currentMonth: null,
    monthStart: INITIAL_CAPITAL,
    monthlyBlocked: false,
    lastClose: new Map(),
    config: schedule(startDate),
    emitIntents
  };
  for (let offset = 1; offset < slice.length; offset += 1) {
    const signalRow = slice[offset - 1];
    const row = slice[offset];
    for (const [symbol, bar] of signalRow.bars) state.lastClose.set(symbol, bar.close);
    if (state.position) {
      const heldBar = signalRow.bars.get(state.position.symbol);
      if (heldBar) state.position.peakClose = Math.max(state.position.peakClose, heldBar.close);
    }
    state.config = schedule(signalRow.date);
    const released = state.unsettled.filter(item => item.releaseIndex <= row.index);
    state.cash += released.reduce((sum, item) => sum + item.amount, 0);
    state.unsettled = state.unsettled.filter(item => item.releaseIndex > row.index);
    const priorEquity = equity(state, signalRow);
    const month = signalRow.date.slice(0, 7);
    if (month !== state.currentMonth) {
      state.currentMonth = month;
      state.monthStart = priorEquity;
      state.monthlyBlocked = false;
    } else if (pct(priorEquity, state.monthStart) <= -(state.config.monthlyStopPct ?? 3)) state.monthlyBlocked = true;
    state.peak = Math.max(state.peak, priorEquity);
    if (state.cooldown > 0) {
      state.cooldown -= 1;
      if (!state.cooldown) state.peak = priorEquity;
    } else if (pct(priorEquity, state.peak) <= -state.config.drawdownGuardPct) state.cooldown = 20;
    const target = targetFor(signalRow, state.config, state);
    if (state.position && state.position.symbol !== target.symbol) sell(state, row, target.reason);
    if (!state.position && target.symbol) buy(state, row, target);
    if (state.position) state.holdingDays += 1;
    for (const [symbol, bar] of row.bars) state.lastClose.set(symbol, bar.close);
    state.curve.push({ date: row.date, equity: equity(state, row) });
  }
  const last = slice.at(-1);
  if (last && state.position) sell(state, last, '驗證期結束');
  if (last) state.curve.push({ date: last.date, equity: equity(state, last) });
  return { state, summary: summarize(state, INITIAL_CAPITAL, startDate, endDate) };
}

function addYears(dateText, years) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

function dayBefore(dateText) {
  return new Date(Date.parse(`${dateText}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function trainScore(summary, yearly) {
  if (summary.trades < 10 || summary.averageMonthlyEquityReturnPct <= 0) return -Infinity;
  if (yearly.filter(value => value > 0).length < Math.ceil(yearly.length * 0.4)) return -Infinity;
  const center = average(yearly);
  const dispersion = Math.sqrt(average(yearly.map(value => (value - center) ** 2)));
  const pf = Number.isFinite(summary.profitFactor) ? Math.min(4, summary.profitFactor) : 4;
  return summary.averageMonthlyEquityReturnPct * 16
    + Math.min(...yearly) * 2
    + center * 2
    - dispersion
    + summary.maximumDrawdownPct * 0.5
    + pf;
}

function selectConfig(rows, fold) {
  const years = Math.max(4, Math.ceil((Date.parse(fold.trainEnd) - Date.parse(fold.trainStart)) / (365.25 * 86_400_000)));
  const yearly = Array.from({ length: years }, (_, index) => ({
    start: addYears(fold.trainStart, index),
    end: index === years - 1 ? fold.trainEnd : dayBefore(addYears(fold.trainStart, index + 1))
  }));
  const inverseTrainingDays = rows.filter(row => row.date >= fold.trainStart
    && row.date <= fold.trainEnd
    && row.metrics.has('00632R.TW')).length;
  const eligibleConfigs = configs.filter(config => config.family !== 'hedged_tactical' || inverseTrainingDays >= 252);
  const evaluated = eligibleConfigs.map(config => {
    const summary = simulate(rows, () => config, fold.trainStart, fold.trainEnd).summary;
    const yearlyReturns = yearly.map(window => simulate(rows, () => config, window.start, window.end).summary.averageMonthlyEquityReturnPct);
    return { config, summary, score: trainScore(summary, yearlyReturns) };
  }).sort((left, right) => right.score - left.score);
  const selected = evaluated.find(row => Number.isFinite(row.score));
  if (selected) return selected;
  return {
    config: { ...configs[0], id: 'cash_fallback', name: '訓練期無合格策略，持有現金', forceCash: true },
    summary: simulate(rows, () => ({ ...configs[0], forceCash: true }), fold.trainStart, fold.trainEnd).summary,
    score: 0
  };
}

const compact = summary => Object.fromEntries(Object.entries(summary).filter(([key]) => key !== 'monthly'));

async function main() {
  const [payload, prior] = await Promise.all([loadHistory(), fs.readFile(PRIOR, 'utf8').then(JSON.parse)]);
  const rows = buildTimeline(payload);
  const folds = foldWindows(rows[0].date, rows.at(-1).date, TRAIN_MONTHS, VALIDATION_MONTHS)
    .filter(fold => Date.parse(fold.validationEnd) - Date.parse(fold.validationStart) >= MIN_VALIDATION_DAYS * 86_400_000);
  const selections = folds.map(fold => {
    const selected = selectConfig(rows, fold);
    return { ...fold, selected };
  });
  const schedule = date => selections.find(row => date >= row.validationStart && date <= row.validationEnd)?.selected.config
    || selections.at(-1).selected.config;
  const validationStart = selections[0].validationStart;
  const validationEnd = selections.at(-1).validationEnd;
  const validation = simulate(rows, schedule, validationStart, validationEnd, true);
  const frozenConfig = selections[0].selected.config;
  const frozenValidation = simulate(rows, () => frozenConfig, validationStart, validationEnd);
  const buyAndHold = simulateBuyAndHold(rows, validationStart, validationEnd);
  const metrics = validation.summary;
  const baseline = prior.metrics;
  const improved = metrics.averageMonthlyEquityReturnPct > baseline.averageMonthlyEquityReturnPct
    && metrics.maximumDrawdownPct > baseline.maximumDrawdownPct;
  const minimumPassed = improved && metrics.trades >= 50 && metrics.profitFactor > 1.15 && metrics.maximumDrawdownPct > -20;
  const result = {
    generatedAt: new Date().toISOString(),
    branch: 'institutional-data-fetcher-v1',
    status: improved ? 'IMPROVED_MONTHLY_AND_DRAWDOWN' : 'NO_DUAL_IMPROVEMENT',
    methodology: `${TRAIN_MONTHS} 個月滾動訓練／${VALIDATION_MONTHS} 個月非重疊驗證；validation 參數固定`,
    dataRange: { start: rows[0].date, end: rows.at(-1).date },
    assets: ASSETS,
    configsTestedPerFold: configs.length,
    validationFolds: selections.length,
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
    metrics: { ...metrics, targetGapPct: round(TARGET_MONTHLY - metrics.averageMonthlyEquityReturnPct), orderIntents: validation.state.intents.length },
    yearlyValidation: yearlyFromMonthly(metrics.monthly),
    frozenFirstConfigValidation: {
      selectedOnlyFrom: `${selections[0].trainStart} 至 ${selections[0].trainEnd}`,
      configId: frozenConfig.id,
      metrics: compact(frozenValidation.summary)
    },
    buyAndHold0050: compact(buyAndHold),
    priorBaseline: compact(baseline),
    comparison: {
      monthlyImprovementPct: round(metrics.averageMonthlyEquityReturnPct - baseline.averageMonthlyEquityReturnPct),
      drawdownImprovementPct: round(metrics.maximumDrawdownPct - baseline.maximumDrawdownPct),
      tradeDifference: metrics.trades - baseline.trades,
      improvedMonthlyAndDrawdown: improved
    },
    readiness: {
      minimumResearchThresholdPassed: minimumPassed,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      brokerApiAllowed: false,
      reason: minimumPassed
        ? '歷史門檻通過，但 validation 已反覆研究，仍須全新期間紙上交易。'
        : '尚未同時通過報酬、回撤與樣本門檻，不可紙上交易或實盤。'
    }
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, [
    '# 跨市場 ETF 輪動長驗證 v1',
    '',
    `- 長期 validation：${selections.length} 段`,
    `- 月均總資產報酬：${metrics.averageMonthlyEquityReturnPct}%`,
    `- 年化報酬：${metrics.annualizedReturnPct}%`,
    `- 最大回撤：${metrics.maximumDrawdownPct}%`,
    `- Profit Factor：${metrics.profitFactor}`,
    `- 交易數：${metrics.trades}`,
    `- 勝率：${metrics.winRatePct}%`,
    `- 首段規則固定於完整驗證月均：${frozenValidation.summary.averageMonthlyEquityReturnPct}%`,
    `- 首段規則固定於完整驗證回撤：${frozenValidation.summary.maximumDrawdownPct}%`,
    `- 同期 0050 買進持有月均：${buyAndHold.averageMonthlyEquityReturnPct}%`,
    `- 同期 0050 買進持有回撤：${buyAndHold.maximumDrawdownPct}%`,
    `- 與前版月均差：${result.comparison.monthlyImprovementPct} 個百分點`,
    `- 與前版回撤差：${result.comparison.drawdownImprovementPct} 個百分點`,
    `- 距離月均 10%：${result.metrics.targetGapPct} 個百分點`,
    `- Paper trading：${result.readiness.paperTradingAllowed ? '允許' : '不允許'}`,
    `- 實盤：${result.readiness.liveTradingAllowed ? '允許' : '不允許'}`,
    '- 結論：未通過長期 validation，不可作為可實盤策略。',
    '',
    '策略只使用 T 日收盤以前資料；台股核心趨勢允許時，從台灣、美國與日本股票 ETF 中挑選相對動能較強者；趨勢轉弱則持有現金，T+1 開盤執行。',
    '已計入 ETF 交易稅 0.1%、手續費、雙邊滑價、T+2、6% 收盤停損、移動停利、月損熔斷與帳戶回撤冷卻。',
    '官方價格資料未回補配息，屬價格報酬回測；同一 validation 已用於研究，正式交易前仍需新期間驗證。',
    ''
  ].join('\n'), 'utf8');
  await fs.writeFile(READINESS, [
    '# 自動交易準備度',
    '',
    `跨市場 ETF 輪動 48/24 長期 validation：月均 ${metrics.averageMonthlyEquityReturnPct}%、年化 ${metrics.annualizedReturnPct}%、最大回撤 ${metrics.maximumDrawdownPct}%、交易 ${metrics.trades} 筆。`,
    `同期 0050 買進持有：月均 ${buyAndHold.averageMonthlyEquityReturnPct}%、最大回撤 ${buyAndHold.maximumDrawdownPct}%。`,
    `歷史最低門檻：${minimumPassed ? '通過' : '未通過'}。`,
    '結論：未通過 validation，Paper trading 不得自動啟用。',
    '真實券商 API：禁止送單，只能保留 order intent dry-run。',
    '',
    '正式交易前仍須補足新期間紙上交易、配息調整、即時報價品質、部分成交、漲跌停與斷線復原測試。',
    ''
  ].join('\n'), 'utf8');
  const registry = JSON.parse(await fs.readFile(REGISTRY, 'utf8'));
  registry.experiments = registry.experiments.filter(row => row.strategyId !== 'deployable_etf_rotation_v1');
  registry.updatedAt = new Date().toISOString();
  await fs.writeFile(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await appendExperiment({
    strategyId: 'deployable_etf_rotation_v1',
    dataSources: ASSETS.map(asset => `${asset.stockNo}_TWSE_daily`),
    setupRules: ['跨市場相對動能', '絕對趨勢', '波動度縮放'],
    triggerRules: ['T 日收盤確認，T+1 開盤輪動'],
    invalidationRules: ['台股核心趨勢轉負', '收盤虧損達 6%', '獲利後回落 10%'],
    exitRules: ['輪動換倉', '初始停損', '移動停利', '月損熔斷', '帳戶回撤冷卻'],
    riskRules: ['不借款', 'T+2', 'ETF 交易稅 0.1%', '雙邊滑價'],
    blockedWhen: ['台股核心趨勢轉弱', '月損或帳戶回撤熔斷'],
    parameters: { configs: configs.length, assets: ASSETS.map(asset => asset.symbol) },
    trainPeriod: { months: TRAIN_MONTHS, mode: 'rolling' },
    validationPeriod: { months: VALIDATION_MONTHS, stepMonths: VALIDATION_MONTHS },
    costModel: COSTS,
    executionModel: 'T 日收盤訊號、T+1 開盤、T+2 可用資金',
    metrics: result.metrics,
    resultStatus: minimumPassed ? 'inconclusive' : 'failed',
    passedMinimum: minimumPassed,
    passedHighProfit: false,
    allowRetest: false,
    notes: minimumPassed ? '僅可等待全新期間紙上驗證。' : '未達門檻，不可紙上交易或實盤。'
  });
  console.log(`ETF 輪動：${selections.length} 段 validation，月均 ${metrics.averageMonthlyEquityReturnPct}%，回撤 ${metrics.maximumDrawdownPct}%，交易 ${metrics.trades} 筆。`);
}

await main();
