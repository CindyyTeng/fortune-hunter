# Fortune Hunter

> **2026-06-11 最新可信狀態：** 十年回測使用 2016-06-11 至 2026-06-11、目前可取得資料的 1,954 檔台股、100 萬元初始資金、真實手續費／交易稅／滑價、整股／零股、T+2、跳空成交與只計已賣出損益。風險平衡版本平均月已實現淨報酬 3.14%，119 個完整月份中 28 個月達 10%，51 個負月份，12 個零交易月份，最差月 -11.89%，最大回撤 -37.27%，共 333 筆交易。**每月 10% 尚未達成，不得用於保證獲利或直接真實自動下單。**

最新研究、黑天鵝防護、技術指標、失敗組合與券商 API 風險，請以 [STRATEGY_RESEARCH_LOG.md](STRATEGY_RESEARCH_LOG.md) 為準。後文保留的舊版兩年回測與「月均 10.28%」只屬歷史研究紀錄，已因不可能成交價而作廢。

> **2026-06-09 重要更正：** 文件後段曾記錄的「月均 10.28%」屬於舊回測結果。舊版錯把隔日盤中突破價視為一定可成交，即使開盤已跳空高於突破價也用較低價格買入，造成績效嚴重高估。該結果已作廢，不得用於交易決策。修正成交價、跳空停損、成本、整股／零股、T+2 與現金限制後，目前最佳十年研究結果為：119 個完整月份中 30 個月已實現淨報酬達 10%，平均月 2.58%，64 個負月，最大回撤 -44.75%。**尚未達成每月 10%，也尚未適合真實自動下單。**

最新研究檔案：

- `data/realized-strategy-search-10y.json`：累積策略排行榜
- `data/realized-strategy-diagnostics-10y.json`：最佳策略逐月與逐筆交易
- `data/strategy-search-ledger-10y.json`：已測組合雜湊，避免重複
- `data/factor-validation-10y.csv`：中文單因子訓練期／驗證期報表
- `STRATEGY_RESEARCH_LOG.md`：研究過程、失敗原因與目前結論

Fortune Hunter 是台股中短線（最長約兩週）選股與交易建議網站。  
系統每天產生 7 檔候選股，並整合四大面向：

- 趨勢與動能（均線、RSI、MACD、波動）
- 型態判讀（多頭/空頭/等待型態）
- 隔夜風險（美股、費半、道瓊、台股 ADR/ETF 與族群代理對隔日台股影響）
- 價格行為 SOP 因子（支撐壓力轉換、長紅/長黑關鍵價、均線扣抵、均線發散、風險報酬比）

## 核心功能

- 自動掃描上市/上櫃成交值前段股票池
- 依分數產生推薦清單（7 檔）
- 以最多 5 個交易日為持有節奏，搭配停損與收盤移動停利
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
- Production selection now requires `100,000,000` in 20-day average traded value and `std20 >= 2%`.
- The stricter liquidity floor is paired with trailing profit protection; execution then applies a hard `2%` account-risk cap without deleting otherwise valid signals.

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

- `買入候選` must pass `RSI 60~78`; the latest review found RSI below `60` had poor follow-through.
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
- Exit: fixed hold for `5` trading days, with early stop if the planned stop-loss is touched
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

## 2026-06 Monthly Target Update

The strategy target is now evaluated against monthly portfolio performance, not only single-trade return.

Backtest assumptions:

- Buy fee: `0.1425%`
- Sell fee: `0.1425%`
- Securities transaction tax: `0.3%`
- Buy slippage: `0.15%`
- Sell slippage: `0.15%`
- Target monthly return: `10%`

Current optimized execution:

