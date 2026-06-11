# Scenario Strategy Diagnostics

Generated at: 2026-06-08T18:09:29.773Z
Scanned: 1953
Signals: 240

## Data Limitation

- This uses daily K data. It cannot accurately test avoiding the first 5 minutes after open.
- First-5-minute logic needs intraday 1-minute or 5-minute historical data.

## Overall Combo Leaders

combo | trades | winRatePct | avgNetReturnPct | medianNetReturnPct | profitFactor | worstTradePct
--- | --- | --- | --- | --- | --- | ---
breakout_0.5% + hold_10d + no_stop + gap_8% | 54 | 59.26 | 6.37 | 2.38 | 2.9 | -12.76
breakout_0.5% + hold_10d + no_stop + gap_none | 54 | 59.26 | 6.37 | 2.38 | 2.9 | -12.76
breakout_0.5% + hold_7d + no_stop + gap_8% | 54 | 55.56 | 5.73 | 1.58 | 2.89 | -14.58
breakout_0.5% + hold_7d + no_stop + gap_none | 54 | 55.56 | 5.73 | 1.58 | 2.89 | -14.58
breakout_0.3% + hold_10d + no_stop + gap_8% | 55 | 58.18 | 6.14 | 2.03 | 2.79 | -12.76
breakout_0.3% + hold_10d + no_stop + gap_none | 55 | 58.18 | 6.14 | 2.03 | 2.79 | -12.76
breakout_0.3% + hold_7d + no_stop + gap_8% | 55 | 54.55 | 5.51 | 1.14 | 2.78 | -14.41
breakout_0.3% + hold_7d + no_stop + gap_none | 55 | 54.55 | 5.51 | 1.14 | 2.78 | -14.41
breakout_0.5% + hold_5d + no_stop + gap_8% | 54 | 51.85 | 5.03 | 1.28 | 2.72 | -11.81
breakout_0.5% + hold_5d + no_stop + gap_none | 54 | 51.85 | 5.03 | 1.28 | 2.72 | -11.81

## Risk-Controlled Combo Leaders

combo | trades | winRatePct | avgNetReturnPct | medianNetReturnPct | profitFactor | worstTradePct
--- | --- | --- | --- | --- | --- | ---
breakout_0.5% + hold_10d + no_stop + gap_8% | 54 | 59.26 | 6.37 | 2.38 | 2.9 | -12.76
breakout_0.5% + hold_10d + no_stop + gap_none | 54 | 59.26 | 6.37 | 2.38 | 2.9 | -12.76
breakout_0.5% + hold_7d + no_stop + gap_8% | 54 | 55.56 | 5.73 | 1.58 | 2.89 | -14.58
breakout_0.5% + hold_7d + no_stop + gap_none | 54 | 55.56 | 5.73 | 1.58 | 2.89 | -14.58
breakout_0.3% + hold_10d + no_stop + gap_8% | 55 | 58.18 | 6.14 | 2.03 | 2.79 | -12.76
breakout_0.3% + hold_10d + no_stop + gap_none | 55 | 58.18 | 6.14 | 2.03 | 2.79 | -12.76
breakout_0.3% + hold_7d + no_stop + gap_8% | 55 | 54.55 | 5.51 | 1.14 | 2.78 | -14.41
breakout_0.3% + hold_7d + no_stop + gap_none | 55 | 54.55 | 5.51 | 1.14 | 2.78 | -14.41
breakout_0.5% + hold_5d + no_stop + gap_8% | 54 | 51.85 | 5.03 | 1.28 | 2.72 | -11.81
breakout_0.5% + hold_5d + no_stop + gap_none | 54 | 51.85 | 5.03 | 1.28 | 2.72 | -11.81

## Adaptive Rule Test

rule | label | trades | winRatePct | avgNetReturnPct | medianNetReturnPct | profitFactor | worstTradePct
--- | --- | --- | --- | --- | --- | --- | ---
adaptive_v1_loss_guard | 改良版：避開 RSI<50、高波動低流動性，依上市/上櫃調整持有天數 | 51 | 52.94 | 4.91 | 0.86 | 2.46 | -14.58
adaptive_v3_segment_rules | 分群規則版：上櫃短抱 5 天、低波動突破 1%、其餘 7 天控風險 | 50 | 56 | 4.14 | 2.19 | 2.29 | -15
adaptive_v2_strict_momentum | 嚴格動能版：RSI 50-74、分數至少 85、突破 1% 才進場 | 46 | 52.17 | 3 | 0.53 | 1.82 | -15

## Filtered Combo Test

