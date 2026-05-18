# 獵金羅盤 Fortune Hunter

台灣上市與上櫃股票推薦靜態網站。Node 腳本會抓取最新可取得的市場資料、計算技術指標、執行近三個月覆盤，並輸出給 GitHub Pages 使用的 `data/recommendations.json`。

## 本機指令

```bash
npm run generate
npm run check
npm run dev
```

`npm run generate` 會重新抓資料並產生推薦結果。

`npm run check` 會檢查 Node 腳本語法。

`npm run dev` 會啟動本機預覽網站。

## 部署方式

此專案適合用 GitHub Pages 部署。`.github/workflows/update-data.yml` 會在台股開盤日定時執行 Node 腳本，並更新 `data/recommendations.json`。

## 資料來源

資料來源包含 TWSE OpenAPI、TPEx 公開日收盤資料與 Yahoo Finance chart API。所有分析只供研究與篩選，不構成投資建議。
