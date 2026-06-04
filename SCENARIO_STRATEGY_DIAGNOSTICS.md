# Scenario Strategy Diagnostics

Generated at: 2026-06-04T16:58:56.974Z
Scanned: 1955
Signals: 839

## Data Limitation

- This uses daily K data. It cannot accurately test avoiding the first 5 minutes after open.
- First-5-minute logic needs intraday 1-minute or 5-minute historical data.

## Overall Combo Leaders

combo | trades | winRatePct | avgNetReturnPct | medianNetReturnPct | profitFactor | worstTradePct
--- | --- | --- | --- | --- | --- | ---
breakout_0.5% + hold_10d + no_stop + gap_8% | 81 | 59.26 | 5.91 | 2.99 | 2.99 | -12.76
breakout_0.5% + hold_10d + no_stop + gap_none | 85 | 57.65 | 5.65 | 2.72 | 2.9 | -12.76
breakout_1% + hold_10d + no_stop + gap_8% | 74 | 59.46 | 5.58 | 2.63 | 2.82 | -12.76
breakout_1% + hold_10d + no_stop + gap_none | 78 | 57.69 | 5.3 | 2.51 | 2.73 | -12.76
breakout_0.5% + hold_10d + close_stop + gap_8% | 81 | 58.02 | 5.54 | 2.99 | 2.67 | -14.58
breakout_0.5% + hold_10d + no_stop + gap_5% | 78 | 57.69 | 5.17 | 2.52 | 2.67 | -12.76
breakout_0.5% + hold_10d + intraday_stop + gap_8% | 81 | 58.02 | 5.53 | 2.99 | 2.66 | -13.21
breakout_0.5% + hold_7d + no_stop + gap_8% | 81 | 56.79 | 4.61 | 2.38 | 2.65 | -14.58
breakout_0.5% + hold_7d + no_stop + gap_none | 85 | 56.47 | 4.54 | 2.38 | 2.64 | -14.58
breakout_0.5% + hold_10d + close_stop + gap_none | 85 | 56.47 | 5.29 | 2.32 | 2.61 | -14.58

## Risk-Controlled Combo Leaders

combo | trades | winRatePct | avgNetReturnPct | medianNetReturnPct | profitFactor | worstTradePct
--- | --- | --- | --- | --- | --- | ---
breakout_0.5% + hold_10d + no_stop + gap_8% | 81 | 59.26 | 5.91 | 2.99 | 2.99 | -12.76
breakout_0.5% + hold_10d + no_stop + gap_none | 85 | 57.65 | 5.65 | 2.72 | 2.9 | -12.76
breakout_1% + hold_10d + no_stop + gap_8% | 74 | 59.46 | 5.58 | 2.63 | 2.82 | -12.76
breakout_1% + hold_10d + no_stop + gap_none | 78 | 57.69 | 5.3 | 2.51 | 2.73 | -12.76
breakout_0.5% + hold_10d + close_stop + gap_8% | 81 | 58.02 | 5.54 | 2.99 | 2.67 | -14.58
breakout_0.5% + hold_10d + no_stop + gap_5% | 78 | 57.69 | 5.17 | 2.52 | 2.67 | -12.76
breakout_0.5% + hold_10d + intraday_stop + gap_8% | 81 | 58.02 | 5.53 | 2.99 | 2.66 | -13.21
breakout_0.5% + hold_7d + no_stop + gap_8% | 81 | 56.79 | 4.61 | 2.38 | 2.65 | -14.58
breakout_0.5% + hold_7d + no_stop + gap_none | 85 | 56.47 | 4.54 | 2.38 | 2.64 | -14.58
breakout_0.5% + hold_10d + close_stop + gap_none | 85 | 56.47 | 5.29 | 2.32 | 2.61 | -14.58

## Adaptive Rule Test

rule | label | trades | winRatePct | avgNetReturnPct | medianNetReturnPct | profitFactor | worstTradePct
--- | --- | --- | --- | --- | --- | --- | ---
adaptive_v3_segment_rules | 分群規則版：上櫃短抱 5 天、低波動突破 1%、其餘 7 天控風險 | 66 | 59.09 | 4.16 | 2.79 | 2.43 | -15
adaptive_v1_loss_guard | 改良版：避開 RSI<50、高波動低流動性，依上市/上櫃調整持有天數 | 78 | 53.85 | 3.91 | 1.44 | 2.27 | -14.58
adaptive_v2_strict_momentum | 嚴格動能版：RSI 50-74、分數至少 85、突破 1% 才進場 | 58 | 53.45 | 2.96 | 1.44 | 1.86 | -15

## Filtered Combo Test

