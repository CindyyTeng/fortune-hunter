# 法人原始資料快取

此目錄保存官方來源回傳的原始檔案，供日後重建 processed dataset。

目錄：

- `twse/`：證交所 T86 原始 JSON。
- `tpex/`：櫃買中心 OpenAPI 原始 JSON。

原始檔必須保存 `fetchedAt`、`url`、`market`、`date`、HTTP 狀態與原始 payload。不要手動修改 raw 檔；若來源格式異常，應在 build 或 audit 報告中標記。