filter | combo | trades | winRatePct | avgNetReturnPct | medianNetReturnPct | profitFactor | worstTradePct
--- | --- | --- | --- | --- | --- | --- | ---
RSI >= 50 | breakout_0.5% + hold_10d + no_stop + gap_8% | 54 | 59.26 | 6.37 | 2.38 | 2.9 | -12.76
RSI 50-78 + 排除高波動低流動性 | breakout_0.5% + hold_10d + no_stop + gap_8% | 54 | 59.26 | 6.37 | 2.38 | 2.9 | -12.76
RSI 50-74 + 分數 >= 85 + 排除高波動低流動性 | breakout_0.5% + hold_7d + no_stop + gap_8% | 51 | 54.9 | 5.28 | 1.14 | 2.68 | -14.58
RSI 50-74 + 分數 >= 85 + 波動 < 5 | breakout_0.5% + hold_10d + no_stop + gap_8% | 49 | 57.14 | 5.52 | 2.03 | 2.55 | -12.76

## Volatility Leaders

segment | combo | trades | winRatePct | avgNetReturnPct | profitFactor | worstTradePct
--- | --- | --- | --- | --- | --- | ---
2-3 | breakout_0.5% + hold_7d + no_stop + gap_8% | 42 | 52.38 | 5.11 | 2.58 | -14.58
3-5 | breakout_0.3% + hold_10d + no_stop + gap_3% | 10 | 70 | 9.75 | 4.39 | -10.29

## Market Leaders

segment | combo | trades | winRatePct | avgNetReturnPct | profitFactor | worstTradePct
--- | --- | --- | --- | --- | --- | ---
上市 | breakout_0.5% + hold_10d + no_stop + gap_8% | 39 | 58.97 | 6.08 | 2.82 | -12.76
上櫃 | breakout_0.3% + hold_5d + no_stop + gap_5% | 15 | 53.33 | 9.14 | 3.99 | -11.81

## Score Leaders

segment | combo | trades | winRatePct | avgNetReturnPct | profitFactor | worstTradePct
--- | --- | --- | --- | --- | --- | ---
100 | breakout_0.3% + hold_10d + no_stop + gap_8% | 15 | 53.33 | 6.03 | 2.5 | -11.59
90-94 | breakout_0.3% + hold_5d + close_stop + gap_8% | 29 | 51.72 | 5.02 | 2.78 | -11.47
80-89 | breakout_0.5% + hold_10d + no_stop + gap_8% | 9 | 66.67 | 15.46 | 6.54 | -11.78

## Loss Diagnosis

### Pure performance leader

Combo: `breakout_0.5% + hold_10d + no_stop + gap_8%`

Top losers:

symbol | name | market | industry | entryDate | signalScore | rsi14 | std20 | gapUpPct | netReturnPct | maePct | mfePct
--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---
6112 | 邁達特 | 上市 | 資訊服務業 | 2025-06-09 | 94 | 64.8 | 2.5569 | 1.64 | -12.76 | -13.6 | 0.89
6715 | 嘉基 | 上市 | 電子零組件業 | 2024-12-04 | 94 | 67.6 | 2.6877 | 0.26 | -12.76 | -13.54 | 2.86
6742 | 澤米 | 上市 | 光電業 | 2025-09-02 | 88 | 64.3 | 2.4504 | 2.35 | -11.78 | -16.17 | 2.64
3227 | 原相 | 上櫃 | 半導體業 | 2025-06-30 | 100 | 71.6 | 2.0208 | -0.43 | -11.59 | -10.8 | 11.45
4572 | 駐龍 | 上市 | 電機機械 | 2025-05-16 | 100 | 62.7 | 2.2323 | 1.06 | -11.32 | -11.84 | 0.79
3162 | 精確 | 上櫃 | 電機機械 | 2026-01-26 | 100 | 68.1 | 2.5121 | -0.75 | -10.58 | -13.81 | 0.46
3443 | 創意 | 上市 | 半導體業 | 2025-02-19 | 94 | 64.7 | 3.6745 | 1.72 | -10.29 | -15.25 | 1.02
2637 | 慧洋-KY | 上市 | 航運業 | 2025-08-19 | 94 | 68.4 | 2.0876 | 1.09 | -10.03 | -10 | 0.62
9933 | 中鼎 | 上市 | 其他 | 2025-12-03 | 91 | 70.2 | 2.1747 | 0.44 | -9.64 | -9.28 | 3.48
3324 | 雙鴻 | 上櫃 | 其他電子業 | 2024-12-04 | 100 | 66.3 | 3.6821 | 0 | -9.63 | -12 | 1.24
3006 | 晶豪科 | 上市 | 半導體業 | 2025-06-19 | 94 | 72.6 | 2.8601 | 0.17 | -8.92 | -10.6 | 0
3443 | 創意 | 上市 | 半導體業 | 2025-02-18 | 94 | 69.4 | 3.3695 | 1.06 | -8.85 | -12.59 | 4.2

Worst loss groups by market:

key | losses | avgLossPct | worstTradePct | avgMaePct
--- | --- | --- | --- | ---
上櫃 | 6 | -8.52 | -11.59 | -11.79
上市 | 16 | -8.15 | -12.76 | -10.22

