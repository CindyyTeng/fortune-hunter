# 法人處理後資料

此目錄保存由 raw 官方資料轉換後的中間資料。

目前主要輸出仍是：

- `data/institutional/institutional-trades.json`
- `data/institutional/validation-report.json`

若官方來源沒有提供精確公布時間，處理後資料會標示 `isPointInTimeSafe: false`，或在明確啟用推定規則時寫入註記。
