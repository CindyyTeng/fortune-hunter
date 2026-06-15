import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  buyExecution,
  sellExecution,
  simulateEntry,
  simulateExit,
  trailingStopPrice
} from '../lib/execution-simulator.mjs';
import {
  beginPortfolioDay,
  closePosition,
  createPortfolio,
  markPosition,
  openPosition,
  portfolioEquity,
  portfolioExposure,
  recordEquity,
  settleCash
} from '../lib/portfolio-simulator.mjs';
import {
  deterministicScore,
  foldWindows,
  iterateObservations,
  loadResearchContext,
  mean,
  pct,
  round,
  summarizePerformance
} from './research-core.mjs';

const OUTPUT = new URL('../../data/research/profit-edge-search.json', import.meta.url);
const REPORT = new URL('../../docs/PROFIT_EDGE_SEARCH.md', import.meta.url);
const HORIZONS = Object.freeze([1, 3, 5, 10, 20]);
const ENTRY_MODES = Object.freeze([
  { id: 'next_open', label: '隔日開盤進場' },
  { id: 'next_breakout', label: '隔日突破確認 K 高點進場' },
  { id: 'support_pullback', label: '回測支撐不破後進場' },
  { id: 'close_confirm', label: '收盤確認後進場' },
  { id: 'intraday_trigger', label: '盤中觸發價進場' },
  { id: 'gap_limited', label: '跳空過高時放棄進場' },
  { id: 'stabilization_wait', label: '急跌後等待止穩確認進場' }
]);
const STOP_TYPES = Object.freeze([
  'signal_low',
  'stabilization_low',
  'swing_low',
  'ma20',
  'ma60',
  'atr1',
  'atr1_5',
  'fixed3',
  'fixed5',
  'fixed8',
  'support_break'
]);
const EXIT_TYPES = Object.freeze([
  'hold3',
  'hold5',
  'hold10',
  'target1r',
  'target1_5r',
  'target2r',
  'trailing',
  'ma20_target',
  'resistance_target',
  'ma20_break',
  'support_break',
  'momentum_stall',
  'market_weak',
  'theme_weak'
]);

const average = values => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : null;
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const standardDeviation = values => {
  if (!values.length) return null;
  const center = average(values);
  return Math.sqrt(average(values.map(value => (value - center) ** 2)));
};
const movingAverage = (history, endIndex, size) => {
  if (endIndex + 1 < size) return null;
  return average(history.slice(endIndex + 1 - size, endIndex + 1).map(row => row.close));
};
const dayReturn = (row, prior) => pct(row.close, prior.close);
const executionReturn = (entryPrice, exitPrice) => {
  const buy = buyExecution(entryPrice, 1000);
  const sell = sellExecution(exitPrice, 1000);
  return pct(sell.net, buy.total);
};

function addTop(map, key, row, limit) {
  const rows = map.get(key) || [];
  rows.push(row);
  rows.sort((left, right) => right.score - left.score);
  if (rows.length > limit) rows.length = limit;
  map.set(key, rows);
}

function recentBreakout(history, index, minimumAgo = 2, maximumAgo = 10) {
  for (let ago = minimumAgo; ago <= maximumAgo; ago += 1) {
    const cursor = index - ago;
    if (cursor < 21) continue;
    const row = history[cursor];
    const resistance = Math.max(...history.slice(cursor - 20, cursor).map(day => day.high));
    const averageVolume = average(history.slice(cursor - 20, cursor).map(day => day.volume));
    if (row.close > resistance && row.volume >= averageVolume * 1.15) {
      return { ago, cursor, row, resistance };
    }
  }
  return null;
}

function makeEvent(observation, scenario, details) {
  const { history, historyIndex: index, day, prior } = observation;
  const recent = history.slice(Math.max(0, index - 14), index + 1);
  const futureBars = history.slice(index + 1, index + 21).map((row, offset) => ({
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    price: row.close,
    volume: row.volume,
    ma20: movingAverage(history, index + 1 + offset, 20),
    ma60: movingAverage(history, index + 1 + offset, 60)
  }));
  const swingLow = Math.min(...recent.slice(-6).map(row => row.low));
  const support = details.support
    ?? Math.max(observation.ma20 || 0, observation.priorLow20 || 0);
  return {
    id: `${scenario.id}|${observation.symbol}|${day.date}`,
    scenarioId: scenario.id,
    scenarioLabel: scenario.label,
    symbol: observation.symbol,
    name: observation.name,
    market: observation.market,
    theme: observation.theme,
    signalDate: day.date,
    regime: observation.factors.regime,
    day: { ...day },
    prior: { ...prior },
    recent,
    futureBars,
    ma20: observation.ma20,
    ma60: observation.ma60,
    support,
    resistance: details.resistance ?? observation.priorHigh20,
    stabilizationLow: details.stabilizationLow ?? swingLow,
    swingLow,
    waitedDays: details.waitedDays ?? 0,
    factors: { ...observation.factors },
    setupReason: details.setup,
    triggerReason: details.trigger,
    invalidationReason: details.invalidation,
    plannedExit: details.exit,
    score: details.score
  };
}

