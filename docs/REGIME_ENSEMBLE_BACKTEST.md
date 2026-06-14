# 市場狀態切換策略 10 年回測

> 倖存者偏差警告：**是**
> 目前使用現有候選資料集，尚未補齊歷史上市、下市與停止交易清單。
> 原始 OHLCV 股票清單偏差警告：**是**。目前股票清單來自舊 10 年資料中曾出現過候選的股票代碼，但候選日期與策略訊號已全部改由原始 OHLCV 重新獨立計算。

## 摘要

- 區間：2016-06-01 至 2026-06-09
- 交易筆數：1066
- 總資產報酬：-92.12%
- 平均月總資產報酬：-2.02%
- 平均月已實現報酬：-2.01%
- 負總資產月份：58
- 月已實現報酬達 10%：0
- 最大回撤：-92.51%
- 勝率：37.52%
- Profit Factor：0.45

## 候選到成交漏斗

| 市場狀態 | 出現天數 | 候選股數量 | 進場條件觸發 | 實際進場 | 候選轉交易 |
|---|---:|---:|---:|---:|---:|
| BULL_TREND | 371 | 11523 | 9023 | 185 | 1.61% |
| BULL_PULLBACK | 227 | 11875 | 6904 | 146 | 1.23% |
| RANGE_BOUND | 632 | 46249 | 42573 | 380 | 0.82% |
| BEAR_DEFENSE | 418 | 0 | 0 | 0 | 0% |
| HIGH_VOLATILITY | 120 | 0 | 0 | 0 | 0% |
| THEME_MOMENTUM | 669 | 33807 | 26188 | 355 | 1.05% |

| 策略 | 候選股數量 | 進場條件觸發 | 實際進場 | 候選轉交易 |
|---|---:|---:|---:|---:|
| breakoutMomentumStrategy | 45330 | 35211 | 540 | 1.19% |
| pullbackTrendStrategy | 11526 | 6558 | 136 | 1.18% |
| rangeReversionStrategy | 44995 | 41355 | 367 | 0.82% |
| oversoldReboundStrategy | 1603 | 1564 | 23 | 1.43% |
| cashDefenseStrategy | 0 | 0 | 0 | 0% |

候選與實際成交的差距主要來自：同日候選競爭、最大持倉數、現金與 T+2 限制、同股票已有持倉，以及限價或突破條件未成交。

### 候選數量診斷

- **breakoutMomentumStrategy**：適用狀態共 1040 天；候選 45330、進場 540。候選充足；實際進場較少主要來自同日排序、持倉上限、現金與 T+2，以及同股票不可重複持有。
- **pullbackTrendStrategy**：適用狀態共 227 天；候選 11526、進場 136。候選充足；實際進場較少主要來自同日排序、持倉上限、現金與 T+2，以及同股票不可重複持有。
- **rangeReversionStrategy**：適用狀態共 632 天；候選 44995、進場 367。候選充足；實際進場較少主要來自同日排序、持倉上限、現金與 T+2，以及同股票不可重複持有。
- **oversoldReboundStrategy**：適用狀態共 859 天；候選 1603、進場 23。短線急跌、放量下影線與當日轉強必須同時成立，因此候選自然較少；完整組合中還會與主要策略競爭資金。
- **cashDefenseStrategy**：適用狀態共 538 天；候選 0、進場 0。防守策略刻意不產生新倉；市場進入空頭或高波動時，回測會關閉既有部位降低曝險。

## 各市場狀態績效

| 市場狀態 | 天數 | 設定策略 | 實際使用策略 | 交易筆數 | 勝率 | 平均報酬 | Profit Factor | 最大回撤 |
|---|---:|---|---|---:|---:|---:|---:|---:|
| BULL_TREND | 371 | breakoutMomentumStrategy | breakoutMomentumStrategy | 185 | 29.19% | -2.8% | 0.22 | -59.96% |
| BULL_PULLBACK | 227 | pullbackTrendStrategy | pullbackTrendStrategy、oversoldReboundStrategy | 146 | 43.15% | -1.26% | 0.42 | -23.02% |
| RANGE_BOUND | 632 | rangeReversionStrategy | rangeReversionStrategy、oversoldReboundStrategy | 380 | 36.05% | -0.72% | 0.76 | -34.84% |
| BEAR_DEFENSE | 418 | cashDefenseStrategy | - | 0 | 0% | 0% | 0 | 0% |
| HIGH_VOLATILITY | 120 | cashDefenseStrategy | - | 0 | 0% | 0% | 0 | 0% |
| THEME_MOMENTUM | 669 | breakoutMomentumStrategy | breakoutMomentumStrategy | 355 | 41.13% | -1.52% | 0.48 | -63.5% |

