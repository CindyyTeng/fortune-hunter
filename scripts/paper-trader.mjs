import { readFile, writeFile } from 'node:fs/promises';

const DATA_FILE = new URL('../data/recommendations.json', import.meta.url);
const STATE_FILE = new URL('../data/paper-trading-state.json', import.meta.url);
const LIVE_QUOTES_URL = process.env.PAPER_LIVE_URL || 'http://localhost:8787/quotes';
const QUOTE_SOURCE = process.env.PAPER_QUOTE_SOURCE || 'live';
const LOOP = process.argv.includes('--loop');
const LOOP_MS = Number(process.env.PAPER_LOOP_MS || 15000);

const INITIAL_CASH = Number(process.env.PAPER_INITIAL_CASH || 1000000);
const MAX_POSITION_PCT = Number(process.env.PAPER_MAX_POSITION_PCT || 10);
const MAX_DAILY_LOSS_PCT = Number(process.env.PAPER_MAX_DAILY_LOSS_PCT || 2);
const BUY_SLIPPAGE_PCT = Number(process.env.PAPER_BUY_SLIPPAGE_PCT || 0.15);
const SELL_SLIPPAGE_PCT = Number(process.env.PAPER_SELL_SLIPPAGE_PCT || 0.15);
const BREAKOUT_BUFFER_PCT = Number(process.env.PAPER_BREAKOUT_BUFFER_PCT || 0.5);
const MAX_GAP_UP_PCT = Number(process.env.PAPER_MAX_GAP_UP_PCT || 8);
const MIN_STD20 = Number(process.env.PAPER_MIN_STD20 || 0.02);
const MAX_EVENTS = Number(process.env.PAPER_MAX_EVENTS || 500);

const BUY_SIGNAL = '\u8cb7\u5165\u5019\u9078';
const SELL_WARNING_NONE = '\u7121';
const MARKET_OTC = '\u4e0a\u6ac3';

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function moneyNumbersFrom(text) {
  return [...String(text || '').matchAll(/NT\$\s*([\d.]+)/g)].map(match => Number(match[1]));
}

function readHoldDays(recommendation) {
  return Number(String(recommendation.plan?.horizon || '').match(/\d+/)?.[0] || 7);
}

function readStop(recommendation) {
  const [stop] = moneyNumbersFrom(recommendation.plan?.stopLoss);
  if (stop) return stop;
  const stopPct = recommendation.metrics?.stopPct;
  if (stopPct && recommendation.latestPrice) return recommendation.latestPrice * (1 - stopPct / 100);
  return null;
}

function toSymbol(recommendation) {
  const suffix = recommendation.market === MARKET_OTC ? 'TWO' : 'TW';
  return `${recommendation.code}.${suffix}`;
}

async function readJsonOrNull(url) {
  try {
    return JSON.parse(await readFile(url, 'utf8'));
  } catch {
    return null;
  }
}

function initialState() {
  return {
    version: 1,
    mode: 'paper',
    strategy: 'close-pick -> next-day resistance breakout -> fixed hold',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    initialCash: INITIAL_CASH,
    cash: INITIAL_CASH,
    positions: [],
    orders: [],
    events: [],
    daily: {
      date: todayKey(),
      startEquity: INITIAL_CASH,
      blocked: false
    },
    settings: settings()
  };
}

function settings() {
  return {
    liveQuotesUrl: LIVE_QUOTES_URL,
    quoteSource: QUOTE_SOURCE,
    maxPositionPct: MAX_POSITION_PCT,
    maxDailyLossPct: MAX_DAILY_LOSS_PCT,
    buySlippagePct: BUY_SLIPPAGE_PCT,
    sellSlippagePct: SELL_SLIPPAGE_PCT,
    breakoutBufferPct: BREAKOUT_BUFFER_PCT,
    maxGapUpPct: MAX_GAP_UP_PCT,
    minStd20: MIN_STD20
  };
}

function event(state, type, message, extra = {}) {
  state.events.push({
    at: new Date().toISOString(),
    type,
    message,
    ...extra
  });
  state.events = state.events.slice(-MAX_EVENTS);
}

function quoteMap(quotes) {
  return new Map((quotes || []).map(quote => [String(quote.symbol || '').toUpperCase(), quote]));
}

async function loadRecommendations() {
  const data = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  return data.recommendations || [];
}

