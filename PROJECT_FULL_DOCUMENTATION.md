# Fortune Hunter 專案完整文件（交接版）

本文件目標：讓**沒碰過這個專案的人**，只看這份就能理解整個系統怎麼跑、資料哪裡來、多久更新、選股怎麼判斷、即時串流怎麼接、怎麼部署與維運。

---

## 1. 專案定位與範圍

Fortune Hunter 是一個「台股中短期（約 5~10 個交易日）」的選股與操作建議工具。

- 主要輸出：推薦股票清單（最多 12 檔）
- 主要邏輯：技術面量化 + 型態判斷 + 風險/賣出警告
- 顯示介面：純前端單頁（`index.html`）
- 後端型態：
- 靜態資料產生器（`scripts/generate-data.mjs`）
- 即時 SSE 服務（`scripts/live-server.mjs`）
- 本機預覽伺服器（`scripts/serve.mjs`）

不包含：

- 下單 API 串接
- 會員/帳號系統
- 資料庫

---

## 2. 目錄與檔案職責

### 2.1 根目錄

- `index.html`
- 前端頁面、樣式、渲染邏輯、SSE 連線邏輯都在同一檔（無框架）。
- `package.json`
- 啟動腳本與指令入口。
- `README.md`
- 簡版說明。
- `release-summary.md`
- 發版摘要草稿。
- `PROJECT_FULL_DOCUMENTATION.md`
- 本文件。

### 2.2 scripts/

- `scripts/generate-data.mjs`
- 量化掃描主程式，抓外部資料後輸出 `data/recommendations.json`。
- `scripts/live-server.mjs`
- 即時行情 SSE 伺服器，提供 `/stream`、`/quotes`、`/health`。
- `scripts/serve.mjs`
- 本機靜態檔案伺服器（開 `http://localhost:4173/`）。

### 2.3 data/

- `data/recommendations.json`
- 前端主要資料來源（推薦結果與說明）。
- `data/verification-*.png`
- 驗證截圖（非執行必要）。

### 2.4 .github/workflows/

- `.github/workflows/update-data.yml`
- GitHub Actions 排程更新 `data/recommendations.json`。

---

## 3. 外部資料來源與用途

本專案目前使用 3 個外部來源：

1. TWSE OpenAPI
- URL：`https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL`
- 用途：上市股票當日資料（代號、名稱、價格、成交量/值、本益比等）

2. TPEx API（櫃買）
- URL：`https://www.tpex.org.tw/www/zh-tw/afterTrading/otc`（POST）
- 用途：上櫃股票當日資料（代號、名稱、價格、成交量/值）

3. Yahoo Finance API
- 歷史 K 線：`/v8/finance/chart/{symbol}?range=6mo&interval=1d`
- 即時報價：`/v7/finance/quote?symbols=...`
- 用途：
- `generate-data`：取近 6 個月日 K 做技術分析與型態判斷
- `live-server`：取盤中最新報價做即時刷新

---

## 4. 系統運作總流程（從資料到畫面）

## 4.1 靜態推薦資料流程（主流程）

1. `generate-data.mjs` 先抓上市 + 上櫃股票池  
2. 依成交值排序，取前 `SYMBOLS_PER_MARKET`（預設各 120）  
3. 對每檔抓 Yahoo 近 6 個月日 K  
4. 計算指標（MA/RSI/MACD/波動/報酬/位置）  
5. 判斷多空型態（W 底、頭肩底、旗形、M 頭、三重頂等）  
6. 合併分數，產生：
- 訊號（強勢買進/買進觀察/不建議）
- 進出場建議
- 部位建議
- 賣出警告等級與應對
7. 取前 12 檔，寫入 `data/recommendations.json`  
8. 前端讀取該 JSON 並渲染卡片

## 4.2 即時行情流程（SSE）

1. 啟動 `live-server.mjs`  
2. 伺服器定時（`POLL_MS`，預設 8000ms）抓 Yahoo 即時 quote  
3. 維護 `lastPayload` 並 broadcast 到所有 `/stream` 連線客戶端  
4. 前端 `EventSource` 收到 `quotes` 後，更新：
- 最新價
- 即時漲跌幅
- 顯示最新時間

