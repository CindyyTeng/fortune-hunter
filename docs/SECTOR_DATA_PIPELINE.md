# 產業／族群資料管線

## 資料來源

- 上市：證交所 OpenAPI `t187ap03_L` 公司基本資料。
- 上櫃：櫃買中心 OpenAPI `mopsfin_t187ap03_O` 公司基本資料。
- 兩個來源均可自動取得現行股票代號、公司名稱與產業代碼。

## 時間點限制

這兩個端點提供的是現行分類，沒有每次產業異動的歷史生效日，因此模式標示為 `static_current_classification`，不是歷史 point-in-time 資料。把現行分類套回歷史會有分類變更與倖存者偏差，只能用於探索性研究，不能單獨作為紙上或實盤批准依據。

## 執行順序

1. `npm run data:probe-sector-sources`：探測來源並快取官方原始資料。
2. `npm run data:build-sector`：正規化上市／上櫃代號、名稱與產業代碼。
3. `npm run data:validate-sector`：檢查唯一鍵、必要欄位、覆蓋率與分類模式。
4. `npm run research:sector-institutional-alpha`：只測新增的族群＋法人策略家族。

## 族群強度

每個交易日只使用當日收盤以前的 OHLCV 計算產業 5／10／20 日平均報酬、上漲家數比例、創 20 日新高比例、成交值變化，以及個股相對產業／大盤強弱。每日按綜合分數排名，前 20% 標記為強勢族群。
