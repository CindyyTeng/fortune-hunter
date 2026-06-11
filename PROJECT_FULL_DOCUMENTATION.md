# Fortune Hunter 專案完整文件

> **文件優先順序（2026-06-11）：** 最新回測數字與策略結論以 `STRATEGY_RESEARCH_LOG.md` 為準。可信風險平衡結果為平均月已實現淨報酬 3.14%、28/119 個月達 10%、51 個負月份、最差月 -11.89%、最大回撤 -37.27%、333 筆交易。後文若出現舊版「月均 10.28%」，該結果已因成交價模擬錯誤作廢。

目前已加入 ATR、布林帶、隨機指標、DMI/DX、Donchian 突破、價量與盤中／隔夜動能，並測試黑天鵝隔日開盤清倉、同族群持倉上限和當月權益煞車。紙上交易也已具備報價新鮮度、交易時段、緊急停止、最大持倉、帳戶回撤、市場急跌與訂單冪等保護；尚未串接真實券商 API。

## 1. 專案目標

Fortune Hunter 提供台股中短期（5~10 個交易日，最長約兩週）選股與交易建議。  
輸出不是自動下單，而是「候選股 + 理由 + 進出場 + 風險控管」的決策輔助。

## 2. 系統架構

- 前端：`index.html`（純靜態頁）
- 資料產生器：`scripts/generate-data.mjs`
- 本機靜態伺服器：`scripts/serve.mjs`
- SSE 即時伺服器：`scripts/live-server.mjs`
- 主資料檔：`data/recommendations.json`

## 3. 執行流程（每日批次）

1. `generate-data.mjs` 讀取上市與上櫃股票池。
2. 依成交值排序，擷取各市場前 N 檔（預設各 180）。
3. 對每檔抓取 Yahoo 日 K（1 年，日線）。
4. 計算指標、型態、隔夜總體風險、隔夜族群風險、賣出警告、部位建議。
5. 產生分數與訊號，排序取前 7 檔。
6. 輸出到 `data/recommendations.json`。
7. 前端載入此 JSON 渲染卡片。

## 4. 資料來源與用途

### 4.1 台股日資料

- TWSE OpenAPI：上市日資料（價格、量、值）
- TPEX API：上櫃日資料（價格、量、值）
- 用途：建立掃描母池與基本行情欄位

### 4.2 歷史 K 線

- Yahoo Finance chart API（1y, 1d）
- 用途：均線、RSI、MACD、波動、動能、回測等計算

### 4.3 隔夜市場因子

- 總體：`^GSPC`、`^IXIC`、`^DJI`、`^SOX`
- 台股夜盤/ADR 情緒代理：`EWT`、`TSM`、`UMC`
- 記憶體代理：`MU`、`WDC`、`STX`
- 被動元件/電子零組件代理：`VSH`、`APH`、`TEL`、`GLW`
- AI 硬體代理：`NVDA`、`AMD`、`AVGO`、`SMCI`、`DELL`
- 電力設備代理：`ETN`、`PWR`、`GEV`、`VRT`、`HUBB`
- 用途：隔夜總體與族群風險加權，影響分數、賣出建議與右側夜盤顯示

### 4.4 即時報價

- `live-server.mjs` 優先使用 TWSE MIS 即時來源
- Yahoo quote 僅作 fallback（避免雲端環境限流造成失效）

### 4.5 交易模式回測

- `backtest-trade-modes.mjs` 用相同選股訊號比較不同買進與賣出模式。
- 買進模式包含隔天開盤市價、隔天限價、回測買進區間、突破近壓。
- 賣出模式包含固定持有、停損停利、分段停利加移動停利。
- 預設直接跑整個台股母池；只有在手動設定 `TRADE_MODE_FULL_UNIVERSE=0` 時才退回抽樣模式。
- 輸出檔為 `data/trade-mode-backtest.json`，用來決定哪種模式值得進入紙上交易或券商 API 階段。

## 5. 評分與篩選順序

