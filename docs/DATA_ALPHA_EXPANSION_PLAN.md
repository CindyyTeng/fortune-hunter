# Alpha 資料擴充與稽核計畫

產生時間：2026-06-15T14:16:52.472Z

## 結論

目前程式只有日線 OHLCV 與可由日線推導的市場狀態。法人、融資券、月營收、基本面、族群、注意處置、公司行動、分鐘資料與歷史股票池仍有缺口，因此六種策略都不得宣稱已完成或可投入真實交易。

資料來源只列候選管道。正式自動化前，必須逐項確認官方端點、授權範圍、歷史深度、更新時間、速率限制與商用條款，不以未經確認的網頁擷取代替授權。

## 策略資料就緒度

策略 | 規格狀態 | 缺少資料 | 可進入驗證 | 結論
--- | --- | --- | --- | ---
投信連買強勢股回檔策略 | DATA_GAP | institutional_trust、industry_classification、theme_classification、attention_disposition、price_limit | 否 | 資料尚未齊備，不可啟用或宣稱已完成
外資與投信同步買超突破確認策略 | DATA_GAP | institutional_foreign、institutional_trust、industry_classification、attention_disposition、price_limit | 否 | 資料尚未齊備，不可啟用或宣稱已完成
月營收成長加技術轉強策略 | DATA_GAP | monthly_revenue、monthly_revenue_release_date、eps、gross_margin、operating_margin、financial_release_date、industry_classification、attention_disposition | 否 | 資料尚未齊備，不可啟用或宣稱已完成
高波動急跌後止穩反轉策略 | RESEARCH_ONLY | price_limit、corporate_actions | 否 | 資料尚未齊備，不可啟用或宣稱已完成
融資過熱排除加強勢股風控策略 | DATA_GAP | margin_short、securities_lending、attention_disposition、price_limit | 否 | 資料尚未齊備，不可啟用或宣稱已完成
強勢族群內相對強勢股策略 | DATA_GAP | industry_classification、theme_classification、theme_strength、attention_disposition、price_limit | 否 | 資料尚未齊備，不可啟用或宣稱已完成

## 資料需求

