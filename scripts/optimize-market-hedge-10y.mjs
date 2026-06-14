import fs from 'node:fs/promises';
import {
  buyExecution as sharedBuyExecution,
  sellExecution as sharedSellExecution
} from './lib/execution-simulator.mjs';

const LONG_RESULT = new URL('../data/realized-strategy-diagnostics-10y.json', import.meta.url);
const OUTPUT = new URL('../data/market-hedge-search-10y.json', import.meta.url);
const HISTORY_OUTPUT = new URL('../data/market-regime-history-10y.json', import.meta.url);
const INITIAL_CAPITAL = 1_000_000;
const FEE_PCT = 0.1425;
const TAX_PCT = 0.3;
const SLIPPAGE_PCT = 0.15;
const MIN_FEE = 20;
const LOT = 1000;
const SETTLEMENT_DAYS = 2;

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function orderFee(price, quantity) {
  const fee = shares => shares
    ? Math.max(MIN_FEE, Math.ceil(price * shares * FEE_PCT / 100))
    : 0;
  const boardShares = Math.floor(quantity / LOT) * LOT;
  return fee(boardShares) + fee(quantity - boardShares);
}

function buyExecution(price, quantity) {
  return sharedBuyExecution(price, quantity, {
    buyFeePct: FEE_PCT,
    buySlippagePct: SLIPPAGE_PCT,
    minimumFee: MIN_FEE,
    boardLotShares: LOT
  });
}

function sellExecution(price, quantity) {
  return sharedSellExecution(price, quantity, {
    sellFeePct: FEE_PCT,
    sellTaxPct: TAX_PCT,
    sellSlippagePct: SLIPPAGE_PCT,
    minimumFee: MIN_FEE,
    boardLotShares: LOT
  });
}

function average(values, size) {
  if (values.length < size) return null;
  return values.slice(-size).reduce((sum, value) => sum + value, 0) / size;
}

