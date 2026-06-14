import { readFile, writeFile } from 'node:fs/promises';
import {
  buyExecution as sharedBuyExecution,
  sellExecution as sharedSellExecution,
  simulateEntry,
  simulateExit,
  trailingStopPrice
} from './lib/execution-simulator.mjs';

const DATA_FILE = new URL('../data/recommendations.json', import.meta.url);
const STATE_FILE = new URL('../data/paper-trading-state.json', import.meta.url);
const LIVE_QUOTES_URL = process.env.PAPER_LIVE_URL || 'http://localhost:8787/quotes';
const QUOTE_SOURCE = process.env.PAPER_QUOTE_SOURCE || 'live';
const LOOP = process.argv.includes('--loop');
const LOOP_MS = Number(process.env.PAPER_LOOP_MS || 15000);

const INITIAL_CASH = Number(process.env.PAPER_INITIAL_CASH || 1000000);
const STANDARD_POSITION_PCT = Number(process.env.PAPER_STANDARD_POSITION_PCT || 44);
const DEFENSIVE_POSITION_PCT = Number(process.env.PAPER_DEFENSIVE_POSITION_PCT || 20);
const EXPLORATORY_POSITION_PCT = Number(process.env.PAPER_EXPLORATORY_POSITION_PCT || 20);
const ACCOUNT_RISK_CAP_PCT = Number(process.env.PAPER_ACCOUNT_RISK_CAP_PCT || 2);
const MAX_DAILY_LOSS_PCT = Number(process.env.PAPER_MAX_DAILY_LOSS_PCT || 2);
const BUY_SLIPPAGE_PCT = Number(process.env.PAPER_BUY_SLIPPAGE_PCT || 0.15);
const SELL_SLIPPAGE_PCT = Number(process.env.PAPER_SELL_SLIPPAGE_PCT || 0.15);
const BREAKOUT_BUFFER_PCT = Number(process.env.PAPER_BREAKOUT_BUFFER_PCT || 0.5);
const MAX_GAP_UP_PCT = Number(process.env.PAPER_MAX_GAP_UP_PCT || 8);
const MIN_STD20 = Number(process.env.PAPER_MIN_STD20 || 0.02);
const MIN_AVG20_TRADE_VALUE = Number(process.env.PAPER_MIN_AVG20_TRADE_VALUE || 100000000);
const TRAIL_TRIGGER_PCT = Number(process.env.PAPER_TRAIL_TRIGGER_PCT || 3);
const TRAIL_GIVEBACK_PCT = Number(process.env.PAPER_TRAIL_GIVEBACK_PCT || 5);
const TRAIL_LOCK_PCT = Number(process.env.PAPER_TRAIL_LOCK_PCT || 1);
const MAX_EVENTS = Number(process.env.PAPER_MAX_EVENTS || 500);
const MAX_OPEN_POSITIONS = Number(process.env.PAPER_MAX_OPEN_POSITIONS || 4);
const MAX_QUOTE_AGE_MS = Number(process.env.PAPER_MAX_QUOTE_AGE_MS || 90000);
const MARKET_SHOCK_PCT = Number(process.env.PAPER_MARKET_SHOCK_PCT || -4);
const MAX_ACCOUNT_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_ACCOUNT_DRAWDOWN_PCT || 10);
const ALLOW_OUTSIDE_MARKET = process.env.PAPER_ALLOW_OUTSIDE_MARKET === 'true';
const EMERGENCY_STOP = process.env.PAPER_EMERGENCY_STOP === 'true';

const BUY_SIGNAL = '\u8cb7\u5165\u5019\u9078';
const WATCH_SIGNAL = '\u504f\u591a\u89c0\u5bdf';
const SELL_WARNING_NONE = '\u7121';
const MARKET_OTC = '\u4e0a\u6ac3';
const BUY_CONFIRMATIONS = Number(process.env.PAPER_BUY_CONFIRMATIONS || 2);
const EXPLORATION_CONFIRMATIONS = Number(process.env.PAPER_EXPLORATION_CONFIRMATIONS || 4);

function todayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
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
    system: {
      degraded: false,
      marketShock: false,
      emergencyStop: false,
      entryBlockedReason: null
    },
    settings: settings()
  };
}

