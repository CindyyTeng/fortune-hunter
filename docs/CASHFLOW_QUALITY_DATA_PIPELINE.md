# 現金流品質資料管線

本資料線用來補足只看營收或 EPS 可能忽略的「獲利品質」問題，重點是檢查公司是否真的把獲利轉成營業現金流，而不是只有帳面盈餘。

## 資料來源

- 來源：公開資訊觀測站 MOPS 歷史財務報表頁面。
- 涵蓋：上市與上櫃公司，損益表、資產負債表、現金流量表。
- 快取：原始 HTML 放在 `data/cashflow-quality/raw/`，不提交 Git。
- 輸出：`data/cashflow-quality/cashflow-quality.json`，此檔案也不提交 Git，避免大型資料進版控。

## Point-in-time 規則

- 目前沒有逐筆歷史公布時間。
- 採保守假設：使用各季法定最晚申報日收盤後作為 `publishedAt`，下一個交易日才可用。
- 這不是 fully verified point-in-time，只能標示為 `conservative_assumption`。
- 策略不可在財報公布日當天盤中使用這份資料。

## 衍生欄位

- 單季營業現金流：由累計現金流轉成單季值。
- 單季淨利：由累計淨利轉成單季值。
- 現金轉換率：營業現金流 / 淨利。
- 應計比率：淨利減營業現金流後除以平均資產。
- 負債比與負債比年變化。
- 營業現金流年增率、淨利年增率。
- 營業現金流是否由負轉正。

## 目前狀態

- 已完成 2024 年快取煙霧測試。
- 目前可用資料：7,679 筆、1,970 檔、4 季。
- 驗證狀態：VALID。
- 因只有 4 季，不足以執行可信的 54 個月訓練 / 18 個月驗證 walk-forward。
- 因此目前不能產生策略績效，也不能宣稱找到可實盤策略。

## 指令

- 建置資料：`npm run data:build-cashflow-quality`
- 驗證資料：`npm run data:validate-cashflow-quality`
- 執行策略：`npm run research:stock-cashflow-quality`
- 自測：`npm run check` 會執行 `scripts/test-cashflow-quality-pipeline.mjs`