filter | combo | trades | winRatePct | avgNetReturnPct | medianNetReturnPct | profitFactor | worstTradePct
--- | --- | --- | --- | --- | --- | --- | ---
RSI >= 50 | breakout_0.5% + hold_10d + no_stop + gap_8% | 81 | 59.26 | 5.91 | 2.99 | 2.99 | -12.76
RSI 50-78 + 排除高波動低流動性 | breakout_0.5% + hold_10d + no_stop + gap_8% | 81 | 59.26 | 5.91 | 2.99 | 2.99 | -12.76
RSI 50-74 + 分數 >= 85 + 排除高波動低流動性 | breakout_1% + hold_7d + no_stop + gap_8% | 63 | 58.73 | 5.07 | 3.7 | 2.74 | -15
RSI 50-74 + 分數 >= 85 + 波動 < 5 | breakout_1% + hold_10d + no_stop + gap_8% | 61 | 59.02 | 5.38 | 2.72 | 2.58 | -12.76

## Volatility Leaders

segment | combo | trades | winRatePct | avgNetReturnPct | profitFactor | worstTradePct
--- | --- | --- | --- | --- | --- | ---
2-3 | breakout_0.5% + hold_10d + no_stop + gap_8% | 57 | 54.39 | 4.92 | 2.48 | -12.76
3-5 | breakout_0.5% + hold_10d + no_stop + gap_none | 24 | 66.67 | 8.23 | 4.81 | -10.29

## Market Leaders

segment | combo | trades | winRatePct | avgNetReturnPct | profitFactor | worstTradePct
--- | --- | --- | --- | --- | --- | ---
上市 | breakout_0.5% + hold_10d + no_stop + gap_none | 57 | 56.14 | 4.75 | 2.45 | -12.76
上櫃 | breakout_0.5% + hold_5d + no_stop + gap_5% | 25 | 60 | 8.63 | 5.25 | -11.81

## Score Leaders

segment | combo | trades | winRatePct | avgNetReturnPct | profitFactor | worstTradePct
--- | --- | --- | --- | --- | --- | ---
100 | breakout_1% + hold_5d + intraday_stop + gap_8% | 29 | 55.17 | 4.63 | 2.75 | -11.47
90-94 | breakout_0.5% + hold_7d + no_stop + gap_5% | 24 | 54.17 | 2.58 | 2.16 | -10.4
80-89 | breakout_0.5% + hold_10d + no_stop + gap_8% | 17 | 52.94 | 9.74 | 4.12 | -11.78

## Loss Diagnosis

### Pure performance leader

Combo: `breakout_0.5% + hold_10d + no_stop + gap_8%`

Top losers:

symbol | name | market | industry | entryDate | signalScore | rsi14 | std20 | gapUpPct | netReturnPct | maePct | mfePct
--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---
6715 | 嘉基 | 上市 | 電子零組件業 | 2024-12-04 | 100 | 67.6 | 2.6877 | 0.26 | -12.76 | -13.54 | 2.86
6112 | 邁達特 | 上市 | 資訊服務業 | 2025-06-09 | 94 | 64.8 | 2.5569 | 1.64 | -12.76 | -13.6 | 0.89
6742 | 澤米 | 上市 | 光電業 | 2025-09-02 | 88 | 64.3 | 2.4504 | 2.35 | -11.78 | -16.17 | 2.64
3227 | 原相 | 上櫃 | 半導體業 | 2025-06-30 | 100 | 71.6 | 2.0208 | -0.43 | -11.59 | -10.8 | 11.45
4572 | 駐龍 | 上市 | 電機機械 | 2025-05-16 | 100 | 62.7 | 2.2323 | 1.06 | -11.32 | -11.84 | 0.79
2365 | 昆盈 | 上市 | 電腦及週邊設備業 | 2025-03-04 | 86 | 73.8 | 2.4576 | 0 | -10.9 | -15.1 | 3.67
3162 | 精確 | 上櫃 | 電機機械 | 2026-01-26 | 100 | 68.1 | 2.5121 | -0.75 | -10.58 | -13.81 | 0.46
3443 | 創意 | 上市 | 半導體業 | 2025-02-19 | 100 | 64.7 | 3.6745 | 1.72 | -10.29 | -15.25 | 1.02
2338 | 光罩 | 上市 | 半導體業 | 2026-01-19 | 89 | 68.4 | 2.6279 | 1.13 | -10.11 | -10.53 | 7.92
2637 | 慧洋-KY | 上市 | 航運業 | 2025-08-19 | 94 | 68.4 | 2.0876 | 1.09 | -10.03 | -10 | 0.62
9933 | 中鼎 | 上市 | 其他 | 2025-12-03 | 91 | 70.2 | 2.1747 | 0.44 | -9.64 | -9.28 | 3.48
3324 | 雙鴻 | 上櫃 | 其他電子業 | 2024-12-04 | 100 | 66.3 | 3.6821 | 0 | -9.63 | -12 | 1.24

Worst loss groups by market:

key | losses | avgLossPct | worstTradePct | avgMaePct
--- | --- | --- | --- | ---
上市 | 25 | -7.46 | -12.76 | -10.12
上櫃 | 8 | -6.76 | -11.59 | -10.85

Worst loss groups by score:

