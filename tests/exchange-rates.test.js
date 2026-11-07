const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseRatesFromHtml } = require('../api/exchange-rates');

const fixture = `
<table>
  <thead><tr><th>العملة</th><th>سعر الشراء</th><th>سعر البيع</th></tr></thead>
  <tbody>
    <tr><td>الدرهم الإماراتي (AED)</td><td>420.00</td><td>423.00</td></tr>
    <tr><td>الدينار البحريني (BHD)</td><td>4,273.00</td><td>4,297.00</td></tr>
    <tr><td>اليورو (EUR)</td><td>1,628.00</td><td>1,749.00</td></tr>
    <tr><td>الدينار الكويتي (KWD)</td><td>5,247.00</td><td>5,330.00</td></tr>
    <tr><td>الريال العماني (OMR)</td><td>4,071.00</td><td>4,130.00</td></tr>
    <tr><td>الريال السعودي (SAR)</td><td>412.00</td><td>413.00</td></tr>
    <tr><td>الدولار الأمريكي (USD)</td><td>1,564.00</td><td>1,571.00</td></tr>
    <tr><td>الريال اليمني (YER)</td><td>1.00</td><td>1.00</td></tr>
  </tbody>
</table>`;

test('parses the Aden buy/sell rate table and thousands separators', () => {
  const rates = parseRatesFromHtml(fixture);
  assert.ok(rates);
  assert.deepEqual(rates.USD, { buy: 1564, sell: 1571 });
  assert.deepEqual(rates.BHD, { buy: 4273, sell: 4297 });
  assert.deepEqual(rates.YER, { buy: 1, sell: 1 });
});

test('rejects incomplete or unrecognized source tables', () => {
  assert.equal(parseRatesFromHtml('<table><tr><td>USD</td><td>1500</td></tr></table>'), null);
});


test('checks the inline application script for JavaScript syntax errors', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(script => script.trim());

  assert.ok(scripts.length > 0, 'index.html should contain an inline application script');
  for (const script of scripts) {
    assert.doesNotThrow(() => new vm.Script(script, { filename: 'index.html:inline-script' }));
  }
});