1. 趨勢門檻：`close > MA20 > MA60`
2. 短中期節奏：`close >= MA5 >= MA20`
3. 量能條件：先分開判斷流動性與量比；`volume > 100000` 只代表好進出，`volumeRatio` 才代表是否真的放量
4. 動能與熱度：10/20/60 日漲跌幅、RSI、MACD
5. 波動結構：20/60 日波動對比
6. 強勢結構：12-1 動能、near-year-high、20 日回撤
7. 型態加減分：多頭/空頭/等待型態
8. 隔夜風險修正：美股總體、台股 ADR/ETF 情緒與族群代理變化
9. 賣出警告扣分：高/中警告會拉低總分
10. 價格行為 SOP 因子：支撐壓力轉換、長紅/長黑關鍵價、均線扣抵、均線發散、拉回均線支撐、量比、竭盡風險、風險報酬比

最後分數 clamp 到 `0~100`，並依條件給 `買入候選 / 偏多觀察 / 等待進場`。
如果仍有低等級賣出警告或多個風險，會額外套用分數上限，避免看起來像滿分但其實有明確風險。

`買入候選` 不是只看分數，還要通過硬條件：

- 趨勢：`close > MA20 > MA60`
- 短線結構：`close >= MA5 >= MA20`
- 量能：流動性足夠，且量比不低於 0.9
- 動能：20 日動能為正，或 10 日動能夠強
- 空間：近 25 日壓力上方空間至少約 4%，或已有效突破壓力
- 報酬：預估風險報酬比至少 1.1，且目標價會受上方壓力限制
- 強弱：RSI 不低於 45
- 風險：20 日漲幅不過熱，賣出警告不是高等級

若硬條件沒過，分數最高只保留到 72，避免等待進場的標的仍看起來像高分推薦。

## 6. 持有週期、出場與回測紀律

持有週期由三項決定：

- 波動（`std20`）
- 型態強弱（`patternScore`）
- 隔夜風險（`overnightScore`）

輸出為：

- 5 天：高波動或風險偏弱
- 7 天：一般中短期
- 10 天：趨勢與型態強、隔夜風險中性偏多

`plan.exitWarning` 會依 5/7/10 天給不同節奏；若賣出警告達中/高，改用更防守的出場指示。

回測不只顯示在畫面，也會反向修正策略：

- 若近期相似高分訊號 3 日或 10 日快速轉弱，候選股會被扣分。
- 若相似訊號出現 10 日報酬低於 -6% 且最大漲幅小於 1%，代表沒有給足出場機會，會直接降成「等待進場」。
- 這是為了避免「分數很高，但最近同樣條件剛失效」的股票仍排在前面。

但回測不是唯一防線。若某次失敗暴露出策略本身太鬆，會優先修正前段條件。中興電 2026-02-26 的檢討，把「流動性」和「放量」拆開，並把 MA5/MA20、RSI、20 日動能納入硬條件，避免弱反彈被當成高品質買點。中信金、元大金、世禾案例則補上 `close >= MA5`、壓力空間與壓力限制後的風險報酬比，避免短線轉弱或上方空間不足仍維持高分。

## 6.1 2026-06 歷史回測後的策略修正

本次沒有先推進紙上交易，而是先檢討兩年完整台股歷史回測。原因是歷史資料已經出現「訊號分數很高，但後續績效很差」的案例，這代表問題在選股與進場條件本身，而不是單純把失敗案例降級。

回測診斷後，主要問題不是持有天數本身，而是候選股前段過濾太鬆：

- `RSI < 60`：最新兩年回測顯示續航力不足，容易占用資金但貢獻很低。
- `RSI > 78`：短線過熱，容易追到相對高點。
- `std20 >= 5%` 且 `avg20TradeValue < 100,000,000`：波動大但成交值不足，容易出現大幅回撤。
- `score` 不能單獨決定買入，必須通過硬條件。

已套用到 `scripts/generate-data.mjs`：

- `買入候選` 需符合 `RSI 60~78`。
- 高波動低流動性標的不能成為 `買入候選`。
- 新增 `metrics.avg20TradeValue`，用來記錄 20 日均成交值。
- 若條件不通過，即使分數高，也會被壓回 `等待進場` 或 `偏多觀察`。

修正後完整台股兩年情境回測：

- 訊號數：`932 -> 839`
- 最大單筆虧損：`-20.34% -> -12.76%`
- 獲利因子：`2.82 -> 2.99`
- 平均淨報酬：`6.15% -> 5.91%`

這代表策略少賺一點平均報酬，但明顯降低高分訊號的大虧損風險，因此目前採用這版作為後續紙上交易與正式 API 前的基準。

## 6.2 2026-06 突破觸發、最多持有 5 天與移動停利