- Entry: breakout limit trigger at resistance `+0.5%`
- Exit: maximum hold of `5` trading days, with early stop-loss and close-based trailing profit protection
- Filters: price >= `15`, 20-day average traded value >= `100,000,000`, 20-day volatility between `2%` and `8.5%`, max 20-day single-day range <= `14%`
- Capital model: odd-lot/fractional-style sizing, planned caps of `44%` standard, `20%` defensive, and `20%` exploratory, with a hard `2%` account-risk cap based on stop distance and at most `8` open positions
- Same-day candidates are ordered by confirmed opening breakout strength instead of stock-code order, so limited capital is assigned to the clearer breakout first
- Market defense: major Taiwan market/theme/global risk or a negative opening gap causes the system to stay in cash
- Tailwind sizing: only when both the Taiwan market and stock theme rise at least `1%` may the planned position increase by `1.5x`, capped at `60%`
- Global defense: uses US market, Nasdaq, Dow, SOX, Nikkei, KOSPI, and KOSDAQ to detect broad risk-off days before Taiwan opens
- Theme defense: memory, passive components, semiconductors, AI hardware, and power-equipment proxies affect same-theme Taiwan candidates
- The website keeps showing 7 observation candidates when the market is risk-off, but they may be marked as waiting instead of buy candidates.

Latest formal full-universe two-year result:

- Range: `2024-06-09` to `2026-06-09`
- Scanned: `1,953` stocks
- Candidate trades: `416`
- Executed trades: `157`
- Win rate: `73.25%`
- Average net return per trade: `7.83%`
- Profit factor: `7.43`
- Average monthly return: `10.28%`
- Months reaching 10%: `11`
- Negative months: `1`
- Best month: `59.76%`
- Worst month: `-0.81%`
- Max portfolio drawdown: `-6.43%`

Conclusion: this revision reaches the 10% average monthly target in the two-year backtest and improves the corrected mark-to-market baseline. It does not make every calendar month reach 10% and still requires paper-trading validation.

Monthly target review:

- The system can reduce weak-month losses by staying in cash when signal quality is poor.
- Cash can protect capital, but it cannot create a 10% return in months with too few high-quality long signals.
- A test using inverse ETF hedging made performance worse, so the current strategy keeps the cleaner rule: long only when edge exists, otherwise stay in cash.
- After correcting month-end mark-to-market accounting, the baseline was `9.47%` average monthly return, `6` negative months, and `-9.96%` max drawdown.
- The liquidity and trailing-exit revision reached `11.20%`, `3` negative months, and `-7.20%` max drawdown.
- Buy candidates require at least 2 of 5 market, theme, global, Asia, and opening confirmations; observation signals require at least 4.
- Breakout-strength ordering with `44% / 20% / 20%` planned caps and a hard `2%` account-risk limit produces `10.28%` average monthly return, `11` target months, `1` negative month, a `-0.81%` worst month, and `-6.43%` max drawdown.
- The remaining negative month is affected by conservative month-end liquidation marking: open positions are valued after estimated selling costs. Several positions contributing to the November mark subsequently exited profitably in December, so blocking all month-end entries would remove valid winners.
- Requiring every single calendar month to reach 10% would require leverage, short-selling, derivatives, or month-specific overfitting; those are not used in this project.

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

- `買入候選`需通過五項環境確認中的至少兩項；`偏多觀察`需至少四項，否則維持現金。
- 只接受 `賣出警告：無`。
- 只做 `突破壓力進場`，不做開盤市價買。
- 價格必須突破 `metrics.resistance` 加上 `0.5%` 緩衝。
- 20 日波動 `std20` 必須大於等於 `0.02`。
- 20 日均成交值必須大於等於 `100,000,000`。
- 隔日負跳空不進場。
- 紙上交易與回測使用相同分級上限：標準 `44%`、防守 `20%`、探索 `20%`；實際部位再依停損距離縮小，確保單筆停損損失不超過帳戶 `2%`。
- 單日虧損達 `2%` 後停止新增進場。
- 跌破停損價出場。
- 報酬曾達 `3%` 後，若從高點回落 `5` 個百分點，啟動移動停利。
- 固定持有期到期出場。

紙上交易狀態檔：

- `data/paper-trading-state.json`
- 此檔只保留本機模擬帳戶狀態，已加入 `.gitignore`。
