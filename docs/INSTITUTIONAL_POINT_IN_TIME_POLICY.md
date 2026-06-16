# 法人資料 Point-in-time 政策

本專案目前尚未找到官方逐筆歷史 `publishedAt` 證據，因此不可宣稱法人資料是 fully verified point-in-time。

## 兩種標記

- `fullyVerifiedPointInTime`：只有取得逐筆歷史 `publishedAt` 證據時才可為 `true`。目前固定為 `false`。
- `conservativePointInTimeAssumption`：資料來源為官方日報，但缺少逐筆歷史 `publishedAt` 時使用。此模式只允許 T 日法人資料在 T+1 交易日使用。

## 保守假設

- `publishedAtAssumption`：`market_close_after_report`
- `publishedAt`：暫以 T 日 `18:00 +08:00` 記錄。
- `effectiveDate`：下一個交易日。
- `isPointInTimeSafe`：在保守假設下可設為 `true`，但必須同時保留 `pointInTimeMode: conservative_assumption`。
- `pointInTimeWarning`：必須說明逐筆歷史 `publishedAt` 待確認。

## 禁止事項

- 不允許 T 日盤中使用 T 日法人資料。
- 不允許 T 日收盤前使用 T 日法人資料。
- 不可把此模式包裝成 fully verified。

## 風險

若官方歷史資料曾修正，或實際公布時間晚於假設時間，回測仍可能偏樂觀。未來若取得官方逐筆公布時間，必須重新產生資料並重跑 walk-forward。
