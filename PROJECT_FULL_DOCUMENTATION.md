# Fortune Hunter 專案完整文件

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
2. 依成交值排序，擷取各市場前 N 檔（預設各 120）。
3. 對每檔抓取 Yahoo 日 K（1 年，日線）。
4. 計算指標、型態、隔夜風險、賣出警告、部位建議。
5. 產生分數與訊號，排序取前 12 檔。
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

- `^GSPC`、`^IXIC`、`^DJI`、`^SOX`
- 用途：隔夜風險加權，影響分數與賣出建議

### 4.4 即時報價

- `live-server.mjs` 優先使用 TWSE MIS 即時來源
- Yahoo quote 僅作 fallback（避免雲端環境限流造成失效）

## 5. 評分與篩選順序

1. 趨勢門檻：`close > MA20 > MA60`
2. 短中期節奏：`close >= MA5 >= MA20`
3. 量能條件：量能是否達標
4. 動能與熱度：10/20/60 日漲跌幅、RSI、MACD
5. 波動結構：20/60 日波動對比
6. 強勢結構：12-1 動能、near-year-high、20 日回撤
7. 型態加減分：多頭/空頭/等待型態
8. 隔夜風險修正：美股與族群指數變化
9. 賣出警告扣分：高/中警告會拉低總分

最後分數 clamp 到 `0~100`，並依條件給 `買入候選 / 偏多觀察 / 等待進場`。

## 6. 持有週期與出場邏輯

持有週期由三項決定：

- 波動（`std20`）
- 型態強弱（`patternScore`）
- 隔夜風險（`overnightScore`）

輸出為：

- 5 天：高波動或風險偏弱
- 7 天：一般中短期
- 10 天：趨勢與型態強、隔夜風險中性偏多

`plan.exitWarning` 會依 5/7/10 天給不同節奏；若賣出警告達中/高，改用更防守的出場指示。

## 7. 賣出警告機制

`buildSellWarning` 綜合以下條件：

- 空頭型態數量與強度
- 跌破 5 日線、20 日線
- RSI 過熱
- 短期漲幅過熱
- 波動異常升高

輸出：

- `level`: 無 / 低 / 中 / 高
- `reasons[]`: 觸發原因
- `action`: 實際出場建議（會影響 plan）

## 8. 前端 UI/UX

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
- 隔夜影響（美股、科技、費半、道瓊）
- 回測參考

## 9. 更新頻率

- 批次推薦：每次執行 `npm run generate` 或 GitHub Actions 觸發時更新
- 即時報價：`live-server` 依 `POLL_MS`（預設 8000ms）輪詢並 SSE 推送

## 10. 部署與環境變數

### GitHub Pages

- 提供靜態前端與 `data/recommendations.json`

### Render（live-server）

- `npm run live`
- 建議 env：
- `POLL_MS=8000`
- `ALLOW_ORIGIN=*`
- `MAX_SYMBOLS=12`

## 11. 驗證清單

每次改版建議固定跑：

1. `npm run check`
2. `npm run generate`
3. 開 `http://localhost:4173` 檢查：
- 卡片收合後是否仍顯示個股摘要列
- 持有週期是否有 5/7/10 差異
- `exitWarning` 是否依週期與風險變化
- SSE 連線後是否可更新即時欄位
