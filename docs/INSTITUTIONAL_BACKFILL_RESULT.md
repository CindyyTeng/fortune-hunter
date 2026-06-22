# 法人歷史回填與策略驗證結果

產生時間：2026-06-22

## 回填結論

- 回填範圍：4 年 3 個月。
- 嘗試交易日：1,033。
- TWSE 成功日期：1,032；本次新下載 61 天、790,790 raw rows。
- TPEx 成功日期：1,033；本次新下載 62 天、44,932 raw rows。
- 失敗日期：1，TWSE `2022-04-07` 官方端點無資料。
- 最終 unique trading dates：1,034，已達 36/12 walk-forward 最低資料門檻。

## Raw 到 Processed 落差

- raw cache 總列數：14,859,102。
- processed dataset：314,668 筆。
- 去重後筆數：314,668；重複筆數：0。
- TWSE processed：255,418 筆、1,003 天。
- TPEx processed：59,250 筆、1,034 天。

落差是刻意且合理的策略資料過濾，不是去重造成：

1. TWSE T86 `ALL` 含 ETF、權證及其他非普通股商品，build 預設只保留四碼、非 `00xx` 的股票。
2. 本階段只驗證「投信連買」策略，processed 預設只保留投信有買賣活動的列；沒有投信活動視為 0，不需要重複保存。
3. 欄位會轉成統一 institutional schema，原始 payload 留在 raw cache，不會塞進 processed。
4. 若未來研究外資或自營商，可用 `INSTITUTIONAL_KEEP_ALL_FLOWS=1` 重建全量 flow dataset。

因此 processed dataset 是「投信策略專用資料集」，不是完整三大法人逐列鏡像。

## Point-in-time 與驗證

- 法人資料驗證：VALID。
- point-in-time safe：314,668 筆。
- fully verified publishedAt：0 筆。
- 使用政策：T 日官方日報只允許 T+1 交易日使用。
- 回測實際採 T+1 收盤確認、下一交易日開盤進場，比最低政策更保守。

## 投信連買強勢股回檔策略

- Train：36 個月。
- Validation：12 個月。
- 每次前進：12 個月。
- 測試參數：648 組，只在 train 選參數。
- Validation 交易：35 筆。
- 月均總資產報酬：-0.1003%。
- 年化報酬：-1.2054%。
- Profit Factor：0.6338。
- 最大回撤：-2.449%。
- 勝率：40%。
- 大盤／0050 代理同期月均：5.3115%。
- 公平隨機同期月均：-0.4542%。

## 明確結論

- 策略有贏過公平隨機基準，但仍為負報酬。
- 策略輸給大盤／0050 代理。
- 交易樣本只有 35 筆，未達 300 筆。
- Profit Factor 未達 1.15。
- 沒有通過最低候選標準。
- 沒有通過高報酬候選標準。

`沒有策略通過 validation 候選標準，不可進入紙上交易或實盤。`
