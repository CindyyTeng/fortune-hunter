# 法人歷史資料深度探測與回填

產生時間：2026-06-16T16:51:06.921Z

## 探測結論

- TWSE T86 是否支援歷史日期：部分支援
- TWSE OpenAPI 是否支援歷史日期：否，尚未確認歷史日期端點
- TPEx OpenAPI 是否支援歷史日期：否，目前偏向只支援最新資料

## 成功日期摘要

- TWSE T86 2026-06-09
- TPEx OpenAPI latest 2026-06-09
- TPEx OpenAPI date parameter 2026-06-09
- TPEx OpenAPI latest 2026-05-08
- TPEx OpenAPI date parameter 2026-05-08
- TPEx OpenAPI latest 2026-03-09
- TPEx OpenAPI date parameter 2026-03-09
- TPEx OpenAPI latest 2025-12-09
- TPEx OpenAPI date parameter 2025-12-09
- TPEx OpenAPI latest 2025-06-09
- TPEx OpenAPI date parameter 2025-06-09
- TPEx OpenAPI latest 2024-06-07
- TPEx OpenAPI date parameter 2024-06-07
- TPEx OpenAPI latest 2022-06-09
- TPEx OpenAPI date parameter 2022-06-09

## 失敗或無資料日期摘要

- TWSE T86 2026-05-08
- TWSE T86 2026-03-09
- TWSE T86 2025-12-09
- TWSE T86 2025-06-09
- TWSE T86 2024-06-07
- TWSE T86 2022-06-09

## 人工匯入 fallback

若官方來源無法穩定回填 4 年資料，請將人工下載的 CSV 放到 `data/institutional/manual/`，後續 importer 需支援同一份 schema：date、symbol、name、foreignBuy、foreignSell、foreignNetBuy、trustBuy、trustSell、trustNetBuy、dealerBuy、dealerSell、dealerNetBuy、source。
