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

test('cloud management actions no longer use the legacy cloud-blocked message', () => {
  assert.doesNotMatch(html, /هذا الإجراء الإداري غير متاح بعد على السجلات السحابية/);
  for (const action of [
    "cloudManageItem('loan',id,'update'",
    "cloudManageItem('goal',id,'update'",
    "cloudManageItem('goal',id,'pause'",
    "cloudManageItem('investment',id,'update'",
    "cloudManageItem('loan',id,'archive'",
    "cloudManageItem('goal',id,'archive'",
    "cloudManageItem('investment',id,'archive'",
    "cloudManageItem('wallet',id,'archive'",
    "cloudManageItem('budget',id,'delete'"
  ]) assert.ok(html.includes(action), 'missing cloud management route: ' + action);
});

test('cloud management RPC checks the live Supabase session and calls the owner-scoped database function', () => {
  const start = html.indexOf('async function cloudManageItem(');
  const end = html.indexOf('async function cloudCreateLegacy(', start);
  assert.ok(start >= 0 && end > start, 'cloud management helper should exist');
  const helper = html.slice(start, end);
  assert.match(helper, /SB\.auth\.getSession\(\)/);
  assert.match(helper, /sessionData\.session\.user\.id!==CLOUD_USER\.id/);
  assert.match(helper, /SB\.rpc\('manage_financial_item'/);
  assert.match(helper, /await cloudRefresh\(\)/);
});

test('cloud edits preserve financial ledger balances by changing profile metadata only', () => {
  assert.match(html, /cloudManageItem\('loan',id,'update'/);
  assert.match(html, /cloudManageItem\('goal',id,'update'/);
  assert.match(html, /cloudManageItem\('investment',id,'update'/);
  assert.match(html, /p_transaction_id/);
  assert.match(html, /cloudEditTransaction\(r,next\)/);
});

test('archived records remain loaded for transaction history and balances, while selectors show active records only', () => {
  assert.match(html, /SB\.from\('loans'\)\.select\('\*'\)\.eq\('user_id',uid\)/);
  assert.match(html, /SB\.from\('savings_goals'\)\.select\('\*'\)\.eq\('user_id',uid\)/);
  assert.match(html, /is_archived:!!l\.is_archived/);
  assert.match(html, /is_paused:!!g\.is_paused/);
  assert.match(html, /const AO=\(\)=>S\.accs\.filter\(a=>!a\.archived\)/);
  assert.match(html, /NW=\(\)=>accT\(\)\+savT\(\)\+invV\(\)\+Z\(S\.loans\.filter/);
});

test('manual investment unit prices persist in the cloud and override spot-derived gram values only when set', () => {
  assert.match(html, /current_unit_price/);
  assert.match(html, /a\.price!==null&&a\.price!==undefined&&Number\.isFinite\(Number\(a\.price\)\)/);
});