## 每月報酬

| 月份 | 已實現報酬 | 總資產報酬 | 月底持倉 | 平倉筆數 | 已實現達 10% |
|---|---:|---:|---:|---:|---|
| 2016-06 | 1.21% | 2.12% | 6 | 9 | 否 |
| 2016-07 | 3.57% | 1.4% | 5 | 20 | 否 |
| 2016-08 | -6.52% | -6.58% | 5 | 23 | 否 |
| 2016-09 | -2.61% | -2.32% | 6 | 16 | 否 |
| 2016-10 | -10.18% | -9.03% | 2 | 21 | 否 |
| 2016-11 | -8.64% | -9.71% | 5 | 25 | 否 |
| 2016-12 | -1.43% | -0.51% | 1 | 20 | 否 |
| 2017-01 | 0.86% | 0.4% | 3 | 13 | 否 |
| 2017-02 | 4.54% | 3.42% | 5 | 11 | 否 |
| 2017-03 | -3.79% | -3.94% | 4 | 23 | 否 |
| 2017-04 | -7.93% | -7.32% | 3 | 17 | 否 |
| 2017-05 | -0.9% | -0.55% | 3 | 11 | 否 |
| 2017-06 | -3.65% | -5.39% | 6 | 15 | 否 |
| 2017-07 | -7.65% | -6.04% | 3 | 18 | 否 |
| 2017-08 | 0.06% | 0.67% | 5 | 19 | 否 |
| 2017-09 | -2.3% | -2.3% | 4 | 22 | 否 |
| 2017-10 | -5.95% | -7.27% | 5 | 16 | 否 |
| 2017-11 | -2.21% | -1.49% | 5 | 14 | 否 |
| 2017-12 | -3.91% | -4.01% | 6 | 24 | 否 |
| 2018-01 | -0.97% | -2.56% | 6 | 19 | 否 |
| 2018-02 | -7.05% | -5.41% | 6 | 10 | 否 |
| 2018-03 | -9.26% | -8.49% | 5 | 23 | 否 |
| 2018-04 | 0.91% | 0.85% | 0 | 13 | 否 |
| 2018-05 | -3.35% | -3.35% | 0 | 7 | 否 |
| 2018-06 | -3.17% | -3.17% | 0 | 7 | 否 |
| 2018-07 | 1.24% | 0.47% | 4 | 15 | 否 |
| 2018-08 | -4% | -3.95% | 4 | 21 | 否 |
| 2018-09 | -4.42% | -5.28% | 6 | 21 | 否 |
| 2018-10 | -8.31% | -6.82% | 0 | 14 | 否 |
| 2018-11 | 0% | 0% | 0 | 0 | 否 |
| 2018-12 | 0% | 0% | 0 | 0 | 否 |
| 2019-01 | 0% | 0% | 0 | 0 | 否 |
| 2019-02 | 0% | -0.86% | 6 | 0 | 否 |
| 2019-03 | -2.59% | -2.39% | 4 | 19 | 否 |
| 2019-04 | -0.9% | -0.4% | 5 | 16 | 否 |
| 2019-05 | -9.83% | -9.69% | 0 | 28 | 否 |
| 2019-06 | 2.62% | 3.67% | 5 | 15 | 否 |
| 2019-07 | -1.58% | -2.69% | 4 | 17 | 否 |
| 2019-08 | -4.79% | -5.01% | 4 | 26 | 否 |
| 2019-09 | -6.17% | -7.22% | 3 | 19 | 否 |
| 2019-10 | -1.39% | 0.59% | 4 | 12 | 否 |
| 2019-11 | -3.21% | -4.07% | 5 | 10 | 否 |
| 2019-12 | -3.94% | -5.15% | 4 | 15 | 否 |
| 2020-01 | -9.97% | -8.33% | 1 | 19 | 否 |
| 2020-02 | -4.31% | -5.13% | 5 | 24 | 否 |
| 2020-03 | -3.56% | -2.88% | 0 | 11 | 否 |
| 2020-04 | 0% | 0% | 0 | 0 | 否 |
| 2020-05 | 0% | 0% | 0 | 0 | 否 |
| 2020-06 | -1.97% | -2.29% | 6 | 13 | 否 |
| 2020-07 | -3.66% | -3.82% | 5 | 25 | 否 |
| 2020-08 | -6.82% | -8.89% | 3 | 21 | 否 |
| 2020-09 | -11.07% | -9.29% | 6 | 21 | 否 |
| 2020-10 | -2.15% | -2.15% | 2 | 15 | 否 |
| 2020-11 | 4.5% | 2.9% | 5 | 11 | 否 |
| 2020-12 | -6.57% | -5.86% | 4 | 19 | 否 |
| 2021-01 | -9.06% | -7.54% | 1 | 19 | 否 |
| 2021-02 | 1.51% | 0.54% | 6 | 9 | 否 |
| 2021-03 | 2.87% | 3.63% | 2 | 21 | 否 |
| 2021-04 | 0.42% | -0.53% | 2 | 14 | 否 |
| 2021-05 | -15.23% | -14.76% | 6 | 21 | 否 |
| 2021-06 | -9.51% | -8.73% | 3 | 17 | 否 |
| 2021-07 | -3.31% | -3.65% | 0 | 10 | 否 |
| 2021-08 | -2.35% | -2.35% | 0 | 4 | 否 |
| 2021-09 | -2.94% | -4.55% | 5 | 6 | 否 |
| 2021-10 | 1.13% | 2.95% | 3 | 6 | 否 |
| 2021-11 | -4.94% | -5.04% | 0 | 15 | 否 |
| 2021-12 | -0.12% | -0.13% | 4 | 6 | 否 |
| 2022-01 | -11.7% | -11.7% | 0 | 12 | 否 |
| 2022-02 | -1.26% | -1.26% | 0 | 5 | 否 |
| 2022-03 | 0% | 0% | 0 | 0 | 否 |
| 2022-04 | 0% | 0% | 0 | 0 | 否 |
| 2022-05 | 0% | 0% | 0 | 0 | 否 |
| 2022-06 | 0% | 0% | 0 | 0 | 否 |
| 2022-07 | 0% | 0% | 0 | 0 | 否 |
| 2022-08 | 0% | 0% | 0 | 0 | 否 |
| 2022-09 | 0% | 0% | 0 | 0 | 否 |
| 2022-10 | 0% | 0% | 0 | 0 | 否 |
| 2022-11 | 3.4% | 2.34% | 3 | 1 | 否 |
| 2022-12 | -5.79% | -4.81% | 0 | 8 | 否 |
| 2023-01 | -2.1% | -2.1% | 0 | 4 | 否 |
| 2023-02 | 0.79% | 0.79% | 0 | 4 | 否 |
| 2023-03 | -0.91% | -1.23% | 3 | 7 | 否 |
| 2023-04 | 0.16% | 0.49% | 0 | 7 | 否 |
| 2023-05 | 0.93% | 0.61% | 3 | 3 | 否 |
| 2023-06 | -2% | -2.31% | 2 | 10 | 否 |
| 2023-07 | -6.69% | -7.14% | 4 | 7 | 否 |
| 2023-08 | -2.36% | -1.26% | 0 | 4 | 否 |
| 2023-09 | 0% | 0% | 0 | 0 | 否 |
| 2023-10 | -1.07% | -1.07% | 0 | 3 | 否 |
| 2023-11 | 0% | 0% | 0 | 0 | 否 |
| 2023-12 | 0% | 0% | 0 | 0 | 否 |
| 2024-01 | 0% | 0% | 0 | 0 | 否 |
| 2024-02 | 0% | 0% | 0 | 0 | 否 |
| 2024-03 | 0% | 0% | 0 | 0 | 否 |
| 2024-04 | 0% | 0% | 0 | 0 | 否 |
| 2024-05 | 0% | 0% | 0 | 0 | 否 |
| 2024-06 | 0% | 0% | 0 | 0 | 否 |
| 2024-07 | 0% | 0% | 0 | 0 | 否 |
| 2024-08 | 0% | 0% | 0 | 0 | 否 |
| 2024-09 | 0% | 0% | 0 | 0 | 否 |
| 2024-10 | 0% | 0% | 0 | 0 | 否 |
| 2024-11 | 0% | 0% | 0 | 0 | 否 |
| 2024-12 | 0% | 0% | 0 | 0 | 否 |
| 2025-01 | 0% | 0% | 0 | 0 | 否 |
| 2025-02 | 0% | 0% | 0 | 0 | 否 |
| 2025-03 | 0% | 0% | 0 | 0 | 否 |
| 2025-04 | 0% | 0% | 0 | 0 | 否 |
| 2025-05 | 0% | 0% | 0 | 0 | 否 |
| 2025-06 | 0% | 0% | 0 | 0 | 否 |
| 2025-07 | 0% | 0% | 0 | 0 | 否 |
| 2025-08 | 0% | 0% | 0 | 0 | 否 |
| 2025-09 | 0% | 0% | 0 | 0 | 否 |
| 2025-10 | 0% | 0% | 0 | 0 | 否 |
| 2025-11 | 0% | 0% | 0 | 0 | 否 |
| 2025-12 | 0% | 0% | 0 | 0 | 否 |
| 2026-01 | 0% | 0% | 0 | 0 | 否 |
| 2026-02 | 0% | 0% | 0 | 0 | 否 |
| 2026-03 | 0% | 0% | 0 | 0 | 否 |
| 2026-04 | 0% | 0% | 0 | 0 | 否 |
| 2026-05 | 0% | 0% | 0 | 0 | 否 |
| 2026-06 | 0% | 0% | 0 | 0 | 否 |

