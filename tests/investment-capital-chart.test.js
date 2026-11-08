const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const pageStart = html.indexOf('PG.invest=()=>');
const pageEnd = html.indexOf('PG.budgets=()=>', pageStart);
const investmentPage = html.slice(pageStart, pageEnd);

test('investment page combines portfolio P/L and gold distribution without duplicate charts', () => {
  assert.ok(pageStart >= 0 && pageEnd > pageStart, 'investment page should exist');
  assert.match(investmentPage, /رأس المال المستثمر والربح والخسارة حسب الأصل\|Invested capital and profit\/loss by asset/);
  assert.equal(investmentPage.split('portfolioPLChart(A)').length - 1, 1);
  assert.match(investmentPage, /توزيع الذهب\|Gold allocation/);
  assert.doesNotMatch(investmentPage, /حركة الذهب في البورصة العالمية\|Global gold market movement/);
});

test('capital comparison chart shows invested amount, current value and total P/L', () => {
  assert.match(html, /invested:cv\(Number\(p\.c\|\|0\)/);
  assert.match(html, /current:cv\(Number\(p\.v\|\|0\)/);
  assert.match(html, /إجمالي المبالغ المستثمرة\|Total invested capital/);
  assert.match(html, /القيمة الحالية للاستثمارات\|Current investment value/);
  assert.match(html, /الربح\/الخسارة الكلي · شامل المحقق\|Total P\/L · including realized/);
});

test('portfolio chart explains that it is not a global gold price chart', () => {
  assert.match(html, /لا يعرض سعر الذهب العالمي أو حركة XAU\/USD/);
});


test('portfolio comparison is a smooth animated interactive line chart', () => {
  assert.match(html, /capital-series-invested/);
  assert.match(html, /capital-series-current/);
  assert.match(html, /capitalLineDraw/);
  assert.match(html, /capital-selection-metrics/);
  assert.ok(html.includes('data-a=\\"capitalPoint\\"'));
  assert.match(html, /capitalPoint\(v\)\{CAP_SELECTED=/);
});

test('investment page exposes transaction editing and reversal deletion beside the asset list', () => {
  assert.match(investmentPage, /investment-history/);
  assert.match(investmentPage, /data-a=ed data-v=/);
  assert.match(investmentPage, /data-a=del data-v=/);
  assert.match(investmentPage, /سجل عمليات الاستثمار\|Investment transaction history/);
  assert.match(html, /SB\.rpc\('void_financial_transaction'/);
  assert.match(html, /SB\.rpc\('edit_financial_transaction'/);
});

test('investment edits and purchase deletion validate all later sales against the recalculated quantity', () => {
  assert.match(html, /function investmentLedgerValidAfterEdit\(assetId,transactionId,replacement\)/);
  assert.match(html, /investmentLedgerValidAfterEdit\(r\.ref,r\.id,next\)/);
  assert.match(html, /investmentLedgerValidAfterEdit\(r\.ref,r\.id,null\)/);
  assert.match(html, /This purchase is required by later sales/);
});

test('asset archive and restore work in local mode while cloud actions use the owner-scoped management RPC', () => {
  assert.match(html, /a\.archived=true;save\(\);build\(\);toast/);
  assert.match(html, /else\{a\.archived=false;save\(\);build\(\);toast/);
  assert.match(html, /cloudManageItem\('investment',id,'archive'/);
  assert.match(html, /cloudManageItem\('investment',id,'restore'/);
});
