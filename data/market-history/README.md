# 官方長期市場行情

資料來源為 TWSE 與 TPEx 官方每日收盤行情，原始回應與處理檔皆以 gzip 快取且不納入 Git。

- `raw/twse/`：TWSE 每日全市場普通股。
- `raw/tpex/`：TPEx 每日全市場普通股。
- `processed/YYYY.json.gz`：依年份、股票代號整理的 OHLCV。
- 僅保留四位數且第一碼不是 0 的普通股代號。
- 隔夜開盤跳空超過 15% 會標記 `corporateActionSuspected`；公司行動資料未補齊前不得在事件附近產生交易。
