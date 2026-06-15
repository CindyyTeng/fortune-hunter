# 法人買賣超 point-in-time 資料

本目錄保存投信、外資與自營商逐檔買賣超資料。任何回測只能讀取已通過 `npm run data:validate-institutional` 的紀錄。

## 來源狀態

來源 | 狀態 | 說明
--- | --- | ---
證交所 T86 官方端點 | 待確認 | 官方端點可回傳上市股票逐檔三大法人資料，但歷史深度、實際公布時間、速率限制與自動化使用條款仍需確認。
櫃買中心 OpenAPI `tpex_3insti_daily_trading` | 待確認 | 官方 OpenAPI 有上櫃股票三大法人買賣明細；歷史深度與公布時間仍需確認。
使用者下載的官方 CSV／JSON | 需人工匯入 | 在來源條款與歷史 API 尚未確認前，這是最安全的正式匯入方式。
授權資料商或券商 API | 待確認 | 未選定供應商，需確認歷史資料、逐筆修訂、商用與自動交易授權。

官方入口：

- 證交所 OpenAPI：https://openapi.twse.com.tw/
- 證交所 T86：https://www.twse.com.tw/rwd/zh/fund/T86
- 櫃買中心 OpenAPI：https://www.tpex.org.tw/openapi/

## 必要時間欄位

- `date`：法人買賣超所屬交易日。
- `publishedAt`：該版本實際可被取得的時間。
- `effectiveDate`：策略最早可使用該資料交易的日期，必須晚於 `date`。
- `updatedAt`：這個版本被匯入或修訂的時間。
- `isPointInTimeSafe`：只有原始公布時間與生效日可驗證時才可為 `true`。

若官方檔案沒有公布時間，不可自行假裝知道。匯入時應補上可稽核的取得紀錄，否則驗證器會把資料列為不可回測。

## 匯入格式

支援 JSON 陣列、包含 `records` 的 JSON，或 UTF-8 CSV。英文欄名使用 `schema.json` 定義，也接受常見官方中文欄名。

```powershell
npm run data:import-institutional -- --input=C:\data\institutional.csv --date=2026-06-12 --source-status=需人工匯入 --published-at=2026-06-12T18:00:00+08:00 --effective-date=2026-06-15
```

若每列已有 `date`，可以省略 `--date`。證交所 T86 的自營商買進與賣出會將「自行買賣」及「避險」相加，再與總買賣超核對。

預設輸出：

`data/institutional/institutional-trades.json`

## 防止未來資料

1. 收盤後資料最早只能用於下一個可交易日。
2. `publishedAt` 必須早於 `effectiveDate` 開盤前。
3. 回測依版本時間選取當時已知的資料，不用後來修正值覆蓋歷史。
4. 同一 `date + symbol + publishedAt` 不可重複。
5. 買進減賣出必須等於買賣超，容許極小的格式誤差。
6. 缺少注意／處置股及公司行動資料時，只能標示風險，不能宣稱完整可實盤。