key | losses | avgLossPct | worstTradePct | avgMaePct
--- | --- | --- | --- | ---
100 | 13 | -8.35 | -12.76 | -10.84
90-94 | 10 | -7.08 | -12.76 | -9.65
80-89 | 8 | -6.64 | -11.78 | -10.38
<80 | 2 | -4.13 | -5.31 | -9.66

Worst loss groups by RSI:

key | losses | avgLossPct | worstTradePct | avgMaePct
--- | --- | --- | --- | ---
>=70 | 8 | -8.01 | -11.59 | -10.38
60-69 | 20 | -7.51 | -12.76 | -10.59
50-59 | 5 | -5.28 | -8.39 | -9.01

### Risk-controlled leader

Combo: `breakout_0.5% + hold_10d + no_stop + gap_8%`

Top losers:

symbol | name | market | industry | entryDate | signalScore | rsi14 | std20 | gapUpPct | netReturnPct | maePct | mfePct
--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---
6715 | 嘉基 | 上市 | 電子零組件業 | 2024-12-04 | 100 | 67.6 | 2.6877 | 0.26 | -12.76 | -13.54 | 2.86
6112 | 邁達特 | 上市 | 資訊服務業 | 2025-06-09 | 94 | 64.8 | 2.5569 | 1.64 | -12.76 | -13.6 | 0.89
6742 | 澤米 | 上市 | 光電業 | 2025-09-02 | 88 | 64.3 | 2.4504 | 2.35 | -11.78 | -16.17 | 2.64
3227 | 原相 | 上櫃 | 半導體業 | 2025-06-30 | 100 | 71.6 | 2.0208 | -0.43 | -11.59 | -10.8 | 11.45
4572 | 駐龍 | 上市 | 電機機械 | 2025-05-16 | 100 | 62.7 | 2.2323 | 1.06 | -11.32 | -11.84 | 0.79
2365 | 昆盈 | 上市 | 電腦及週邊設備業 | 2025-03-04 | 86 | 73.8 | 2.4576 | 0 | -10.9 | -15.1 | 3.67
3162 | 精確 | 上櫃 | 電機機械 | 2026-01-26 | 100 | 68.1 | 2.5121 | -0.75 | -10.58 | -13.81 | 0.46
3443 | 創意 | 上市 | 半導體業 | 2025-02-19 | 100 | 64.7 | 3.6745 | 1.72 | -10.29 | -15.25 | 1.02
2338 | 光罩 | 上市 | 半導體業 | 2026-01-19 | 89 | 68.4 | 2.6279 | 1.13 | -10.11 | -10.53 | 7.92
2637 | 慧洋-KY | 上市 | 航運業 | 2025-08-19 | 94 | 68.4 | 2.0876 | 1.09 | -10.03 | -10 | 0.62
9933 | 中鼎 | 上市 | 其他 | 2025-12-03 | 91 | 70.2 | 2.1747 | 0.44 | -9.64 | -9.28 | 3.48
3324 | 雙鴻 | 上櫃 | 其他電子業 | 2024-12-04 | 100 | 66.3 | 3.6821 | 0 | -9.63 | -12 | 1.24

Worst loss groups by market:

key | losses | avgLossPct | worstTradePct | avgMaePct
--- | --- | --- | --- | ---
上市 | 25 | -7.46 | -12.76 | -10.12
上櫃 | 8 | -6.76 | -11.59 | -10.85

Worst loss groups by score:

key | losses | avgLossPct | worstTradePct | avgMaePct
--- | --- | --- | --- | ---
100 | 13 | -8.35 | -12.76 | -10.84
90-94 | 10 | -7.08 | -12.76 | -9.65
80-89 | 8 | -6.64 | -11.78 | -10.38
<80 | 2 | -4.13 | -5.31 | -9.66

Worst loss groups by RSI:

key | losses | avgLossPct | worstTradePct | avgMaePct
--- | --- | --- | --- | ---
>=70 | 8 | -8.01 | -11.59 | -10.38
60-69 | 20 | -7.51 | -12.76 | -10.59
50-59 | 5 | -5.28 | -8.39 | -9.01

## Decision Notes

- Best in-sample combo is breakout_0.5% + hold_10d + no_stop + gap_8%, with 81 trades, 5.91% average net return, and PF 2.99.
- Best risk-controlled combo is breakout_0.5% + hold_10d + no_stop + gap_8%, with worst trade -12.76% and PF 2.99.
- Do not treat this as final automation logic yet; this is still in-sample optimization.
- Avoiding the first 5 minutes cannot be validated with current daily data, so it should remain a live/paper-trading guard until intraday history is added.
- Loss diagnosis should drive the next strategy edit; do not move to paper trading while worst-case loss groups are unresolved.
- 2026-06 revision: candidate logic now blocks RSI below 50, RSI above 78, and high-volatility low-liquidity setups because the filtered test reduced worst loss from -20.34% to -12.76% while improving PF to 2.99.
- Next step is to edit the selection or execution rules based on the loss groups, then rerun historical backtests.