## 最近 100 次策略切換

| 日期 | 前狀態 | 新狀態 | 策略 | 原因 |
|---|---|---|---|---|
| 2024-11-26 | THEME_MOMENTUM | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2024-12-03 | RANGE_BOUND | BULL_PULLBACK | pullbackTrendStrategy | 中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱 |
| 2024-12-04 | BULL_PULLBACK | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 8.22%，樣本 7 檔 |
| 2024-12-11 | THEME_MOMENTUM | BULL_PULLBACK | pullbackTrendStrategy | 中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱 |
| 2024-12-13 | BULL_PULLBACK | BULL_TREND | breakoutMomentumStrategy | 價格與 20/60/120/200 日均線多頭排列 |
| 2024-12-20 | BULL_TREND | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2024-12-23 | RANGE_BOUND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 2.71%，樣本 13 檔 |
| 2024-12-24 | THEME_MOMENTUM | BULL_TREND | breakoutMomentumStrategy | 價格與 20/60/120/200 日均線多頭排列 |
| 2024-12-25 | BULL_TREND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 2.07%，樣本 13 檔 |
| 2024-12-26 | THEME_MOMENTUM | BULL_TREND | breakoutMomentumStrategy | 價格與 20/60/120/200 日均線多頭排列 |
| 2024-12-31 | BULL_TREND | BULL_PULLBACK | pullbackTrendStrategy | 中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱 |
| 2025-01-02 | BULL_PULLBACK | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-01-06 | RANGE_BOUND | BULL_TREND | breakoutMomentumStrategy | 價格與 20/60/120/200 日均線多頭排列 |
| 2025-01-13 | BULL_TREND | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-01-16 | RANGE_BOUND | BULL_TREND | breakoutMomentumStrategy | 價格與 20/60/120/200 日均線多頭排列 |
| 2025-01-17 | BULL_TREND | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-01-20 | RANGE_BOUND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 6.29%，樣本 8 檔 |
| 2025-02-03 | THEME_MOMENTUM | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-02-07 | RANGE_BOUND | BULL_PULLBACK | pullbackTrendStrategy | 中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱 |
| 2025-02-10 | BULL_PULLBACK | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 5.16%，樣本 7 檔 |
| 2025-02-13 | THEME_MOMENTUM | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-02-17 | RANGE_BOUND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 12.04%，樣本 8 檔 |
| 2025-02-24 | THEME_MOMENTUM | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-03-07 | RANGE_BOUND | BEAR_DEFENSE | cashDefenseStrategy | 價格位於中長期均線下方且中期趨勢轉弱 |
| 2025-04-07 | BEAR_DEFENSE | HIGH_VOLATILITY | cashDefenseStrategy | 20 日年化波動 39.29%，5 日動能 -12.49% |
| 2025-05-09 | HIGH_VOLATILITY | BEAR_DEFENSE | cashDefenseStrategy | 價格位於中長期均線下方且中期趨勢轉弱 |
| 2025-06-10 | BEAR_DEFENSE | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 1.95%，樣本 8 檔 |
| 2025-06-11 | THEME_MOMENTUM | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-06-18 | RANGE_BOUND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 3.13%，樣本 8 檔 |
| 2025-06-19 | THEME_MOMENTUM | BULL_PULLBACK | pullbackTrendStrategy | 中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱 |
| 2025-06-24 | BULL_PULLBACK | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-06-27 | RANGE_BOUND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 1.72%，樣本 55 檔 |
| 2025-06-30 | THEME_MOMENTUM | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-07-03 | RANGE_BOUND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 1.54%，樣本 7 檔 |
| 2025-07-04 | THEME_MOMENTUM | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-07-07 | RANGE_BOUND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 1.58%，樣本 7 檔 |
| 2025-07-08 | THEME_MOMENTUM | BULL_PULLBACK | pullbackTrendStrategy | 中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱 |
| 2025-07-10 | BULL_PULLBACK | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-07-17 | RANGE_BOUND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 1.73%，樣本 7 檔 |
| 2025-07-18 | THEME_MOMENTUM | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-07-21 | RANGE_BOUND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 2.64%，樣本 7 檔 |
| 2025-07-22 | THEME_MOMENTUM | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-07-23 | RANGE_BOUND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 2.16%，樣本 7 檔 |
| 2025-07-24 | THEME_MOMENTUM | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-07-25 | RANGE_BOUND | BULL_PULLBACK | pullbackTrendStrategy | 中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱 |
| 2025-07-28 | BULL_PULLBACK | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-07-29 | RANGE_BOUND | BULL_PULLBACK | pullbackTrendStrategy | 中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱 |
| 2025-07-31 | BULL_PULLBACK | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 2.73%，樣本 13 檔 |
| 2025-08-01 | THEME_MOMENTUM | BULL_PULLBACK | pullbackTrendStrategy | 中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱 |
| 2025-08-05 | BULL_PULLBACK | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 3.89%，樣本 13 檔 |
| 2025-08-06 | THEME_MOMENTUM | BULL_PULLBACK | pullbackTrendStrategy | 中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱 |
| 2025-08-07 | BULL_PULLBACK | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 6%，樣本 13 檔 |
| 2025-08-12 | THEME_MOMENTUM | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-08-14 | RANGE_BOUND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 4.2%，樣本 8 檔 |
| 2025-08-20 | THEME_MOMENTUM | BULL_PULLBACK | pullbackTrendStrategy | 中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱 |
| 2025-08-27 | BULL_PULLBACK | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 5.7%，樣本 7 檔 |
| 2025-09-01 | THEME_MOMENTUM | BULL_PULLBACK | pullbackTrendStrategy | 中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱 |
| 2025-09-04 | BULL_PULLBACK | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-09-05 | RANGE_BOUND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 6.7%，樣本 8 檔 |
| 2025-09-30 | THEME_MOMENTUM | BULL_TREND | breakoutMomentumStrategy | 價格與 20/60/120/200 日均線多頭排列 |
| 2025-10-02 | BULL_TREND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 2.1%，樣本 13 檔 |
| 2025-10-23 | THEME_MOMENTUM | BULL_TREND | breakoutMomentumStrategy | 價格與 20/60/120/200 日均線多頭排列 |
| 2025-10-27 | BULL_TREND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 17.47%，樣本 7 檔 |
| 2025-11-05 | THEME_MOMENTUM | BULL_TREND | breakoutMomentumStrategy | 價格與 20/60/120/200 日均線多頭排列 |
| 2025-11-07 | BULL_TREND | BULL_PULLBACK | pullbackTrendStrategy | 中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱 |
| 2025-11-10 | BULL_PULLBACK | BULL_TREND | breakoutMomentumStrategy | 價格與 20/60/120/200 日均線多頭排列 |
| 2025-11-11 | BULL_TREND | BULL_PULLBACK | pullbackTrendStrategy | 中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱 |
| 2025-11-12 | BULL_PULLBACK | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 23.66%，樣本 8 檔 |
| 2025-11-13 | THEME_MOMENTUM | BULL_PULLBACK | pullbackTrendStrategy | 中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱 |
| 2025-11-14 | BULL_PULLBACK | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-11-26 | RANGE_BOUND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 2.64%，樣本 13 檔 |
| 2025-11-27 | THEME_MOMENTUM | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-11-28 | RANGE_BOUND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 2.95%，樣本 55 檔 |
| 2025-12-02 | THEME_MOMENTUM | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-12-03 | RANGE_BOUND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 1.73%，樣本 7 檔 |
| 2025-12-15 | THEME_MOMENTUM | BULL_TREND | breakoutMomentumStrategy | 價格與 20/60/120/200 日均線多頭排列 |
| 2025-12-17 | BULL_TREND | BULL_PULLBACK | pullbackTrendStrategy | 中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱 |
| 2025-12-18 | BULL_PULLBACK | RANGE_BOUND | rangeReversionStrategy | 趨勢排列不完整，價格處於區間型態 |
| 2025-12-19 | RANGE_BOUND | BULL_TREND | breakoutMomentumStrategy | 價格與 20/60/120/200 日均線多頭排列 |
| 2025-12-22 | BULL_TREND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 4.32%，樣本 8 檔 |
| 2026-01-26 | THEME_MOMENTUM | BULL_TREND | breakoutMomentumStrategy | 價格與 20/60/120/200 日均線多頭排列 |
| 2026-01-27 | BULL_TREND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 3.64%，樣本 8 檔 |
| 2026-02-02 | THEME_MOMENTUM | BULL_PULLBACK | pullbackTrendStrategy | 中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱 |
| 2026-02-03 | BULL_PULLBACK | BULL_TREND | breakoutMomentumStrategy | 價格與 20/60/120/200 日均線多頭排列 |
| 2026-02-05 | BULL_TREND | BULL_PULLBACK | pullbackTrendStrategy | 中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱 |
| 2026-02-09 | BULL_PULLBACK | BULL_TREND | breakoutMomentumStrategy | 價格與 20/60/120/200 日均線多頭排列 |
| 2026-02-24 | BULL_TREND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 6.48%，樣本 7 檔 |
| 2026-03-03 | THEME_MOMENTUM | BULL_TREND | breakoutMomentumStrategy | 價格與 20/60/120/200 日均線多頭排列 |
| 2026-03-09 | BULL_TREND | HIGH_VOLATILITY | cashDefenseStrategy | 20 日年化波動 32.66%，5 日動能 -8.4% |
| 2026-04-22 | HIGH_VOLATILITY | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 8.51%，樣本 55 檔 |
| 2026-04-24 | THEME_MOMENTUM | HIGH_VOLATILITY | cashDefenseStrategy | 20 日年化波動 32.52%，5 日動能 6.89% |
| 2026-04-30 | HIGH_VOLATILITY | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 2.68%，樣本 8 檔 |
| 2026-05-13 | THEME_MOMENTUM | BULL_TREND | breakoutMomentumStrategy | 價格與 20/60/120/200 日均線多頭排列 |
| 2026-05-19 | BULL_TREND | BULL_PULLBACK | pullbackTrendStrategy | 中期多頭仍在，但短線回到 20 日線附近或 5 日動能轉弱 |
| 2026-05-21 | BULL_PULLBACK | BULL_TREND | breakoutMomentumStrategy | 價格與 20/60/120/200 日均線多頭排列 |
| 2026-05-22 | BULL_TREND | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 29%，樣本 7 檔 |
| 2026-05-29 | THEME_MOMENTUM | HIGH_VOLATILITY | cashDefenseStrategy | 20 日年化波動 32.52%，5 日動能 8.32% |
| 2026-06-01 | HIGH_VOLATILITY | THEME_MOMENTUM | breakoutMomentumStrategy | 題材族群相對強度 17.14%，樣本 7 檔 |
| 2026-06-05 | THEME_MOMENTUM | BULL_TREND | breakoutMomentumStrategy | 價格與 20/60/120/200 日均線多頭排列 |
| 2026-06-08 | BULL_TREND | HIGH_VOLATILITY | cashDefenseStrategy | 20 日年化波動 33.04%，5 日動能 -4.31% |