function settings() {
  return {
    liveQuotesUrl: LIVE_QUOTES_URL,
    quoteSource: QUOTE_SOURCE,
    standardPositionPct: STANDARD_POSITION_PCT,
    defensivePositionPct: DEFENSIVE_POSITION_PCT,
    exploratoryPositionPct: EXPLORATORY_POSITION_PCT,
    accountRiskCapPct: ACCOUNT_RISK_CAP_PCT,
    maxDailyLossPct: MAX_DAILY_LOSS_PCT,
    buySlippagePct: BUY_SLIPPAGE_PCT,
    sellSlippagePct: SELL_SLIPPAGE_PCT,
    breakoutBufferPct: BREAKOUT_BUFFER_PCT,
    maxGapUpPct: MAX_GAP_UP_PCT,
    minStd20: MIN_STD20
    ,
    maxOpenPositions: MAX_OPEN_POSITIONS,
    maxQuoteAgeMs: MAX_QUOTE_AGE_MS,
    marketShockPct: MARKET_SHOCK_PCT,
    maxAccountDrawdownPct: MAX_ACCOUNT_DRAWDOWN_PCT
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
  if (QUOTE_SOURCE === 'snapshot') {
    return { quotes: snapshotQuotes(recommendations), degraded: true, source: 'snapshot' };
  }
  try {
    return { quotes: await fetchLiveQuotes(), degraded: false, source: 'live' };
  } catch (error) {
    if (QUOTE_SOURCE === 'live-only') throw error;
    return {
      quotes: snapshotQuotes(recommendations),
      degraded: true,
      source: 'snapshot-fallback',
      error: error.message
    };
  }
}

function isMarketSession(date = new Date()) {
  if (ALLOW_OUTSIDE_MARKET) return true;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).map(part => [part.type, part.value]));
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 9 * 60 && minutes <= 13 * 60 + 30;
}

function quoteIsFresh(quote) {
  return Number.isFinite(Number(quote?.ts))
    && Date.now() - Number(quote.ts) <= MAX_QUOTE_AGE_MS
    && Number(quote.ts) <= Date.now() + 10000;
}

