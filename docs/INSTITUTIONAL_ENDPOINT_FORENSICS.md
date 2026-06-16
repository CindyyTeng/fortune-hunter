# 法人端點鑑識報告

產生時間：2026-06-16T17:57:12.566Z

## 端點矩陣

- TWSE T86：supportsHistoricalDate=true，recommendedForBackfill=true，coverage=上市，notes=確認 7/7 個日期可取回指定日期資料
- TWSE OpenAPI Swagger：supportsHistoricalDate=false，recommendedForBackfill=false，coverage=上市，notes=尚未確認可穩定取回指定歷史日期
- TPEx OpenAPI latest：supportsHistoricalDate=false，recommendedForBackfill=false，coverage=上櫃，notes=尚未確認可穩定取回指定歷史日期
- TPEx OpenAPI date parameter：supportsHistoricalDate=false，recommendedForBackfill=false，coverage=上櫃，notes=尚未確認可穩定取回指定歷史日期
- TPEx 三大法人頁面 dailyTrade：supportsHistoricalDate=true，recommendedForBackfill=true，coverage=上櫃，notes=確認 7/7 個日期可取回指定日期資料
- TPEx legacy 3itrade：supportsHistoricalDate=true，recommendedForBackfill=true，coverage=上櫃，notes=確認 7/7 個日期可取回指定日期資料

## 結論

至少一個端點可進入自動回填 smoke test

## 人工匯入

若沒有端點可穩定回填，請改用 `data/institutional/manual/` 放入人工下載 CSV，再執行 `npm run data:validate-manual-institutional` 與 `npm run data:import-manual-institutional`。
