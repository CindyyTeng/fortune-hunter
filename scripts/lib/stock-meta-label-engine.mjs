import { deterministicScore } from '../research/research-core.mjs';

export const FEATURES = Object.freeze([
  'return5Pct', 'return20Pct', 'nearYearHigh', 'ma20Slope5Pct',
  'volumeRatio1To20', 'atr14Pct', 'distanceToMa20Pct', 'upperWickRatio',
  'marketMovePct', 'themeMovePct', 'rsi14'
]);

const outcomeCache = new WeakMap();
const mean = values => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : 0;

export const stockOnly = row => /^\d{4}$/.test(String(row.symbol || ''))
  && !String(row.symbol).startsWith('00');

export function forwardReturn(row, holdDays) {
  const cached = outcomeCache.get(row);
  if (cached?.has(holdDays)) return cached.get(holdDays);
  const bars = row.forwardPrices || [];
  if (bars.length < holdDays) return null;
  const entry = Number(bars[0].open);
  const exit = Number(bars[holdDays - 1].close ?? bars[holdDays - 1].price);
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || !entry) return null;
  const result = (exit / entry - 1) * 100 - 0.7425;
  if (cached) cached.set(holdDays, result);
  else outcomeCache.set(row, new Map([[holdDays, result]]));
  return result;
}

function quantileCuts(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return [0.2, 0.4, 0.6, 0.8].map(percentile =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentile))]
  );
}

function bucket(value, cuts) {
  if (!Number.isFinite(value)) return null;
  let index = 0;
  while (index < cuts.length && value > cuts[index]) index += 1;
  return index;
}

export function fitModel(rows, config, trainEnd) {
  const training = rows.filter(row => row.signalDate <= trainEnd
    && stockOnly(row)
    && row.forwardPrices?.at(-1)?.date <= trainEnd
    && Number.isFinite(forwardReturn(row, config.holdDays)));
  const model = {
    holdDays: config.holdDays,
    overall: mean(training.map(row => forwardReturn(row, config.holdDays))),
    factors: {}
  };
  const selectedFeatures = config.featureMode === 'momentum'
    ? FEATURES.slice(0, 5)
    : config.featureMode === 'risk' ? FEATURES.slice(5) : FEATURES;
  for (const feature of selectedFeatures) {
    const values = training.map(row => Number(row[feature])).filter(Number.isFinite);
    if (values.length < 100) continue;
    const cuts = quantileCuts(values);
    const groups = Array.from({ length: 5 }, () => []);
    for (const row of training) {
      const index = bucket(Number(row[feature]), cuts);
      const result = forwardReturn(row, config.holdDays);
      if (index !== null && Number.isFinite(result)) groups[index].push(result);
    }
    model.factors[feature] = {
      cuts,
      means: groups.map(group => mean(group)),
      counts: groups.map(group => group.length)
    };
  }
  return model;
}

export function modelScore(row, model) {
  let score = 0;
  let used = 0;
  for (const [feature, factor] of Object.entries(model.factors)) {
    const index = bucket(Number(row[feature]), factor.cuts);
    if (index === null || factor.counts[index] < 30) continue;
    score += (factor.means[index] - model.overall)
      * Math.min(1, Math.sqrt(factor.counts[index] / 100));
    used += 1;
  }
  score += (row.return20Pct || 0) * 0.03 + (row.nearYearHigh || 0) * 0.5;
  return used ? score : -999;
}

export function eligible(row) {
  return stockOnly(row)
    && (row.avg20TradeValue || 0) >= 20_000_000
    && (row.atr14Pct || 999) <= 8
    && (row.rsi14 || 999) <= 88
    && (row.gapUpPct || 999) <= 6
    && (row.upperWickRatio || 999) <= 0.75
    && (row.distanceToMa20Pct || 999) <= 20
    && (row.return20Pct || -999) >= -2
    && (row.marketMovePct || -999) >= -1.5
    && (row.themeMovePct || -999) >= -1.5;
}

function makeCandidate(row, model, config) {
  const bars = (row.forwardPrices || [])
    .slice(0, config.holdDays + 2)
    .map(bar => ({ ...bar, close: bar.close ?? bar.price, price: bar.price ?? bar.close }))
    .filter(bar => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
  if (bars.length < config.holdDays) return null;
  const entry = bars[0].open;
  return {
    symbol: row.symbol,
    name: row.name,
    signalDate: row.signalDate,
    entryDate: row.entryDate,
    entryMode: 'next_open_market',
    signalDay: { date: row.signalDate, close: row.entryPrice, price: row.entryPrice },
    futureBars: bars,
    close: row.entryPrice,
    stopLossPrice: entry * (1 - config.stopLossPct / 100),
    stopDistancePct: config.stopLossPct,
    rewardRisk: config.rewardRisk,
    positionPct: config.positionPct,
    accountRiskPct: 0.5,
    maxHoldingDays: config.holdDays,
    trailingStopRule: config.trailingStop ? { triggerPct: 5, lockPct: 1, givebackPct: 4 } : null,
    stopLossMode: 'close',
    setup: '個股動能與風險因子通過篩選',
    trigger: '下一交易日開盤，以模型分數排序進場',
    invalidation: `跌破停損價 ${config.stopLossPct}%`,
    exitPlan: config.trailingStop ? '移動停利或持有期滿' : '固定持有期滿',
    reason: '只使用訊號日前資料訓練的 Meta-label 模型',
    orderIntent: { action: 'BUY', orderType: 'MARKET', timing: 'NEXT_OPEN', quantityMode: 'RISK_BASED' },
    score: modelScore(row, model),
    alphaSource: '個股 Meta-label'
  };
}

export function signalMap(rows, model, config, context, random = false) {
  const byDate = new Map();
  for (const row of rows) {
    if (!eligible(row)) continue;
    const regime = context.marketByDate.get(row.signalDate)?.regime;
    if (config.regimeGate === 'bull'
      && !['BULL_TREND', 'BULL_PULLBACK', 'THEME_MOMENTUM'].includes(regime)) continue;
    if (config.regimeGate === 'trend'
      && !['BULL_TREND', 'THEME_MOMENTUM'].includes(regime)) continue;
    const item = makeCandidate(row, model, config);
    if (item && item.score > -900) {
      const list = byDate.get(item.signalDate) || [];
      list.push({ row, item });
      byDate.set(item.signalDate, list);
    }
  }
  const output = new Map();
  for (const [date, list] of byDate) {
    list.sort((left, right) => random
      ? deterministicScore(`${date}|${left.row.tradeId}|random`)
        - deterministicScore(`${date}|${right.row.tradeId}|random`)
      : right.item.score - left.item.score);
    output.set(date, list.slice(0, config.maxEntriesPerDay).map(entry => entry.item));
  }
  return output;
}
