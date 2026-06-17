# 法人歷史回填結果

產生時間：2026-06-17

## 結論

- 3 個月 smoke backfill：成功。
- 4 年 backfill：已執行，但目前覆蓋交易日仍不足 36/12 walk-forward 門檻。
- 法人資料驗證：VALID。
- 投信連買強勢股回檔策略：未執行，因 unique trading dates 未達 1000。

## 3 個月 Smoke Backfill

- 嘗試交易日：64
- TWSE 成功天數：64
- TPEx 成功天數：64
- 失敗日期：0
- 結果：通過

## 4 年 Backfill

- 嘗試交易日：971
- TWSE 成功天數：965
- TPEx 成功天數：971
- TWSE 新下載筆數：4,070,213
- TPEx 新下載筆數：0，皆使用既有快取
- 失敗日期：6
- 主要原因：TWSE 指定日期無資料，屬無資料日或官方端點未回傳資料

## Processed Dataset

目前 processed dataset 預設只保留投信有買賣活動的股票列，原因是本階段要驗證「投信連買強勢股回檔策略」。若未來要研究外資或自營商策略，可使用 `INSTITUTIONAL_KEEP_ALL_FLOWS=1` 重新建置全量法人資料。

- 去重前筆數：299,416
- 去重後筆數：299,416
- 重複筆數：0
- point-in-time safe 筆數：299,416
- unique trading dates：972
- TWSE 筆數：242,939
- TWSE 日期數：942
- TPEx 筆數：56,477
- TPEx 日期數：972

## Walk-forward 狀態

目前 unique trading dates 為 972，未達本專案設定的 1000 個交易日門檻，因此：

- 尚不足以執行 36/12 walk-forward validation。
- 未執行 `research:institutional-alpha`。
- 沒有任何策略通過 validation。

明確結論：

`法人歷史資料仍不足，尚無法完成真實 walk-forward 驗證`

## 下一步

1. 繼續補齊至少 28 個有效交易日，讓 unique trading dates 達到 1000。
2. 確認缺失的 6 個 TWSE 日期是否為非交易日、官方無資料日，或端點回傳異常。
3. 達到 1000 個交易日後，再執行投信連買強勢股回檔策略的 walk-forward validation。
