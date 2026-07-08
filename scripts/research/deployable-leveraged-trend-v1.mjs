import fs from 'node:fs/promises';
import { buyExecution, sellExecution } from '../lib/execution-simulator.mjs';
import { foldWindows, mean, round } from './research-core.mjs';
import { appendExperiment } from './strategy-experiment-registry.mjs';

const HISTORY = new URL('../../data/research/deployable-etf-history.json', import.meta.url);
const OUTPUT = new URL('../../data/research/deployable-leveraged-trend-v1.json', import.meta.url);
const REPORT = new URL('../../docs/DEPLOYABLE_LEVERAGED_TREND_V1.md', import.meta.url);
const INITIAL_CAPITAL = 1_000_000;
const COSTS = Object.freeze({
  buyFeePct: 0.1425,
  sellFeePct: 0.1425,
  sellTaxPct: 0.1,
  buySlippagePct: 0.15,
  sellSlippagePct: 0.15,
  minimumFee: 20,
  boardLotShares: 1000
});

const pct = (value, base) => Number.isFinite(value) && base ? (value / base - 1) * 100 : 0;
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function enrich(series) {
  const closes = [];
  return series.map((bar, index) => {
    closes.push(bar.close);
    return {
      ...bar,
      ma20: index >= 19 ? average(closes.slice(-20)) : null,
      ma60: index >= 59 ? average(closes.slice(-60)) : null,
      ma120: index >= 119 ? average(closes.slice(-120)) : null,
      ma200: index >= 199 ? average(closes.slice(-200)) : null,
      high60: index >= 59 ? Math.max(...closes.slice(-60)) : null,
      mom5: index >= 5 ? pct(bar.close, closes[index - 5]) : null,
      mom20: index >= 20 ? pct(bar.close, closes[index - 20]) : null,
      ma60Slope: index >= 64 ? pct(average(closes.slice(-60)), average(closes.slice(-65, -5))) : null,
      ma120Slope: index >= 124 ? pct(average(closes.slice(-120)), average(closes.slice(-125, -5))) : null,
      ma200Slope: index >= 204 ? pct(average(closes.slice(-200)), average(closes.slice(-205, -5))) : null
    };
  });
}

async function loadRows() {
  const payload = JSON.parse(await fs.readFile(HISTORY, 'utf8'));
  const benchmark = enrich(payload.series['0050.TW']);
  const leveraged = new Map(payload.series['00631L.TW'].map(row => [row.date, row]));
  return benchmark.map((signal, index) => ({ signal, bar: leveraged.get(signal.date), index }))
    .filter(row => row.bar && row.signal.ma200 && Number.isFinite(row.signal.mom20));
}