後續回測發現，管理式出場版本雖然風控較嚴，但兩年全市場只剩 6 筆交易，樣本數太少，不能作為穩定策略。

新的回測基準改為：

- 進場：隔日盤中突破近壓力價 `+0.5%` 後觸發。
- 出場：最多持有 5 個交易日，觸及停損或收盤移動停利時提前出場。
- 不再用「連續兩天跌破 5 日線」過早洗出。
- 保留大盤/族群逆風過濾。
- 保留低流動性、高波動、RSI 過弱/過熱等防呆。

參數比較後，固定持有 5 天比 3 天與 7 天更平衡：

- 3 天：最大虧損較小，但平均報酬下降。
- 5 天：獲利因子最高，報酬與風控較平衡。
- 7 天：平均報酬略高，但最大虧損較差。

最終全市場兩年回測：

- 區間：`2024-06-05` 到 `2026-06-05`
- 掃描：`1,955` 檔
- 交易：`56` 筆
- 勝率：`55.36%`
- 平均淨報酬：`3.46%`
- 中位數淨報酬：`0.85%`
- 獲利因子：`2.43`
- 最大單筆獲利：`48.68%`
- 最大單筆虧損：`-13.22%`

這版不是最終自動交易版本，但已比前一版更適合作為後續紙上交易與盤中監控測試基準。

## 6.3 2026-06 月均 10% 目標檢討

本次把回測從「單筆交易績效」升級成「資金曲線與每月績效」。

原因：

- 單筆平均報酬高，不代表每個月都能賺錢。
- 若交易集中在少數月份，全年總報酬可能漂亮，但月均目標仍不穩。
- 若只靠放大部位達標，最大回撤會快速惡化。

正式回測現在納入：

- 買進手續費 `0.1425%`
- 賣出手續費 `0.1425%`
- 證券交易稅 `0.3%`
- 買進滑價 `0.15%`
- 賣出滑價 `0.15%`
- 初始資金、單筆部位比例、最多同時持股數
- 每月報酬、達標月份、虧損月份、資金最大回撤

目前最佳方向仍是：

- 盤中突破近壓力 `+0.5%` 後進場。
- 最多持有 5 個交易日；若盤中觸及規劃停損則提前出場。
- 收盤淨報酬曾達 `3%` 後，若自高點回落 `5` 個百分點則提前停利，約 `1%` 作為最低獲利保護參考。
- 20 日均成交值低於 `1 億` 的標的不納入正式候選。
- 排除低價、低成交值、低波動、過高波動、過大日振幅。
- 使用突破價限價觸發假設；此假設未來必須用盤中資料或紙上交易驗證。
- 若同市場/同族群偏弱，或隔日開盤為負跳空，暫停開新倉或降部位，不再用滿倉硬做。
- 美股、Nasdaq、Dow、SOX、日經、韓國 KOSPI、KOSDAQ 會合成全球與亞洲風險分數，避免美股或日韓股市急跌後仍追台股。
- 記憶體、被動元件、半導體、AI 硬體、電力設備等族群代理會影響同題材個股，避免單股技術面漂亮但題材正在退潮。
- 採用零股/分散型資金模型：標準計畫部位上限 `44%`，防守與偏多觀察計畫上限各 `20%`，最多同時持股 `8` 檔；實際部位依停損距離縮小，確保單筆停損風險不超過帳戶 `2%`。
- 同日多檔觸發時，不再用股票代號決定資金順序；改以隔日開盤相對前收的突破幅度優先，再比較訊號分數。
- 買入候選必須在同市場、同族群、全球、亞洲與隔日開盤五項中至少兩項轉強；環境幾乎全面逆風時，即使個股分數高也空手。
- 偏多觀察必須在同市場、同族群、全球、亞洲與隔日開盤五項中至少四項轉強，才允許探索進場；不足四項直接空手。
- 回測抓 `5y` 歷史資料作為指標暖機，但績效只統計最近兩年，避免前幾個月因 K 線不足而交易數為 0。

最新正式兩年全市場回測：

- 區間：`2024-06-09` 到 `2026-06-09`
- 掃描：`1,953` 檔
- 候選交易：`416` 筆
- 實際執行交易：`157` 筆
- 勝率：`73.25%`
- 平均單筆淨報酬：`7.83%`
- 獲利因子：`7.43`
- 平均月報酬：`10.28%`
- 目標月報酬：`10%`
- 達標月份：`11`
- 虧損月份：`1`
- 最佳月份：`59.76%`
- 最差月份：`-0.81%`
- 資金最大回撤：`-6.43%`