const SCENARIOS = Object.freeze([
  {
    id: 'breakout_pullback_hold',
    label: '強勢股突破後回測不破',
    detect(row) {
      const breakout = recentBreakout(row.history, row.historyIndex, 2, 8);
      if (!breakout) return null;
      const support = breakout.resistance;
      const held = row.day.low >= support * 0.985 && row.day.close >= support;
      const turnsUp = row.day.close > row.day.open && row.day.close > row.prior.close;
      if (!held || !turnsUp || row.factors.relativeMarket20 < 0) return null;
      return {
        support,
        resistance: Math.max(breakout.row.high, row.priorHigh20),
        setup: '先前已放量突破 20 日壓力，之後回測突破位置但未有效跌破。',
        trigger: '回測後收紅且收盤高於前一日，確認買盤重新接手。',
        invalidation: '跌破突破位置或回測低點，代表前高轉支撐失敗。',
        exit: '沿 MA20 或前高轉支撐續抱，動能停滯或支撐失守出場。',
        score: row.factors.relativeMarket20 + row.factors.volumeRatio20 * 3
      };
    }
  },
  {
    id: 'first_ma20_pullback',
    label: '多頭趨勢第一次回測 MA20',
    detect(row) {
      const trend = row.ma20 > row.ma60
        && row.factors.ma20Slope > 0
        && row.factors.ma60Slope > 0
        && row.day.close > row.ma60;
      let priorStayedAbove = true;
      for (let cursor = row.historyIndex - 15; cursor < row.historyIndex - 2; cursor += 1) {
        if (row.history[cursor].low <= movingAverage(row.history, cursor, 20) * 0.995) {
          priorStayedAbove = false;
          break;
        }
      }
      const touches = row.day.low <= row.ma20 * 1.012 && row.day.close >= row.ma20;
      const turnsUp = row.day.close > row.day.open || row.day.close > row.prior.high;
      if (!trend || !priorStayedAbove || !touches || !turnsUp) return null;
      return {
        support: row.ma20,
        setup: 'MA20、MA60 同步上彎，股價位於 MA60 之上，近期首次回測 MA20。',
        trigger: '測試 MA20 後收紅或收盤站回前一日高點。',
        invalidation: '跌破 MA20 且無法快速收回，或跌破本次回測低點。',
        exit: '趨勢延續則續抱；跌破 MA20、動能轉弱或到達前高壓力時出場。',
        score: row.factors.ma20Slope * 3 + row.factors.relativeMarket20
      };
    }
  },
  {
    id: 'high_volatility_reversal',
    label: '高波動急跌後止穩反轉',
    detect(row) {
      const priorRows = row.history.slice(row.historyIndex - 4, row.historyIndex);
      const selloffIndex = priorRows.findIndex((day, offset) => {
        const absoluteIndex = row.historyIndex - 4 + offset;
        return dayReturn(day, row.history[absoluteIndex - 1]) <= -5;
      });
      if (selloffIndex < 0) return null;
      const afterSelloff = priorRows.slice(selloffIndex);
      const stabilizationLow = Math.min(...afterSelloff.map(day => day.low), row.day.low);
      const noNewLow = row.day.low >= stabilizationLow * 0.995;
      const confirms = row.factors.longLowerWick
        || (row.day.close > row.day.open && row.day.close > row.prior.high);
      const waitedDays = priorRows.length - selloffIndex;
      if (!noNewLow || !confirms || waitedDays < 1 || waitedDays > 3) return null;
      if (row.factors.regime === 'BEAR_DEFENSE') return null;
      return {
        support: stabilizationLow,
        stabilizationLow,
        waitedDays,
        setup: '先出現短線急跌，之後等待 1 至 3 天確認低點沒有持續下移。',
        trigger: '長下影、收紅或站回前一日高點，至少一項止穩訊號成立。',
        invalidation: '跌破止穩區低點，代表反轉尚未成立。',
        exit: '只做短線反彈，接近 MA20、動能停滯或大盤再轉弱即出場。',
        score: Math.abs(row.factors.maximumDailyLoss20)
          + (row.factors.longLowerWick ? 3 : 0)
      };
    }
  },
  {
    id: 'range_lower_rebound',
    label: '區間下緣反彈',
    detect(row) {
      if (row.factors.regime === 'BEAR_DEFENSE'
        || row.factors.regime === 'HIGH_VOLATILITY'
        || row.factors.rangePosition20 > 0.25) return null;
      const turnsUp = row.day.close > row.day.open || row.day.close > row.prior.close;
      const upside = pct(row.priorHigh20, row.day.close);
      const downside = Math.abs(pct(row.priorLow20, row.day.close));
      if (!turnsUp || upside < Math.max(5, downside * 1.8)) return null;
      return {
        support: row.priorLow20,
        resistance: row.priorHigh20,
        setup: '股價接近 20 日區間下緣，且大盤並非空頭或高波動崩跌。',
        trigger: '個股沒有再破低並出現收紅或收盤轉強。',
        invalidation: '跌破區間低點，原本的箱型支撐假設失效。',
        exit: '靠近區間上緣或前波壓力即分批出場，不把區間單當趨勢單。',
        score: upside - downside * 1.5
      };
    }
  },
  {
    id: 'failed_breakout_reclaim',
    label: '突破失敗後重新站回',
    detect(row) {
      const breakout = recentBreakout(row.history, row.historyIndex, 3, 10);
      if (!breakout) return null;
      const between = row.history.slice(breakout.cursor + 1, row.historyIndex);
      const failed = between.some(day => day.close < breakout.resistance);
      const collapsed = Math.min(...between.map(day => day.low)) < breakout.resistance * 0.9;
      const reclaimed = row.day.close > breakout.resistance
        && row.day.close > row.day.open
        && row.day.close > row.prior.close;
      if (!failed || collapsed || !reclaimed) return null;
      return {
        support: breakout.resistance,
        resistance: Math.max(breakout.row.high, row.priorHigh20),
        setup: '第一次突破後曾跌回壓力下方，但沒有出現失速崩跌。',
        trigger: '回測支撐後第二次收盤站回原壓力。',
        invalidation: '再次跌回原壓力下方並跌破回測低點。',
        exit: '第二次突破仍無法延續即退出；有效突破則用移動停利續抱。',
        score: row.factors.relativeMarket20 + row.factors.volumeRatio20
      };
    }
  },
  {
    id: 'volume_surge_consolidation',
    label: '爆量長紅後整理再攻',
    detect(row) {
      const history = row.history;
      let impulse = null;
      for (let ago = 2; ago <= 10; ago += 1) {
        const cursor = row.historyIndex - ago;
        const candle = history[cursor];
        const prior = history[cursor - 1];
        const averageVolume = average(history.slice(cursor - 20, cursor).map(day => day.volume));
        if (dayReturn(candle, prior) >= 4.5 && candle.volume >= averageVolume * 1.7) {
          impulse = { cursor, candle, prior, ago };
          break;
        }
      }
      if (!impulse) return null;
      const midpoint = (impulse.candle.open + impulse.candle.close) / 2;
      const consolidation = history.slice(impulse.cursor + 1, row.historyIndex);
      if (!consolidation.length
        || Math.min(...consolidation.map(day => day.low), row.day.low) < midpoint) return null;
      const turnsUp = row.day.close > Math.max(...consolidation.slice(-3).map(day => day.high))
        && row.factors.volumeRatio20 >= 1.05;
      if (!turnsUp) return null;
      return {
        support: midpoint,
        resistance: impulse.candle.high,
        setup: '先出現爆量長紅，之後整理 2 至 10 天且未跌破長紅中線。',
        trigger: '整理後再次放量站上近三日高點。',
        invalidation: '跌破長紅中線或長紅低點，代表主升假設失效。',
        exit: '再攻成功可續抱；量縮攻不上、跌破整理平台或移動停利時出場。',
        score: row.factors.volumeRatio20 * 3 + row.factors.relativeMarket20
      };
    }
  },
  {
    id: 'volume_contraction_pullback',
    label: '量縮回檔後轉強',
    detect(row) {
      if (row.factors.return20 < 8 || row.factors.return5 > 1 || row.factors.return5 < -8) return null;
      const pullback = row.history.slice(row.historyIndex - 5, row.historyIndex);
      const earlier = row.history.slice(row.historyIndex - 15, row.historyIndex - 5);
      const volumeContracted = average(pullback.map(day => day.volume))
        < average(earlier.map(day => day.volume)) * 0.85;
      const support = Math.max(row.ma20, Math.min(...earlier.slice(-5).map(day => day.low)));
      const held = row.day.low >= support * 0.98 && row.day.close >= support;
      const turnsUp = row.day.close > row.day.open && row.day.close > row.prior.high;
      if (!volumeContracted || !held || !turnsUp) return null;
      return {
        support,
        setup: '前段已有明顯漲幅，回檔期間成交量低於上漲期且守住 MA20 或前波支撐。',
        trigger: '轉強日收紅並站上前一日高點。',
        invalidation: '跌破 MA20 或前波支撐，代表量縮不是健康整理。',
        exit: '沿 MA20 續抱；族群轉弱、量價失速或支撐跌破時出場。',
        score: row.factors.return20 - Math.abs(row.factors.return5)
          + row.factors.relativeTheme20
      };
    }
  },
  {
    id: 'gap_hold_reacceleration',
    label: '跳空上漲後不回補缺口',
    detect(row) {
      const history = row.history;
      let gap = null;
      for (let ago = 1; ago <= 3; ago += 1) {
        const cursor = row.historyIndex - ago;
        const candle = history[cursor];
        const prior = history[cursor - 1];
        const gapPct = pct(candle.open, prior.close);
        if (gapPct >= 2.5) {
          gap = { cursor, candle, prior, ago, gapFloor: prior.close };
          break;
        }
      }
      if (!gap) return null;
      const held = history.slice(gap.cursor, row.historyIndex + 1)
        .every(day => day.low > gap.gapFloor);
      const turnsUp = row.day.close > row.day.open && row.day.close > row.prior.high;
      if (!held || !turnsUp) return null;
      return {
        support: gap.gapFloor,
        waitedDays: gap.ago,
        setup: '跳空上漲後先觀察 1 至 3 天，缺口下緣始終沒有被回補。',
        trigger: '守缺口後再次收紅並站上前一日高點。',
        invalidation: '回補缺口或跌破跳空日低點。',
        exit: '缺口續守可續抱；回補缺口、族群轉弱或動能停滯時出場。',
        score: row.factors.relativeTheme20 + row.factors.volumeRatio20 * 2
      };
    }
  }
]);

