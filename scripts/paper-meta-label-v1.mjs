import fs from 'node:fs/promises';
import { loadResearchContext } from './research/research-core.mjs';
import { generateOrderIntents } from './lib/order-intent-generator.mjs';
import { createMockBroker } from './lib/broker-adapter.mock.mjs';
import { buyExecution } from './lib/execution-simulator.mjs';
import { eligible, fitModel, modelScore, stockOnly } from './lib/stock-meta-label-engine.mjs';

const INPUT = new URL('../data/tw-backtest-10y.json', import.meta.url);
const REPORT = new URL('../data/research/stock-meta-label-v1.json', import.meta.url);
const STATE = new URL('../data/paper-meta-label-state.json', import.meta.url);
const INITIAL_CASH = 1_000_000;
const MAX_DATA_AGE_DAYS = Number(process.env.PAPER_META_MAX_DATA_AGE_DAYS || 3);
const LIVE_URL = process.env.PAPER_META_LIVE_URL || process.env.PAPER_LIVE_URL || 'http://localhost:8787/quotes';
const COSTS = {
  buyFeePct: 0.1425,
  sellFeePct: 0.1425,
  sellTaxPct: 0.3,
  buySlippagePct: 0.15,
  sellSlippagePct: 0.15,
  minimumFee: 20,
  boardLotShares: 1
};

const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const percent = (value, base) => Number.isFinite(value) && Number.isFinite(base) && base
  ? (value / base - 1) * 100
  : null;
const mean = values => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : null;
const dateDiff = (from, to) => Math.floor(
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
);
const todayKey = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());

function rsi(closes) {
  if (closes.length < 15) return null;
  const changes = closes.slice(-15).map((close, index, rows) =>
    index ? close - rows[index - 1] : 0
  ).slice(1);
  const gains = mean(changes.map(value => Math.max(0, value))) || 0;
  const losses = mean(changes.map(value => Math.max(0, -value))) || 0;
  return losses ? 100 - 100 / (1 + gains / losses) : 100;
}

function atrPercent(history) {
  if (history.length < 15) return null;
  const rows = history.slice(-15);
  const ranges = rows.slice(1).map((row, index) => {
    const previousClose = rows[index].close;
    return Math.max(
      row.high - row.low,
      Math.abs(row.high - previousClose),
      Math.abs(row.low - previousClose)
    );
  });
  return mean(ranges) / rows.at(-1).close * 100;
}

function symbolKey(symbol) {
  return String(symbol || '').split('.')[0];
}

function marketSuffix(market) {
  return String(market || '').includes('上櫃') || String(market || '').includes('TWO') ? 'TWO' : 'TW';
}

function quoteMap(quotes) {
  return new Map((quotes || []).map(quote => [symbolKey(quote.symbol), quote]));
}

function marketMap(quotes) {
  const map = {};
  for (const quote of quotes) {
    const key = symbolKey(quote.symbol);
    map[quote.symbol] = quote;
    map[`${key}.TW`] = quote;
    map[`${key}.TWO`] = quote;
  }
  return map;
}

function themeMoves(stocks, date) {
  const grouped = new Map();
  for (const { stock, history } of stocks) {
    const index = history.findIndex(row => row.date === date);
    if (index < 1) continue;
    const theme = stock.themes?.find(Boolean) || '未分類';
    const move = percent(history[index].close, history[index - 1].close);
    if (!Number.isFinite(move)) continue;
    const item = grouped.get(theme) || { sum: 0, count: 0 };
    item.sum += move;
    item.count += 1;
    grouped.set(theme, item);
  }
  return new Map([...grouped].map(([theme, item]) => [theme, item.sum / item.count]));
}