function updateSystemRisk(state, quotes, degraded, quotesBySymbol) {
  const changes = quotes.map(quote => Number(quote.changePercent)).filter(Number.isFinite).sort((a, b) => a - b);
  const middle = Math.floor(changes.length / 2);
  const medianChange = changes.length
    ? changes.length % 2 ? changes[middle] : (changes[middle - 1] + changes[middle]) / 2
    : null;
  const currentEquity = equity(state, quotesBySymbol);
  const drawdownPct = (currentEquity / state.initialCash - 1) * 100;
  const marketShock = medianChange !== null && medianChange <= MARKET_SHOCK_PCT;
  const reasons = [];
  if (EMERGENCY_STOP) reasons.push('人工緊急停止已啟用');
  if (degraded) reasons.push('即時報價失敗，已降級為舊快照');
  if (!isMarketSession()) reasons.push('目前不在台股交易時段');
  if (marketShock) reasons.push(`候選股漲跌幅中位數 ${round(medianChange)}% 達市場急跌門檻`);
  if (drawdownPct <= -MAX_ACCOUNT_DRAWDOWN_PCT) reasons.push(`帳戶回撤 ${round(drawdownPct)}% 達停止門檻`);
  state.system = {
    degraded,
    marketShock,
    emergencyStop: EMERGENCY_STOP,
    medianChangePct: round(medianChange),
    accountDrawdownPct: round(drawdownPct),
    entryBlockedReason: reasons.join('；') || null
  };
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

function explorationConfirmations(item, quote) {
  const atLeast = (value, minimum) => Number.isFinite(Number(value))
    && value !== null
    && Number(value) >= minimum;
  return [
    atLeast(item.marketFlow?.marketMove, 0.25),
    atLeast(item.marketFlow?.themeMove, 0.25),
    atLeast(item.overnight?.globalComposite, 0),
    atLeast(item.overnight?.asiaComposite, 0),
    atLeast(quote?.changePercent, 0.5)
  ].filter(Boolean).length;
}

function isCandidate(item, quote) {
  const confirmations = explorationConfirmations(item, quote);
  const signalPass = item.signal === BUY_SIGNAL
    ? confirmations >= BUY_CONFIRMATIONS
    : item.signal === WATCH_SIGNAL && confirmations >= EXPLORATION_CONFIRMATIONS;
  return signalPass
    && item.sellWarning?.level === SELL_WARNING_NONE
    && Number(item.metrics?.resistance) > 0
    && Number(item.metrics?.std20) >= MIN_STD20
    && Number(item.metrics?.avg20TradeValue) >= MIN_AVG20_TRADE_VALUE;
}

function canEnter(item, quote, state) {
  if (!isCandidate(item, quote)) {
    const confirmations = explorationConfirmations(item, quote);
    const required = item.signal === BUY_SIGNAL ? BUY_CONFIRMATIONS : EXPLORATION_CONFIRMATIONS;
    const reason = item.signal === WATCH_SIGNAL || item.signal === BUY_SIGNAL
      ? `${item.signal}確認 ${confirmations}/5，未達 ${required} 項，維持現金。`
      : '不是符合條件的買入候選。';
    return { ok: false, reason };
  }
  if (!quote?.price) return { ok: false, reason: '沒有即時價格。' };
  if (state.system?.entryBlockedReason) return { ok: false, reason: state.system.entryBlockedReason };
  if (!quoteIsFresh(quote)) return { ok: false, reason: '即時報價已過期或時間異常。' };
  if (state.daily?.blocked) return { ok: false, reason: '已觸發單日最大虧損限制。' };
  if (state.positions.length >= MAX_OPEN_POSITIONS) return { ok: false, reason: '已達最大持倉檔數。' };

  const symbol = toSymbol(item);
  if (hasOpenPosition(state, symbol)) return { ok: false, reason: '已有持倉。' };
  if (alreadyEnteredToday(state, symbol)) return { ok: false, reason: '今日已模擬進場過。' };

  const resistance = Number(item.metrics.resistance);
  const trigger = resistance * (1 + BREAKOUT_BUFFER_PCT / 100);
  if (quote.price < trigger) return { ok: false, reason: `尚未突破壓力價 ${round(trigger)}。` };
  if (quote.changePercent !== null && quote.changePercent > MAX_GAP_UP_PCT) {
    return { ok: false, reason: `漲幅 ${quote.changePercent}% 超過追價上限。` };
  }
  if (quote.changePercent !== null && quote.changePercent < 0) {
    return { ok: false, reason: '隔日負跳空，缺乏突破確認，暫不進場。' };
  }

  return { ok: true, trigger };
}

function plannedPositionPct(item) {
  if (item.signal === WATCH_SIGNAL) return EXPLORATORY_POSITION_PCT;
  if (item.metrics?.strictRisk) return DEFENSIVE_POSITION_PCT;
  return STANDARD_POSITION_PCT;
}

function buy(item, quote, state, trigger, accountEquity) {
  const symbol = toSymbol(item);
  const fill = simulateEntry({
    mode: 'resistance_breakout',
    signalDay: { close: item.latestPrice },
    nextDay: { open: quote.price, high: quote.price, low: quote.price, close: quote.price },
    triggerPrice: trigger
  });
  if (!fill) return;
  const entryPrice = sharedBuyExecution(fill.price, 1, {
    buyFeePct: 0,
    buySlippagePct: BUY_SLIPPAGE_PCT,
    minimumFee: 0
  }).fillPrice;
  const stop = readStop(item);
  const stopDistancePct = stop ? ((entryPrice - stop) / entryPrice) * 100 : null;
  if (!Number.isFinite(stopDistancePct) || stopDistancePct <= 0) {
    event(state, 'skip-buy', '停損價無效，無法計算單筆風險，因此維持現金。', { symbol });
    return;
  }
  const plannedPct = plannedPositionPct(item);
  const positionPct = Math.min(plannedPct, ACCOUNT_RISK_CAP_PCT * 100 / stopDistancePct);
  const budget = Math.min(state.cash, accountEquity * (positionPct / 100));
  const quantity = Math.floor(budget / entryPrice);
  if (quantity <= 0) {
    event(state, 'skip-buy', '現金不足，無法建立模擬部位。', { symbol });
    return;
  }

  const cost = quantity * entryPrice;
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
    signalScore: item.score,
    plannedPositionPct: plannedPct,
    positionPct: round(positionPct),
    accountRiskPct: round(positionPct * stopDistancePct / 100),
    peakReturnPct: 0
  });
  state.orders.push({
    idempotencyKey: `buy:${todayKey()}:${symbol}`,
    date: todayKey(),
    at: new Date().toISOString(),
    side: 'buy',
    symbol,
    quantity,
    price: round(entryPrice, 2),
    reason: '突破壓力進場'
  });
  event(
    state,
    'buy',
    `模擬買進 ${item.name} ${quantity} 股，價格 ${round(entryPrice, 2)}，實際部位 ${round(positionPct)}%，停損風險不超過帳戶 ${ACCOUNT_RISK_CAP_PCT}%。`,
    { symbol }
  );
}