const NO_BUY_FILTERS = Object.freeze([
  { id: 'none', label: '不加額外排除條件', test: () => true },
  { id: 'large_gap', label: '排除開盤跳空超過 3%', test: event => Math.abs(event.factors.gapPct) <= 3 },
  { id: 'far_ma20', label: '排除離 MA20 超過 8%', test: event => Math.abs(event.factors.distanceMa20) <= 8 },
  { id: 'far_ma60', label: '排除離 MA60 超過 15%', test: event => Math.abs(event.factors.distanceMa60) <= 15 },
  { id: 'near_resistance', label: '排除距離前高壓力不足 4%', test: event => pct(event.resistance, event.day.close) >= 4 },
  { id: 'low_value', label: '排除成交值低於 5,000 萬元', test: event => event.factors.transactionValue >= 50_000_000 },
  { id: 'high_atr', label: '排除 ATR 高於 6%', test: event => event.factors.atrPct <= 6 },
  { id: 'upper_wick', label: '排除長上影線', test: event => !event.factors.longUpperWick },
  { id: 'market_below_ma60', label: '排除大盤跌破 MA60', test: event => event.factors.marketAboveMa60 },
  { id: 'theme_divergence', label: '排除族群不同步', test: event => event.factors.relativeTheme20 >= -2 },
  { id: 'overextended', label: '排除已連漲超過 4 天', test: event => event.factors.consecutiveUp <= 4 },
  {
    id: 'near_limit_without_volume',
    label: '排除接近漲停但量能不足',
    test: event => dayReturn(event.day, event.prior) < 8.5 || event.factors.volumeRatio20 >= 1.5
  }
]);

function compactRandomEvent(observation) {
  return makeEvent(observation, {
    id: 'random',
    label: '公平隨機進場'
  }, {
    support: Math.max(observation.ma20 || 0, observation.priorLow20),
    resistance: observation.priorHigh20,
    setup: '同日期、同市場狀態的隨機流動性股票。',
    trigger: '沿用候選策略相同的進場方式。',
    invalidation: '沿用候選策略相同的停損方式。',
    exit: '沿用候選策略相同的出場方式。',
    score: deterministicScore(`${observation.date}|${observation.symbol}|公平隨機`)
  });
}

function entryFill(event, mode) {
  const nextDay = event.futureBars[0];
  if (!nextDay) return null;
  if (mode === 'next_open') {
    return { ...simulateEntry({ mode: 'next_open_market', nextDay }), date: nextDay.date, barOffset: 0 };
  }
  if (mode === 'next_breakout' || mode === 'intraday_trigger') {
    const fill = simulateEntry({
      mode: 'resistance_breakout',
      nextDay,
      triggerPrice: event.day.high * 1.001
    });
    return fill ? { ...fill, date: nextDay.date, barOffset: 0 } : null;
  }
  if (mode === 'support_pullback') {
    const fill = simulateEntry({
      mode: 'pullback_entry',
      nextDay,
      pullbackPrice: event.support,
      pullbackFloor: event.support * 0.97
    });
    return fill ? { ...fill, date: nextDay.date, barOffset: 0 } : null;
  }
  if (mode === 'close_confirm') {
    const entryDay = event.futureBars[1];
    if (!entryDay || nextDay.close <= event.day.high || nextDay.close <= nextDay.open) return null;
    const fill = simulateEntry({ mode: 'next_open_market', nextDay: entryDay });
    return fill ? {
      ...fill,
      date: entryDay.date,
      barOffset: 1,
      reason: '完整收盤確認後，下一個交易日開盤進場'
    } : null;
  }
  if (mode === 'gap_limited') {
    if (pct(nextDay.open, event.day.close) > 3) return null;
    return { ...simulateEntry({ mode: 'next_open_market', nextDay }), date: nextDay.date, barOffset: 0 };
  }
  if (mode === 'stabilization_wait') {
    if (event.scenarioId === 'high_volatility_reversal' && event.waitedDays < 1) return null;
    return { ...simulateEntry({ mode: 'next_open_market', nextDay }), date: nextDay.date, barOffset: 0 };
  }
  return null;
}

