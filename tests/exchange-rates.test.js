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

test('WALLET OS uses Supabase Auth and the public publishable key', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /@supabase\/supabase-js@2\.119\.0/);
  assert.match(html, /SUPABASE_PUBLISHABLE_KEY\s*=\s*['"]sb_publishable_/);
  assert.match(html, /signInWithPassword\(/);
  assert.match(html, /auth\.signUp\(/);
  assert.match(html, /auth\.getSession\(/);
  assert.doesNotMatch(html, /SUPABASE_SERVICE_ROLE|service_role_key|sb_secret_/i);
});

test('cloud financial writes use the secure posting RPC and preserve a local import backup', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /function cloudPostTransaction\(/);
  assert.match(html, /post_financial_transaction/);
  assert.match(html, /p_idempotency_key:\s*cloudKey\(/);
  assert.match(html, /wos_pre_cloud_backup_/);
  assert.match(html, /function cloudImportLocal\(/);
  assert.match(html, /CLOUD_IMPORT_STATUS='partial'/);
  assert.match(html, /wallet_account_balances/);
});

test('cloud import is multi-device safe and password recovery is wired', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /function cloudImportSourceId\(/);
  assert.match(html, /function cloudImportKey\(/);
  assert.match(html, /S\.cloudOwnerId=uid/);
  assert.match(html, /cloudImportSavedBackup/);
  assert.match(html, /cloudShowPasswordRecovery/);
  assert.match(html, /PASSWORD_RECOVERY/);
  assert.match(html, /auth\.updateUser\(\{password:/);
});

test('cloud creation forms use database RPCs instead of local-only writes', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  for (const name of ['create_wallet_account', 'create_savings_goal_v2', 'create_loan_v2', 'create_investment_asset_v2']) {
    assert.match(html, new RegExp("cloudRpc\\('" + name + "'"));
  }
  assert.match(html, /async v=>\{if\(!\(\+v\.l>0\)\).*cloudUpsertBudget/);
  assert.match(html, /function cloudAssetType\(/);
});

test('income and expense form types are translated to the ledger RPC contract', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /if\(t==='inc'\|\|t==='exp'\)\{type=t==='inc'\?'income':'expense';cat=cloudCategoryId\(type,v\.cat\);\}/);
});
