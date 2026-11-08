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

test('investment edits and permanent deletion validate dependencies before removing the ledger records', () => {
  assert.match(html, /function investmentLedgerValidAfterEdit\(assetId,transactionId,replacement\)/);
  assert.match(html, /investmentLedgerValidAfterEdit\(r\.ref,r\.id,next\)/);
  assert.match(html, /investmentLedgerValidAfterEdit\(r\.ref,r\.id,null\)/);
  assert.match(html, /This purchase cannot be deleted because later sales depend on it/);
  assert.match(html, /mode==='delete_transaction'/);
  assert.match(html, /mode==='delete_asset'/);
  assert.match(html, /SB\.rpc\('delete_investment_data'/);
  assert.match(html, /Permanently delete this asset/);
  assert.match(html, /Permanently delete this investment operation/);
});

test('investment assets provide edit and permanent delete only, with no archive or restore controls', () => {
  assert.match(investmentPage, /data-a=ip data-v=/);
  assert.match(investmentPage, /data-a=di data-v=/);
  assert.doesNotMatch(investmentPage, /restoreInvestment|أرشفة الأصل|Archive asset|مؤرشف\|Archived/);
  assert.doesNotMatch(html, /restoreInvestment\(id\)/);
  assert.match(html, /purgeInvestmentLocalCopies/);
  assert.match(html, /wos_pre_cloud_backup_/);
  assert.match(html, /cloudInvestmentMutation\('update'/);
  assert.match(html, /cloudInvestmentMutation\('delete_asset'/);
  assert.match(html, /else purgeInvestmentLocalCopies\(\[id\],\[\],null\)/);
});


test('investment transaction deletion is permanent for buys and sells, while other ledger deletions stay audited reversals', () => {
  const actionsStart = html.indexOf('const A={');
  const deleteStart = html.indexOf('async del(id){', actionsStart);
  const editStart = html.indexOf('\ned(id){', deleteStart);
  const deleteHandler = html.slice(deleteStart, editStart);
  assert.ok(deleteStart > actionsStart && editStart > deleteStart);
  assert.match(deleteHandler, /r\.t==='buy'\|\|r\.t==='sell'/);
  assert.match(deleteHandler, /cloudInvestmentMutation\('delete_transaction'/);
  assert.match(deleteHandler, /purgeInvestmentLocalCopies\(\[\], \[r\.id\], null\)/);
  assert.match(deleteHandler, /if\(!confirm\(prompt\)\)return/);
  assert.match(deleteHandler, /delete this investment operation/);
  assert.match(deleteHandler, /void_financial_transaction/);
  assert.match(html, /Permanently delete this asset/);
  assert.match(html, /Permanently delete this investment operation/);
});



test('permanent investment deletion migration is owner-scoped, atomic and removes the journal correction chain', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'wallet_os_permanent_investment_deletion_v1.sql'), 'utf8');
  assert.match(migration, /create or replace function private\.delete_investment_data_impl/);
  assert.match(migration, /security definer[\s\S]*auth\.uid\(\)/);
  assert.match(migration, /set search_path to ''/i);
  assert.match(migration, /create or replace function public\.delete_investment_data/);
  assert.match(migration, /create or replace function private\.update_investment_asset_impl/);
  assert.match(migration, /delete from public\.investment_trades/);
  assert.match(migration, /delete from public\.transactions/);
  assert.match(migration, /delete from public\.audit_logs/);
  assert.match(migration, /replacement_transaction_id = null/);
  assert.match(migration, /reversal_of = null/);
  assert.match(migration, /if not exists \(\s*select 1 from public\.journal_entries/);
  assert.match(migration, /grant execute on function public\.delete_investment_data[\s\S]*to authenticated/);
});