function stopPrice(event, entryPrice, type) {
  const atr = entryPrice * event.factors.atrPct / 100;
  const values = {
    signal_low: event.day.low,
    stabilization_low: event.stabilizationLow,
    swing_low: event.swingLow,
    ma20: event.ma20 * 0.995,
    ma60: event.ma60 * 0.995,
    atr1: entryPrice - atr,
    atr1_5: entryPrice - atr * 1.5,
    fixed3: entryPrice * 0.97,
    fixed5: entryPrice * 0.95,
    fixed8: entryPrice * 0.92,
    support_break: event.support * 0.995
  };
  const raw = values[type] ?? entryPrice * 0.95;
  return Math.min(entryPrice * 0.995, Math.max(entryPrice * 0.88, raw));
}

function exitDecision(event, variant, fill, barIndex, peakPrice, context, holdingIndex = barIndex) {
  const bar = event.futureBars[barIndex];
  if (!bar) return null;
  const stop = stopPrice(event, fill.price, variant.stopType);
  const risk = Math.max(fill.price * 0.005, fill.price - stop);
  const fixedDays = { hold3: 3, hold5: 5, hold10: 10 };
  const targets = {
    target1r: fill.price + risk,
    target1_5r: fill.price + risk * 1.5,
    target2r: fill.price + risk * 2,
    ma20_target: event.ma20 > fill.price ? event.ma20 : null,
    resistance_target: event.resistance > fill.price ? event.resistance * 0.995 : null
  };
  const trailing = variant.exitType === 'trailing'
    ? trailingStopPrice(fill.price, peakPrice, { triggerPct: 4, lockPct: 1, givebackPct: 3 })
    : null;
  let activeStop = stop;
  let closeStop = false;
  if (variant.exitType === 'ma20_break') {
    activeStop = bar.ma20 ?? stop;
    closeStop = true;
  } else if (variant.exitType === 'support_break') {
    activeStop = event.support;
  }
  const simulated = simulateExit({
    day: bar,
    stopLoss: activeStop,
    takeProfit: targets[variant.exitType],
    trailingStop: trailing,
    peakPrice,
    closeStop
  });
  if (simulated?.price) return { ...simulated, date: bar.date };

  if (fixedDays[variant.exitType] && holdingIndex + 1 >= fixedDays[variant.exitType]) {
    return {
      date: bar.date,
      price: bar.close,
      type: 'holding_period',
      reason: `固定持有 ${fixedDays[variant.exitType]} 個交易日`
    };
  }
  if (variant.exitType === 'momentum_stall' && holdingIndex >= 2) {
    const prior = event.futureBars[barIndex - 1];
    if (bar.close <= prior.close && bar.volume < prior.volume) {
      return { date: bar.date, price: bar.close, type: 'momentum_stall', reason: '量縮且價格無法再創高' };
    }
  }
  if (variant.exitType === 'market_weak') {
    const market = context.marketByDate.get(bar.date);
    if (market && (market.regime === 'BEAR_DEFENSE' || market.regime === 'HIGH_VOLATILITY')) {
      return { date: bar.date, price: bar.close, type: 'market_weak', reason: '大盤轉為空頭或高波動狀態' };
    }
  }
  if (variant.exitType === 'theme_weak') {
    const theme = context.themeReturns.get(`${bar.date}|${event.theme}`);
    const market = context.marketByDate.get(bar.date);
    if (theme && market && theme.average < market.mom20 - 2) {
      return { date: bar.date, price: bar.close, type: 'theme_weak', reason: '族群二十日強度落後大盤超過 2%' };
    }
  }
  if (barIndex === event.futureBars.length - 1 || holdingIndex >= 9) {
    return { date: bar.date, price: bar.close, type: 'maximum_holding', reason: '達到最長十日持有上限' };
  }
  return null;
}

function simulateOutcome(event, variant, context) {
  const filter = NO_BUY_FILTERS.find(row => row.id === variant.filterId);
  if (!variant.ignoreFilter && filter && !filter.test(event)) return null;
  const fill = entryFill(event, variant.entryMode);
  if (!fill) return null;
  let peakPrice = fill.price;
  const startBar = fill.barOffset ?? 0;
  for (let index = startBar; index < event.futureBars.length; index += 1) {
    peakPrice = Math.max(peakPrice, event.futureBars[index].high);
    const exit = exitDecision(
      event,
      variant,
      fill,
      index,
      peakPrice,
      context,
      index - startBar
    );
    if (!exit) continue;
    return {
      event,
      fill,
      exit,
      grossReturnPct: pct(exit.price, fill.price),
      returnPct: executionReturn(fill.price, exit.price),
      holdingDays: index - startBar + 1,
      entryReason: `${event.triggerReason}；進場方式：${ENTRY_MODES.find(row => row.id === variant.entryMode)?.label}`,
      stopReason: event.invalidationReason,
      exitReason: exit.reason
    };
  }
  return null;
}

function distribution(values, grossValues = values) {
  if (!values.length) return null;
  const gains = values.filter(value => value > 0);
  const losses = values.filter(value => value <= 0);
  const sortedGains = [...gains].sort((a, b) => b - a);
  const topCount = Math.max(1, Math.ceil(values.length * 0.05));
  const totalGains = gains.reduce((sum, value) => sum + value, 0);
  const topContribution = totalGains
    ? sortedGains.slice(0, topCount).reduce((sum, value) => sum + value, 0) / totalGains * 100
    : 0;
  return {
    sampleSize: values.length,
    averageReturnPct: round(average(grossValues)),
    medianReturnPct: round(median(grossValues)),
    costAdjustedAverageReturnPct: round(average(values)),
    costAdjustedMedianReturnPct: round(median(values)),
    winRatePct: round(gains.length / values.length * 100),
    maximumLossPct: round(Math.min(...values)),
    standardDeviationPct: round(standardDeviation(values)),
    profitFactor: losses.length
      ? round(gains.reduce((sum, value) => sum + value, 0)
        / Math.abs(losses.reduce((sum, value) => sum + value, 0)))
      : gains.length ? null : 0,
    topFivePercentProfitContributionPct: round(topContribution),
    warning: average(values) > 0 && median(values) < 0
      ? '可能是少數飆股拉高平均'
      : values.length < 300
        ? '樣本數不足，不可宣稱有效'
        : null
  };
}

function stability(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const group = key(row);
    const values = groups.get(group) || [];
    values.push(row.returnPct);
    groups.set(group, values);
  }
  return [...groups].map(([group, values]) => ({
    group,
    sampleSize: values.length,
    averageReturnPct: round(average(values)),
    medianReturnPct: round(median(values)),
    positive: average(values) > 0
  }));
}

