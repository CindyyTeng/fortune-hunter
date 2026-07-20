import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { mergeStatements, parseStatement } from './data/build-cashflow-quality-dataset.mjs';

const marketPayload = JSON.parse(await fs.readFile(new URL('../data/market-regime-history-10y.json', import.meta.url), 'utf8'));
const tradingDates = (marketPayload.benchmark || marketPayload.marketHistory || marketPayload || [])
  .map(row => row.date).filter(Boolean).sort();

async function cachedPage(year, quarter, market, statement) {
  const html = await fs.readFile(new URL(`../data/cashflow-quality/raw/${year}/${year}Q${quarter}-${market}-${statement}.html`, import.meta.url), 'utf8');
  return { year, quarter, market, statement, html };
}

const income = await cachedPage(2024, 1, 'sii', 'income');
const balance = await cachedPage(2024, 1, 'sii', 'balance');
const cashflow = await cachedPage(2024, 1, 'sii', 'cashflow');
const incomeRows = parseStatement(income.html, 'income', 2024, 1, 'sii');
const balanceRows = parseStatement(balance.html, 'balance', 2024, 1, 'sii');
const cashflowRows = parseStatement(cashflow.html, 'cashflow', 2024, 1, 'sii');
const tccIncome = incomeRows.find(row => row.symbol === '1101');
const tccBalance = balanceRows.find(row => row.symbol === '1101');
const tccCashflow = cashflowRows.find(row => row.symbol === '1101');

assert.equal(tccIncome?.netIncomeCumulative, 2239346, '應能解析一般產業損益表本期淨利');
assert.equal(tccBalance?.totalAssets, 567986963, '應能解析資產總計');
assert.equal(tccBalance?.totalLiabilities, 272059608, '應能解析負債總計');
assert.equal(tccCashflow?.operatingCashFlowCumulative, 4585075, '應能解析營業活動現金流');

const pages = [
  income, balance, cashflow,
  await cachedPage(2024, 2, 'sii', 'income'),
  await cachedPage(2024, 2, 'sii', 'balance'),
  await cachedPage(2024, 2, 'sii', 'cashflow')
];
const records = mergeStatements(pages, tradingDates);
const q1 = records.find(row => row.symbol === '1101' && row.quarter === '2024Q1');
const q2 = records.find(row => row.symbol === '1101' && row.quarter === '2024Q2');

assert.ok(q1?.effectiveDate > q1?.announcedDate, 'effectiveDate 必須晚於保守公布日');
assert.equal(q1?.isPointInTimeSafe, true, '資料必須標示 point-in-time safe');
assert.equal(q2?.operatingCashFlow, q2.operatingCashFlowCumulative - q1.operatingCashFlowCumulative, 'Q2 單季現金流必須由累計值轉換');
assert.equal(new Set(records.map(row => `${row.market}|${row.symbol}|${row.quarter}`)).size, records.length, '合併後不可有重複鍵');

console.log('cashflow quality pipeline tests passed');
