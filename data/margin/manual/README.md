# 融資融券人工 CSV 匯入

官方端點受限流時，可將 TWSE／TPEx 歷史資料轉成 CSV 放在本目錄，再執行 `npm run data:build-margin`。

必要欄位可使用英文或中文：

`date/日期, market/市場, symbol/股票代號, name/名稱, marginPrevious/前資餘額, marginBalance/融資餘額, marginQuota/融資限額, marginUtilizationRate/融資使用率, shortPrevious/前券餘額, shortBalance/融券餘額`

日期支援 `YYYY-MM-DD`、`YYYYMMDD` 與民國 `YYYMMDD`。資料仍會套用 T+1 保守時間點政策，並以 `date + market + symbol` 去重；人工檔不得使用事後修正或模擬資料。
