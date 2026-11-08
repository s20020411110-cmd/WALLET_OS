const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('transaction rows expose edit and delete actions in both local and cloud mode', () => {
  const start = html.indexOf('const actList=');
  const end = html.indexOf('\nconst tbody=', start);
  assert.ok(start >= 0 && end > start, 'activity row renderer should exist');
  const renderer = html.slice(start, end);
  assert.match(renderer, /data-a=ed/);
  assert.match(renderer, /data-a=del/);
  assert.doesNotMatch(renderer, /CLOUD_USER\s*\?\s*''/);
});

test('cloud edits use the audited replacement transaction RPC', () => {
  const start = html.indexOf('async function cloudEditTransaction(');
  const end = html.indexOf('async function cloudCreateLegacy(', start);
  assert.ok(start >= 0 && end > start, 'cloud edit helper should exist');
  const helper = html.slice(start, end);
  assert.match(helper, /SB\.rpc\('edit_financial_transaction'/);
  for (const field of [
    'p_transaction_id', 'p_payload', 'p_type', 'p_amount',
    'p_currency_code', 'p_account_id', 'p_destination_account_id',
    'p_related_goal_id', 'p_related_loan_id', 'p_related_investment_id',
    'p_target_amount', 'p_target_currency_code', 'p_occurred_on'
  ]) assert.ok(helper.includes(field), 'cloud edit payload includes ' + field);
  assert.match(helper, /await cloudRefresh\(\)/);
});

test('cloud deletion requires confirmation and calls the audited void RPC', () => {
  const start = html.indexOf('async del(id){');
  const end = html.indexOf('\nel(id)', start);
  assert.ok(start >= 0 && end > start, 'delete action should exist');
  const handler = html.slice(start, end);
  assert.match(handler, /confirm\(/);
  assert.match(handler, /SB\.rpc\('void_financial_transaction'/);
  assert.match(handler, /await cloudRefresh\(\)/);
});

test('transaction editing requires confirmation before replacing the local or cloud record', () => {
  const start = html.indexOf('ed(id){', html.indexOf('async del(id){'));
  const end = html.indexOf('\nel(id)', start);
  assert.ok(start >= 0 && end > start, 'edit action should exist');
  const handler = html.slice(start, end);
  assert.match(handler, /تأكيد تعديل المعاملة/);
  assert.match(handler, /cloudEditTransaction\(r,next\)/);
  assert.match(handler, /Object\.assign\(r,next\)/);
});

test('voided cloud transactions are excluded from active transaction views', () => {
  assert.match(html, /tx\.filter\(t=>types\[t\.type\]&&!t\.is_voided\)/);
});

test('manual transfers retain both source and destination wallets and remain transfers', () => {
  const start = html.indexOf('async function cloudPostTransaction(');
  const end = html.indexOf('async function cloudEditTransaction(', start);
  assert.ok(start >= 0 && end > start, 'cloud posting helper should exist');
  const helper = html.slice(start, end);
  assert.match(helper, /if\(t==='trf'\)/);
  assert.match(helper, /type='transfer'/);
  assert.match(helper, /p_destination_account_id:dest\?dest\.id:null/);
  assert.match(helper, /p_target_amount:ta/);
});