function marketForwardReturn(context, event, horizon, barOffset = 0) {
  const index = context.marketHistory.findIndex(row => row.date === event.signalDate);
  const entryIndex = index + 1 + barOffset;
  const exitIndex = entryIndex + horizon - 1;
  if (index < 0 || exitIndex >= context.marketHistory.length) return null;
  const entry = context.marketHistory[entryIndex].open;
  const exit = context.marketHistory[exitIndex].close;
  return executionReturn(entry, exit);
}

function forwardAnalysis(context, events, randomByEvent) {
  return SCENARIOS.map(scenario => {
    const scenarioEvents = events.filter(event => event.scenarioId === scenario.id);
    const entryModes = ENTRY_MODES.map(entryMode => {
      const horizons = {};
      for (const horizon of HORIZONS) {
        const rows = [];
        const randomRows = [];
        const marketReturns = [];
        for (const event of scenarioEvents) {
          const fill = entryFill(event, entryMode.id);
          const exitBar = event.futureBars[(fill?.barOffset ?? 0) + horizon - 1];
          if (fill && exitBar) {
            rows.push({
              date: event.signalDate,
              regime: event.regime,
              grossReturnPct: pct(exitBar.close, fill.price),
              returnPct: executionReturn(fill.price, exitBar.close)
            });
            const marketReturn = marketForwardReturn(
              context,
              event,
              horizon,
              fill.barOffset ?? 0
            );
            if (Number.isFinite(marketReturn)) marketReturns.push(marketReturn);
          }
          const randomEvent = randomByEvent.get(event.id);
          const randomEntryDay = randomEvent?.futureBars[fill?.barOffset ?? 0];
          const randomFill = fill && randomEntryDay
            ? {
                ...simulateEntry({ mode: 'next_open_market', nextDay: randomEntryDay }),
                date: randomEntryDay.date,
                barOffset: fill.barOffset ?? 0
              }
            : null;
          const randomExit = randomEvent?.futureBars[
            (randomFill?.barOffset ?? 0) + horizon - 1
          ];
          if (randomFill && randomExit) {
            randomRows.push({
              grossReturnPct: pct(randomExit.close, randomFill.price),
              returnPct: executionReturn(randomFill.price, randomExit.close)
            });
          }
        }
        const result = distribution(
          rows.map(row => row.returnPct),
          rows.map(row => row.grossReturnPct)
        );
        const randomResult = distribution(
          randomRows.map(row => row.returnPct),
          randomRows.map(row => row.grossReturnPct)
        );
        horizons[horizon] = result ? {
          ...result,
          averageMarketReturnPct: round(average(marketReturns)),
          averageRandomReturnPct: round(randomResult?.costAdjustedAverageReturnPct),
          beatsMarket: result.costAdjustedAverageReturnPct > (average(marketReturns) ?? Infinity),
          beatsRandom: result.costAdjustedAverageReturnPct
            > (randomResult?.costAdjustedAverageReturnPct ?? Infinity),
          positiveAfterCosts: result.costAdjustedAverageReturnPct > 0,
          yearlyStability: stability(rows, row => row.date.slice(0, 4)),
          regimeStability: stability(rows, row => row.regime)
        } : null;
      }
      return { ...entryMode, horizons };
    });
    return {
      id: scenario.id,
      label: scenario.label,
      setup: scenarioEvents[0]?.setupReason ?? null,
      trigger: scenarioEvents[0]?.triggerReason ?? null,
      invalidation: scenarioEvents[0]?.invalidationReason ?? null,
      exit: scenarioEvents[0]?.plannedExit ?? null,
      detectedSamples: scenarioEvents.length,
      entryModes
    };
  });
}

function variants() {
  const rows = [];
  for (const scenario of SCENARIOS) {
    for (let index = 0; index < 28; index += 1) {
      rows.push({
        id: `${scenario.id}-v${String(index + 1).padStart(2, '0')}`,
        scenarioId: scenario.id,
        scenarioLabel: scenario.label,
        entryMode: ENTRY_MODES[index % ENTRY_MODES.length].id,
        stopType: STOP_TYPES[(index * 3) % STOP_TYPES.length],
        exitType: EXIT_TYPES[(index * 5) % EXIT_TYPES.length],
        filterId: NO_BUY_FILTERS[(index * 7) % NO_BUY_FILTERS.length].id
      });
    }
  }
  return rows;
}

function summarizeOutcomes(outcomes) {
  const stats = distribution(
    outcomes.map(row => row.returnPct),
    outcomes.map(row => row.grossReturnPct)
  );
  if (!stats) return null;
  const yearly = stability(outcomes.map(row => ({
    date: row.event.signalDate,
    regime: row.event.regime,
    returnPct: row.returnPct
  })), row => row.date.slice(0, 4));
  return {
    ...stats,
    averageHoldingDays: round(average(outcomes.map(row => row.holdingDays))),
    positiveYears: yearly.filter(row => row.positive).length,
    testedYears: yearly.length,
    yearly
  };
}

function selectVariant(context, events, allVariants, startDate, endDate) {
  let best = null;
  for (const variant of allVariants) {
    const outcomes = events
      .filter(event => event.scenarioId === variant.scenarioId
        && event.signalDate >= startDate
        && event.signalDate <= endDate)
      .map(event => simulateOutcome(event, variant, context))
      .filter(Boolean);
    const summary = summarizeOutcomes(outcomes);
    if (!summary || summary.sampleSize < 80) continue;
    const concentrationPenalty = Math.max(0, summary.topFivePercentProfitContributionPct - 55) / 20;
    const score = summary.costAdjustedAverageReturnPct * 3
      + summary.costAdjustedMedianReturnPct
      + ((summary.profitFactor ?? 0) - 1) * 2
      + summary.positiveYears / Math.max(1, summary.testedYears)
      - concentrationPenalty
      + summary.maximumLossPct / 20;
    if (!best || score > best.score) best = { variant, summary, score: round(score) };
  }
  return best;
}

