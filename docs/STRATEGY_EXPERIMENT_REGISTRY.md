# 策略實驗紀錄與查重

目的：每次回測前先計算 `experimentHash` 與 `strategyFamilyId`，避免重複測已失敗或完全相同的策略。

## 查重規則

1. 相同 `experimentHash` 已存在時，直接跳過。
2. 同一 `strategyFamilyId` 若 validation 明確失敗，且沒有新增資料來源或核心規則改變，不重測。
3. 只改小參數仍屬同一策略家族。
4. 新增法人、融資、月營收、產業族群等資料來源，才允許重測同策略家族。
5. train 有效但 validation 無效標示為 `overfit`。
6. 樣本數不足標示為 `inconclusive` 或 `data_missing`，不可宣稱成功。

## 未來接線

所有策略研究腳本應在大型回測前呼叫：

- `buildExperimentIdentity()`
- `loadRegistry()`
- `shouldSkipExperiment()`
- `appendExperiment()`

本階段先接入 `research:institutional-alpha`，後續再把舊研究腳本逐步改為同一套 registry。