async function loadState() {
  const existing = await readJsonOrNull(STATE_FILE);
  if (!existing) return initialState();
  return {
    ...initialState(),
    ...existing,
    settings: settings(),
    positions: existing.positions || [],
    orders: existing.orders || [],
    events: existing.events || []
  };
}

async function fetchLiveQuotes() {
  const response = await fetch(LIVE_QUOTES_URL, {
    headers: { 'user-agent': 'fortune-hunter-paper-trader/1.0' }
  });
  if (!response.ok) throw new Error(`live quotes HTTP ${response.status}`);
  const payload = await response.json();
  return payload.quotes || [];
}

function snapshotQuotes(recommendations) {
  return recommendations.map(item => ({
    symbol: toSymbol(item),
    name: item.name,
    price: item.latestPrice,
    changePercent: null,
    ts: Date.parse(`${item.latestDate}T13:30:00+08:00`) || Date.now()
  })).filter(item => Number.isFinite(item.price));
}

async function getQuotes(recommendations) {
  if (QUOTE_SOURCE === 'snapshot') return snapshotQuotes(recommendations);
  try {
    return await fetchLiveQuotes();
  } catch (error) {
    if (QUOTE_SOURCE === 'live-only') throw error;
    return snapshotQuotes(recommendations);
  }
}

function equity(state, quotesBySymbol) {
  const positionValue = state.positions.reduce((sum, position) => {
    const quote = quotesBySymbol.get(position.symbol);
    const price = quote?.price || position.lastPrice || position.entryPrice;
    return sum + position.quantity * price;
  }, 0);
  return state.cash + positionValue;
}

function resetDailyIfNeeded(state, quotesBySymbol) {
  const date = todayKey();
  if (state.daily?.date === date) return;
  state.daily = {
    date,
    startEquity: equity(state, quotesBySymbol),
    blocked: false
  };
  event(state, 'daily-reset', '新交易日開始，重設單日風控基準。');
}

function updateDailyLossBlock(state, quotesBySymbol) {
  const currentEquity = equity(state, quotesBySymbol);
  const lossPct = state.daily?.startEquity ? ((currentEquity - state.daily.startEquity) / state.daily.startEquity) * 100 : 0;
  if (lossPct <= -MAX_DAILY_LOSS_PCT) {
    if (!state.daily.blocked) {
      event(state, 'risk-block', `單日虧損達 ${round(lossPct)}%，停止新增進場。`);
    }
    state.daily.blocked = true;
  }
}

function hasOpenPosition(state, symbol) {
  return state.positions.some(position => position.symbol === symbol);
}

function alreadyEnteredToday(state, symbol) {
  const date = todayKey();
  return state.orders.some(order => order.symbol === symbol && order.side === 'buy' && order.date === date);
}

function isCandidate(item) {
  return item.signal === BUY_SIGNAL
    && item.sellWarning?.level === SELL_WARNING_NONE
    && Number(item.metrics?.resistance) > 0
    && Number(item.metrics?.std20) >= MIN_STD20;
}

function canEnter(item, quote, state) {
  if (!isCandidate(item)) return { ok: false, reason: '不是符合條件的買入候選。' };
  if (!quote?.price) return { ok: false, reason: '沒有即時價格。' };
  if (state.daily?.blocked) return { ok: false, reason: '已觸發單日最大虧損限制。' };

  const symbol = toSymbol(item);
  if (hasOpenPosition(state, symbol)) return { ok: false, reason: '已有持倉。' };
  if (alreadyEnteredToday(state, symbol)) return { ok: false, reason: '今日已模擬進場過。' };

  const resistance = Number(item.metrics.resistance);
  const trigger = resistance * (1 + BREAKOUT_BUFFER_PCT / 100);
  if (quote.price < trigger) return { ok: false, reason: `尚未突破壓力價 ${round(trigger)}。` };
  if (quote.changePercent !== null && quote.changePercent > MAX_GAP_UP_PCT) {
    return { ok: false, reason: `漲幅 ${quote.changePercent}% 超過追價上限。` };
  }

  return { ok: true, trigger };
}

