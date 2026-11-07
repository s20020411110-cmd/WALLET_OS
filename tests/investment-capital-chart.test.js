const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('investment page uses portfolio capital and P/L instead of global gold candles', () => {
  assert.match(html, /رأس المال المستثمر والربح والخسارة\|Invested capital and portfolio profit\/loss/);
  assert.match(html, /portfolioPLChart\(A\)/);
  assert.doesNotMatch(html, /حركة الذهب في البورصة العالمية\|Global gold market movement/);
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
