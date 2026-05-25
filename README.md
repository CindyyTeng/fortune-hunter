# Fortune Hunter

Fortune Hunter 是一個面向台股中短期交易的靜態選股頁面。  
目前版本把量價、均線、波動、型態判讀與即時 SSE 報價整合在一起，專注找 **5 到 10 個交易日內有機會完成表態** 的候選股，而不是偏長抱的配置型標的。

## 這版做了什麼

- 整合中短期型態選股：`W底 / 頭肩底 / 上升三角形 / 上升旗形 / 下降楔形`
- 加入空頭賣出警告：`M頭 / 三重頂 / 下跌旗形 / 上升楔形`
- 每檔股票都會產生不同的部位與止損建議
- 持有週期改成兩週內為主，超過 10 個交易日沒有表態就偏向出場
- 前端支援 Render / 其他 Node 主機提供的 SSE 即時串流

## 指令

```bash
npm run generate
npm run check
npm run dev
npm run live
```

- `npm run generate`
  重新抓取市場資料並產生 `data/recommendations.json`
- `npm run check`
  檢查 Node 腳本語法
- `npm run dev`
  啟動本機靜態預覽，預設 `http://localhost:4173`
- `npm run live`
  啟動即時 SSE 後端，預設 `http://localhost:8787`

## 選股邏輯

目前評分會綜合這幾類訊號：

- 中短期趨勢：股價、5 日線、20 日線、60 日線的相對位置
- 動能與節奏：`RSI`、`MACD`、近 10 日 / 20 日漲幅
- 波動與路徑：20 日 / 60 日波動、價格意圖因子、60 日相對位置
- 型態加分：偏多型態成立時加分，等待型態只提醒不硬加分
- 賣出警告：空頭型態、跌回 5 日線 / 20 日線、過熱與高波動會直接影響出場建議

## 即時串流

前端是靜態頁面，本身不會長連線抓報價。  
要看即時數字，需要另外啟動 `npm run live` 或部署 `scripts/live-server.mjs`。

後端提供三個路徑：

- `/health`
- `/quotes`
- `/stream`

前端連接方式：

1. 打開網站
2. 點右上角 `即時連線`
3. 貼上後端網址，例如 `https://your-live.onrender.com`
4. 前端會自動連到 `.../stream`

## Render 部署

如果你要部署即時後端到 Render，最基本設定如下：

- `Runtime`: `Node`
- `Build Command`: `npm install`
- `Start Command`: `npm run live`
- `Health Check Path`: `/health`

建議環境變數：

- `POLL_MS=8000`
- `ALLOW_ORIGIN=*`

`PORT` 不用自己填，Render 會提供。

## GitHub Pages

靜態頁面可以直接部署到 GitHub Pages。  
常見做法是把 repo 根目錄的 `index.html` 與 `data/recommendations.json` 一起發布。

## 注意

- 這套型態判讀是規則式邏輯，不是機器學習模型
- 它適合幫你快速篩掉不合節奏的標的，不代表可以跳過停損
- 目前設計重點是 **中短期兩週內操作**
## Live Quote Source

`scripts/live-server.mjs` now requests realtime quotes from TWSE MIS first. Yahoo Finance quote API is kept only as a fallback, because cloud hosts such as Render may be rate-limited or blocked by Yahoo.
Live symbols are not hardcoded anymore. By default, the server reads the latest symbols from `data/recommendations.json` on each polling cycle and keeps only the first `MAX_SYMBOLS`.
`SYMBOLS` env var is now optional and only used as a manual override.

## Overnight Market Factor

`scripts/generate-data.mjs` now includes overnight external-market context in the stock-picking score.

- Market-wide risk uses S&P 500, Nasdaq, and Dow Jones composite movement from the latest U.S. session.
- Theme-level risk uses sector matching:
- semiconductor names lean on `^SOX`
- AI hardware names lean on Nasdaq + `^SOX`
- finance names lean on Dow Jones
- The effect is not only descriptive. It adjusts recommendation score, risk text, and sell-warning behavior for the next Taiwan session.

## Advanced Ranking Factors

The ranking now also rewards stronger medium-term leaders while avoiding obvious overheating.

- `12-1 momentum`: uses the last `126` trading days but skips the most recent `21` days.
- `Near-year-high`: rewards names trading near their yearly high without already going fully vertical.
- `20-day drawdown`: penalizes names whose recent pullback still looks structurally weak.
