# 投信連買強勢股回檔策略驗證

產生時間：2026-06-16T16:54:46.003Z

## 結論

**法人歷史資料不足，尚無法完成真實 walk-forward 驗證**

## 資料狀態

- point-in-time 安全筆數：367176
- 交易日數：26
- 股票檔數：32873
- 是否足夠 walk-forward：否

## 資料缺口

- 至少 1000 個交易日

## Registry

- experimentHash：d8c22ceed3a7020bb1f90cd7
- strategyFamilyId：trust_accumulation_pullback:606784dbff2763f62dadf108
- 是否跳過既有實驗：是
- 跳過原因：相同 experimentHash 已存在，不重複回測

## Walk-forward

- 訓練：36 個月
- 驗證：12 個月
- 每次前進：12 個月
- 參數組合：324
- 交易次數：未產生
- 月均總資產報酬：未產生
- 年化報酬：未產生
- Profit Factor：未產生
- 最大回撤：未產生

## 風險警告

- 本資料採用 conservative point-in-time assumption，不是逐筆 fully verified publishedAt。
- T 日法人資料只允許 T+1 交易日使用，不允許 T 日盤中或收盤前使用。
- 注意股、處置股、除權息、減資、分割資料尚未完整介接。
