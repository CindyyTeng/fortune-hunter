# 法人資料人工 CSV 匯入指南

當 TWSE / TPEx 官方端點無法穩定回填歷史法人資料時，請使用人工 CSV fallback。

## 放檔位置

把 CSV 放到：

`data/institutional/manual/`

支援單日檔、多日檔與資料夾批次匯入。檔名建議：

- `twse-YYYYMMDD.csv`
- `tpex-YYYYMMDD.csv`

檔名不可包含 `mock`、`sample`、`demo`、`test`。

## 欄位

CSV 可使用英文欄位或常見中文欄位。必要欄位包含日期、股票代號、股票名稱、外資買進/賣出/買賣超、投信買進/賣出/買賣超、自營商買進/賣出/買賣超。

日期支援：

- `YYYY-MM-DD`
- `YYYY/MM/DD`
- `YYYYMMDD`
- 民國 `YYY/MM/DD`
- 民國 `YYYMMDD`

## 指令

先驗證：

```bash
npm run data:validate-manual-institutional
```

確認沒有錯誤後匯入：

```bash
npm run data:import-manual-institutional
```

匯入後再跑：

```bash
npm run data:validate-institutional
npm run data:audit-institutional-coverage
```

## Point-in-time

人工匯入資料會採用既有 conservative point-in-time policy：T 日資料只能於 T+1 交易日使用，不可用於 T 日盤中或收盤前。