---

## 5. generate-data 核心邏輯（重點）

檔案：`scripts/generate-data.mjs`

## 5.1 重要參數

- `SYMBOLS_PER_MARKET`（預設 120）：每市場掃描檔數
- `CONCURRENCY`（預設 6）：並行分析數
- `HOLD_DAYS`（固定 10）：策略目標持有天數（中短期）

## 5.2 技術指標計算

每檔至少要有足夠歷史資料（<70 日會略過）：

- MA5 / MA20 / MA60
- RSI(14)
- MACD（EMA12 - EMA26）
- 近 5/10/20/60 日報酬
- 20 日/60 日日報酬波動（`std20`, `std60`）
- 60 日相對位置（`rsv60`）
- 趨勢意圖因子（`intentFactor60`）

## 5.3 分數結構（0~100）

先做 gating（趨勢、量能、過熱），再加減分：

- 趨勢結構（close > MA20 > MA60）偏多加分，反之扣分
- 短均線排列（MA5/MA20）加減分
- 成交量是否達標（>100,000）加減分
- 20 日是否過熱（>18%）過熱扣分
- `intentFactor60` 強弱加減分
- `rsv60` 在合理區間加分，過熱扣分
- 短波動與長波動關係（收斂/擴張）加減分
- RSI 區間（48~68 佳，過熱/過弱扣分）
- MACD 正負
- 站上 MA20 但不過度乖離時加分
- 本益比區間（若有）微調

最後把分數 clamp 到 0~100。

## 5.4 型態偵測（detectPatterns）

會從最近視窗找 pivot highs/lows，判斷：

偏多型態（加分）：

- W 底（雙底）
- 頭肩底
- 上升三角
- 上升旗形
- 下降楔形反轉

偏空型態（扣分，且會進入賣出警告）：

- M 頭（雙頂）
- 三重頂
- 下跌旗形
- 上升楔形轉弱

觀察型（不直接強加分）：

- 箱型收斂
- 三角收斂
- 上升通道等

## 5.5 賣出警告（buildSellWarning）

此邏輯會把「空頭型態」真正反映到出場建議，不只是風險提示。

賣出警告分級：

- `低`
- `中`
- `高`
- `極高`

影響來源：

- 偏空型態數量與強度
- 跌破 MA5 / MA20
- RSI 過熱
- 20 日漲幅過大
- 短波動過大

輸出：

- `sellWarning.level`
- `sellWarning.reasons[]`
- `sellWarning.action`（直接用於「賣出警告應對」欄位）

## 5.6 部位建議（buildPositionSizing）

部位不是固定文案，會依個股狀態動態改變：

- 先估算 stop 百分比（`stopPct`）
- 依波動度給風險預算（例如 0.7%/0.9%/1.2%）
- 若賣出警告高/極高，進一步壓低風險預算
- 換算建議資金占比（有上下限）

所以不同股票的 `plan.positionSizing` 應該不同。

## 5.7 訊號輸出條件

`signal` 主要有：

- 強勢買進
- 買進觀察
- 不建議

若 gating 不通過或賣出警告極高，會偏向 `不建議`。

## 5.8 回測欄位（backtest）

對最近區段做簡易回看，只保留最多 3 筆命中：

- 進場日分數
- 3 日報酬
- 10 日報酬
- 10 日最大漲幅
- 10 日最大回撤

用途是提供「歷史行為感」，不是嚴格交易系統回測。

---

## 6. JSON 結構（前端依賴）

主檔：`data/recommendations.json`

頂層欄位：

- `asOf`
- `generatedAtTaipei`
- `source`
- `universeSize`
- `scanned`
- `scanStrategy`
- `marketCoverage`
- `recommendations[]`
- `warnings[]`

每一檔 `recommendations[]` 重要欄位：

