# Fortune Hunter

Fortune Hunter 是台股中短線（最長約兩週）選股與交易建議網站。  
系統每天產生 12 檔候選股，並整合三大面向：

- 趨勢與動能（均線、RSI、MACD、波動）
- 型態判讀（多頭/空頭/等待型態）
- 隔夜風險（美股、費半、道瓊對隔日台股影響）

## 核心功能

- 自動掃描上市/上櫃成交值前段股票池
- 依分數產生推薦清單（12 檔）
- 依波動/型態/隔夜風險自動給 5、7、10 天持有週期
- 賣出警告會直接影響出場建議（不只是提示）
- 前端支援 SSE 即時報價更新
- 卡片支援收合，避免 12 檔頁面過長

## 快速開始

```bash
npm install
npm run check
npm run generate
npm run dev
```

- `npm run check`：語法檢查
- `npm run generate`：重建 `data/recommendations.json`
- `npm run dev`：啟動本機網站（預設 `http://localhost:4173`）

## 即時報價（SSE）

```bash
npm run live
```

- 預設 `http://localhost:8787`
- 可用端點：
- `/health`
- `/quotes`
- `/stream`

前端點「即時連線」後輸入 live server URL（例如 Render 網址），即可接收即時更新。

## 部署

### GitHub Pages（前端）

- 以 repo root 發佈靜態頁（`index.html` + `data/recommendations.json`）

### Render（live-server）

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm run live`
- Health Check Path: `/health`

常用環境變數：

- `POLL_MS=8000`
- `ALLOW_ORIGIN=*`
- `MAX_SYMBOLS=12`

## 文件

- 完整專案文件：`PROJECT_FULL_DOCUMENTATION.md`
- 選股/進出場邏輯細節：`TRADING_LOGIC_DETAILS.md`
- Release 摘要範本：`release-summary.md`