function buy(item, quote, state, trigger) {
  const symbol = toSymbol(item);
  const entryPrice = quote.price * (1 + BUY_SLIPPAGE_PCT / 100);
  const budget = Math.min(state.cash, state.initialCash * (MAX_POSITION_PCT / 100));
  const quantity = Math.floor(budget / entryPrice);
  if (quantity <= 0) {
    event(state, 'skip-buy', '現金不足，無法建立模擬部位。', { symbol });
    return;
  }

  const cost = quantity * entryPrice;
  const stop = readStop(item);
  const holdDays = readHoldDays(item);
  state.cash = round(state.cash - cost, 2);
  state.positions.push({
    symbol,
    code: item.code,
    name: item.name,
    market: item.market,
    quantity,
    entryPrice: round(entryPrice, 2),
    entryDate: todayKey(),
    entryAt: new Date().toISOString(),
    lastPrice: quote.price,
    stop: stop ? round(stop, 2) : null,
    resistance: item.metrics.resistance,
    trigger: round(trigger, 2),
    holdDays,
    signalScore: item.score
  });
  state.orders.push({
    date: todayKey(),
    at: new Date().toISOString(),
    side: 'buy',
    symbol,
    quantity,
    price: round(entryPrice, 2),
    reason: '突破壓力進場'
  });
  event(state, 'buy', `模擬買進 ${item.name} ${quantity} 股，價格 ${round(entryPrice, 2)}。`, { symbol });
}

function daysHeld(position) {
  const start = Date.parse(`${position.entryDate}T00:00:00+08:00`);
  if (!Number.isFinite(start)) return 0;
  return Math.floor((Date.now() - start) / 86400000);
}

function sell(position, quote, state, reason) {
  const exitPrice = (quote?.price || position.lastPrice || position.entryPrice) * (1 - SELL_SLIPPAGE_PCT / 100);
  const proceeds = position.quantity * exitPrice;
  const pnl = (exitPrice - position.entryPrice) * position.quantity;
  state.cash = round(state.cash + proceeds, 2);
  state.positions = state.positions.filter(item => item.symbol !== position.symbol);
  state.orders.push({
    date: todayKey(),
    at: new Date().toISOString(),
    side: 'sell',
    symbol: position.symbol,
    quantity: position.quantity,
    price: round(exitPrice, 2),
    pnl: round(pnl, 2),
    reason
  });
  event(state, 'sell', `模擬賣出 ${position.name} ${position.quantity} 股，原因：${reason}。`, {
    symbol: position.symbol,
    pnl: round(pnl, 2)
  });
}

function manageExits(state, quotesBySymbol) {
  for (const position of [...state.positions]) {
    const quote = quotesBySymbol.get(position.symbol);
    if (quote?.price) position.lastPrice = quote.price;

    const currentPrice = quote?.price || position.lastPrice;
    if (!currentPrice) continue;

    if (position.stop && currentPrice <= position.stop) {
      sell(position, quote, state, '跌破停損');
      continue;
    }

    if (daysHeld(position) >= position.holdDays) {
      sell(position, quote, state, '固定持有期到期');
    }
  }
}

function scanEntries(state, recommendations, quotesBySymbol) {
  for (const item of recommendations) {
    const symbol = toSymbol(item);
    const quote = quotesBySymbol.get(symbol);
    const decision = canEnter(item, quote, state);
    if (decision.ok) {
      buy(item, quote, state, decision.trigger);
    } else if (isCandidate(item)) {
      event(state, 'watch', `${item.name} 觀察中：${decision.reason}`, { symbol });
    }
  }
}

async function runOnce() {
  const recommendations = await loadRecommendations();
  const state = await loadState();
  const quotes = await getQuotes(recommendations);
  const quotesBySymbol = quoteMap(quotes);

  resetDailyIfNeeded(state, quotesBySymbol);
  manageExits(state, quotesBySymbol);
  updateDailyLossBlock(state, quotesBySymbol);
  scanEntries(state, recommendations, quotesBySymbol);
  updateDailyLossBlock(state, quotesBySymbol);

  state.updatedAt = new Date().toISOString();
  state.lastRun = {
    at: state.updatedAt,
    quoteSource: QUOTE_SOURCE,
    quoteCount: quotes.length,
    equity: round(equity(state, quotesBySymbol), 2),
    cash: state.cash,
    positions: state.positions.length
  };

  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(state.lastRun, null, 2));
}

async function main() {
  await runOnce();
  if (!LOOP) return;
  setInterval(() => {
    runOnce().catch(error => {
      console.error(error);
    });
  }, LOOP_MS);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
