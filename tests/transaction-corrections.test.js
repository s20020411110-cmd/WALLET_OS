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

test('duplicate standalone request-key indexes are cleaned up without dropping the surviving unique indexes', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'wallet_os_duplicate_request_indexes_cleanup_v1.sql'), 'utf8');
  for (const name of [
    'uq_budgets_owner_category_period',
    'uq_investment_assets_request',
    'uq_loans_request',
    'uq_savings_goals_request'
  ]) assert.ok(migration.toLowerCase().includes('drop index if exists public.' + name.toLowerCase()), 'missing duplicate index drop: ' + name);
  assert.doesNotMatch(migration, /drop index if exists public\.(budgets_user_period_unique|investment_assets_user_request_key_unique|loans_user_request_key_unique|savings_goals_user_request_key_unique)/i);
});

test('public transaction edit/delete RPC wrappers are invoker-rights with narrowly granted private helpers', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'wallet_os_transaction_rpc_invoker_hardening_v1.sql'), 'utf8');
  assert.match(migration, /revoke all on function private\.edit_financial_transaction\(uuid, jsonb\) from public, anon, authenticated/i);
  assert.match(migration, /revoke all on function private\.reverse_financial_transaction\(uuid, text\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function private\.edit_financial_transaction\(uuid, jsonb\) to authenticated/i);
  assert.match(migration, /grant execute on function private\.reverse_financial_transaction\(uuid, text\) to authenticated/i);
  assert.match(migration, /alter function public\.edit_financial_transaction\(uuid, jsonb\) security invoker/i);
  assert.match(migration, /alter function public\.void_financial_transaction\(uuid, text\) security invoker/i);
});