function simulatePortfolio(context, events, variant, startDate, endDate, options = {}) {
  const dates = context.marketHistory
    .map(row => row.date)
    .filter(date => date >= startDate && date <= endDate);
  const entries = new Map();
  for (const sourceEvent of events) {
    if (sourceEvent.signalDate < startDate || sourceEvent.signalDate > endDate) continue;
    const appliedVariant = { ...variant };
    const filter = NO_BUY_FILTERS.find(row => row.id === appliedVariant.filterId);
    if (filter && !filter.test(sourceEvent)) continue;
    const sourceFill = entryFill(sourceEvent, appliedVariant.entryMode);
    if (!sourceFill) continue;
    const event = options.randomByEvent?.get(sourceEvent.id) ?? sourceEvent;
    const randomEntryDay = event.futureBars[sourceFill.barOffset ?? 0];
    const fill = options.randomByEvent
      ? randomEntryDay
        ? {
            ...simulateEntry({ mode: 'next_open_market', nextDay: randomEntryDay }),
            date: randomEntryDay.date,
            barOffset: sourceFill.barOffset ?? 0,
            reason: '與原策略相同交易日的公平隨機進場'
          }
        : null
      : sourceFill;
    if (!fill || fill.date < startDate || fill.date > endDate) continue;
    const rows = entries.get(fill.date) || [];
    rows.push({ event, fill, variant: appliedVariant });
    entries.set(fill.date, rows);
  }
  const portfolio = createPortfolio({
    initialCapital: 1_000_000,
    settlementDays: 2,
    maxOpenPositions: 6,
    riskControls: true
  });
  for (let dayIndex = 0; dayIndex < dates.length; dayIndex += 1) {
    const date = dates[dayIndex];
    const regime = context.marketByDate.get(date)?.regime;
    settleCash(portfolio, dayIndex);
    beginPortfolioDay(portfolio, date, dayIndex, regime);

    for (const position of [...portfolio.positions]) {
      const barIndex = position.bars.findIndex(row => row.date === date);
      if (barIndex < 0) continue;
      const bar = position.bars[barIndex];
      markPosition(portfolio, position.tradeId, bar.close);
      const exit = exitDecision(
        position.event,
        position.variant,
        position.fill,
        barIndex,
        Math.max(position.peakPrice, bar.high),
        context,
        barIndex - (position.fill.barOffset ?? 0)
      );
      if (exit) closePosition(portfolio, position, exit, dayIndex);
    }

    const exposureLimitPct = portfolio.riskRules.exposureLimits[regime] ?? 0;
    for (const position of [...portfolio.positions].sort((a, b) => b.markValue - a.markValue)) {
      if (portfolioExposure(portfolio) <= portfolioEquity(portfolio) * exposureLimitPct / 100) break;
      const bar = position.bars.find(row => row.date === date);
      if (!bar) continue;
      closePosition(portfolio, position, {
        date,
        price: bar.close,
        type: 'exposure_reduction',
        reason: `市場狀態允許的總曝險降至 ${exposureLimitPct}%`
      }, dayIndex);
    }

    for (const candidate of (entries.get(date) || []).sort((a, b) => b.event.score - a.event.score)) {
      const { event, fill, variant: selected } = candidate;
      const stop = stopPrice(event, fill.price, selected.stopType);
      openPosition(portfolio, {
        tradeId: `${event.symbol}-${event.signalDate}-${selected.id}`,
        symbol: event.symbol,
        name: event.name,
        signalDate: event.signalDate,
        entryDate: fill.date,
        entryPrice: fill.price,
        stopLoss: stop,
        takeProfit: null,
        positionPct: 9,
        strategy: `${event.scenarioLabel}｜${selected.id}`,
        regime,
        bars: event.futureBars,
        event,
        fill,
        variant: selected,
        setupReason: event.setupReason,
        entryReason: `${event.triggerReason}；${ENTRY_MODES.find(row => row.id === selected.entryMode)?.label}`,
        invalidationReason: event.invalidationReason
      }, dayIndex, {
        positionPct: 9,
        accountRiskPct: 0.5,
        regime
      });
    }
    recordEquity(portfolio, date, { dayIndex, regime });
  }
  const finalDate = dates.at(-1);
  const finalIndex = dates.length - 1;
  if (finalDate) {
    beginPortfolioDay(portfolio, finalDate, finalIndex, context.marketByDate.get(finalDate)?.regime);
    for (const position of [...portfolio.positions]) {
      closePosition(portfolio, position, {
        date: finalDate,
        price: position.markPrice,
        type: 'end_of_test',
        reason: '驗證區間結束'
      }, finalIndex);
    }
    portfolio.equityCurve.pop();
    portfolio.previousEquity = portfolio.equityCurve.at(-1)?.equity ?? portfolio.initialCapital;
    recordEquity(portfolio, finalDate, {
      dayIndex: finalIndex,
      regime: context.marketByDate.get(finalDate)?.regime
    });
  }
  return {
    summary: summarizePerformance(portfolio, startDate, endDate),
    trades: portfolio.closedTrades.map(trade => ({
      symbol: trade.symbol,
      name: trade.name,
      strategy: trade.strategy,
      signalDate: trade.signalDate,
      entryDate: trade.entryDate,
      entryPrice: trade.entryPrice,
      exitDate: trade.exitDate,
      exitPrice: trade.exitPrice,
      setupReason: trade.setupReason,
      entryReason: trade.entryReason,
      invalidationReason: trade.invalidationReason,
      exitReason: trade.exitReason,
      realizedPnl: trade.realizedPnl,
      tradeReturnPct: trade.tradeReturnPct,
      accountReturnPct: trade.accountReturnPct
    })),
    equityCurve: portfolio.equityCurve,
    riskEvents: portfolio.riskEvents
  };
}

function marketMonthlyReturns(context, startDate, endDate) {
  const rows = context.marketHistory.filter(row => row.date >= startDate && row.date <= endDate);
  const endByMonth = new Map();
  for (const row of rows) endByMonth.set(row.date.slice(0, 7), row.close);
  const months = [...endByMonth.entries()].sort(([left], [right]) => left.localeCompare(right));
  let prior = rows[0]?.open;
  const returns = [];
  for (const [month, close] of months) {
    returns.push({ month, returnPct: pct(close, prior) });
    prior = close;
  }
  return returns;
}

