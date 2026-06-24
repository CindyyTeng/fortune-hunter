# 月營收人工 CSV 匯入

官方歷史檔無法取得時，可將 CSV 放在本目錄後重新執行 `npm run data:build-revenue`。

必要欄位：`symbol/股票代號, stockName/股票名稱, market/市場, revenueMonth/營收月份, monthlyRevenue/當月營收`。可選欄位：`announcedDate/公布日期`。

若缺公布日期，程式採營收月份次月 10 日收盤後、下一交易日才可使用。人工檔不得使用模擬資料或無法確認版本時間的事後修正值。
