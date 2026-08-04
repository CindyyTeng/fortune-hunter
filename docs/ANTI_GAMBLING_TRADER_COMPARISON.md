# 與 Anti-Gambling Trader 的功能比較

- 對方專案核心是匯入既有交易紀錄，判斷績效較像可重複優勢或運氣，並提供紙上券商與真實券商介面範本。
- Fortune Hunter 核心是建立台股 point-in-time 資料、搜尋選股 alpha、模擬真實成交與產生每日交易決策；兩者終點都涉及自動交易，但起點與主要職責不同。
- 本專案不直接複製其 Python 程式碼，只採納公開方法論：期望值、t 檢定、置中 Bootstrap、獲利集中度及樣本外衰減檢查。
- 任何策略必須先通過共用成交模擬、成本、T+2、walk-forward、統計證據與基準比較，才可能進入紙上交易；統計通過也不代表保證獲利。
- 參考來源：https://github.com/mars-tw/anti-gambling-trader-tw （MIT License，查核日期 2026-08-04）。
