# 法人歷史資料人工匯入

如果官方端點無法穩定回填 4 年法人歷史資料，請將人工下載的 CSV 放在本資料夾。

建議檔名：

- `twse-YYYYMMDD.csv`
- `tpex-YYYYMMDD.csv`

必要欄位：

- `date`
- `symbol`
- `name`
- `foreignBuy`
- `foreignSell`
- `foreignNetBuy`
- `trustBuy`
- `trustSell`
- `trustNetBuy`
- `dealerBuy`
- `dealerSell`
- `dealerNetBuy`
- `source`

匯入後仍必須執行資料驗證、去重、覆蓋率 audit，並套用 conservative point-in-time policy。
