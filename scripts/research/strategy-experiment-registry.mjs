import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REGISTRY = new URL('../../data/research/strategy-experiment-registry.json', import.meta.url);
const SCHEMA = new URL('../../data/research/strategy-experiment-registry.schema.json', import.meta.url);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

function hash(value) {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')
    .slice(0, 24);
}

export function buildExperimentIdentity(input) {
  const familyPayload = {
    strategyId: input.strategyId,
    dataSources: input.dataSources || [],
    setupRules: input.setupRules || [],
    triggerRules: input.triggerRules || [],
    invalidationRules: input.invalidationRules || [],
    exitRules: input.exitRules || [],
    riskRules: input.riskRules || {},
    blockedWhen: input.blockedWhen || []
  };
  const experimentPayload = {
    ...familyPayload,
    parameters: input.parameters || {},
    trainPeriod: input.trainPeriod || null,
    validationPeriod: input.validationPeriod || null,
    costModel: input.costModel || null,
    executionModel: input.executionModel || null
  };
  return {
    strategyFamilyId: `${input.strategyId || 'unknown'}:${hash(familyPayload)}`,
    experimentHash: hash(experimentPayload)
  };
}

async function readJson(url, fallback) {
  try {
    return JSON.parse(await fs.readFile(url, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function loadRegistry() {
  const registry = await readJson(REGISTRY, null);
  if (registry) return registry;
  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    experiments: []
  };
}

export function shouldSkipExperiment(registry, identity, input = {}) {
  const sameHash = registry.experiments.find(row => row.experimentHash === identity.experimentHash);
  if (sameHash) {
    return {
      skip: true,
      reason: '相同 experimentHash 已存在，不重複回測',
      matchedExperimentId: sameHash.experimentId
    };
  }
  const familyRows = registry.experiments
    .filter(row => row.strategyFamilyId === identity.strategyFamilyId);
  const failedFamily = familyRows.find(row =>
    ['failed', 'overfit'].includes(row.resultStatus)
    && row.allowRetest !== true
  );
  const hasNewDataSource = input.dataSources
    && failedFamily
    && input.dataSources.some(source => !(failedFamily.dataSources || []).includes(source));
  if (failedFamily && !hasNewDataSource && input.coreRulesChanged !== true) {
    return {
      skip: true,
      reason: '同一策略家族已在 validation 明確失敗，且沒有新增資料來源或核心規則改變',
      matchedExperimentId: failedFamily.experimentId
    };
  }
  return { skip: false, reason: '未找到需跳過的既有實驗' };
}

export async function appendExperiment(input) {
  const registry = await loadRegistry();
  const identity = buildExperimentIdentity(input);
  const skip = shouldSkipExperiment(registry, identity, input);
  if (skip.skip && input.force !== true) return { registry, identity, skip, appended: false };
  const row = {
    experimentId: `EXP-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${identity.experimentHash.slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    strategyId: input.strategyId,
    ...identity,
    dataSources: input.dataSources || [],
    parameters: input.parameters || {},
    trainPeriod: input.trainPeriod || null,
    validationPeriod: input.validationPeriod || null,
    costModel: input.costModel || null,
    executionModel: input.executionModel || null,
    metrics: input.metrics || null,
    resultStatus: input.resultStatus || 'inconclusive',
    failureReason: input.failureReason || null,
    overfitFlag: input.overfitFlag === true,
    passedMinimum: input.passedMinimum === true,
    passedHighProfit: input.passedHighProfit === true,
    allowRetest: input.allowRetest === true,
    notes: input.notes || ''
  };
  registry.experiments.push(row);
  registry.updatedAt = new Date().toISOString();
  await fs.writeFile(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  return { registry, identity, skip: { skip: false }, appended: true, row };
}

async function ensureSchema() {
  const exists = await readJson(SCHEMA, null);
  if (exists) return;
  const schema = {
    '$schema': 'https://json-schema.org/draft/2020-12/schema',
    title: '策略實驗紀錄',
    type: 'object',
    required: ['version', 'experiments'],
    properties: {
      version: { type: 'string' },
      generatedAt: { type: 'string' },
      updatedAt: { type: 'string' },
      experiments: {
        type: 'array',
        items: {
          type: 'object',
          required: ['experimentId', 'experimentHash', 'strategyFamilyId', 'strategyId', 'resultStatus'],
          properties: {
            experimentId: { type: 'string' },
            experimentHash: { type: 'string' },
            strategyFamilyId: { type: 'string' },
            strategyId: { type: 'string' },
            resultStatus: {
              type: 'string',
              enum: ['passed', 'failed', 'overfit', 'inconclusive', 'data_missing', 'skipped']
            }
          },
          additionalProperties: true
        }
      }
    },
    additionalProperties: true
  };
  await fs.writeFile(SCHEMA, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
}

async function main() {
  await ensureSchema();
  const registry = await loadRegistry();
  await fs.writeFile(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  const summary = registry.experiments.reduce((acc, row) => {
    acc[row.resultStatus] = (acc[row.resultStatus] || 0) + 1;
    return acc;
  }, {});
  console.log(`策略實驗 registry：${registry.experiments.length} 筆。`);
  console.log(`狀態摘要：${JSON.stringify(summary)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