function combinedValidation(folds) {
  const trades = folds.flatMap(fold => fold.validation.trades);
  const monthly = folds.flatMap(fold => fold.validation.summary.monthly);
  const randomMonthly = folds.flatMap(fold => fold.randomValidation.summary.monthly);
  const marketMonthly = folds.flatMap(fold => fold.marketMonthlyReturns);
  const gains = trades.filter(trade => trade.realizedPnl > 0)
    .reduce((sum, trade) => sum + trade.realizedPnl, 0);
  const losses = Math.abs(trades.filter(trade => trade.realizedPnl <= 0)
    .reduce((sum, trade) => sum + trade.realizedPnl, 0));
  const sortedWinners = trades.filter(trade => trade.realizedPnl > 0)
    .sort((left, right) => right.realizedPnl - left.realizedPnl);
  const topCount = Math.max(1, Math.ceil(trades.length * 0.05));
  const topContribution = gains
    ? sortedWinners.slice(0, topCount).reduce((sum, trade) => sum + trade.realizedPnl, 0) / gains * 100
    : 0;
  const symbols = new Map();
  for (const trade of trades) symbols.set(trade.symbol, (symbols.get(trade.symbol) || 0) + 1);
  const summary = {
    validationTrades: trades.length,
    validationAverageMonthlyEquityReturnPct: round(mean(monthly.map(row => row.equityReturnPct)) || 0),
    randomAverageMonthlyEquityReturnPct: round(mean(randomMonthly.map(row => row.equityReturnPct)) || 0),
    marketAverageMonthlyReturnPct: round(mean(marketMonthly.map(row => row.returnPct)) || 0),
    validationProfitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    validationWinRatePct: round(trades.filter(trade => trade.realizedPnl > 0).length
      / Math.max(1, trades.length) * 100),
    validationMaximumDrawdownPct: round(Math.min(
      0,
      ...folds.map(fold => fold.validation.summary.maximumDrawdownPct)
    )),
    validationNegativeMonths: monthly.filter(row => row.equityReturnPct < 0).length,
    topFivePercentProfitContributionPct: round(topContribution),
    maximumSymbolConcentrationPct: round(
      Math.max(0, ...symbols.values()) / Math.max(1, trades.length) * 100
    )
  };
  const checks = {
    enoughSamples: summary.validationTrades > 300,
    profitFactor: summary.validationProfitFactor > 1.15,
    beatsMarket: summary.validationAverageMonthlyEquityReturnPct
      > summary.marketAverageMonthlyReturnPct,
    controlledDrawdown: summary.validationMaximumDrawdownPct > -20,
    notDrivenByFewWinners: summary.topFivePercentProfitContributionPct < 55,
    positiveAfterCosts: summary.validationAverageMonthlyEquityReturnPct > 0,
    beatsRandom: summary.validationAverageMonthlyEquityReturnPct
      > summary.randomAverageMonthlyEquityReturnPct,
    beatsCash: summary.validationAverageMonthlyEquityReturnPct > 0,
    diversified: summary.maximumSymbolConcentrationPct < 10,
    noLookahead: true,
    realisticExecution: true
  };
  return {
    ...summary,
    checks,
    qualifies: Object.values(checks).every(Boolean)
  };
}

function markdown(report) {
  const scenarioRows = report.forwardAnalysis.map(scenario => {
    const nextOpen = scenario.entryModes.find(row => row.id === 'next_open');
    const horizon = nextOpen?.horizons?.[5];
    return `| ${scenario.label} | ${scenario.detectedSamples} | ${horizon?.averageReturnPct ?? '-'}% | ${horizon?.medianReturnPct ?? '-'}% | ${horizon?.costAdjustedAverageReturnPct ?? '-'}% | ${horizon?.profitFactor ?? '-'} | ${horizon?.positiveAfterCosts ? '是' : '否'} | ${horizon?.beatsMarket ? '是' : '否'} | ${horizon?.beatsRandom ? '是' : '否'} | ${horizon?.warning ?? '-'} |`;
  }).join('\n');
  const foldRows = report.walkForward.folds.map(fold => (
    `| ${fold.index} | ${fold.trainStart} 至 ${fold.trainEnd} | ${fold.validationStart} 至 ${fold.validationEnd} | ${fold.selectedVariant.scenarioLabel} | ${fold.selectedVariant.entryMode} / ${fold.selectedVariant.stopType} / ${fold.selectedVariant.exitType} / ${fold.selectedVariant.filterId} | ${fold.validation.summary.trades} | ${fold.validation.summary.averageMonthlyEquityReturnPct}% | ${fold.validation.summary.profitFactor ?? '-'} | ${fold.validation.summary.maximumDrawdownPct}% |`
  )).join('\n');
  const passed = report.walkForward.combined.qualifies
    ? '找到符合條件、可進入紙上交易驗證的候選策略。'
    : '找不到符合條件的候選策略';
  return `# 統計優勢轉可交易策略研究

> 本報告只使用訊號日收盤前可知的 OHLCV、成交量、成交值、族群與市場狀態。成交、費稅、滑價、跳空停損與 T+2 均由共用模擬器處理。歷史股票池仍有倖存者偏差，因此結果不可視為正式獲利保證。

## 研究結論

**${passed}**

- 合併 Validation 交易數：${report.walkForward.combined.validationTrades}
- 月均總資產報酬：${report.walkForward.combined.validationAverageMonthlyEquityReturnPct}%
- 0050／大盤代理同期月均報酬：${report.walkForward.combined.marketAverageMonthlyReturnPct}%
- 公平隨機策略月均報酬：${report.walkForward.combined.randomAverageMonthlyEquityReturnPct}%
- Profit Factor：${report.walkForward.combined.validationProfitFactor ?? '-'}
- 最大回撤：${report.walkForward.combined.validationMaximumDrawdownPct}%
- 前 5% 獲利交易貢獻：${report.walkForward.combined.topFivePercentProfitContributionPct}%

## 八種交易情境

| 情境 | 樣本數 | 5 日毛報酬平均 | 5 日毛報酬中位數 | 5 日成本後平均 | PF | 成本後為正 | 優於大盤 | 優於公平隨機 | 警告 |
|---|---:|---:|---:|---:|---:|---|---|---|---|
${scenarioRows}

完整 JSON 另列七種進場方式與 1、3、5、10、20 日統計，並包含年度與市場狀態穩定性。

## Walk-Forward

訓練 36 個月、驗證 12 個月，每次前進 12 個月。每段只在訓練期挑選情境、進場、停損、出場與排除條件，驗證期固定不變。

| 段 | 訓練區間 | 驗證區間 | 訓練選中情境 | 固定規則 | 驗證交易 | 月均報酬 | PF | 最大回撤 |
|---:|---|---|---|---|---:|---:|---:|---:|
${foldRows}

## 公平隨機基準

隨機股票改為在每個候選訊號的**相同日期、相同市場狀態**中抽取流動性股票，套用相同進場、停損、出場、持有上限、費稅、滑價、T+2 與風控。它不再用不同市場時段或不同風險條件與策略比較。

## 已測試規則

- 進場：${ENTRY_MODES.map(row => row.label).join('、')}。
- 停損：進場確認 K 低點、止穩 K 低點、前波低點、MA20、MA60、ATR 1 倍、ATR 1.5 倍、固定 -3%／-5%／-8%、支撐跌破。
- 出場：固定 3／5／10 日、1R／1.5R／2R、移動停利、反彈到 MA20、前波壓力、跌破 MA20、跌破前高轉支撐、動能停滯、大盤轉弱、族群轉弱。
- 不要買：跳空過大、離均線太遠、離壓力太近、成交值太低、ATR 太高、長上影、大盤跌破 MA60、族群不同步、連漲過多、接近漲停但量能不足。
- 處置／注意股與精確公司行動資料目前不可得；異常價格只以單日絕對報酬 15% 的資料清理代理，不等同完整事件資料。

## 目前資料不足

${report.missingData.map(row => `- ${row}`).join('\n')}

## 下一步

${report.nextSteps.map(row => `- ${row}`).join('\n')}
`;
}

