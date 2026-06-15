import fs from 'node:fs/promises';

const requirementsUrl = new URL('../../data/research/alpha-data-requirements.json', import.meta.url);
const specsUrl = new URL('../../data/research/executable-strategy-specs.json', import.meta.url);
const reportUrl = new URL('../../docs/DATA_ALPHA_EXPANSION_PLAN.md', import.meta.url);

const currentlyAvailableData = new Set([
  'daily_ohlcv',
  'market_regime'
]);

const requiredFields = [
  'dataId',
  'name',
  'supportsStrategies',
  'automationStatus',
  'manualImportRequired',
  'sourceConfirmation',
  'candidateSources',
  'schema',
  'noFutureDataControl',
  'priority'
];

function validateRequirement(row) {
  return requiredFields.filter(field => row[field] === undefined || row[field] === null);
}

function strategyAudit(strategy) {
  const missingData = strategy.requiredData.filter(dataId => !currentlyAvailableData.has(dataId));
  return {
    strategyId: strategy.strategyId,
    name: strategy.name,
    activationStatus: strategy.activationStatus,
    readyForValidation: missingData.length === 0 && strategy.activationStatus === 'ACTIVE',
    missingData,
    conclusion: missingData.length
      ? '資料尚未齊備，不可啟用或宣稱已完成'
      : strategy.activationStatus === 'ACTIVE'
        ? '資料齊備，可進入 walk-forward 驗證'
        : '資料齊備但策略仍未通過驗證'
  };
}

function markdown(payload, strategyAudits) {
  const requirementRows = payload.requirements
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, 'zh-Hant'))
    .map(row => [
      row.priority,
      row.name,
      row.supportsStrategies.join('、') || '共用資料',
      row.automationStatus,
      row.manualImportRequired ? '可能需要' : '否',
      row.sourceConfirmation,
      row.candidateSources.join('、'),
      row.noFutureDataControl
    ].join(' | '));
  const strategyRows = strategyAudits.map(row => [
    row.name,
    row.activationStatus,
    row.missingData.join('、') || '無',
    row.readyForValidation ? '是' : '否',
    row.conclusion
  ].join(' | '));
  return `# Alpha 資料擴充與稽核計畫

產生時間：${payload.audit.generatedAt}

## 結論

目前程式只有日線 OHLCV 與可由日線推導的市場狀態。法人、融資券、月營收、基本面、族群、注意處置、公司行動、分鐘資料與歷史股票池仍有缺口，因此六種策略都不得宣稱已完成或可投入真實交易。

資料來源只列候選管道。正式自動化前，必須逐項確認官方端點、授權範圍、歷史深度、更新時間、速率限制與商用條款，不以未經確認的網頁擷取代替授權。

## 策略資料就緒度

策略 | 規格狀態 | 缺少資料 | 可進入驗證 | 結論
--- | --- | --- | --- | ---
${strategyRows.join('\n')}

## 資料需求

優先序 | 資料 | 支援策略 | 自動化狀態 | 人工匯入 | 來源確認 | 候選來源 | 避免未來資料
--- | --- | --- | --- | --- | --- | --- | ---
${requirementRows.join('\n')}

## 最優先三項

1. 法人分項買賣超：投信與外資資料可直接解鎖前兩個策略，也是檢驗籌碼 alpha 的第一步。
2. 產業／族群分類與每日族群強度：讓個股訊號能判斷是否有族群同步，而不是只看單股。
3. 月營收與實際公布時間：測試營收成長加技術轉強時，必須依公布時間做 point-in-time 對齊。

## 防止偷看未來

1. 所有資料必須保存 \`availableAt\` 或實際公告時間。
2. 訊號日只能讀取 \`availableAt <= decisionAt\` 的版本。
3. 財務資料不得回填到財報期間末；月營收不得回填到營收月份。
4. 公司行動、除權息與減資分割要同時保存公告日、生效日與調整方式。
5. 歷史股票池必須使用當時已上市櫃且可交易的股票，未補齊前持續標示倖存者偏差。
`;
}

const payload = JSON.parse(await fs.readFile(requirementsUrl, 'utf8'));
const specs = JSON.parse(await fs.readFile(specsUrl, 'utf8'));
const invalidRows = payload.requirements
  .map(row => ({ dataId: row.dataId, missingFields: validateRequirement(row) }))
  .filter(row => row.missingFields.length);
if (invalidRows.length) {
  throw new Error(`Alpha 資料規格欄位不完整：${JSON.stringify(invalidRows)}`);
}

const strategyAudits = specs.strategies.map(strategyAudit);
payload.audit = {
  generatedAt: new Date().toISOString(),
  currentlyAvailableData: [...currentlyAvailableData],
  requirementCount: payload.requirements.length,
  invalidRequirementCount: invalidRows.length,
  readyStrategyCount: strategyAudits.filter(row => row.readyForValidation).length,
  strategyAudits
};

await fs.writeFile(requirementsUrl, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
await fs.writeFile(reportUrl, markdown(payload, strategyAudits), 'utf8');

console.log(`已稽核 ${payload.requirements.length} 種資料需求。`);
console.log(`可直接進入驗證的策略：${payload.audit.readyStrategyCount}。`);
console.log('結論：目前所有高報酬策略仍有資料缺口或尚未通過驗證。');
