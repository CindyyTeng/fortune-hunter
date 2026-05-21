# 獵金羅盤 Fortune Hunter

台灣上市與上櫃股票推薦靜態網站。Node 腳本會抓取最新可取得的市場資料、計算技術指標、執行近三個月覆盤，並輸出給 GitHub Pages 使用的 `data/recommendations.json`。

## 本機指令

```bash
npm run generate
npm run check
npm run dev
npm run live
```

`npm run generate` 會重新抓資料並產生推薦結果。

`npm run check` 會檢查 Node 腳本語法。

`npm run dev` 會啟動本機預覽網站。

`npm run live` 會啟動即時 SSE 後端（預設 `http://localhost:8787`）。

## 部署方式

此專案適合用 GitHub Pages 部署。`.github/workflows/update-data.yml` 會在台股開盤日定時執行 Node 腳本，並更新 `data/recommendations.json`。

### 即時模式（免費小後端）

GitHub Pages 只能放靜態前端，不會長駐執行程式。若要秒級更新體感，可加一個免費後端服務：

1. 在 Render 或 Railway 建立一個 Web Service。
2. 指向同一份專案，啟動指令填：`npm run live`
3. 設定環境變數（可選）：
   - `PORT`：平台自動帶入即可
   - `POLL_MS`：輪詢頻率，預設 `8000`
   - `SYMBOLS`：要追蹤的股票代碼，例：`2330.TW,8299.TWO`
4. 部署完成後會有一個網址，例如 `https://xxx.onrender.com`
5. 打開前端網站，點「即時連線」按鈕，貼上該網址，前端會連 `.../stream`

後端提供三個端點：

- `/health`：檢查服務是否存活
- `/quotes`：目前即時快照
- `/stream`：SSE 即時推播

## 資料來源

資料來源包含 TWSE OpenAPI、TPEx 公開日收盤資料與 Yahoo Finance chart API。所有分析只供研究與篩選，不構成投資建議。