結論：

回測已改用逐日市價評價，不再讓月底持倉停留在成本價。加入流動性、環境確認、重大風險空手、收盤移動停利、同日資金排序與單筆帳戶風險 `2%` 硬限制後，正式結果為月均 `10.28%`、達標月份 `11`、虧損月份 `1`、最差月 `-0.81%`、最大回撤 `-6.43%`。

### 6.4 每月都達 10% 的檢討

本輪額外測試了三個方向：

- 低把握月份空手：可以降低負月份傷害，但空手只能讓報酬接近 0%，不能讓沒有機會的月份自然達到 10%。
- 反向 ETF 避險：以 `00632R` 測試全球/亞洲風險偏弱時進行短期避險，結果月均報酬與回撤都變差，因此不納入正式策略。
- 放大部位：可讓少數好月份更漂亮，但仍無法讓每個月份都達標，且會使最大回撤明顯惡化。
- 修正逐日市價評價後的正式基準：平均月報酬 `9.47%`、負月份 `6`、最大回撤 `-9.96%`。
- 採用 1 億流動性門檻與收盤移動停利後：平均月報酬 `11.20%`、負月份 `3`、最大回撤 `-7.20%`。
- 再要求偏多觀察至少四項環境確認後：平均月報酬 `10.45%`、負月份 `2`、最差月份 `-0.86%`、最大回撤 `-7.76%`。
- 買入候選也要求至少兩項環境確認後：平均月報酬 `10.49%`、負月份 `1`、最差月份 `-0.39%`、最大回撤維持 `-7.76%`。
- 改以突破幅度分配同日有限資金，並採 `44% / 12% / 12%` 部位後：平均月報酬 `10.37%`、達標月份 `11`、負月份 `1`、最大回撤 `-7.71%`。
- 加入單筆帳戶風險 `2%` 硬限制，並把防守與探索計畫上限調為 `20%` 後：平均月報酬 `10.28%`、達標月份 `11`、負月份 `1`、最差月份 `-0.81%`、最大回撤改善至 `-6.43%`。

結論是：反向避險沒有證明有效時，寧可維持現金；停損無效時也不得進場。但空手門檻不能過寬，否則會錯殺大量正期望交易。最新版本平均月報酬超過 10%，有 11 個月份達標。`2024-08`、`2025-01`、`2025-03`、`2025-04`、`2025-05` 因無合格訊號而空手為 `0%`，剩餘負月份只有 `2025-11 -0.81%`。

`2025-11` 的負值主要來自月底仍持有部位的保守清算價值：市價評價已預扣假設賣出成本。相關跨月部位於 12 月實際出場包含長榮鋼 `+0.72%`、新興 `+22.02%`、慧洋-KY `+8.66%`、欣興 `+15.87%`。測試禁止月底進場會同時刪除後續大贏家，因此不採用，也不修改會計口徑掩飾負值。

## 7. 賣出警告機制

`buildSellWarning` 綜合以下條件：

- 空頭型態數量與強度
- 跌破 5 日線、20 日線
- MA5 仍低於 MA20 的弱反彈
- RSI 過熱或偏弱
- 短期漲幅過熱
- 近 5 日急彈但 20 日動能未轉正
- 反彈量比不足
- 60 日相對位置過高
- 波動異常升高
- 價格行為 SOP 觸發的支撐跌破、長紅低點失守、假突破、壓力、竭盡風險

輸出：

- `level`: 無 / 低 / 中 / 高
- `reasons[]`: 觸發原因
- `action`: 實際出場建議（會影響 plan）

等級門檻為低 >= 7、中 >= 14、高 >= 24。若只是單一輕微風險，例如 20 日波動偏高，可能會出現在 reasons，但仍顯示 `無`，代表還不到正式賣出警告。

## 8. 價格行為 SOP 整合

PDF 中的觀念整理成 `analyzePriceActionSop`。這個函式只放可以用日線資料驗證的規則，不做主觀猜測：