async function fetchHistory(symbol) {
  const period1 = Math.floor(Date.parse('2015-06-01T00:00:00Z') / 1000);
  const period2 = Math.floor(Date.now() / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&includePrePost=false`;
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`${symbol}: ${response.status}`);
  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!result?.timestamp || !quote) throw new Error(`${symbol}: invalid history`);
  return result.timestamp.map((timestamp, index) => ({
    date: new Date(timestamp * 1000).toISOString().slice(0, 10),
    open: quote.open[index],
    close: quote.close[index]
  })).filter(row => Number.isFinite(row.open) && Number.isFinite(row.close));
}

function simulate(benchmark, inverseByDate, config, months) {
  let cash = INITIAL_CAPITAL;
  let realizedCapital = INITIAL_CAPITAL;
  let position = null;
  let unsettled = [];
  let riskDays = 0;
  const pnlByMonth = new Map(months.map(month => [month, 0]));
  const tradesByMonth = new Map(months.map(month => [month, 0]));
  const closes = [];

  for (let index = 0; index < benchmark.length; index += 1) {
    const day = benchmark[index];
    const inverse = inverseByDate.get(day.date);
    const released = unsettled.filter(item => item.releaseIndex <= index);
    cash += released.reduce((sum, item) => sum + item.amount, 0);
    unsettled = unsettled.filter(item => item.releaseIndex > index);
    if (!inverse || index < config.slowMa + config.confirmDays) {
      closes.push(day.close);
      continue;
    }

    const known = closes;
    const fast = average(known, config.fastMa);
    const slow = average(known, config.slowMa);
    const momentumBase = known.at(-1 - config.momentumDays);
    const momentum = momentumBase
      ? (known.at(-1) / momentumBase - 1) * 100
      : 0;
    const riskOff = fast < slow && momentum <= config.momentumThreshold;
    riskDays = riskOff ? riskDays + 1 : 0;
    const confirmed = riskDays >= config.confirmDays;
    const month = day.date.slice(0, 7);

    if (position && !confirmed) {
      const sell = sellExecution(inverse.open, position.quantity);
      const pnl = sell.net - position.cost;
      realizedCapital += pnl;
      pnlByMonth.set(month, (pnlByMonth.get(month) || 0) + pnl);
      tradesByMonth.set(month, (tradesByMonth.get(month) || 0) + 1);
      unsettled.push({ releaseIndex: index + SETTLEMENT_DAYS, amount: sell.net });
      position = null;
    } else if (!position && confirmed) {
      const budget = Math.min(cash, realizedCapital * config.allocationPct / 100);
      let quantity = Math.floor(budget / (inverse.open * (1 + SLIPPAGE_PCT / 100)));
      while (quantity > 0 && buyExecution(inverse.open, quantity).total > budget) quantity -= 1;
      if (quantity > 0) {
        const buy = buyExecution(inverse.open, quantity);
        cash -= buy.total;
        position = { quantity, cost: buy.total };
      }
    }
    closes.push(day.close);
  }

  let capital = INITIAL_CAPITAL;
  const monthly = months.map(month => {
    const pnl = pnlByMonth.get(month) || 0;
    const startCapital = capital;
    const row = {
      month,
      realizedPnl: round(pnl, 0),
      returnPct: round(pnl / startCapital * 100),
      trades: tradesByMonth.get(month) || 0
    };
    capital += pnl;
    return row;
  });
  return { config, monthly };
}

function stats(rows) {
  return {
    months: rows.length,
    hit: rows.filter(row => row.returnPct >= 10).length,
    negative: rows.filter(row => row.returnPct < 0).length,
    zero: rows.filter(row => row.returnPct === 0).length,
    average: round(rows.reduce((sum, row) => sum + row.returnPct, 0) / rows.length),
    worst: Math.min(...rows.map(row => row.returnPct))
  };
}

async function main() {
  const longPayload = JSON.parse(await fs.readFile(LONG_RESULT, 'utf8'));
  const longMonthly = longPayload.targetFirst.monthly.slice(1, -1);
  const months = longMonthly.map(row => row.month);
  const [benchmark, inverse] = await Promise.all([
    fetchHistory('0050.TW'),
    fetchHistory('00632R.TW')
  ]);
  const inverseByDate = new Map(inverse.map(row => [row.date, row]));
  await fs.writeFile(HISTORY_OUTPUT, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    benchmarkSymbol: '0050.TW',
    inverseSymbol: '00632R.TW',
    benchmark,
    inverse
  })}\n`, 'utf8');
  const results = [];

  for (const fastMa of [3, 5, 10, 20]) {
    for (const slowMa of [20, 40, 60, 120, 200]) {
      if (fastMa >= slowMa) continue;
      for (const momentumDays of [1, 3, 5, 10, 20]) {
        for (const momentumThreshold of [0, -1, -2, -3]) {
          for (const confirmDays of [1, 2, 3]) {
            for (const allocationPct of [10, 20, 30, 40, 50]) {
              const result = simulate(benchmark, inverseByDate, {
                fastMa,
                slowMa,
                momentumDays,
                momentumThreshold,
                confirmDays,
                allocationPct
              }, months);
              const complete = result.monthly;
              const combined = complete.map((row, index) => ({
                month: row.month,
                returnPct: round(longMonthly[index].returnPct + row.returnPct)
              }));
              result.hedge = stats(complete);
              result.combined = stats(combined);
              result.negativeMonthsImproved = combined.filter((row, index) => (
                longMonthly[index].returnPct < 0 && row.returnPct >= 0
              )).length;
              results.push(result);
            }
          }
        }
      }
    }
  }

  results.sort((a, b) => (
    a.combined.negative - b.combined.negative
    || b.combined.hit - a.combined.hit
    || b.negativeMonthsImproved - a.negativeMonthsImproved
    || b.combined.average - a.combined.average
    || b.combined.worst - a.combined.worst
  ));
  const output = {
    generatedAt: new Date().toISOString(),
    note: '組合結果為研究近似值；正式採用前須與多頭部位共用同一現金帳戶重跑。',
    combinations: results.length,
    benchmarkRows: benchmark.length,
    inverseRows: inverse.length,
    long: stats(longMonthly),
    best: results[0],
    top: results.slice(0, 100)
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    output: OUTPUT.pathname,
    combinations: output.combinations,
    long: output.long,
    best: {
      config: output.best.config,
      hedge: output.best.hedge,
      combined: output.best.combined,
      negativeMonthsImproved: output.best.negativeMonthsImproved
    }
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