- 基本：`code`, `name`, `market`, `tradeValue`, `score`, `signal`
- 漲跌：`latestPrice`, `change5d`, `change10d`, `change20d`, `change60d`
- 指標：`metrics.ma5/ma20/ma60/rsi14/macd/std20/std60/rsv60/intentFactor60/stopPct`
- 型態：`patterns.score/bias/bullish/bearish/watch`
- 賣出：`sellWarning.level/reasons/action`
- 文案：`reasons[]`, `risks[]`
- 策略：`plan.horizon/entry/takeProfit/stopLoss/exitWarning/positionSizing`
- 驗證：`backtest[]`

---

## 7. 前端運作順序（index.html）

1. 頁面載入後執行 `loadData()`
2. `fetch data/recommendations.json?ts=...`（避免快取）
3. 更新抬頭統計（產生時間、掃描母體、推薦數）
4. 逐檔渲染卡片（分數、指標、型態、計畫、賣出警告、backtest）
5. 若 localStorage 有 `fh_live_url`，自動 `connectLive()`
6. 收到 SSE `quotes` 後：
- 依 `code + market -> Yahoo symbol` 對應
- 更新最新價與即時漲跌幅
- 重畫卡片

前端沒有框架，所有邏輯都在同一個 `<script>`，走的是簡單直接路線（低抽象）。

---

## 8. live-server（SSE）說明

檔案：`scripts/live-server.mjs`

## 8.1 端點

- `GET /health`
- 服務健康、連線數、symbol 數
- `GET /quotes`
- 目前快取報價（`lastPayload`）
- `GET /stream`
- SSE 串流（`event: quotes`）

## 8.2 重要環境變數

- `PORT`（預設 8787）
- `POLL_MS`（預設 8000）
- `MAX_SYMBOLS`（預設 12）
- `ALLOW_ORIGIN`（預設 `*`）
- `SYMBOLS`（預設一組台股 symbol）

## 8.3 推播節奏

- 服務啟動先抓一次
- 之後每 `POLL_MS` 抓一次並廣播
- 若抓取失敗會推 `type:error` payload（不會直接 crash）

---

## 9. 自動更新機制（GitHub Actions）

檔案：`.github/workflows/update-data.yml`

觸發方式：

- `workflow_dispatch`（手動）
- `schedule`（排程）

排程（UTC）對應台北時間（Asia/Taipei）：

- 平日 09:00~12:50，每 10 分鐘更新
- 平日 13:00~13:30，每 10 分鐘更新
- 平日 15:10 再補一次

工作內容：

1. checkout
2. setup-node (20)
3. `npm run generate`
4. 自動 commit `data/recommendations.json`

注意：

- 這代表遠端 `main` 可能因排程更新而比本機新，推送前要先 `pull --rebase`。

---

## 10. 啟動與操作（本機）

## 10.1 安裝/檢查

```bash
npm run check
```

## 10.2 產生最新推薦資料

```bash
npm run generate
```

## 10.3 開前端預覽

```bash
npm run dev
```

開啟：`http://localhost:4173/`

## 10.4 開即時 SSE 服務（另一個終端）

```bash
npm run live
```

預設：`http://localhost:8787/`

## 10.5 前端接即時串流

在頁面按「即時連線」按鈕，輸入：

- 本機：`http://localhost:8787`
- Render：`https://<your-service>.onrender.com`

---

## 11. Render 部署要點（live-server）

