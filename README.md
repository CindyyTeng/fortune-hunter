# Fortune Hunter

Fortune Hunter 是台股中短線（最長約兩週）選股與交易建議網站。  
系統每天產生 7 檔候選股，並整合四大面向：

- 趨勢與動能（均線、RSI、MACD、波動）
- 型態判讀（多頭/空頭/等待型態）
- 隔夜風險（美股、費半、道瓊、台股 ADR/ETF 與族群代理對隔日台股影響）
- 價格行為 SOP 因子（支撐壓力轉換、長紅/長黑關鍵價、均線扣抵、均線發散、風險報酬比）

## 核心功能

- 自動掃描上市/上櫃成交值前段股票池
- 依分數產生推薦清單（7 檔）
- 依波動/型態/隔夜風險自動給 5、7、10 天持有週期
- 賣出警告會直接影響出場建議（不只是提示）
- 買入候選需通過趨勢、短線均線、量比、RSI、20 日動能、上方壓力空間、風險報酬比與賣出警告硬條件，不只看總分
- 流動性與放量分開判斷，避免把「好進出」誤判成「資金真正表態」
- 預設掃描上市/上櫃成交值前 180 檔，條件變嚴時靠擴大股票池補足候選，不靠放寬標準
- 前端支援 SSE 即時報價更新
- 股票卡片可收合，收合後仍保留個股摘要（名稱/代號/分數/訊號/賣出警告/收盤價/型態/持有天數）
- 展開後右側固定顯示賣出警告、出場應對、停損條件、主要風險、隔夜美股/科技/台股 ADR/費半/道瓊/族群夜盤與歷史回測參考
- 每檔展開後先顯示「何時買、何時賣、何時停損、持有多久」
- 指標矩陣會顯示價格行為 SOP 因子、均線扣抵通過數、近 20 日支撐、近 25 日壓力與風險報酬比

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

## 交易模式回測

```bash
npm run backtest:modes
```

- 比較不同買進模式：隔天開盤市價、隔天限價、回測買進區間、突破近壓。
- 搭配不同賣出模式：固定持有、停損停利、分段停利加移動停利。
- 預設直接回測整個台股母池，不是只抽前段熱門股；若要縮小測試，再用環境變數關掉全市場模式。
- 輸出到 `data/trade-mode-backtest.json`，先用數據決定要自動化哪一種模式。

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
- `MAX_SYMBOLS=7`

## 文件

- 完整專案文件：`PROJECT_FULL_DOCUMENTATION.md`
- 選股/進出場邏輯細節：`TRADING_LOGIC_DETAILS.md`
- Release 摘要範本：`release-summary.md`
## 2026-06 Trade Mode Backtest Update

Command:

```bash
npm run backtest:modes
npm run backtest:scenarios
npm run diagnose:best-mode
```

What this backtest now does:

- Runs on the full Taiwan stock universe by default for the last 2 years.
- Compares 4 entry modes:
  - `next_open_market`
  - `next_open_limit`
  - `pullback_entry`
  - `resistance_breakout`
- Compares 3 exit modes:
  - `fixed_hold`
  - `stop_target`
  - `scale_trail`
- Applies transaction friction:
  - buy fee `0.1425%`
  - sell fee `0.1425%`
  - sell tax `0.3%`
  - buy slippage `0.15%`
  - sell slippage `0.15%`
- Filters out weak trade setups before simulation:
  - low price
  - low 20-day average traded value
  - low 20-day average volume
  - excessive 20-day volatility
  - excessive 20-day intraday range
  - oversized next-day gap up

Output:

- File: `data/trade-mode-backtest.json`
- Diagnostics: `data/best-mode-diagnostics.json` and `BEST_MODE_DIAGNOSTICS.md`
- Includes:
  - `summary.overall`
  - `summary.byYear`
  - `summary.byMarket`
  - `summary.byIndustry`
  - `rejectedSignals`
  - full `trades` detail

Current takeaway:

