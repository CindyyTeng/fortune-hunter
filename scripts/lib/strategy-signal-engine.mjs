import fs from 'node:fs/promises';

const DEFAULT_SPECS = new URL('../../data/research/executable-strategy-specs.json', import.meta.url);
const REQUIRED_STRATEGY_FIELDS = [
  'strategyId',
  'name',
  'activationStatus',
  'requiredData',
  'setupRules',
  'triggerRules',
  'invalidationRules',
  'exitRules',
  'riskRules',
  'blockedWhen',
  'orderIntentTemplate'
];

function readPath(source, path) {
  return String(path).split('.').reduce((value, key) => value?.[key], source);
}

function compare(actual, operator, expected) {
  if (operator === 'eq') return actual === expected;
  if (operator === 'neq') return actual !== expected;
  if (operator === 'gt') return Number(actual) > Number(expected);
  if (operator === 'gte') return Number(actual) >= Number(expected);
  if (operator === 'lt') return Number(actual) < Number(expected);
  if (operator === 'lte') return Number(actual) <= Number(expected);
  if (operator === 'in') return Array.isArray(expected) && expected.includes(actual);
  if (operator === 'notIn') return Array.isArray(expected) && !expected.includes(actual);
  if (operator === 'between') {
    return Array.isArray(expected)
      && Number(actual) >= Number(expected[0])
      && Number(actual) <= Number(expected[1]);
  }
  if (operator === 'truthy') return Boolean(actual);
  if (operator === 'falsey') return !actual;
  throw new Error(`不支援的規則運算子：${operator}`);
}

function evaluateRule(rule, snapshot) {
  if (rule.all) {
    const rows = rule.all.map(item => evaluateRule(item, snapshot));
    return {
      matched: rows.every(row => row.matched),
      reasons: rows.flatMap(row => row.reasons),
      failures: rows.flatMap(row => row.failures)
    };
  }
  if (rule.any) {
    const rows = rule.any.map(item => evaluateRule(item, snapshot));
    const matchedRows = rows.filter(row => row.matched);
    return {
      matched: matchedRows.length > 0,
      reasons: matchedRows.flatMap(row => row.reasons),
      failures: matchedRows.length ? [] : rows.flatMap(row => row.failures)
    };
  }
  const actual = readPath(snapshot, rule.field);
  const matched = compare(actual, rule.operator, rule.value);
  return {
    matched,
    reasons: matched ? [rule.reason || `${rule.field} 符合條件`] : [],
    failures: matched ? [] : [{
      field: rule.field,
      operator: rule.operator,
      expected: rule.value,
      actual,
      reason: rule.reason || `${rule.field} 未符合條件`
    }]
  };
}

function evaluateAll(rules, snapshot) {
  const rows = (rules || []).map(rule => evaluateRule(rule, snapshot));
  return {
    matched: rows.every(row => row.matched),
    reasons: rows.flatMap(row => row.reasons),
    failures: rows.flatMap(row => row.failures)
  };
}

function evaluateAny(rules, snapshot) {
  const rows = (rules || []).map(rule => evaluateRule(rule, snapshot));
  return {
    matched: rows.some(row => row.matched),
    reasons: rows.filter(row => row.matched).flatMap(row => row.reasons),
    failures: rows.filter(row => !row.matched).flatMap(row => row.failures)
  };
}

export async function loadStrategySpecs(url = DEFAULT_SPECS) {
  const payload = JSON.parse(await fs.readFile(url, 'utf8'));
  if (!Array.isArray(payload.strategies)) throw new Error('策略規格缺少 strategies 陣列');
  for (const strategy of payload.strategies) {
    const missingFields = REQUIRED_STRATEGY_FIELDS.filter(field => strategy[field] === undefined);
    if (missingFields.length) {
      throw new Error(`${strategy.strategyId || '未命名策略'} 缺少欄位：${missingFields.join('、')}`);
    }
  }
  return payload;
}

export function generateStrategySignals({
  date,
  stocks,
  strategySpecs,
  availableData = [],
  approvedStrategyIds = [],
  simulationOnly = false
}) {
  const dataSet = new Set(availableData);
  const approved = new Set(approvedStrategyIds);
  const signals = [];

  for (const stock of stocks) {
    const snapshot = { ...stock, date };
    for (const strategy of strategySpecs.strategies) {
      const missingData = strategy.requiredData.filter(dataId => !dataSet.has(dataId));
      const setup = evaluateAll(strategy.setupRules, snapshot);
      const trigger = evaluateAll(strategy.triggerRules, snapshot);
      const invalidation = evaluateAny(strategy.invalidationRules, snapshot);
      const blocked = evaluateAny(strategy.blockedWhen, snapshot);
      const strategyApproved = approved.has(strategy.strategyId);
      const activationAllowed = strategy.activationStatus === 'ACTIVE' || simulationOnly;
      const executable = missingData.length === 0
        && strategyApproved
        && activationAllowed
        && !blocked.matched
        && setup.matched
        && trigger.matched
        && !invalidation.matched;
      let status = 'NO_SETUP';
      if (missingData.length) status = 'DATA_GAP';
      else if (!activationAllowed) status = strategy.activationStatus;
      else if (!strategyApproved) status = 'NOT_VALIDATED';
      else if (blocked.matched) status = 'BLOCKED';
      else if (invalidation.matched) status = 'INVALIDATED';
      else if (setup.matched && !trigger.matched) status = 'WAIT_TRIGGER';
      else if (executable) status = 'READY';

      signals.push({
        date,
        symbol: stock.symbol,
        name: stock.name,
        strategyId: strategy.strategyId,
        strategyName: strategy.name,
        activationStatus: strategy.activationStatus,
        status,
        executable,
        simulationOnly,
        missingData,
        setupMatched: setup.matched,
        triggerMatched: trigger.matched,
        invalidated: invalidation.matched,
        blocked: blocked.matched,
        setupReasons: setup.reasons,
        triggerReasons: trigger.reasons,
        invalidationReasons: invalidation.reasons,
        blockedReasons: blocked.reasons,
        setupFailures: setup.failures,
        triggerFailures: trigger.failures,
        strategy,
        snapshot
      });
    }
  }
  return signals;
}

export function summarizeSignalReadiness(signals) {
  return signals.reduce((summary, signal) => {
    summary[signal.status] = (summary[signal.status] || 0) + 1;
    return summary;
  }, {});
}
