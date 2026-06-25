# 獲利品質人工匯入

如果免費 API 無法穩定回填財報資料，可以把人工下載的 CSV 放在這個資料夾，然後執行 `npm run data:build-quality`。

支援欄位名稱：

- `symbol` 或 `股票代號`
- `stockName` 或 `公司名稱`
- `quarter` 或 `季度`，格式如 `2025Q1`
- `announcedDate` 或 `公布日`
- `EPS`
- `grossMargin` 或 `毛利率`
- `operatingMargin` 或 `營益率`
- `netMargin` 或 `稅後淨利率`
- `ROE`

時間點規則：若沒有精確公布時間，系統採保守假設，只能在公布日後下一個交易日使用。