function buildLiveRows(context, date) {
  const themeByName = themeMoves(context.ohlcv.stocks, date);
  const marketIndex = context.marketHistory.findIndex(row => row.date === date);
  const marketMove = marketIndex > 0
    ? percent(context.marketHistory[marketIndex].close, context.marketHistory[marketIndex - 1].close)
    : null;
  const rows = [];
  for (const { stock, history } of context.ohlcv.stocks) {
    if (!stockOnly(stock) || history.at(-1)?.date !== date || history.length < 200) continue;
    const day = history.at(-1);
    const previous = history.at(-2);
    const closes = history.map(row => row.close);
    const ma20 = mean(closes.slice(-20));
    const oldMa20 = mean(closes.slice(-25, -5));
    const theme = stock.themes?.find(Boolean) || '未分類';
    rows.push({
      symbol: stock.symbol,
      name: stock.name,
      market: stock.market,
      signalDate: date,
      entryPrice: day.close,
      return5Pct: percent(day.close, closes.at(-6)),
      return20Pct: percent(day.close, closes.at(-21)),
      nearYearHigh: day.close / Math.max(...history.slice(-120).map(row => row.high)),
      ma20Slope5Pct: percent(ma20, oldMa20),
      volumeRatio1To20: day.volume / (mean(history.slice(-20).map(row => row.volume)) || 1),
      atr14Pct: atrPercent(history),
      distanceToMa20Pct: percent(day.close, ma20),
      upperWickRatio: (day.high - Math.max(day.open, day.close))
        / Math.max(day.high - day.low, day.close * 0.001),
      marketMovePct: marketMove,
      themeMovePct: themeByName.get(theme),
      rsi14: rsi(closes),
      avg20TradeValue: mean(history.slice(-20).map(row => row.close * row.volume)),
      gapUpPct: percent(day.open, previous.close),
      regime: context.marketByDate.get(date)?.regime
    });
  }
  return rows;
}