- 原壓力突破後不跌回，視為壓力轉支撐加分。
- 收盤貼近近 25 日壓力但未有效突破時，視為追價空間不足。
- 跌破近 20 日支撐，加入風險與賣出警告。
- 近期長紅低點守住加分，跌破則視為多方防線失守。
- 近期長黑高點被突破加分，碰到長黑高點壓回則扣分。
- 收盤價高於 5/10/20 日均線扣抵值，代表均線續揚機率提高。
- 均線糾結後向上發散加分，糾結未表態則提醒不要重倉。
- 拉回上揚 5 日線或 20 日線守住加分。
- 量比放大且收盤不弱加分，量能不足時提醒突破容易失真。
- 高檔放量但留下上影線或黑 K，視為可能竭盡點。
- 跌深後放量長下影線，視為短線止穩觀察。
- 風險報酬比會用上方壓力限制目標價；若壓力太近，會提醒等更靠近支撐再操作。

這些規則會影響分數、進場依據、風險提醒與賣出警告，但不取代原本趨勢、型態與隔夜風險。

## 9. 前端 UI/UX

- 卡片採「摘要列 + 詳細內容」兩層結構
- 收合後仍可看見：
- 股票名稱
- 代號與市場別
- 推薦分數
- 訊號
- 賣出警告等級
- 最新收盤價
- 近 10 日漲幅
- 型態傾向
- 建議持有天數
- 預設展開前 2 檔，其餘收合，降低長頁面負擔
- 展開後右側面板會固定顯示：
- 賣出警告等級與警戒分
- 出場應對與停損條件
- 主要風險（若沒有賣出警告原因，改顯示一般風險提醒）
- 隔夜影響（美股、科技、台股 ADR/ETF、費半、道瓊、對應族群）
- 回測參考
- 每檔展開後會先顯示「何時買、何時賣、何時停損、持有多久」
- 指標、進場依據、風險提醒與完整操作收在折疊區，避免第一眼資訊過載
- 指標矩陣會顯示價格行為 SOP 因子、均線扣抵通過數、量比、風險報酬比、近 20 日支撐與近 25 日壓力

## 10. 更新頻率

- 批次推薦：每次執行 `npm run generate` 或 GitHub Actions 觸發時更新
- 即時報價：`live-server` 依 `POLL_MS`（預設 8000ms）輪詢並 SSE 推送

## 11. 部署與環境變數

### GitHub Pages

- 提供靜態前端與 `data/recommendations.json`

### Render（live-server）

- `npm run live`
- 建議 env：
- `POLL_MS=8000`
- `ALLOW_ORIGIN=*`
- `MAX_SYMBOLS=7`

### 交易模式回測

- `npm run backtest:modes`
- `TRADE_MODE_FULL_UNIVERSE=0` 可改回抽樣模式
- `TRADE_MODE_SYMBOLS_PER_MARKET=80` 可調整上市/上櫃各自掃描檔數。
- `TRADE_MODE_RANGE=2y` 可調整 Yahoo 歷史資料區間。
- `TRADE_MODE_CONCURRENCY=5` 可調整併發抓取數。

## 12. 驗證清單

每次改版建議固定跑：

1. `npm run check`
2. `npm run generate`
3. 開 `http://localhost:4173` 檢查：
- 卡片收合後是否仍顯示個股摘要列
- 持有週期是否有 5/7/10 差異
- `exitWarning` 是否依週期與風險變化
- SSE 連線後是否可更新即時欄位
## 2026-06 Trade Mode Backtest Update

Purpose:

- Compare execution styles before any paper trading or broker API work.
- Measure whether execution choice destroys or preserves the signal edge.

Command:

```bash
npm run backtest:modes
npm run backtest:scenarios
npm run diagnose:best-mode
```

Default scope:

- full Taiwan stock universe
- last 2 years of daily data

Execution modes:

- Entry:
  - `next_open_market`
  - `next_open_limit`
  - `pullback_entry`
  - `resistance_breakout`
- Exit:
  - `fixed_hold`
  - `stop_target`
  - `scale_trail`

Friction assumptions:

- buy fee `0.1425%`
- sell fee `0.1425%`
- sell tax `0.3%`
- buy slippage `0.15%`
- sell slippage `0.15%`

Pre-trade filters:

- minimum price
- minimum 20-day average traded value
- minimum 20-day average volume
- maximum 20-day volatility
- maximum 20-day intraday range
- maximum next-day gap-up

Output file:

