# 高報酬可執行策略搜尋

產生時間：2026-06-15T14:18:21.424Z

## 誠實結論

**找不到符合條件的高報酬可執行策略**

本分支建立的是可執行研究與下單意圖架構，不代表已找到可獲利策略。舊 OHLCV 結果月均總資產報酬 0.3285%、Profit Factor 1.2198、最大回撤 -13.2172%，雖通過部分基本門檻，但同期大盤月均 2.1784%，因此不合格。

## 舊 OHLCV 基準資格

條件 | 結果
--- | ---
月均總資產報酬高於大盤 | 未通過
Profit Factor 大於 1.15 | 通過
最大回撤小於 20% | 通過
交易樣本大於 300 | 通過
贏過公平隨機策略 | 通過
月均總資產報酬大於 2% | 未通過
Profit Factor 大於 1.3 | 未通過

## 六種策略就緒度

| 策略 | 完整資料需求 | 目前缺少資料 | 驗證狀態 | 已達標 |
| --- | --- | --- | --- | --- |
| 投信連買強勢股回檔策略 | daily_ohlcv、institutional_trust、industry_classification、theme_classification、market_regime、attention_disposition、price_limit | institutional_trust、industry_classification、theme_classification、attention_disposition、price_limit | NOT_TESTABLE_DATA_GAP | 否 |
| 外資與投信同步買超突破確認策略 | daily_ohlcv、institutional_foreign、institutional_trust、industry_classification、market_regime、attention_disposition、price_limit | institutional_foreign、institutional_trust、industry_classification、attention_disposition、price_limit | NOT_TESTABLE_DATA_GAP | 否 |
| 月營收成長加技術轉強策略 | daily_ohlcv、monthly_revenue、monthly_revenue_release_date、eps、gross_margin、operating_margin、financial_release_date、industry_classification、market_regime、attention_disposition | monthly_revenue、monthly_revenue_release_date、eps、gross_margin、operating_margin、financial_release_date、industry_classification、attention_disposition | NOT_TESTABLE_DATA_GAP | 否 |
| 高波動急跌後止穩反轉策略 | daily_ohlcv、market_regime、price_limit、corporate_actions | price_limit、corporate_actions | NOT_TESTABLE_DATA_GAP | 否 |
| 融資過熱排除加強勢股風控策略 | daily_ohlcv、margin_short、securities_lending、market_regime、attention_disposition、price_limit | margin_short、securities_lending、attention_disposition、price_limit | NOT_TESTABLE_DATA_GAP | 否 |
| 強勢族群內相對強勢股策略 | daily_ohlcv、industry_classification、theme_classification、theme_strength、market_regime、attention_disposition、price_limit | industry_classification、theme_classification、theme_strength、attention_disposition、price_limit | NOT_TESTABLE_DATA_GAP | 否 |

## BUY／SELL／HOLD／SKIP

1. BUY：資料齊備、策略已核准、setup 與 trigger 同時成立、沒有 blocked 或 invalidation，且進場價、停損、至少風險報酬比與部位上限都能合理計算。
2. SELL：已有該策略持倉，且 invalidation 或 blocked 條件成立。賣出意圖只允許賣出實際持有數量。
3. HOLD：已有該策略持倉，且尚未觸發失效或禁止條件；保留目前停損與停利計畫。
4. SKIP：缺資料、策略未驗證、策略仍是研究狀態、setup 未成立、trigger 尚未成立、風險計畫無法計算，或同一股票已由另一策略持有。

## 每日自動化流程

1. 收盤後更新價格、法人、融資券、基本面、族群與風險名單。
2. 驗證日期、欄位、重複資料、公司行動與 point-in-time 可用時間。
3. 策略訊號引擎產生 setup、trigger、invalidation 與 blocked 狀態。
4. 交易決策引擎輸出 BUY、SELL、HOLD、SKIP。
5. 依帳戶資金、單筆風險、停損距離、總曝險與市場狀態執行風控。
6. 下單意圖產生器輸出券商介面可讀但預設不送出的 order intent。
7. 先進入紙上交易或人工審核。
8. 未來由真實 broker adapter 轉換券商欄位並送單。
9. 回收成功、失敗、部分成交、漲跌停未成交與資金不足結果。
10. 記錄成交價、費稅、滑價、未成交數量與失敗原因。
11. 更新持倉、T+2 資金與交易日誌。
12. 每日計算策略、因子、成交品質與風險歸因。

## 現階段邊界

1. 所有 order intent 預設 `submitToRealBroker: false` 且需要人工核准。
2. Mock broker 只驗證介面與異常處理，不代表真實券商規格。
3. 缺少法人、族群、月營收與公告時間等資料時，相關策略一律輸出 SKIP。
4. 高波動反轉策略只有 OHLCV 研究基礎，仍標示 RESEARCH_ONLY，不能宣稱通過。
5. 未建立歷史下市股票池前，歷史研究仍有倖存者偏差。
