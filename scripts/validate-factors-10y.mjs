import fs from 'node:fs/promises';
import {
  buyExecution,
  sellExecution
} from './lib/execution-simulator.mjs';

const INPUT = new URL('../data/tw-backtest-10y.json', import.meta.url);
const OUTPUT = new URL('../data/factor-validation-10y.json', import.meta.url);
const CSV_OUTPUT = new URL('../data/factor-validation-10y.csv', import.meta.url);
const BUY_FEE_PCT = 0.1425;
const SELL_FEE_PCT = 0.1425;
const SELL_TAX_PCT = 0.3;
const BUY_SLIPPAGE_PCT = 0.15;
const SELL_SLIPPAGE_PCT = 0.15;
const MIN_FEE = 20;
const QUANTITY = 1000;
const MIN_SAMPLE = 100;

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function netReturnPct(entryPrice, exitPrice) {
  const buy = buyExecution(entryPrice, QUANTITY, {
    buyFeePct: BUY_FEE_PCT,
    buySlippagePct: BUY_SLIPPAGE_PCT,
    minimumFee: MIN_FEE
  });
  const sell = sellExecution(exitPrice, QUANTITY, {
    sellFeePct: SELL_FEE_PCT,
    sellTaxPct: SELL_TAX_PCT,
    sellSlippagePct: SELL_SLIPPAGE_PCT,
    minimumFee: MIN_FEE
  });
  return (sell.net / buy.total - 1) * 100;
}

function outcome(trade, days) {
  const forward = trade.forwardPrices || [];
  if (forward.length <= days) return null;
  return netReturnPct(trade.entryPrice, forward[days].price);
}

function summarize(rows, days) {
  const values = rows.map(row => outcome(row, days)).filter(Number.isFinite);
  if (!values.length) return null;
  return {
    samples: values.length,
    averagePct: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    medianPct: round(median(values)),
    winRatePct: round(values.filter(value => value > 0).length / values.length * 100),
    gain5PctRate: round(values.filter(value => value >= 5).length / values.length * 100),
    loss3PctRate: round(values.filter(value => value <= -3).length / values.length * 100)
  };
}

