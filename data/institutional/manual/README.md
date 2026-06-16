# 法人歷史資料人工匯入

如果官方端點無法穩定回填 4 年法人歷史資料，請將人工下載的 CSV 放在本資料夾。

建議檔名：

- `twse-YYYYMMDD.csv`
- `tpex-YYYYMMDD.csv`

檔名不可包含 `mock`、`sample`、`demo`、`test`，避免測試資料被誤匯入。

必要欄位可用英文或中文：

- `date` / `日期`
- `symbol` / `證券代號`
- `name` / `證券名稱`
- `foreignBuy` / `外資買進`
- `foreignSell` / `外資賣出`
- `foreignNetBuy` / `外資買賣超`
- `trustBuy` / `投信買進`
- `trustSell` / `投信賣出`
- `trustNetBuy` / `投信買賣超`
- `dealerBuy` / `自營商買進`
- `dealerSell` / `自營商賣出`
- `dealerNetBuy` / `自營商買賣超`

流程：

1. 放入 CSV。
2. 執行 `npm run data:validate-manual-institutional`。
3. 沒有錯誤後執行 `npm run data:import-manual-institutional`。
4. 再執行法人資料驗證、去重、覆蓋率 audit。
