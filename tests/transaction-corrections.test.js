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


test('budgets accept a user-entered name and an optional linked wallet account', () => {
  const start = html.indexOf('function addBud(){');
  const end = html.indexOf('\nconst IC=', start);
  assert.ok(start >= 0 && end > start, 'budget form should exist');
  const form = html.slice(start, end);
  assert.match(form, /\['name',_\('اسم الميزانية\|Budget name'\)/);
  assert.match(form, /\['accountId',_\('الحساب المرتبط/);
  assert.match(form, /name\.length>80/);
});

test('cloud budget writes and refreshes preserve the custom name and account link', () => {
  assert.match(html, /budget_name:String\(b\.name\|\|''\)\.trim\(\)/);
  assert.match(html, /account_id:b\.accountId\|\|null/);
  assert.match(html, /name:b\.budget_name\|\|CLOUD_EXPENSE_NAMES/);
  assert.match(html, /accountId:b\.account_id\|\|null/);
});

test('offline budget queue keeps the entered name and maps a pending account ID at sync', () => {
  assert.match(html, /kind:'budget',categoryIndex:Number\(b\.ci\),name,accountId/);
  assert.match(html, /budget_name:item\.name,account_id:item\.accountId\?\(map\[String\(item\.accountId\)\]\|\|item\.accountId\):null/);
});

test('account-linked budgets calculate spending only from the selected wallet', () => {
  assert.match(html, /r\.t=='exp'&&r\.cat==b\.ci&&\(!b\.accountId\|\|String\(r\.acc\)===String\(b\.accountId\)\)/);
});

test('budget migration backfills existing names and enforces account ownership through RLS', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'wallet_os_budget_names_and_account_links_v1.sql'), 'utf8');
  assert.match(migration, /add column if not exists budget_name text/);
  assert.match(migration, /add column if not exists account_id uuid/);
  assert.match(migration, /update public\.budgets b[\s\S]*from public\.categories c/);
  assert.match(migration, /budgets_insert_own[\s\S]*wallet_accounts a[\s\S]*a\.user_id = \(select auth\.uid\(\)\)/);
  assert.match(migration, /budgets_update_own[\s\S]*wallet_accounts a[\s\S]*a\.user_id = \(select auth\.uid\(\)\)/);
});