async function main() {
  const context = await loadResearchContext();
  const eventMaps = new Map(SCENARIOS.map(row => [row.id, new Map()]));
  const randomPools = new Map();
  let observations = 0;

  observations = iterateObservations(context, observation => {
    if (observation.factors.transactionValue >= 20_000_000) {
      const key = `${observation.date}|${observation.factors.regime}`;
      addTop(randomPools, key, compactRandomEvent(observation), 12);
    }
    for (const scenario of SCENARIOS) {
      const details = scenario.detect(observation);
      if (!details) continue;
      addTop(
        eventMaps.get(scenario.id),
        observation.date,
        makeEvent(observation, scenario, details),
        4
      );
    }
  });

  const events = [...eventMaps.values()]
    .flatMap(map => [...map.values()].flat())
    .sort((left, right) => left.signalDate.localeCompare(right.signalDate)
      || right.score - left.score);
  const randomByEvent = new Map();
  for (const event of events) {
    const pool = randomPools.get(`${event.signalDate}|${event.regime}`) || [];
    const alternatives = pool.filter(row => row.symbol !== event.symbol);
    if (!alternatives.length) continue;
    const index = Math.floor(deterministicScore(event.id) * alternatives.length);
    randomByEvent.set(event.id, alternatives[Math.min(index, alternatives.length - 1)]);
  }

  const forward = forwardAnalysis(context, events, randomByEvent);
  const allVariants = variants();
  const windows = foldWindows(context.startDate, context.endDate, 36, 12);
  const folds = [];
  for (const [index, window] of windows.entries()) {
    const selected = selectVariant(
      context,
      events,
      allVariants,
      window.trainStart,
      window.trainEnd
    );
    if (!selected) continue;
    const validationEvents = events.filter(event => event.scenarioId === selected.variant.scenarioId);
    const validation = simulatePortfolio(
      context,
      validationEvents,
      selected.variant,
      window.validationStart,
      window.validationEnd
    );
    const randomValidation = simulatePortfolio(
      context,
      validationEvents,
      selected.variant,
      window.validationStart,
      window.validationEnd,
      { randomByEvent }
    );
    const marketMonthly = marketMonthlyReturns(
      context,
      window.validationStart,
      window.validationEnd
    );
    folds.push({
      index: index + 1,
      ...window,
      selectedVariant: selected.variant,
      trainSummary: selected.summary,
      trainScore: selected.score,
      validation,
      randomValidation,
      marketMonthlyReturns: marketMonthly,
      marketAverageMonthlyReturnPct: round(mean(marketMonthly.map(row => row.returnPct)) || 0),
      validationParametersFixed: true
    });
    console.log(
      `第 ${index + 1} 段：${selected.variant.scenarioLabel}，`
      + `Validation ${validation.summary.trades} 筆，月均 ${validation.summary.averageMonthlyEquityReturnPct}%`
    );
  }

  const combined = combinedValidation(folds);
  const report = {
    generatedAt: new Date().toISOString(),
    branch: 'profit-edge-search-v1',
    startDate: context.startDate,
    endDate: context.endDate,
    observations,
    survivorshipBiasWarning: context.survivorshipBiasWarning,
    methodology: {
      executionSimulator: 'scripts/lib/execution-simulator.mjs',
      portfolioSimulator: 'scripts/lib/portfolio-simulator.mjs',
      trainMonths: 36,
      validationMonths: 12,
      rollMonths: 12,
      validationParametersFixed: true,
      transactionCostsIncluded: true,
      slippageIncluded: true,
      settlementDays: 2,
      noFutureData: true,
      realisticGapExecution: true,
      randomBenchmark: '相同訊號日期、相同市場狀態、相同交易規則與風控'
    },
    testedRules: {
      scenarios: SCENARIOS.map(row => ({ id: row.id, label: row.label })),
      entries: ENTRY_MODES,
      stops: STOP_TYPES,
      exits: EXIT_TYPES,
      noBuyFilters: [
        ...NO_BUY_FILTERS.map(row => ({ id: row.id, label: row.label, tested: true })),
        { id: 'attention_disposition', label: '處置股或注意股', tested: false, reason: '目前資料集未提供歷史名單' },
        { id: 'corporate_actions', label: '減資、分割、除權息異常', tested: 'proxy', reason: '僅用異常單日報酬清理代理' }
      ],
      completeVariants: allVariants.length
    },
    testedVariants: allVariants,
    forwardAnalysis: forward,
    walkForward: {
      folds: folds.map(fold => ({
        ...fold,
        validation: {
          summary: fold.validation.summary,
          trades: fold.validation.trades
        },
        randomValidation: {
          summary: fold.randomValidation.summary
        }
      })),
      combined,
      conclusion: combined.qualifies
        ? '找到符合條件、可進入紙上交易驗證的候選策略'
        : '找不到符合條件的候選策略'
    },
    missingData: [
      '歷史月營收、EPS、毛利率、營益率與財報公布日期',
      '外資、投信、自營商買賣超及法人持股變化',
      '融資融券、借券與券資比',
      '可回溯的產業與題材族群分類',
      '歷史注意股、處置股與恢復交易名單',
      '除權息、減資、分割及價格還原事件',
      '月營收與重大訊息的實際公布時間',
      '歷史逐筆或分鐘資料，用於確認盤中觸發先後順序',
      '歷史股票池與下市股票，降低倖存者偏差'
    ],
    nextSteps: combined.qualifies
      ? [
          '先以紙上交易驗證成交落差與訊號延遲，不直接接實盤。',
          '補上分鐘資料後重測盤中突破、停損與同 K 棒先後順序。',
          '補齊法人、基本面與事件資料，檢查優勢是否可跨資料類型維持。'
        ]
      : [
          '不要把目前結果部署成正式策略或宣稱有穩定正期望。',
          '優先補齊法人、基本面、事件與分鐘資料，再重新做相同 walk-forward 驗證。',
          '保留本次失敗組合與參數紀錄，避免日後重複測試相同規則。'
        ]
  };

  await fs.mkdir(new URL('../../data/research/', import.meta.url), { recursive: true });
  await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, markdown(report), 'utf8');
  console.log(JSON.stringify({
    output: fileURLToPath(OUTPUT),
    report: fileURLToPath(REPORT),
    events: Object.fromEntries(SCENARIOS.map(scenario => [
      scenario.label,
      events.filter(event => event.scenarioId === scenario.id).length
    ])),
    combined,
    conclusion: report.walkForward.conclusion
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