Worst loss groups by score:

key | losses | avgLossPct | worstTradePct | avgMaePct
--- | --- | --- | --- | ---
100 | 7 | -8.63 | -11.59 | -10.96
80-89 | 3 | -8.37 | -11.78 | -11.28
90-94 | 12 | -8 | -12.76 | -10.31

Worst loss groups by RSI:

key | losses | avgLossPct | worstTradePct | avgMaePct
--- | --- | --- | --- | ---
>=70 | 5 | -8.98 | -11.59 | -9.72
60-69 | 17 | -8.04 | -12.76 | -10.92

### Risk-controlled leader

Combo: `breakout_0.5% + hold_10d + no_stop + gap_8%`

Top losers:

symbol | name | market | industry | entryDate | signalScore | rsi14 | std20 | gapUpPct | netReturnPct | maePct | mfePct
--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---
6112 | 邁達特 | 上市 | 資訊服務業 | 2025-06-09 | 94 | 64.8 | 2.5569 | 1.64 | -12.76 | -13.6 | 0.89
6715 | 嘉基 | 上市 | 電子零組件業 | 2024-12-04 | 94 | 67.6 | 2.6877 | 0.26 | -12.76 | -13.54 | 2.86
6742 | 澤米 | 上市 | 光電業 | 2025-09-02 | 88 | 64.3 | 2.4504 | 2.35 | -11.78 | -16.17 | 2.64
3227 | 原相 | 上櫃 | 半導體業 | 2025-06-30 | 100 | 71.6 | 2.0208 | -0.43 | -11.59 | -10.8 | 11.45
4572 | 駐龍 | 上市 | 電機機械 | 2025-05-16 | 100 | 62.7 | 2.2323 | 1.06 | -11.32 | -11.84 | 0.79
3162 | 精確 | 上櫃 | 電機機械 | 2026-01-26 | 100 | 68.1 | 2.5121 | -0.75 | -10.58 | -13.81 | 0.46
3443 | 創意 | 上市 | 半導體業 | 2025-02-19 | 94 | 64.7 | 3.6745 | 1.72 | -10.29 | -15.25 | 1.02
2637 | 慧洋-KY | 上市 | 航運業 | 2025-08-19 | 94 | 68.4 | 2.0876 | 1.09 | -10.03 | -10 | 0.62
9933 | 中鼎 | 上市 | 其他 | 2025-12-03 | 91 | 70.2 | 2.1747 | 0.44 | -9.64 | -9.28 | 3.48
3324 | 雙鴻 | 上櫃 | 其他電子業 | 2024-12-04 | 100 | 66.3 | 3.6821 | 0 | -9.63 | -12 | 1.24
3006 | 晶豪科 | 上市 | 半導體業 | 2025-06-19 | 94 | 72.6 | 2.8601 | 0.17 | -8.92 | -10.6 | 0
3443 | 創意 | 上市 | 半導體業 | 2025-02-18 | 94 | 69.4 | 3.3695 | 1.06 | -8.85 | -12.59 | 4.2

Worst loss groups by market:

key | losses | avgLossPct | worstTradePct | avgMaePct
--- | --- | --- | --- | ---
上櫃 | 6 | -8.52 | -11.59 | -11.79
上市 | 16 | -8.15 | -12.76 | -10.22

Worst loss groups by score:

key | losses | avgLossPct | worstTradePct | avgMaePct
--- | --- | --- | --- | ---
100 | 7 | -8.63 | -11.59 | -10.96
80-89 | 3 | -8.37 | -11.78 | -11.28
90-94 | 12 | -8 | -12.76 | -10.31

Worst loss groups by RSI:

key | losses | avgLossPct | worstTradePct | avgMaePct
--- | --- | --- | --- | ---
>=70 | 5 | -8.98 | -11.59 | -9.72
60-69 | 17 | -8.04 | -12.76 | -10.92

## Decision Notes

- Best in-sample combo is breakout_0.5% + hold_10d + no_stop + gap_8%, with 54 trades, 6.37% average net return, and PF 2.9.
- Best risk-controlled combo is breakout_0.5% + hold_10d + no_stop + gap_8%, with worst trade -12.76% and PF 2.9.
- Do not treat this as final automation logic yet; this is still in-sample optimization.
- Avoiding the first 5 minutes cannot be validated with current daily data, so it should remain a live/paper-trading guard until intraday history is added.
- Loss diagnosis should drive the next strategy edit; do not move to paper trading while worst-case loss groups are unresolved.
- 2026-06 revision: candidate logic now blocks RSI below 50, RSI above 78, and high-volatility low-liquidity setups because the filtered test reduced worst loss from -20.34% to -12.76% while improving PF to 2.99.
- Next step is to edit the selection or execution rules based on the loss groups, then rerun historical backtests.