test('cloud deletion requires confirmation and calls the permanent delete RPC', () => {
  const start = html.indexOf('async del(id){');
  const end = html.indexOf('\nel(id)', start);
  assert.ok(start >= 0 && end > start, 'delete action should exist');
  const handler = html.slice(start, end);
  assert.match(handler, /confirm\(/);
  assert.match(handler, /SB\.rpc\('delete_financial_transaction'/);
  assert.match(handler, /cloudManageItem\('loan',r\.ref,'delete'\)/);
  assert.doesNotMatch(handler, /void_financial_transaction/);
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


test('budgets accept a user-entered name, expense category and optional linked wallet account', () => {
  const start = html.indexOf('function addBud(){');
  const end = html.indexOf('\nconst IC=', start);
  assert.ok(start >= 0 && end > start, 'budget form should exist');
  const form = html.slice(start, end);
  assert.match(form, /categoryName/);
  assert.match(form, /تصنيف المصروف \(اكتب يدويًا\)/);
  assert.match(form, /resolveFinanceCategory\('expense',categoryName\)/);
  assert.match(form, /accountId/);
  assert.match(form, /name\.length>80/);
  assert.doesNotMatch(form, /\['ci',[^\n]*'s',CAT/);
});

test('cloud budget writes and refreshes preserve manual category ID, name and account link', () => {
  assert.match(html, /budget_name:String\(b\.name\|\|''\)\.trim\(\)/);
  assert.match(html, /account_id:b\.accountId\|\|null/);
  assert.match(html, /categoryId=b\.categoryId\|\|cloudCategoryId\('expense',b\.ci\)/);
  assert.match(html, /categoryId=item\.categoryId\?\(map\[String\(item\.categoryId\)\]\|\|item\.categoryId\):cloudCategoryId/);
  assert.match(html, /categoryId:b\.category_id/);
});

test('offline budget queue maps pending custom category and account IDs before the upsert', () => {
  assert.match(html, /kind:'budget',categoryIndex:Number\(b\.ci\),categoryId,categoryName,name,accountId/);
  assert.match(html, /item\.categoryId\?\(map\[String\(item\.categoryId\)\]\|\|item\.categoryId\)/);
  assert.match(html, /budget_name:item\.name,account_id:item\.accountId\?\(map\[String\(item\.accountId\)\]\|\|item\.accountId\):null/);
});

test('account-linked budgets calculate spending only from the selected wallet', () => {
  assert.match(html, /r\.t=='exp'&&\(b\.categoryId\?String\(r\.categoryId\)===String\(b\.categoryId\):r\.cat==b\.ci\)&&\(!b\.accountId\|\|String\(r\.acc\)===String\(b\.accountId\)\)/);
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
    "cloudInvestmentMutation('update'",
    "cloudManageItem('loan',id,'delete'",
    "cloudManageItem('goal',id,'delete'",
    "cloudManageItem('wallet',id,'delete'",
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
  assert.match(helper, /SB\.rpc\('delete_financial_item'/);
  assert.match(helper, /await cloudRefresh\(\)/);
});

test('cloud edits preserve financial ledger balances by changing profile metadata only', () => {
  assert.match(html, /cloudManageItem\('loan',id,'update'/);
  assert.match(html, /cloudManageItem\('goal',id,'update'/);
  assert.match(html, /cloudInvestmentMutation\('update'/);
  assert.match(html, /p_transaction_id/);
  assert.match(html, /cloudEditTransaction\(r,next\)/);
});

test('archive and restore UI is removed while existing owner records remain selectable', () => {
  assert.match(html, /SB\.from\('loans'\)\.select\('\*'\)\.eq\('user_id',uid\)/);
  assert.match(html, /SB\.from\('savings_goals'\)\.select\('\*'\)\.eq\('user_id',uid\)/);
  assert.match(html, /activate_owned_financial_records/);
  assert.match(html, /archived:false/);
  assert.match(html, /const AO=\(\)=>S\.accs\.map/);
  assert.match(html, /const LN=\(\)=>S\.loans\.filter\(l=>l\.kind!='owed'\)/);
  assert.doesNotMatch(html, /data-a=restore/);
  assert.doesNotMatch(html, /أرشفة|استعادة\|Restore/);
});

test('account cards use number formatting and provide edit/delete for linked transactions', () => {
  const start = html.indexOf('PG.accounts=()=>');
  const end = html.indexOf('PG.income=()=>', start);
  const page = html.slice(start, end);
  assert.match(page, /kc\('عدد الحسابات\|Accounts',accounts\.length,'',null,'var\(--g\)','','#'\)/);
  assert.match(page, /data-a=ea/);
  assert.match(page, /data-a=xa/);
  assert.match(page, /data-a=ed data-v=/);
  assert.match(page, /data-a=del data-v=/);
});

test('global activity exposes edit and delete for loan origination as well as every ordinary transaction', () => {
  const start=html.indexOf('const actList=ts=>');
  const end=html.indexOf('\nconst tbody=',start);
  const renderer=html.slice(start,end);
  assert.match(renderer,/data-a=ed/);
  assert.match(renderer,/data-a=del/);
  assert.doesNotMatch(renderer,/r\.t==='disb'\?'':/);
});

test('investment page connects trades to wallet accounts and shows portfolio totals', () => {
  assert.match(html,/data-a=investFromAccount/);
  assert.match(html,/Funding wallet account/);
  assert.match(html,/p_account_id:source\.id/);
  assert.match(html,/p_related_investment_id:asset\?asset\.id:null/);
  assert.match(html,/القيمة الحالية\|Current value/);
  assert.match(html,/حسابات التمويل\|Funding accounts/);
});

test('loan origination correction updates principal and deletion removes dependent movements', () => {
  const start=html.indexOf('async del(id){');
  const end=html.indexOf('\ned(id)',start);
  const handler=html.slice(start,end);
  assert.match(handler,/loanOrigination/);
  assert.match(handler,/cloudManageItem\('loan',r\.ref,'delete'\)/);
  assert.match(handler,/S\.loans=S\.loans\.filter/);
  const editorStart=html.indexOf('ed(id){',start);
  const editorEnd=html.indexOf('\nel(id)',editorStart);
  const editor=html.slice(editorStart,editorEnd);
  assert.match(editor,/amount\+1e-8<paid/);
  assert.match(editor,/loan\.orig=amount/);
  assert.match(html,/type='loan_disbursement'/);
});

test('budget rows expose editing and permanent deletion in local and cloud storage', () => {
  assert.match(html,/data-a=ebud data-v=\$\{b\.id\}/);
  assert.match(html,/async ebud\(id\)/);
  assert.match(html,/SB\.from\('budgets'\)\.update\(payload\)/);
  assert.match(html,/async db\(id\)/);
  assert.match(html,/cloudManageItem\('budget',id,'delete'\)/);
});

test('permanent deletion migration is owner-scoped and removes journal and correction dependencies', () => {
  const migration=fs.readFileSync(path.join(__dirname,'..','supabase','wallet_os_permanent_record_deletion_v1.sql'),'utf8');
  assert.match(migration,/create or replace function private\.delete_financial_item_impl/i);
  assert.match(migration,/create or replace function private\.delete_financial_transaction_impl/i);
  assert.match(migration,/auth\.uid\(\)/i);
  assert.match(migration,/security definer[\s\S]*set search_path to ''/i);
  assert.match(migration,/reversal_of = null[\s\S]*replacement_transaction_id = null/i);
  assert.match(migration,/delete from public\.transactions/i);
  assert.match(migration,/delete from public\.loans/i);
  assert.match(migration,/delete from public\.audit_logs/i);
  assert.match(migration,/delete_investment_data_impl/i);
  assert.match(migration,/alter function public\.delete_financial_transaction\(uuid\) security invoker/i);
  assert.match(migration,/grant execute on function public\.delete_financial_item[\s\S]*to authenticated/i);
});

test('archive workflow removal migration changes only rows owned by the signed-in user', () => {
  const migration=fs.readFileSync(path.join(__dirname,'..','supabase','wallet_os_remove_archive_semantics_v1.sql'),'utf8');
  assert.match(migration,/create or replace function private\.activate_owned_financial_records_impl/i);
  assert.match(migration,/auth\.uid\(\)/i);
  assert.match(migration,/update public\.wallet_accounts[\s\S]*where user_id = v_user/i);
  assert.match(migration,/update public\.loans[\s\S]*where user_id = v_user/i);
  assert.match(migration,/update public\.savings_goals[\s\S]*where user_id = v_user/i);
  assert.match(migration,/update public\.investment_assets[\s\S]*where user_id = v_user/i);
  assert.match(migration,/alter function public\.activate_owned_financial_records\(\) security invoker/i);
});

test('manual investment unit prices persist in the cloud and override spot-derived gram values only when set', () => {
  assert.match(html, /current_unit_price/);
  assert.match(html, /a\.price!==null&&a\.price!==undefined&&Number\.isFinite\(Number\(a\.price\)\)/);
});


test('cloud management function stays outside the exposed API schema and the public RPC is invoker-secured', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'wallet_os_cloud_management_security_hardening_v1.sql'), 'utf8');
  assert.match(migration, /create or replace function private\.manage_financial_item_impl/);
  assert.match(migration, /security definer[\s\S]*auth\.uid\(\)/);
  assert.match(migration, /create or replace function public\.manage_financial_item[\s\S]*security invoker/);
  assert.match(migration, /revoke all on function public\.manage_financial_item/);
  assert.match(migration, /grant execute on function public\.manage_financial_item[\s\S]*to authenticated/);
});

test('investment asset edits and permanent deletion bypass archive management', () => {
  assert.match(html, /cloudInvestmentMutation\('update'/);
  assert.match(html, /cloudInvestmentMutation\('delete_asset'/);
  assert.match(html, /SB\.rpc\('update_investment_asset'/);
  assert.match(html, /SB\.rpc\('delete_investment_data'/);
  assert.match(html, /Permanently delete this asset/);
  assert.match(html, /purgeInvestmentLocalCopies/);
  assert.doesNotMatch(html, /restoreInvestment\(id\)/);
});


test('manual income and expense categories are persisted as owner-scoped cloud category IDs', () => {
  assert.match(html, /function resolveFinanceCategory\(direction,name\)/);
  assert.match(html, /cloudRpc\('create_finance_category'/);
  assert.match(html, /if\(t=='inc'\)f\.push\(\['catName'/);
  assert.match(html, /if\(t=='exp'\)f\.push\(\['catName'/);
  assert.match(html, /cat=v\.categoryId\|\|cloudCategoryId\(type,v\.cat\)/);
  assert.match(html, /categoryId=v\.categoryId\|\|cloudCategoryId\(type,Number\(v\.cat\)\)/);
});

test('offline custom categories are queued before postings and local category IDs are remapped on sync', () => {
  assert.match(html, /'create_finance_category'/);
  assert.match(html, /'p_category_id'\]\)if\(out\[k\]!=null\)out\[k\]=map\[String\(out\[k\]\)\]/);
  assert.match(html, /else if\(name==='create_finance_category'\)/);
  const syncStart = html.indexOf('async function cloudSyncPending(');
  const syncEnd = html.indexOf('function cloudLoanKind', syncStart);
  const sync = html.slice(syncStart, syncEnd);
  assert.match(sync, /cloudResolveRpcArgs\(item\.args\)/);
  assert.match(sync, /item\.categoryId\?\(map\[String\(item\.categoryId\)\]\|\|item\.categoryId\)/);
});

test('account opening balances use the double-entry opening balance RPC and appear in account totals', () => {
  const start = html.indexOf('function addAcc(){');
  const end = html.indexOf('const CLOUD_INCOME_NAMES', start);
  const form = html.slice(start, end);
  assert.match(form, /p_opening_balance:opening/);
  assert.match(form, /p_opening_fx_rate:opening>0\?cloudFxRate\(v\.cur\):1/);
  assert.match(form, /openingBalance:opening/);
  assert.match(html, /Number\(a\.openingBalance\)\|\|0/);
  assert.match(html, /PG\.accounts=\(\)=>/);
  assert.match(html, /postFromAccount\(value\)/);
  assert.match(html, /addTx\(parts\[1\],\{acc:account\.id,c:account\.cur\}\)/);
});

test('loans and receivables have separate pages and creation paths', () => {
  assert.match(html, /PG\.loans=\(\)=>\{/);
  assert.match(html, /const rows=LN\(\)/);
  assert.match(html, /PG\.debts=\(\)=>\{const rows=OW\(\)/);
  assert.match(html, /function addLoan\(kind='loan'\)/);
  assert.match(html, /function addDebt\(\)\{addLoan\('owed'\);\}/);
  assert.match(html, /loan:\(\)=>addLoan\('loan'\),debt:addDebt/);
  assert.match(html, /card\('debts',[^\n]*'debts'/);
});


test('manual finance category names survive local reload and are used by budgets and transaction history', () => {
  assert.match(html, /function hydrateFinanceCategoryLabels\(\)/);
  assert.match(html, /ensureLocalCategory\('expense',n\)/);
  assert.match(html, /categoryName:category\?\.name\|\|''/);
  assert.match(html, /categoryName:CLOUD_CATEGORY_ROWS\.find\(c=>String\(c\.id\)===String\(t\.category_id\)\)/);
  assert.match(html, /inc:\(\)=>r\.categoryName\|\|_\(SRC\[r\.cat\]\|\|''\)/);
  assert.match(html, /exp:\(\)=>r\.categoryName\|\|_\(CAT\[r\.cat\]\|\|''\)/);
  assert.match(html, /htm\(b\.categoryName\|\|_\(CAT\[b\.ci\]\|\|''\)\)/);
});

test('new loan and receivable origination is atomic with the selected bank or cash account', () => {
  assert.match(html, /function addLoan\(kind='loan'\)/);
  assert.match(html, /p_account_id:wallet\.id/);
  assert.match(html, /cloudRpc\('create_loan_from_account_v1'/);
  assert.match(html, /t:'disb',a:principal,c:v\.cur,d:v\.start\|\|TD,acc:wallet\.id,ref:id/);
  assert.match(html, /loan_disbursement:'disb'/);
  assert.match(html, /\(k==='pay'\|\|k==='disb'\)\?t\.related_loan_id/);
  assert.match(html, /type='loan_disbursement'/);
  assert.match(html, /if\(r\.t==='disb'\)\{const loan=/);
  assert.doesNotMatch(html, /r\.t==='disb'\)return toast/);
  assert.match(html, /history=S\.tx\.filter\(x=>\(x\.t==='pay'\|\|x\.t==='disb'\)/);
});

test('loan origination migration creates one owner-scoped balanced wallet and debt posting', () => {
  const migration=fs.readFileSync(path.join(__dirname,'..','supabase','wallet_os_loans_linked_to_wallet_accounts_v1.sql'),'utf8');
  assert.match(migration,/create or replace function private\.create_loan_from_account_v1/i);
  assert.match(migration,/auth\.uid\(\)/i);
  assert.match(migration,/security definer[\s\S]*set search_path to ''/i);
  assert.match(migration,/where id=p_account_id and user_id=v_user and not is_archived[\s\S]*for update/i);
  assert.match(migration,/if p_kind='owed'[\s\S]*Insufficient funds to lend this amount/i);
  assert.match(migration,/insert into public\.transactions\([\s\S]*'loan_disbursement'/i);
  assert.match(migration,/insert into public\.journal_entries/i);
  assert.match(migration,/amount_debit,base_debit/);
  assert.match(migration,/amount_credit,base_credit/);
  assert.doesNotMatch(migration,/alter table/i);
  assert.match(migration,/create or replace function public\.create_loan_from_account_v1[\s\S]*security invoker/i);
  assert.match(migration,/revoke all on function private\.create_loan_from_account_v1[\s\S]*from public,anon,authenticated/i);
  assert.match(migration,/grant execute on function private\.create_loan_from_account_v1[\s\S]*to authenticated/i);
});


test('an existing empty wallet can receive its one-time opening balance through the ledger RPC', () => {
  assert.match(html, /opening\(id\)\{const account=S\.accs\.find/);
  assert.match(html, /SB\.rpc\('set_wallet_opening_balance_v1'/);
  assert.match(html, /account\.openingBalance=amount/);
  assert.match(html, /لا يمكن تعديل الرصيد الافتتاحي بعد وجود حركات على الحساب/);
  const migration=fs.readFileSync(path.join(__dirname,'..','supabase','wallet_os_existing_wallet_opening_balance_v1.sql'),'utf8');
  assert.match(migration,/create or replace function private\.set_wallet_opening_balance_v1/i);
  assert.match(migration,/if exists\([\s\S]*public\.transactions t[\s\S]*source_account_id=v_wallet\.id/i);
  assert.match(migration,/idempotency_key='opening:'\|\|v_wallet\.id::text/i);
  assert.match(migration,/insert into public\.journal_entries/i);
  assert.match(migration,/amount_debit,base_debit/);
  assert.match(migration,/amount_credit,base_credit/);
  assert.match(migration,/create or replace function public\.set_wallet_opening_balance_v1[\s\S]*security invoker/i);
  assert.match(migration,/revoke all on function private\.set_wallet_opening_balance_v1[\s\S]*from public,anon,authenticated/i);
  assert.match(migration,/grant execute on function private\.set_wallet_opening_balance_v1[\s\S]*to authenticated/i);
});