function daysHeld(position) {
  const start = Date.parse(`${position.entryDate}T00:00:00+08:00`);
  if (!Number.isFinite(start)) return 0;
  return Math.floor((Date.now() - start) / 86400000);
}

function sell(position, quote, state, reason) {
  const exitPrice = sharedSellExecution(
    quote?.price || position.lastPrice || position.entryPrice,
    position.quantity,
    {
      sellFeePct: 0,
      sellTaxPct: 0,
      sellSlippagePct: SELL_SLIPPAGE_PCT,
      minimumFee: 0
    }
  ).fillPrice;
  const proceeds = position.quantity * exitPrice;
  const pnl = (exitPrice - position.entryPrice) * position.quantity;
  state.cash = round(state.cash + proceeds, 2);
  state.positions = state.positions.filter(item => item.symbol !== position.symbol);
  state.orders.push({
    idempotencyKey: `sell:${todayKey()}:${position.symbol}:${reason}`,
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

    const trailingStop = trailingStopPrice(
      position.entryPrice,
      position.entryPrice * (1 + (position.peakReturnPct || 0) / 100),
      {
        triggerPct: TRAIL_TRIGGER_PCT,
        givebackPct: TRAIL_GIVEBACK_PCT,
        lockPct: TRAIL_LOCK_PCT
      }
    );
    const executionExit = simulateExit({
      day: { open: currentPrice, high: currentPrice, low: currentPrice, close: currentPrice },
      stopLoss: position.stop,
      trailingStop
    });
    if (executionExit?.type === 'stop_loss') {
      sell(position, { ...quote, price: executionExit.price }, state, '跌破停損');
      continue;
    }

    const currentReturnPct = (currentPrice / position.entryPrice - 1) * 100;
    position.peakReturnPct = Math.max(position.peakReturnPct || 0, currentReturnPct);
    if (executionExit?.type === 'trailing_stop') {
      sell(position, { ...quote, price: executionExit.price }, state, '移動停利');
      continue;
    }

    if (daysHeld(position) >= position.holdDays) {
      sell(position, quote, state, '固定持有期到期');
    }
  }
}

function scanEntries(state, recommendations, quotesBySymbol) {
  const ordered = [...recommendations].sort((a, b) => {
    const quoteA = quotesBySymbol.get(toSymbol(a));
    const quoteB = quotesBySymbol.get(toSymbol(b));
    return (Number(quoteB?.changePercent) || 0) - (Number(quoteA?.changePercent) || 0)
      || b.score - a.score;
  });
  for (const item of ordered) {
    const symbol = toSymbol(item);
    const quote = quotesBySymbol.get(symbol);
    const decision = canEnter(item, quote, state);
    if (decision.ok) {
      buy(item, quote, state, decision.trigger, equity(state, quotesBySymbol));
    } else if (isCandidate(item, quote) || item.signal === WATCH_SIGNAL) {
      event(state, 'watch', `${item.name} 觀察中：${decision.reason}`, { symbol });
    }
  }
}

async function runOnce() {
  const recommendations = await loadRecommendations();
  const state = await loadState();
  const quoteResult = await getQuotes(recommendations);
  const quotes = quoteResult.quotes;
  const quotesBySymbol = quoteMap(quotes);

  resetDailyIfNeeded(state, quotesBySymbol);
  updateSystemRisk(state, quotes, quoteResult.degraded, quotesBySymbol);
  if (!quoteResult.degraded) manageExits(state, quotesBySymbol);
  updateDailyLossBlock(state, quotesBySymbol);
  scanEntries(state, recommendations, quotesBySymbol);
  updateDailyLossBlock(state, quotesBySymbol);

  state.updatedAt = new Date().toISOString();
  state.lastRun = {
    at: state.updatedAt,
    quoteSource: quoteResult.source,
    degraded: quoteResult.degraded,
    entryBlockedReason: state.system.entryBlockedReason,
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