- The strongest mode after cost and slippage is currently `resistance_breakout + fixed_hold`.
- `next_open_market + fixed_hold` still trades much more often, but edge is far weaker after friction.
- After diagnostics, the current enhanced default keeps the original `30,000,000` 20-day traded-value floor and adds `std20 >= 2`.
- A stricter `100,000,000` traded-value floor plus hard plan-risk cap reduced worst loss, but left too few trades and made returns too concentrated.

Scenario backtest:

- File: `data/scenario-backtest.json`
- Report: `SCENARIO_STRATEGY_DIAGNOSTICS.md`
- Tests whether different situations need different rules.
- Current finding:
  - Pure performance leader: breakout `0.5%`, hold `10` days, no hard stop, max gap `8%`.
  - Risk-controlled leader: breakout `0.5%`, hold `7` days, no hard stop, max gap `8%`.
  - OTC segment currently prefers shorter `5` day holding.
  - Daily K data cannot validate avoiding the first 5 minutes after open; that requires intraday historical data.

## 2026-06 Strategy Risk-Control Update

This update intentionally returns to historical backtesting before moving forward with paper trading. If the historical data already shows that a high score can still lead to a poor trade, paper trading would only wait for the same weakness to happen again.

The two-year full Taiwan-stock scenario backtest found the main causes of high-score losing trades:

- RSI below `50`: the breakout often lacks follow-through.
- RSI above `78`: the setup is often overheated and close to a short-term high.
- `std20 >= 5%` with `avg20TradeValue < 100,000,000`: high volatility with weak liquidity has higher large-drawdown risk.
- Recommendation score alone is not enough; a candidate must also pass hard entry filters.

Changes now applied to the production selection logic:

- `買入候選` must pass `RSI 50~78`.
- High-volatility low-liquidity names are blocked from becoming buy candidates.
- `metrics.avg20TradeValue` is included in `data/recommendations.json`.

Backtest effect after this revision:

- Signals: `932 -> 839`
- Worst single trade: `-20.34% -> -12.76%`
- Profit factor: `2.82 -> 2.99`
- Average net return: `6.15% -> 5.91%`

Conclusion: the revision sacrifices a small amount of average upside to remove the worst high-score failure cases.

## 2026-06 Breakout Mode Update

The prior managed-exit version became too restrictive and produced only 6 trades across the full Taiwan market over two years. That sample size was too small to trust.

The current default backtest mode is now:

- Entry: intraday breakout trigger above resistance + `0.5%`
- Exit: fixed hold for `5` trading days
- Universe: full listed + OTC Taiwan stock universe
- Extra guards: market/theme headwind filter, low-liquidity filter, RSI health range, and stricter rules for low-liquidity or high-volatility setups

Latest full-universe two-year backtest:

- Range: `2024-06-05` to `2026-06-05`
- Scanned: `1,955` stocks
- Trades: `56`
- Win rate: `55.36%`
- Average net return: `3.46%`
- Median net return: `0.85%`
- Profit factor: `2.43`
- Best trade: `48.68%`
- Worst trade: `-13.22%`

The generated Excel report is `data/tw-backtest-2y.xlsx`.

## 2026-06 Paper Trading Update

紙上交易是模擬交易，不會連券商 API，也不會下真單。

```bash
npm run live
npm run paper
```

盤中持續輪詢：

```bash
npm run live
npm run paper:loop
```

如果只是要離線測試流程，不開即時伺服器：

```bash
$env:PAPER_QUOTE_SOURCE='snapshot'
npm run paper
```

目前紙上交易規則：

- 只觀察 `買入候選`。
- 只接受 `賣出警告：無`。
- 只做 `突破壓力進場`，不做開盤市價買。
- 價格必須突破 `metrics.resistance` 加上 `0.5%` 緩衝。
- 20 日波動 `std20` 必須大於等於 `0.02`。
- 單檔最多使用模擬本金 `10%`。
- 單日虧損達 `2%` 後停止新增進場。
- 跌破停損價出場。
- 固定持有期到期出場。

紙上交易狀態檔：

- `data/paper-trading-state.json`
- 此檔只保留本機模擬帳戶狀態，已加入 `.gitignore`。