建議設定：

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm run live`
- Health Check Path: `/health`

可選環境變數：

- `POLL_MS=8000`
- `ALLOW_ORIGIN=*`
- `MAX_SYMBOLS=12`
- `SYMBOLS=2330.TW,...`

部署驗證：

1. 打開 `/health` 看是否 `{ ok: true }`
2. 打開 `/quotes` 看是否有 quotes
3. 前端接上該 URL，看「即時連線中」與行情更新

---

## 12. 更新頻率與資料時效

靜態推薦資料（`recommendations.json`）：

- 本機手動跑：你執行 `npm run generate` 當下更新
- 遠端自動跑：依 GitHub Actions 排程（盤中 10 分鐘級）

即時資料（SSE quotes）：

- 預設每 8 秒輪詢一次 Yahoo quote API（可調 `POLL_MS`）

實務上：

- 選股邏輯主體是日 K 結構（中短期），不是 tick 級策略
- 盤中 SSE 主要補「最新價與漲跌感」，不會重算完整日 K 選股分數

---

## 13. 常見問題與排錯

## 13.1 畫面出現很多 `-`

常見原因：

- `index.html` 已升級，但 `data/recommendations.json` 還是舊 schema

處理：

1. `npm run generate`
2. `Ctrl + F5` 強制重整

## 13.2 每檔部位文案看起來一樣

常見原因：

- 還在舊資料檔
- 或頁面仍是快取

處理同上。

## 13.3 push 被拒（non-fast-forward）

原因：

- 遠端（常見是 Actions）先更新了 `main`

固定流程：

1. `git add ...`
2. `git commit -m "<中文訊息>"`
3. `git pull --rebase origin main`
4. `git push origin main`

## 13.4 rebase 卡在編輯器畫面

代表 Git 正在等你確認 commit message。  
可直接存檔離開（或改完訊息再存檔）即可繼續。

---

## 14. 專案目前介接清單

已介接：

- TWSE OpenAPI
- TPEx API
- Yahoo Finance chart API
- Yahoo Finance quote API
- GitHub Actions（排程更新）
- Render（SSE 部署）

未介接：

- 券商下單 API
- 使用者帳務
- DB/快取層（Redis 等）

---

## 15. 風險與限制（必讀）

- 外部 API 若欄位改版，解析可能壞掉（尤其中文欄名）
- Yahoo/TWSE/TPEx 偶發超時，會進 `warnings`
- 此系統是決策輔助，不是保證獲利模型
- 回測是簡化版樣本，不是完整交易引擎
- 盤中 SSE 不重算整套日 K 分數（僅更新報價）

---

## 16. 交接人快速上手清單（10 分鐘）

1. 跑 `npm run generate`
2. 跑 `npm run dev`，開 `http://localhost:4173/`
3. 看卡片欄位是否完整（尤其持有週期/賣出警告/部位）
4. 跑 `npm run live`
5. 前端接 `http://localhost:8787` 測即時
6. 看 `.github/workflows/update-data.yml` 了解自動更新節奏
7. 確認推送流程採 `pull --rebase` 後再 push

---

## 17. 後續可擴充方向（保留）

- 增加「賣出警告」可視化分解（分數來源條）
- 加入多週期（週線/日線）一致性檢查
- 讓前端顯示「資料 freshness」（上次生成距今幾分鐘）
- 增加策略版本號（便於比較不同邏輯表現）

---

## 18. Live Quote Source Update

`scripts/live-server.mjs` uses TWSE MIS realtime quotes as the primary source for `/quotes` and `/stream`.

- Primary source: `https://mis.twse.com.tw/stock/api/getStockInfo.jsp`
- Fallback source: Yahoo Finance quote API
- Reason: Render and similar cloud hosts can be rate-limited or blocked by Yahoo, so relying on Yahoo alone makes realtime quotes unstable.
- Frontend contract: unchanged. The server still emits `quotes[]` with `symbol`, `name`, `price`, `changePercent`, and `ts`.
- Symbol source: no hardcoded list. The server resolves symbols from `data/recommendations.json` every polling cycle, then applies `MAX_SYMBOLS` as the cap.
- Optional override: set `SYMBOLS=2330.TW,2454.TW,...` only when you explicitly want fixed symbols.

---

## 19. Overnight Market Factor

The stock-picking logic now includes the previous U.S. session as a next-day Taiwan-market risk factor.

- Data source: Yahoo Finance daily chart API for `^GSPC`, `^IXIC`, `^DJI`, and `^SOX`
- Scope:
- broad-market risk adjusts the base score using a composite of S&P 500, Nasdaq, and Dow Jones
- semiconductor-linked names receive extra adjustment from `^SOX`
- AI hardware names receive extra adjustment from Nasdaq + `^SOX`
- finance names receive extra adjustment from Dow Jones
- Behavioral effect:
- affects recommendation score directly
- adds overnight risk/reason text into `reasons[]` or `risks[]`
- can increase sell-warning severity when the overnight backdrop is clearly weak
- Output:
- top-level `overnightContext` is stored in `data/recommendations.json`
- each recommendation also carries its own `overnight` summary object