- `data/trade-mode-backtest.json`
- `data/best-mode-diagnostics.json`
- `BEST_MODE_DIAGNOSTICS.md`

Important sections in the output:

- `summary.overall`: all modes ranked by net return after friction
- `summary.byYear`: same comparison split by year
- `summary.byMarket`: split by listed / OTC
- `summary.byIndustry`: split by industry when enough trades exist
- `rejectedSignals`: why candidate signals were filtered out
- `trades`: raw trade-level detail for audit

Current interpretation:

- `resistance_breakout + fixed_hold` remains the strongest mode after costs.
- `next_open_market + fixed_hold` keeps more opportunities but loses most of its edge after friction.
- This means execution quality matters enough that direct open-market buying is not a safe default for automation.
- Best-mode diagnostics showed that low 20-day volatility (`std20 < 2`) had weak edge, so the enhanced backtest now filters it out by default.
- Raising the 20-day traded-value floor to `100,000,000` and capping plan risk too tightly reduced worst-case loss, but the sample became too small and too concentrated.
- Production selection uses a `100,000,000` 20-day average traded-value floor and `std20 >= 2%`; scenario tools may still expose lower thresholds for comparison.

### Scenario-based strategy backtest

`scripts/backtest-scenarios.mjs` tests whether different stock conditions should use different execution rules.

It compares:

- breakout buffer: `0.3%`, `0.5%`, `1%`
- holding period: `3`, `5`, `7`, `10` trading days
- stop handling: intraday stop, close stop, no hard stop
- max next-day gap-up: `3%`, `5%`, `8%`, no cap

It segments results by:

- 20-day volatility
- market: listed / OTC
- score bucket
- RSI bucket
- liquidity bucket
- industry

Output:

- `data/scenario-backtest.json`
- `SCENARIO_STRATEGY_DIAGNOSTICS.md`

Current findings:

- Pure performance leader: breakout `0.5%`, hold `10` days, no hard stop, max gap `8%`.
- Risk-controlled leader: breakout `0.5%`, hold `7` days, no hard stop, max gap `8%`.
- OTC currently performs better with shorter `5` day holding and max gap `5%`.
- RSI `50-59` has a small-sample result favoring `3` day holding with intraday stop, so it needs forward paper-trading validation before automation.
- Avoiding the first 5 minutes cannot be validated with current daily K data. It requires historical intraday 1-minute or 5-minute data.

## 2026-06 Paper Trading

Purpose:

- Simulate the first automation candidate without broker API access.
- Verify that the project can follow the intended execution rules in a near-live workflow.
- Keep all simulated cash, positions, orders, and events in a local state file.

Commands:

```bash
npm run live
npm run paper
npm run paper:loop
```

Offline snapshot test:

```bash
$env:PAPER_QUOTE_SOURCE='snapshot'
npm run paper
```

Files:

- `scripts/paper-trader.mjs`
- `data/paper-trading-state.json`

The state file is intentionally ignored by Git because it represents local simulated account state.

Current paper-trading rules:

- Candidate source: `data/recommendations.json`
- Entry candidate: `signal === 買入候選`
- Risk filter: `sellWarning.level === 無`
- Volatility filter: `metrics.std20 >= 0.02`
- Entry trigger: latest price breaks above `metrics.resistance * 1.005`
- Gap filter: quote change must not exceed `PAPER_MAX_GAP_UP_PCT`, default `8`
- Position sizing: planned caps are standard `44%`, defensive `20%`, and exploratory `20%`; actual size is reduced by stop distance so estimated stop-loss damage cannot exceed `2%` of current paper-account equity
- Daily loss guard: if daily equity falls `2%`, new entries are blocked
- Exit: stop loss or fixed holding period expiry

This is still a simulation layer. It does not connect to any broker, does not create real orders, and should be evaluated for several sessions before broker integration is considered.
> **回測有效性更正（2026-06-09）：** 本文件後段保留了歷史研究紀錄，其中「月均 10.28%」來自已確認有不可能成交價的舊回測，現已作廢。可信版本必須使用 `entryPrice = max(開盤價, 突破價)`、跳空跌破停損時按開盤價、真實手續費／交易稅／滑價、整股／零股、T+2 與不超過新台幣 100 萬元初始外部資金。最新數字請以本文件開頭與 `STRATEGY_RESEARCH_LOG.md` 為準。