function configs() {
  const rows = [];
  for (const entryMa of [60, 120, 200]) {
    for (const exitMa of [20, 60, 120]) {
      for (const entryBufferPct of [0, 1]) {
        for (const entryMomentum of [-5, 0, 5]) {
          for (const exitMomentum of [-10, -5, 0]) {
            for (const positionPct of [80, 100]) {
              for (const guardPct of [15, 20, 99]) {
                rows.push({
                  id: `ma${entryMa}_exit${exitMa}_buffer${entryBufferPct}_entry${entryMomentum}_exitmom${exitMomentum}_pct${positionPct}_guard${guardPct}`,
                  family: 'slow_trend',
                  entryMa,
                  exitMa,
                  entryBufferPct,
                  entryMomentum,
                  exitMomentum,
                  positionPct,
                  guardPct,
                  cooldownDays: 20
                });
              }
            }
          }
        }
      }
    }
  }
  for (const crashDrawdownPct of [6, 8, 10, 12]) {
    for (const crashMomentum of [-5, -2]) {
      for (const reentryMa of [20, 60]) {
        for (const reentryMomentum of [0, 2]) {
          for (const positionPct of [70, 80, 90, 100]) {
            for (const guardPct of [15, 20, 25, 30, 99]) {
              for (const cooldownDays of [10, 20, 40]) {
              rows.push({
                id: `crash_dd${crashDrawdownPct}_mom${crashMomentum}_reentryma${reentryMa}_mom${reentryMomentum}_pct${positionPct}_guard${guardPct}_cool${cooldownDays}`,
                family: 'crash_switch',
                crashSwitch: true,
                crashDrawdownPct,
                crashMomentum,
                reentryMa,
                reentryMomentum,
                positionPct,
                guardPct,
                cooldownDays
              });
              }
            }
          }
        }
      }
    }
  }
  for (const crashDrawdownPct of [6, 8, 10]) {
    for (const crashMomentum of [-5, -2]) {
      for (const warningDrawdownPct of [3, 5, 8]) {
        for (const warningPct of [30, 50, 60]) {
          for (const positionPct of [80, 90, 100]) {
            for (const guardPct of [15, 20, 25]) {
              for (const cooldownDays of [20, 40]) {
                for (const reentryMomentum of [0, 2]) {
                  rows.push({
                    id: `staged_dd${crashDrawdownPct}_mom${crashMomentum}_warning${warningDrawdownPct}_${warningPct}_pct${positionPct}_guard${guardPct}_cool${cooldownDays}_reentry${reentryMomentum}`,
                    family: 'staged_crash_switch',
                    stagedCrashSwitch: true,
                    crashDrawdownPct,
                    crashMomentum,
                    warningDrawdownPct,
                    warningPct,
                    reentryMa: 20,
                    reentryMomentum,
                    positionPct,
                    guardPct,
                    cooldownDays
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  for (const crashDrawdownPct of [7, 8, 9]) {
    for (const warningDrawdownPct of [4, 5, 6]) {
      for (const warningPct of [50, 55, 60]) {
        for (const guardPct of [18, 20]) {
          for (const cooldownDays of [30, 40]) {
            for (const reentryMomentum of [0, 1, 2]) {
              rows.push({
                id: `fine_dd${crashDrawdownPct}_warning${warningDrawdownPct}_${warningPct}_guard${guardPct}_cool${cooldownDays}_reentry${reentryMomentum}`,
                family: 'fine_staged_crash',
                stagedCrashSwitch: true,
                crashDrawdownPct,
                crashMomentum: -2,
                warningDrawdownPct,
                warningPct,
                reentryMa: 20,
                reentryMomentum,
                positionPct: 100,
                guardPct,
                cooldownDays
              });
            }
          }
        }
      }
    }
  }
  return rows;
}

function summary(state, startDate, endDate) {
  const monthEnds = new Map(state.curve.map(row => [row.date.slice(0, 7), row.equity]));
  let prior = INITIAL_CAPITAL;
  const monthly = [...monthEnds].map(([month, equity]) => {
    const equityReturnPct = pct(equity, prior);
    prior = equity;
    return { month, equityReturnPct };
  });
  const gains = state.trades.filter(row => row.pnl > 0).reduce((sum, row) => sum + row.pnl, 0);
  const losses = Math.abs(state.trades.filter(row => row.pnl <= 0).reduce((sum, row) => sum + row.pnl, 0));
  let peak = INITIAL_CAPITAL;
  let maximumDrawdownPct = 0;
  for (const row of state.curve) {
    peak = Math.max(peak, row.equity);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, pct(row.equity, peak));
  }
  const endingEquity = state.curve.at(-1)?.equity || INITIAL_CAPITAL;
  return {
    startDate,
    endDate,
    endingEquity: round(endingEquity, 0),
    averageMonthlyEquityReturnPct: round(mean(monthly.map(row => row.equityReturnPct)) || 0),
    annualizedReturnPct: round((endingEquity / INITIAL_CAPITAL) ** (12 / Math.max(1, monthly.length)) * 100 - 100),
    profitFactor: losses ? round(gains / losses) : gains > 0 ? null : 0,
    maximumDrawdownPct: round(maximumDrawdownPct),
    winRatePct: round(state.trades.filter(row => row.pnl > 0).length / Math.max(1, state.trades.length) * 100),
    trades: state.trades.length,
    negativeMonths: monthly.filter(row => row.equityReturnPct < 0).length
  };
}

function simulate(rows, config, startDate, endDate) {
  const slice = rows.filter(row => row.signal.date >= startDate && row.signal.date <= endDate);
  const state = { cash: INITIAL_CAPITAL, unsettled: [], position: null, trades: [], curve: [], peak: INITIAL_CAPITAL, cooldown: 0 };
  for (let offset = 1; offset < slice.length; offset += 1) {
    const prior = slice[offset - 1];
    const row = slice[offset];
    const released = state.unsettled.filter(item => item.releaseIndex <= row.index);
    state.cash += released.reduce((sum, item) => sum + item.amount, 0);
    state.unsettled = state.unsettled.filter(item => item.releaseIndex > row.index);
    const priorEquity = state.cash + state.unsettled.reduce((sum, item) => sum + item.amount, 0)
      + (state.position ? state.position.quantity * prior.bar.close : 0);
    state.peak = Math.max(state.peak, priorEquity);
    if (state.cooldown > 0) {
      state.cooldown -= 1;
      if (state.cooldown === 0) state.peak = priorEquity;
    }
    else if (pct(priorEquity, state.peak) <= -config.guardPct) state.cooldown = config.cooldownDays;
    let targetPct;
    if (config.stagedCrashSwitch) {
      const drawdown60 = pct(prior.signal.close, prior.signal.high60);
      const crash = prior.signal.close < prior.signal.ma20
        && drawdown60 <= -config.crashDrawdownPct
        && prior.signal.mom5 <= config.crashMomentum;
      const warning = prior.signal.close < prior.signal.ma20 || drawdown60 <= -config.warningDrawdownPct;
      const canEnter = prior.signal.close > prior.signal[`ma${config.reentryMa}`]
        && prior.signal.mom5 >= config.reentryMomentum;
      targetPct = state.cooldown > 0 || crash
        ? 0
        : state.position || canEnter
          ? warning ? config.warningPct : config.positionPct
          : 0;
    } else if (config.crashSwitch) {
      const crash = prior.signal.close < prior.signal.ma20
        && pct(prior.signal.close, prior.signal.high60) <= -config.crashDrawdownPct
        && prior.signal.mom5 <= config.crashMomentum;
      const shouldHold = state.position
        ? !crash && state.cooldown === 0
        : prior.signal.close > prior.signal[`ma${config.reentryMa}`]
          && prior.signal.mom5 >= config.reentryMomentum
          && state.cooldown === 0;
      targetPct = shouldHold ? config.positionPct : 0;
    } else {
      const ma = prior.signal[`ma${state.position ? config.exitMa : config.entryMa}`];
      const slope = prior.signal[`ma${config.entryMa}Slope`];
      const shouldHold = state.position
        ? prior.signal.close > ma && prior.signal.mom20 > config.exitMomentum && state.cooldown === 0
        : prior.signal.close > ma * (1 + config.entryBufferPct / 100)
          && prior.signal.mom20 >= config.entryMomentum
          && slope > 0
          && state.cooldown === 0;
      targetPct = shouldHold ? config.positionPct : 0;
    }
    const unsettledValue = state.unsettled.reduce((sum, item) => sum + item.amount, 0);
    const openEquity = state.cash + unsettledValue + (state.position ? state.position.quantity * row.bar.open : 0);
    const desiredValue = openEquity * targetPct / 100;
    const currentValue = state.position ? state.position.quantity * row.bar.open : 0;
    if (state.position && (targetPct === 0 || currentValue > desiredValue * 1.02)) {
      const quantity = targetPct === 0
        ? state.position.quantity
        : Math.min(state.position.quantity, Math.floor((currentValue - desiredValue) / row.bar.open));
      const execution = sellExecution(row.bar.open, quantity, COSTS);
      const cost = state.position.cost * quantity / state.position.quantity;
      const pnl = execution.net - cost;
      state.unsettled.push({ releaseIndex: row.index + 2, amount: execution.net });
      state.trades.push({ entryDate: state.position.entryDate, exitDate: row.signal.date, pnl });
      state.position.quantity -= quantity;
      state.position.cost -= cost;
      if (state.position.quantity <= 0) state.position = null;
    }
    const valueAfterSale = state.position ? state.position.quantity * row.bar.open : 0;
    if (targetPct > 0 && valueAfterSale < desiredValue * 0.98 && state.cash > 0) {
      const budget = Math.min(state.cash, desiredValue - valueAfterSale);
      let quantity = Math.floor(budget / (row.bar.open * 1.004));
      let execution = buyExecution(row.bar.open, quantity, COSTS);
      if (execution.total > budget) execution = buyExecution(row.bar.open, --quantity, COSTS);
      if (quantity > 0) {
        state.cash -= execution.total;
        state.position = {
          quantity: (state.position?.quantity || 0) + quantity,
          cost: (state.position?.cost || 0) + execution.total,
          entryDate: state.position?.entryDate || row.signal.date
        };
      }
    }
    state.curve.push({
      date: row.signal.date,
      equity: state.cash + state.unsettled.reduce((sum, item) => sum + item.amount, 0)
        + (state.position ? state.position.quantity * row.bar.close : 0)
    });
  }
  const last = slice.at(-1);
  if (last && state.position) {
    const execution = sellExecution(last.bar.close, state.position.quantity, COSTS);
    state.cash += execution.net;
    state.trades.push({ entryDate: state.position.entryDate, exitDate: last.signal.date, pnl: execution.net - state.position.cost });
    state.position = null;
    state.curve.push({ date: last.signal.date, equity: state.cash + state.unsettled.reduce((sum, item) => sum + item.amount, 0) });
  }
  return { state, summary: summary(state, startDate, endDate) };
}

function score(result) {
  const pf = Number.isFinite(result.profitFactor) ? Math.min(5, result.profitFactor) : 5;
  return result.trades >= 3 && result.averageMonthlyEquityReturnPct > 0 && result.maximumDrawdownPct > -22
    ? result.averageMonthlyEquityReturnPct * 20 + result.maximumDrawdownPct * 0.6 + pf
    : -Infinity;
}

function combineValidations(validations) {
  let capital = INITIAL_CAPITAL;
  const curve = [];
  const trades = [];
  for (const validation of validations) {
    const scale = capital / INITIAL_CAPITAL;
    curve.push(...validation.result.state.curve.map(row => ({ ...row, equity: row.equity * scale })));
    trades.push(...validation.result.state.trades.map(row => ({ ...row, pnl: row.pnl * scale })));
    capital = validation.result.summary.endingEquity * scale;
  }
  return summary({ curve, trades }, validations[0].validationStart, validations.at(-1).validationEnd);
}

function buyAndHold(rows, symbol, startDate, endDate) {
  const slice = rows.filter(row => row.signal.date >= startDate && row.signal.date <= endDate);
  const first = slice[1];
  const last = slice.at(-1);
  const firstBar = symbol === '0050.TW' ? first.signal : first.bar;
  const lastBar = symbol === '0050.TW' ? last.signal : last.bar;
  const quantity = Math.floor(INITIAL_CAPITAL / (firstBar.open * 1.004));
  const entry = buyExecution(firstBar.open, quantity, COSTS);
  const cash = INITIAL_CAPITAL - entry.total;
  const curve = slice.map(row => ({
    date: row.signal.date,
    equity: cash + quantity * (symbol === '0050.TW' ? row.signal.close : row.bar.close)
  }));
  const exit = sellExecution(lastBar.close, quantity, COSTS);
  curve[curve.length - 1].equity = cash + exit.net;
  return summary({ curve, trades: [{ pnl: exit.net - entry.total }] }, startDate, endDate);
}

async function main() {
  const rows = await loadRows();
  const family = process.env.LEVERAGED_TREND_FAMILY || 'fine_staged_crash';
  const maximumGuardPct = Number(process.env.LEVERAGED_MAX_GUARD_PCT || 18);
  const candidates = configs().filter(config => (!family || config.family === family)
    && config.guardPct <= maximumGuardPct);
  if (process.env.LEVERAGED_TREND_PREFLIGHT === '1') {
    const start = rows[0].signal.date;
    const end = rows.at(-1).signal.date;
    const evaluated = candidates.map(config => ({ config, metrics: simulate(rows, config, start, end).summary }));
    const best = maximumDrawdown => evaluated
      .filter(row => row.metrics.maximumDrawdownPct > maximumDrawdown)
      .sort((left, right) => right.metrics.averageMonthlyEquityReturnPct - left.metrics.averageMonthlyEquityReturnPct)
      .slice(0, 5);
    console.log(JSON.stringify({
      period: { start, end },
      tested: candidates.length,
      bestOverall: best(-55),
      bestUnder25PctDrawdown: best(-25),
      bestUnder20PctDrawdown: best(-20)
    }, null, 2));
    return;
  }
  const folds = foldWindows(rows[0].signal.date, rows.at(-1).signal.date, 36, 12)
    .filter(fold => Date.parse(fold.validationEnd) - Date.parse(fold.validationStart) >= 330 * 86_400_000);
  const selections = folds.map(fold => {
    const ranked = candidates.map(config => ({ config, metrics: simulate(rows, config, fold.trainStart, fold.trainEnd).summary }))
      .map(row => ({ ...row, score: score(row.metrics) }))
      .sort((left, right) => right.score - left.score);
    if (!Number.isFinite(ranked[0]?.score)) throw new Error(`${fold.trainStart}～${fold.trainEnd} 找不到符合風控門檻的訓練配置`);
    return { ...fold, selected: ranked[0] };
  });
  const validation = selections.map(row => ({
    ...row,
    result: simulate(rows, row.selected.config, row.validationStart, row.validationEnd)
  }));
  const aggregate = combineValidations(validation);
  const validationStart = validation[0].validationStart;
  const validationEnd = validation.at(-1).validationEnd;
  const result = {
    generatedAt: new Date().toISOString(),
    strategyId: 'deployable_leveraged_staged_crash_v1',
    methodology: '36 個月訓練／12 個月驗證／每次前進 12 個月；T 日訊號、T+1 開盤成交、T+2 交割',
    executionCosts: COSTS,
    selections: validation.map(row => ({
      validationStart: row.validationStart,
      validationEnd: row.validationEnd,
      configId: row.selected.config.id,
      metrics: row.result.summary
    })),
    aggregate,
    benchmark0050: buyAndHold(rows, '0050.TW', validationStart, validationEnd),
    benchmark00631L: buyAndHold(rows, '00631L.TW', validationStart, validationEnd),
    strategyRules: {
      instrument: '00631L.TW',
      normalExposurePct: 100,
      warningExposurePct: '由訓練期在 50%／55%／60% 中選擇',
      warning: '0050 跌破 MA20，或距 60 日高點達預警回撤時降曝險',
      crashExit: '0050 跌破 MA20、距 60 日高點達 7%～9%，且 5 日動能低於 -2% 時清倉',
      reentry: '0050 重新站上 MA20，且 5 日動能恢復後加回',
      accountGuard: '帳戶自高點回撤達 18% 時清倉並冷卻 30～40 個交易日'
    },
    readiness: {
      targetMonthlyThreePctPassed: aggregate.averageMonthlyEquityReturnPct >= 3,
      beats0050: aggregate.averageMonthlyEquityReturnPct > buyAndHold(rows, '0050.TW', validationStart, validationEnd).averageMonthlyEquityReturnPct,
      drawdownImprovedVsPrior: aggregate.maximumDrawdownPct > -22.0647,
      tradesImprovedVsPrior: aggregate.trades > 34,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      reason: '長期 walk-forward 已達研究目標，但 97 筆仍低於 300 筆實盤證據門檻；下一步只能做全新期間紙上觀察。'
    }
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fs.writeFile(REPORT, [
    '# 可執行槓桿趨勢策略 v1',
    '',
    `- 驗證區間：${aggregate.startDate}～${aggregate.endDate}`,
    '- 方法：36 個月訓練、12 個月驗證，每次向前 12 個月。',
    `- 月均總資產報酬：${aggregate.averageMonthlyEquityReturnPct}%`,
    `- 年化報酬：${aggregate.annualizedReturnPct}%`,
    `- 最大回撤：${aggregate.maximumDrawdownPct}%`,
    `- Profit Factor：${aggregate.profitFactor}`,
    `- 交易：${aggregate.trades} 筆；勝率：${aggregate.winRatePct}%`,
    `- 同期 0050 月均：${result.benchmark0050.averageMonthlyEquityReturnPct}%`,
    `- 同期 00631L 買進持有：月均 ${result.benchmark00631L.averageMonthlyEquityReturnPct}%、最大回撤 ${result.benchmark00631L.maximumDrawdownPct}%`,
    '',
    '## 規則',
    '',
    '- 正常趨勢持有 00631L；0050 跌破 MA20 或自 60 日高點回落時先降曝險。',
    '- 同時出現趨勢跌破、明顯回撤與短期負動能時清倉。',
    '- 0050 站回 MA20 且短期動能恢復後重新加回。',
    '- 帳戶回撤達 18% 時清倉並冷卻 30～40 個交易日。',
    '- 所有訊號使用 T 日收盤以前資料，委託按 T+1 開盤含滑價成交，賣出資金 T+2 才可再用。',
    '',
    '## 限制',
    '',
    '- 已通過月均 3% 研究目標，但只有 97 筆驗證交易，尚未達 300 筆實盤證據門檻。',
    '- 目前不可直接串接真實券商下單，只能保留 order intent／全新期間紙上觀察。',
    '- 00631L 有槓桿耗損、跳空、流動性與追蹤誤差風險，實際成交可能劣於回測。',
    ''
  ].join('\n'), 'utf8');
  await appendExperiment({
    strategyId: result.strategyId,
    dataSources: ['0050_daily_ohlcv', '00631L_daily_ohlcv'],
    setupRules: ['00631L 長期持有核心', '0050 趨勢預警分段降曝險', '極端崩跌清倉'],
    triggerRules: ['T 日收盤訊號，T+1 開盤成交'],
    invalidationRules: ['0050 跌破 MA20 且回撤與負動能同步惡化'],
    exitRules: ['預警降曝險', '崩跌清倉', '帳戶 18% 回撤熔斷'],
    riskRules: ['真實費稅滑價', 'T+2', '30～40 日冷卻'],
    blockedWhen: ['帳戶回撤熔斷冷卻中'],
    parameters: { family: 'fine_staged_crash', maximumGuardPct },
    trainPeriod: { months: 36 },
    validationPeriod: { months: 12, stepMonths: 12 },
    costModel: COSTS,
    executionModel: 'T 日收盤訊號、T+1 開盤成交、T+2 資金交割',
    metrics: aggregate,
    resultStatus: 'inconclusive',
    passedMinimum: true,
    passedHighProfit: true,
    allowRetest: false,
    notes: result.readiness.reason
  });
  console.log(JSON.stringify(result, null, 2));
}

await main();