優先序 | 資料 | 支援策略 | 自動化狀態 | 人工匯入 | 來源確認 | 候選來源 | 避免未來資料
--- | --- | --- | --- | --- | --- | --- | ---
1 | 分鐘資料 | 全部策略 | LICENSE_REQUIRED | 否 | REQUIRED | 券商行情 API、交易所授權行情、授權資料商 | 事件驅動回放必須依 timestamp 順序，不得用整根 K 棒同時知道高低價。
1 | 日線 OHLCV 與成交值 | 全部策略 | AVAILABLE_WITH_SOURCE_RISK | 否 | PARTIAL | TWSE OpenAPI、TPEx OpenAPI、券商 API、授權資料商 | 收盤策略只能在收盤資料 availableAt 後執行；盤中策略使用即時或分鐘資料。
1 | 月營收 | revenue_growth_technical_turn | CONDITIONAL | 否 | REQUIRED | MOPS、政府資料開放平台、授權資料商 | 以公司實際上傳時間 availableAt 生效，不以營收月份月底回填。
1 | 月營收公布日期 | revenue_growth_technical_turn | CONDITIONAL | 否 | REQUIRED | MOPS、政府資料開放平台、授權資料商 | 作為月營收與成長率的時間閘門。
1 | 外資買賣超 | foreign_trust_breakout_confirmation | CONDITIONAL | 否 | REQUIRED | TWSE OpenAPI、TPEx OpenAPI、授權資料商 | 不得把收盤後公告的外資資料用於同日盤中下單。
1 | 市場狀態 | 全部策略 | DERIVED | 否 | DEPENDS_ON_MARKET_DATA | 由大盤行情與市場廣度計算 | 僅用 signalDate 收盤前資料分類。
1 | 投信買賣超 | trust_accumulation_pullback、foreign_trust_breakout_confirmation | CONDITIONAL | 否 | REQUIRED | TWSE OpenAPI、TPEx OpenAPI、授權資料商 | 連買日數只由 availableAt 不晚於訊號時間的紀錄計算。
1 | 法人買賣超 | foreign_trust_breakout_confirmation、trust_accumulation_pullback | CONDITIONAL | 否 | REQUIRED | TWSE OpenAPI、TPEx OpenAPI、授權資料商 | 使用交易所實際公告時間；公告前不得回填到當日盤中訊號。
1 | 注意股與處置股 | trust_accumulation_pullback、foreign_trust_breakout_confirmation、revenue_growth_technical_turn、margin_heat_exclusion_strength、theme_relative_strength_leader | CONDITIONAL | 否 | REQUIRED | TWSE、TPEx | 依公告生效時間阻擋下單，保存歷史狀態。
1 | 財報公布日期 | revenue_growth_technical_turn | CONDITIONAL | 否 | REQUIRED | MOPS、授權資料商 | 作為所有財報欄位的時間閘門。
1 | 除權息 | 全部策略 | CONDITIONAL | 否 | REQUIRED | TWSE、TPEx、MOPS、授權資料商 | 行情還原與事件排除只能使用當時已公告資訊。
1 | 族群分類與強度 | theme_relative_strength_leader、trust_accumulation_pullback | DERIVED | 否 | DEPENDS_ON_CLASSIFICATION | 由歷史分類與成分股行情計算 | 只使用當日已存在的成分股與當日收盤前資料。
1 | 產業分類 | trust_accumulation_pullback、foreign_trust_breakout_confirmation、revenue_growth_technical_turn、theme_relative_strength_leader | CONDITIONAL | 否 | REQUIRED | TWSE、TPEx、授權資料商 | 保存分類生效區間，不能用目前分類回填十年前。
1 | 減資與分割 | 全部策略 | CONDITIONAL | 否 | REQUIRED | TWSE、TPEx、MOPS、授權資料商 | 保存原始價與還原因子版本，事件生效前不可套用。
1 | 漲跌停資料 | 全部策略 | CONDITIONAL | 否 | REQUIRED | TWSE、TPEx、券商行情 API | 每日開盤前由已知參考價與交易規則產生，成交模擬不得穿越漲跌停。
1 | 歷史下市股票池 | 全部策略 | SOURCE_PENDING | 可能需要 | REQUIRED | 交易所歷史名錄、授權資料商、人工整理 | 每天只允許使用當時已上市且可交易股票，避免倖存者偏差。
1 | 融資融券 | margin_heat_exclusion_strength | CONDITIONAL | 否 | REQUIRED | TWSE OpenAPI、TPEx OpenAPI、授權資料商 | 以公告後下一個可交易時點開始使用。
1 | 營收月增率 | revenue_growth_technical_turn | DERIVED | 否 | DEPENDS_ON_MONTHLY_REVENUE | 由月營收原始值計算 | 兩期營收均已公布後才計算。
1 | 營收年增率 | revenue_growth_technical_turn | DERIVED | 否 | DEPENDS_ON_MONTHLY_REVENUE | 由月營收原始值計算 | 兩期營收均已公布後才計算。
2 | 毛利率 | revenue_growth_technical_turn | CONDITIONAL | 否 | REQUIRED | MOPS、授權資料商 | 只能在財報 availableAt 後使用。
2 | 自營商買賣超 | foreign_trust_breakout_confirmation、theme_relative_strength_leader | CONDITIONAL | 否 | REQUIRED | TWSE OpenAPI、TPEx OpenAPI、授權資料商 | 分開保存自行買賣與避險部位，依公告時間生效。
2 | 借券與券資比 | margin_heat_exclusion_strength | CONDITIONAL | 否 | REQUIRED | TWSE、TPEx、授權資料商 | 使用原始公告版本，不用事後修訂值覆蓋歷史。
2 | 營益率 | revenue_growth_technical_turn | CONDITIONAL | 否 | REQUIRED | MOPS、授權資料商 | 只能在財報 availableAt 後使用。
2 | 題材分類 | trust_accumulation_pullback、theme_relative_strength_leader | SOURCE_PENDING | 可能需要 | REQUIRED | 人工維護、具授權的新聞或題材資料商 | 題材只能從當時已公開資訊建立，保留加入與移除時間。
2 | EPS | revenue_growth_technical_turn | CONDITIONAL | 否 | REQUIRED | MOPS、授權資料商 | 依財報公布時間生效，保留更正前後版本。

## 最優先三項

1. 法人分項買賣超：投信與外資資料可直接解鎖前兩個策略，也是檢驗籌碼 alpha 的第一步。
2. 產業／族群分類與每日族群強度：讓個股訊號能判斷是否有族群同步，而不是只看單股。
3. 月營收與實際公布時間：測試營收成長加技術轉強時，必須依公布時間做 point-in-time 對齊。

## 防止偷看未來

1. 所有資料必須保存 `availableAt` 或實際公告時間。
2. 訊號日只能讀取 `availableAt <= decisionAt` 的版本。
3. 財務資料不得回填到財報期間末；月營收不得回填到營收月份。
4. 公司行動、除權息與減資分割要同時保存公告日、生效日與調整方式。
5. 歷史股票池必須使用當時已上市櫃且可交易的股票，未補齊前持續標示倖存者偏差。