function factorRows(trades) {
  const definitions = [
    ['量價狀態', trade => trade.priceVolumeState],
    ['20日均線上升', trade => String(Boolean(trade.ma20Rising))],
    ['向上穿越20日均線', trade => String(Boolean(trade.crossAboveMa20))],
    ['跌破後站回20日均線', trade => String(Boolean(trade.falseBreakdownReclaim))],
    ['回測20日均線支撐', trade => String(Boolean(trade.supportBounce))],
    ['20日均線乖離過大', trade => String(Boolean(trade.overextendedAboveMa20))],
    ['高檔爆量派發', trade => String(Boolean(trade.highVolumeDistribution))],
    ['單日量比區間', trade => {
      const value = trade.volumeRatio1To20;
      if (!Number.isFinite(value)) return null;
      if (value < 0.7) return '<0.7';
      if (value < 1) return '0.7-1.0';
      if (value < 1.5) return '1.0-1.5';
      if (value < 2) return '1.5-2.0';
      return '>=2.0';
    }],
    ['20日盤中動能', trade => {
      const value = trade.intradayMomentum20Pct;
      if (!Number.isFinite(value)) return null;
      if (value < 0) return '<0%';
      if (value < 3) return '0-3%';
      if (value < 6) return '3-6%';
      if (value < 10) return '6-10%';
      return '>=10%';
    }],
    ['20日隔夜動能', trade => {
      const value = trade.overnightMomentum20Pct;
      if (!Number.isFinite(value)) return null;
      if (value < -3) return '<-3%';
      if (value < 0) return '-3-0%';
      if (value < 3) return '0-3%';
      if (value < 6) return '3-6%';
      return '>=6%';
    }],
    ['接近年高區間', trade => {
      const value = trade.nearYearHigh;
      if (!Number.isFinite(value)) return null;
      if (value < 0.7) return '<70%';
      if (value < 0.8) return '70-80%';
      if (value < 0.9) return '80-90%';
      if (value < 0.97) return '90-97%';
      return '>=97%';
    }],
    ['布林通道位置', trade => {
      const value = trade.bollingerPercentB;
      if (!Number.isFinite(value)) return null;
      if (value < 0) return '<0';
      if (value < 0.5) return '0-0.5';
      if (value < 1) return '0.5-1.0';
      if (value < 1.2) return '1.0-1.2';
      return '>=1.2';
    }],
    ['布林通道寬度', trade => {
      const value = trade.bollingerBandwidthPct;
      if (!Number.isFinite(value)) return null;
      if (value < 8) return '<8%';
      if (value < 15) return '8-15%';
      if (value < 25) return '15-25%';
      return '>=25%';
    }],
    ['波動壓縮比', trade => {
      const value = trade.volatilityCompression5To20;
      if (!Number.isFinite(value)) return null;
      if (value < 0.6) return '<0.6';
      if (value < 0.9) return '0.6-0.9';
      if (value < 1.2) return '0.9-1.2';
      return '>=1.2';
    }],
    ['ATR波動區間', trade => {
      const value = trade.atr14Pct;
      if (!Number.isFinite(value)) return null;
      if (value < 2) return '<2%';
      if (value < 4) return '2-4%';
      if (value < 6) return '4-6%';
      return '>=6%';
    }],
    ['隨機指標K值', trade => {
      const value = trade.stochastic14;
      if (!Number.isFinite(value)) return null;
      if (value < 20) return '<20';
      if (value < 50) return '20-50';
      if (value < 80) return '50-80';
      return '>=80';
    }],
    ['方向趨勢', trade => String(Boolean(trade.directionalTrendUp))],
    ['Donchian二十日突破', trade => String(Boolean(trade.donchian20Breakout))],
    ['20日均線乖離區間', trade => {
      const value = trade.distanceToMa20Pct;
      if (!Number.isFinite(value)) return null;
      if (value < 0) return '<0%';
      if (value < 3) return '0-3%';
      if (value < 6) return '3-6%';
      if (value < 10) return '6-10%';
      return '>=10%';
    }]
  ];
  const output = [];
  for (const [factor, bucketOf] of definitions) {
    const buckets = new Map();
    for (const trade of trades) {
      const bucket = bucketOf(trade);
      if (bucket === null || bucket === undefined) continue;
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push(trade);
    }
    for (const [bucket, rows] of buckets) {
      const train = rows.filter(row => row.signalDate <= '2021-12-31');
      const test = rows.filter(row => row.signalDate >= '2022-01-01');
      const horizons = {};
      for (const days of [3, 5, 10]) {
        horizons[days] = {
          full: summarize(rows, days),
          train: summarize(train, days),
          test: summarize(test, days)
        };
      }
      const stable = [3, 5, 10].some(days => {
        const result = horizons[days];
        return result.train?.samples >= MIN_SAMPLE
          && result.test?.samples >= MIN_SAMPLE
          && result.train.averagePct >= 0.25
          && result.test.averagePct >= 0.25
          && result.full.medianPct > -1;
      });
      output.push({ factor, bucket, samples: rows.length, stable, horizons });
    }
  }
  return output.sort((a, b) => a.factor.localeCompare(b.factor, 'zh-Hant')
    || b.samples - a.samples);
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main() {
  const payload = JSON.parse(await fs.readFile(INPUT, 'utf8'));
  const trades = payload.candidateTrades || [];
  const factors = factorRows(trades);
  const report = {
    generatedAt: new Date().toISOString(),
    sourceGeneratedAt: payload.generatedAt,
    entryMode: payload.assumptions?.entryMode,
    candidates: trades.length,
    minimumStableSamplePerPeriod: MIN_SAMPLE,
    costAssumptions: {
      buyFeePct: BUY_FEE_PCT,
      sellFeePct: SELL_FEE_PCT,
      sellTaxPct: SELL_TAX_PCT,
      buySlippagePct: BUY_SLIPPAGE_PCT,
      sellSlippagePct: SELL_SLIPPAGE_PCT,
      minimumFee: MIN_FEE
    },
    factors
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const header = ['因子', '分組', '樣本數', '跨期穩定', '持有日', '區間', '平均淨報酬%', '中位數%', '勝率%', '上漲5%以上%', '下跌3%以上%'];
  const rows = [header];
  for (const factor of factors) {
    for (const days of [3, 5, 10]) {
      for (const period of ['full', 'train', 'test']) {
        const result = factor.horizons[days][period];
        rows.push([
          factor.factor,
          factor.bucket,
          result?.samples || 0,
          factor.stable ? '是' : '否',
          days,
          period === 'full' ? '全期' : period === 'train' ? '訓練期' : '驗證期',
          result?.averagePct,
          result?.medianPct,
          result?.winRatePct,
          result?.gain5PctRate,
          result?.loss3PctRate
        ]);
      }
    }
  }
  await fs.writeFile(CSV_OUTPUT, `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\n')}\n`, 'utf8');
  console.log(JSON.stringify({
    output: OUTPUT.pathname,
    csv: CSV_OUTPUT.pathname,
    candidates: trades.length,
    stableBuckets: factors.filter(row => row.stable).map(row => `${row.factor}:${row.bucket}`)
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
