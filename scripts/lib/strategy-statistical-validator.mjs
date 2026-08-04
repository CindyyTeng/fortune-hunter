const round = (value, digits = 4) => Number(Number(value || 0).toFixed(digits));

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + (sorted[lower + 1] ?? sorted[lower]) * weight;
}

function logGamma(value) {
  const coefficients = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 0.000009984369578019572, 0.00000015056327351493116];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  let sum = 0.9999999999998099;
  const adjusted = value - 1;
  coefficients.forEach((coefficient, index) => { sum += coefficient / (adjusted + index + 1); });
  const base = adjusted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (adjusted + 0.5) * Math.log(base) - base + Math.log(sum);
}

function betaFraction(x, a, b) {
  const maximumIterations = 200;
  const epsilon = 3e-12;
  const minimum = 1e-30;
  const safe = value => Math.abs(value) < minimum ? (value < 0 ? -minimum : minimum) : value;
  let c = 1;
  let d = 1 / safe(1 - (a + b) * x / (a + 1));
  let result = d;
  for (let iteration = 1; iteration <= maximumIterations; iteration += 1) {
    const even = iteration * 2;
    let coefficient = iteration * (b - iteration) * x / ((a + even - 1) * (a + even));
    d = 1 / safe(1 + coefficient * d);
    c = safe(1 + coefficient / c);
    result *= d * c;
    coefficient = -(a + iteration) * (a + b + iteration) * x / ((a + even) * (a + even + 1));
    d = 1 / safe(1 + coefficient * d);
    c = safe(1 + coefficient / c);
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return result;
}

function regularizedBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logTerm = a * Math.log(x) + b * Math.log1p(-x) - logGamma(a) - logGamma(b) + logGamma(a + b);
  if (x < (a + 1) / (a + b + 2)) return Math.exp(logTerm) * betaFraction(x, a, b) / a;
  return 1 - Math.exp(logTerm) * betaFraction(1 - x, b, a) / b;
}

function twoSidedTTestPValue(tStatistic, degreesOfFreedom) {
  const ratio = degreesOfFreedom / (degreesOfFreedom + tStatistic ** 2);
  return regularizedBeta(ratio, degreesOfFreedom / 2, 0.5);
}

function randomGenerator(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function bootstrapMeans(values, samples, seed, centered) {
  const random = randomGenerator(seed);
  const baseline = centered ? average(values) : 0;
  const source = values.map(value => value - baseline);
  const means = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    for (let index = 0; index < source.length; index += 1) {
      total += source[Math.floor(random() * source.length)];
    }
    means.push(total / source.length);
  }
  return means;
}

export function evaluateTradeReturns(input, options = {}) {
  const values = input.map(value => Number(value)).filter(Number.isFinite);
  const minimumSamples = options.minimumSamples ?? 300;
  const bootstrapSamples = options.bootstrapSamples ?? 2000;
  const significance = options.significance ?? 0.05;
  const maximumTopProfitContributionPct = options.maximumTopProfitContributionPct ?? 50;
  if (!values.length) {
    return { sampleSize: 0, verdict: 'insufficient', passed: false, reason: '沒有可驗證的已平倉交易。' };
  }

  const mean = average(values);
  const sorted = [...values].sort((a, b) => a - b);
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
    : 0;
  const standardDeviation = Math.sqrt(variance);
  const tStatistic = standardDeviation ? mean / (standardDeviation / Math.sqrt(values.length)) : null;
  const tTestPValue = tStatistic === null ? (mean === 0 ? 1 : 0) : twoSidedTTestPValue(tStatistic, values.length - 1);
  const nullMeans = bootstrapMeans(values, bootstrapSamples, options.seed ?? 20260804, true);
  const bootstrapPValue = (nullMeans.filter(value => Math.abs(value) >= Math.abs(mean)).length + 1) / (bootstrapSamples + 1);
  const sampledMeans = bootstrapMeans(values, bootstrapSamples, (options.seed ?? 20260804) + 1, false).sort((a, b) => a - b);
  const gains = values.filter(value => value > 0).sort((a, b) => b - a);
  const topCount = Math.max(1, Math.ceil(values.length * 0.05));
  const totalGains = gains.reduce((sum, value) => sum + value, 0);
  const topContribution = totalGains
    ? gains.slice(0, topCount).reduce((sum, value) => sum + value, 0) / totalGains * 100
    : 100;
  const confidenceInterval95Pct = [percentile(sampledMeans, 0.025), percentile(sampledMeans, 0.975)].map(value => round(value));

  let verdict = 'statistical_edge';
  let reason = '正期望通過樣本數、顯著性、Bootstrap 與獲利集中度檢查。';
  if (mean <= 0) {
    verdict = 'negative_expectancy';
    reason = '平均交易報酬不為正。';
  } else if (values.length < minimumSamples) {
    verdict = 'insufficient';
    reason = `樣本僅 ${values.length} 筆，低於最低 ${minimumSamples} 筆。`;
  } else if (tTestPValue >= significance || bootstrapPValue >= significance || confidenceInterval95Pct[0] <= 0) {
    verdict = 'luck_suspected';
    reason = '正報酬未同時通過 t 檢定、置中 Bootstrap 與平均值信賴區間。';
  } else if (topContribution > maximumTopProfitContributionPct) {
    verdict = 'fragile_edge';
    reason = `前 5% 交易貢獻 ${round(topContribution)}% 獲利，結果過度集中。`;
  }

  return {
    sampleSize: values.length,
    meanReturnPct: round(mean),
    medianReturnPct: round(percentile(sorted, 0.5)),
    standardDeviationPct: round(standardDeviation),
    tStatistic: tStatistic === null ? null : round(tStatistic),
    tTestPValue: round(tTestPValue, 6),
    centeredBootstrapPValue: round(bootstrapPValue, 6),
    confidenceInterval95Pct,
    topFivePercentProfitContributionPct: round(topContribution),
    verdict,
    passed: verdict === 'statistical_edge',
    reason
  };
}

export function evaluateStrategyEvidence(trainTrades, validationTrades, options = {}) {
  const returns = trades => trades.map(trade => trade.tradeReturnPct);
  const train = evaluateTradeReturns(returns(trainTrades), options);
  const validation = evaluateTradeReturns(returns(validationTrades), options);
  const decayPct = train.meanReturnPct > 0
    ? (train.meanReturnPct - validation.meanReturnPct) / train.meanReturnPct * 100
    : null;
  const maximumDecayPct = options.maximumDecayPct ?? 50;
  const decayPassed = decayPct === null || decayPct <= maximumDecayPct;
  return {
    train,
    validation,
    outOfSampleDecayPct: decayPct === null ? null : round(decayPct),
    maximumAllowedDecayPct: maximumDecayPct,
    passed: train.passed && validation.passed && decayPassed,
    reason: !train.passed
      ? `訓練期：${train.reason}`
      : !validation.passed
        ? `驗證期：${validation.reason}`
        : !decayPassed
          ? `樣本外平均報酬衰減 ${round(decayPct)}%，超過 ${maximumDecayPct}%。`
          : '訓練與驗證均通過統計證據閘門。'
  };
}