async function loadQuotes(symbols) {
  const url = new URL(LIVE_URL);
  if (symbols?.length) url.searchParams.set('symbols', symbols.join(','));
  const response = await fetch(url, { headers: { 'user-agent': 'fortune-hunter-meta-paper/1.0' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  return payload.quotes || [];
}

async function loadState() {
  try {
    const state = JSON.parse(await fs.readFile(STATE, 'utf8'));
    const orders = state.orders || [];
    const positions = (state.positions || []).map(position => {
      if (position.entryCost != null) return position;
      const buy = orders.find(order =>
        order.side === 'BUY'
        && order.status === 'FILLED'
        && order.symbol === position.symbol
      );
      return {
        ...position,
        entryCost: buy
          ? Number(buy.fillPrice) * Number(buy.filledQuantity) + Number(buy.fee || 0)
          : Number(position.entryPrice) * Number(position.quantity)
      };
    });
    return {
      ...state,
      initialCash: Number(state.initialCash ?? INITIAL_CASH),
      realizedPnl: Number(state.realizedPnl ?? 0),
      cash: Number(state.cash ?? INITIAL_CASH),
      positions,
      orders,
      runs: state.runs || [],
      pendingOrders: state.pendingOrders || [],
      pendingSettlements: state.pendingSettlements || []
    };
  } catch {
    return {
      initialCash: INITIAL_CASH,
      realizedPnl: 0,
      cash: INITIAL_CASH,
      positions: [],
      orders: [],
      runs: [],
      pendingOrders: [],
      pendingSettlements: []
    };
  }
}

function account(state, quotes) {
  const bySymbol = quoteMap(quotes);
  const marketValue = state.positions.reduce((sum, position) => {
    const price = Number(bySymbol.get(symbolKey(position.symbol))?.price) || position.entryPrice;
    return sum + position.quantity * price;
  }, 0);
  const pendingCash = (state.pendingSettlements || [])
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  return {
    equity: state.cash + pendingCash + marketValue,
    availableCash: state.cash,
    pendingCash
  };
}

function settlementDate(date, tradingDates) {
  const index = tradingDates.indexOf(date);
  if (index >= 0 && tradingDates[index + 2]) return tradingDates[index + 2];
  const cursor = new Date(`${date}T00:00:00Z`);
  let businessDays = 0;
  while (businessDays < 2) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) businessDays += 1;
  }
  return cursor.toISOString().slice(0, 10);
}

function settlePendingCash(state, date) {
  const pending = state.pendingSettlements || [];
  const due = pending.filter(item => item.settlementDate <= date);
  if (!due.length) return;
  state.cash = round(state.cash + due.reduce((sum, item) => sum + Number(item.amount || 0), 0), 2);
  state.pendingSettlements = pending.filter(item => item.settlementDate > date);
}

function nextAvailableBar(pendingOrder, context, dataDate) {
  const signalDate = pendingOrder.signalDate;
  const executionDate = context.marketHistory
    .map(row => row.date)
    .find(date => date > signalDate && date <= dataDate);
  if (!executionDate) return null;
  const stock = context.ohlcv.stocks.find(({ stock }) =>
    symbolKey(stock.symbol) === symbolKey(pendingOrder.intent.symbol)
  );
  const bar = stock?.history.find(row => row.date === executionDate);
  return { executionDate, bar: bar || null };
}

function openMarketMap(pendingOrders, context, dataDate) {
  const market = {};
  const due = [];
  for (const pendingOrder of pendingOrders) {
    const next = nextAvailableBar(pendingOrder, context, dataDate);
    if (!next) continue;
    due.push({ ...pendingOrder, ...next });
    if (next.bar) {
      market[pendingOrder.intent.symbol] = {
        symbol: pendingOrder.intent.symbol,
        price: next.bar.open,
        open: next.bar.open,
        high: next.bar.high,
        low: next.bar.low,
        close: next.bar.close
      };
    }
  }
  return { due, market };
}

function positionDecision(position, quote, date, config) {
  const price = Number(quote?.price);
  if (!Number.isFinite(price)) return {
    date, symbol: position.symbol, action: 'HOLD', strategyId: 'stock-meta-label-v1',
    reason: '缺少即時價格，保留持倉。', warnings: ['等待下一次報價']
  };
  const heldDays = dateDiff(position.entryDate, date);
  if (price <= position.stopPrice) return {
    date, symbol: position.symbol, action: 'SELL', strategyId: 'stock-meta-label-v1',
    exit: '停損', reason: `價格 ${round(price)} 跌破停損 ${round(position.stopPrice)}`,
    warnings: ['目前僅送至模擬券商']
  };
  if (price >= position.targetPrice) return {
    date, symbol: position.symbol, action: 'SELL', strategyId: 'stock-meta-label-v1',
    exit: '停利', reason: `現價 ${round(price)} 已達 1.5R 停利 ${round(position.targetPrice)}`,
    warnings: []
  };
  if (heldDays >= (position.maxHoldingDays ?? config.holdDays)) return {
    date, symbol: position.symbol, action: 'SELL', strategyId: 'stock-meta-label-v1',
    exit: '持有期滿', reason: `已持有 ${heldDays} 個交易日`, warnings: ['目前僅送至模擬券商']
  };
  return {
    date, symbol: position.symbol, action: 'HOLD', strategyId: 'stock-meta-label-v1',
    reason: `持有第 ${heldDays} 個交易日`, warnings: []
  };
}

function buyDecision(row, quote, model, config, date) {
  const entry = Number(quote?.price);
  if (!Number.isFinite(entry)) return {
    date, symbol: row.symbol, action: 'SKIP', strategyId: 'stock-meta-label-v1',
    reason: '缺少個股即時價格。', warnings: ['不使用歷史收盤價代替']
  };
  const stop = entry * (1 - config.stopLossPct / 100);
  return {
    date,
    symbol: `${row.symbol}.${marketSuffix(row.market)}`,
    name: row.name,
    action: 'BUY',
    strategyId: 'stock-meta-label-v1',
    setup: '個股動能與風險因子通過篩選',
    trigger: '模型排名進榜，使用即時價格產生紙上買進意圖',
    invalidation: `跌破停損價 ${round(stop)}`,
    entryPlan: {
      referencePrice: entry,
      maximumAcceptablePrice: entry * 1.005,
      orderType: 'MARKET',
      timing: 'NEXT_OPEN',
      timeInForce: 'ROD',
      session: 'REGULAR'
    },
    riskPlan: {
      stopPrice: stop,
      targetPrice: entry + (entry - stop) * config.rewardRisk,
      riskRewardRatio: config.rewardRisk,
      accountRiskPct: 0.5,
      riskBudget: INITIAL_CASH * 0.005,
      positionBudget: INITIAL_CASH * config.positionPct / 100
    },
    maxHoldingDays: config.holdDays,
    reason: `Meta-label 分數 ${round(modelScore(row, model))}`,
    warnings: ['僅使用模擬券商，不連接真實 API']
  };
}

function markPositions(state, quotes, date) {
  const bySymbol = quoteMap(quotes);
  for (const position of state.positions) {
    const quote = bySymbol.get(symbolKey(position.symbol));
    const price = Number(quote?.price);
    if (Number.isFinite(price)) {
      position.lastPrice = price;
      position.lastPriceDate = date;
    }
    if (!position.name && quote?.name) position.name = quote.name;
  }
}

function applyFills(state, results, decisions, date, quotes, dueDate) {
  const bySymbol = new Map(decisions.map(decision => [decision.symbol, decision]));
  for (const result of results) {
    const order = result.side === 'SELL' ? { ...result, settlementDate: dueDate } : result;
    state.orders.push(order);
    if (!['FILLED', 'PARTIALLY_FILLED'].includes(result.status) || !result.filledQuantity) continue;
    const decision = bySymbol.get(result.symbol);
    if (result.side === 'BUY') {
      const referencePrice = Number(decision?.entryPlan?.referencePrice) || result.fillPrice;
      const referenceStop = Number(decision?.riskPlan?.stopPrice) || referencePrice;
      const stopPct = referencePrice > 0
        ? Math.max(0, 1 - referenceStop / referencePrice)
        : 0.03;
      const stopPrice = result.fillPrice * (1 - stopPct);
      const rewardRisk = Number(decision?.riskPlan?.riskRewardRatio) || 1.5;
      state.cash = round(state.cash + result.cashImpact, 2);
      state.positions.push({
        symbol: result.symbol,
        name: decision?.name || result.symbol,
        quantity: result.filledQuantity,
        entryPrice: result.fillPrice,
        entryCost: -result.cashImpact,
        targetPrice: result.fillPrice + (result.fillPrice - stopPrice) * rewardRisk,
        entryDate: date,
        stopPrice,
        maxHoldingDays: decision?.maxHoldingDays,
        lastPrice: result.fillPrice,
        lastPriceDate: date
      });
    } else if (result.side === 'SELL') {
      state.pendingSettlements ||= [];
      state.pendingSettlements.push({
        settlementDate: dueDate,
        amount: result.cashImpact,
        symbol: result.symbol,
        orderId: result.orderId
      });
      const position = state.positions.find(item => item.symbol === result.symbol);
      if (!position) continue;
      const soldQuantity = Math.min(result.filledQuantity, position.quantity);
      const entryCost = Number(position.entryCost ?? position.entryPrice * position.quantity);
      const allocatedEntryCost = entryCost * soldQuantity / position.quantity;
      state.realizedPnl = round(Number(state.realizedPnl || 0) + result.cashImpact - allocatedEntryCost, 2);
      position.quantity -= soldQuantity;
      position.entryCost = Math.max(0, entryCost - allocatedEntryCost);
      if (position.quantity <= 0) {
        state.positions = state.positions.filter(item => item !== position);
      }
    }
  }
  markPositions(state, quotes, date);
}

async function saveAndReport(state, payload) {
  const next = { ...state, ...payload };
  recordRun(next, payload);
  await fs.writeFile(STATE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`紙上交易安全停止：${payload.status}；${payload.reason}`);
}

function recordRun(state, run) {
  const previous = (state.runs || []).filter(item => item.runDate !== run.runDate);
  state.lastRun = run;
  state.runs = [...previous, run].slice(-60);
}

async function main() {
  const report = JSON.parse(await fs.readFile(REPORT, 'utf8'));
  const state = await loadState();
  const runDate = todayKey();
  const input = JSON.parse(await fs.readFile(INPUT, 'utf8'));
  const context = await loadResearchContext();
  const tradingDates = context.marketHistory.map(row => row.date).filter(Boolean);
  const nameBySymbol = new Map(context.ohlcv.stocks.map(({ stock }) => [
    symbolKey(`${stock.symbol}.${marketSuffix(stock.market)}`),
    stock.name
  ]));
  for (const position of state.positions) {
    position.name ||= nameBySymbol.get(symbolKey(position.symbol)) || position.symbol;
  }
  const dataDate = context.marketHistory.at(-1)?.date;
  const dataAgeDays = dataDate ? dateDiff(dataDate, runDate) : null;
  const base = {
    runDate,
    dataDate,
    dataAgeDays,
    strategyId: 'stock-meta-label-v1',
    paperOnly: true,
    submitToRealBroker: false
  };
  if (!report.passed) return saveAndReport(state, {
    ...base, status: 'BLOCKED', reason: '策略尚未通過研究門檻。'
  });
  if (!dataDate || dataAgeDays > MAX_DATA_AGE_DAYS) return saveAndReport(state, {
    ...base,
    status: 'SKIP',
    reason: `OHLCV 資料已過期 ${dataAgeDays ?? '未知'} 天，不使用歷史資料代替今日訊號。`
  });

  const config = report.folds?.at(-1)?.selectedConfig;
  if (!config) return saveAndReport(state, {
    ...base, status: 'BLOCKED', reason: '研究報告缺少可用的紙上交易設定。'
  });
  for (const position of state.positions) {
    position.targetPrice ||= position.entryPrice
      + (position.entryPrice - position.stopPrice) * config.rewardRisk;
  }
  settlePendingCash(state, dataDate || runDate);
  const pendingExecution = openMarketMap(state.pendingOrders, context, dataDate);
  const duePending = pendingExecution.due;
  const broker = createMockBroker({
    failureRate: 0.02,
    partialFillRate: 0.05,
    executionCosts: COSTS
  });
  const pendingResults = [];
  for (const item of duePending) {
    const result = broker.submitOrderIntent(
      item.intent,
      pendingExecution.market[item.intent.symbol],
      account(state, [])
    );
    pendingResults.push(result);
    applyFills(
      state,
      [result],
      [item.decision],
      item.executionDate,
      [],
      settlementDate(item.executionDate, tradingDates)
    );
  }
  const dueIntentIds = new Set(duePending.map(item => item.intent.intentId));
  state.pendingOrders = state.pendingOrders.filter(item => !dueIntentIds.has(item.intent.intentId));
  const trainingRows = (input.candidateTrades || []).filter(row =>
    stockOnly(row) && row.forwardPrices?.length >= 12
  );
  const model = fitModel(trainingRows, config, dataDate);
  const liveRows = buildLiveRows(context, dataDate)
    .filter(eligible)
    .map(row => ({ row, score: modelScore(row, model) }))
    .filter(item => item.score > -900)
    .sort((left, right) => right.score - left.score)
    .slice(0, config.maxEntriesPerDay);
  const requestedSymbols = [
    ...liveRows.map(({ row }) => `${row.symbol}.${marketSuffix(row.market)}`),
    ...state.positions.map(position => position.symbol)
  ];
  if (!requestedSymbols.length) return saveAndReport(state, {
    ...base, status: 'SKIP', reason: '沒有通過模型篩選的個股可查價。'
  });
  let quotes;
  try {
    quotes = await loadQuotes([...new Set(requestedSymbols)]);
  } catch (error) {
    return saveAndReport(state, { ...base, status: 'SKIP', reason: `即時報價取得失敗：${error.message}` });
  }
  if (!quotes.length) return saveAndReport(state, {
    ...base, status: 'SKIP', reason: '沒有可用即時報價。'
  });
  const byQuote = quoteMap(quotes);
  const pendingSymbols = new Set(state.pendingOrders.map(item => item.intent.symbol));
  const decisions = state.positions
    .map(position => positionDecision(
      position,
      byQuote.get(symbolKey(position.symbol)),
      dataDate,
      config
    ))
    .filter(decision => !pendingSymbols.has(decision.symbol));
  for (const { row } of liveRows) {
    const symbol = `${row.symbol}.${marketSuffix(row.market)}`;
    if (!state.positions.some(position => position.symbol === symbol)
      && !pendingSymbols.has(symbol)) {
      decisions.push(buyDecision(row, byQuote.get(row.symbol), model, config, dataDate));
    }
  }
  const accountSnapshot = account(state, quotes);
  let reservedCash = 0;
  const intents = [];
  for (const decision of decisions) {
    const [intent] = generateOrderIntents({
      decisions: [decision],
      account: {
        ...accountSnapshot,
        availableCash: Math.max(0, accountSnapshot.availableCash - reservedCash)
      },
      positions: state.positions,
      executionCosts: COSTS
    });
    if (!intent) continue;
    intents.push(intent);
    if (intent.side === 'BUY' && intent.status === 'PENDING_REVIEW') {
      reservedCash += buyExecution(
        decision.entryPlan.referencePrice,
        intent.quantity,
        COSTS
      ).total;
    }
  }
  const queued = intents
    .filter(intent => intent.status === 'PENDING_REVIEW')
    .map(intent => ({
      intent,
      decision: decisions.find(decision => decision.symbol === intent.symbol
        && decision.action === intent.action),
      signalDate: dataDate
    }))
    .filter(item => item.decision);
  state.pendingOrders.push(...queued);
  state.updatedAt = new Date().toISOString();
  state.status = 'OK';
  state.reason = '本次紙上交易執行成功，僅使用模擬成交。';
  const run = {
    ...base,
    actions: decisions.reduce((counts, decision) => ({
      ...counts,
      [decision.action]: (counts[decision.action] || 0) + 1
    }), {}),
    orderIntents: intents.length,
    brokerResults: pendingResults.length,
    queuedOrders: queued.length
  };
  recordRun(state, run);
  await fs.writeFile(STATE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  console.log(`紙上交易完成：${runDate}，資料日 ${dataDate}，訊號 ${decisions.length}，委託意圖 ${intents.length}，待執行 ${queued.length}，模擬成交結果 ${pendingResults.length}。`);
}

main().catch(error => {
  console.error(`紙上交易執行失敗：${error.message}`);
  process.exitCode = 1;
});
