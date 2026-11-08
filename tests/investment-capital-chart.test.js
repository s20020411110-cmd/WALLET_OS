const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const pageStart = html.indexOf('PG.invest=()=>');
const pageEnd = html.indexOf('PG.budgets=()=>', pageStart);
const investmentPage = html.slice(pageStart, pageEnd);

test('gold page shows only a clear profit/loss summary and one line chart', () => {
  assert.ok(pageStart >= 0 && pageEnd > pageStart, 'gold page should exist');
  assert.match(investmentPage, /portfolioPLChart\(A\)/);
  assert.match(investmentPage, /الربح والخسارة\|Profit & loss/);
  assert.match(investmentPage, /goldHeroCard\(g\)/);
  assert.match(investmentPage, /goldTrendChart\(g\)/);
  assert.match(investmentPage, /حركة سعر الذهب العالمي\|Global gold price movement/);
  assert.doesNotMatch(investmentPage, /goldKaratStrip\(g\)|donut\(by\)|investment-insights/);
  assert.doesNotMatch(investmentPage, /رأس المال المستثمر والربح والخسارة حسب الأصل|توزيع الذهب\|Gold allocation/);
});

test('profit/loss chart calculates positive profit and negative loss only', () => {
  const chartStart = html.indexOf('const portfolioPLChart=assets=>{');
  const chartEnd = html.indexOf('\n};\n\nconst goldKaratStrip', chartStart);
  const chart = html.slice(chartStart, chartEnd);
  assert.ok(chartStart >= 0 && chartEnd > chartStart, 'P/L chart helper should exist');
  assert.match(chart, /profit=rows\.reduce/);
  assert.match(chart, /loss=rows\.reduce/);
  assert.match(chart, /portfolio-pl-chart/);
  assert.match(chart, /pl-zero-line/);
  assert.match(chart, /row\.total/);
  assert.doesNotMatch(chart, /invested capital|current investment value|realized|unrealized/);
});

test('profit/loss chart is a single responsive line with gain/loss markers', () => {
  assert.match(html, /portfolio-pl-line/);
  assert.match(html, /portfolio-pl-point\.profit/);
  assert.match(html, /portfolio-pl-point\.loss/);
  assert.match(html, /portfolio-pl-summary/);
  assert.match(html, /grid-template-columns:1fr 1fr;gap:12px/);
  assert.doesNotMatch(html, /capital-series-invested|capital-series-current/);
});

test('user-controlled text is HTML-escaped before insertion into application markup', () => {
  const helperStart = html.indexOf('const htm=value=>');
  const helperEnd = html.indexOf(';', helperStart) + 1;
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'shared HTML escape helper should exist');
  const escapeHtml = vm.runInNewContext('(()=>{' + html.slice(helperStart, helperEnd) + ';return htm})()');
  assert.equal(
    escapeHtml('"><img src=x onerror=alert(1)> & \''),
    '&quot;&gt;&lt;img src=x onerror=alert(1)&gt; &amp; &#39;'
  );
  const formStart = html.indexOf('function form(ti,fs,ok){');
  const formEnd = html.indexOf('\nconst AO=', formStart);
  const form = html.slice(formStart, formEnd);
  assert.match(form, /htm\(ti\)/);
  assert.match(form, /htm\(f\[1\]\)/);
  assert.match(form, /htm\(o\[1\]\)/);
  assert.match(form, /htm\(f\[4\]\?\?''\)/);
  assert.match(html, /\$\{htm\(z\[1\]\)\}/);
  assert.match(html, /htm\(r\.note\)/);
  assert.match(html, /htm\(S\.user\.name\)/);
  assert.match(html, /htm\(b\.name\|\|_\(CAT\[b\.ci\]\)\)/);
});

test('home dashboard separates seven categories and uses correct asset/income ratio bases', () => {
  const homeStart = html.indexOf('PG.home=()=>');
  const homeEnd = html.indexOf('const hl=()=>', homeStart);
  const home = html.slice(homeStart, homeEnd);
  for (const key of ['accounts', 'income', 'expenses', 'investment', 'debts', 'loans', 'savings']) {
    assert.match(home, new RegExp("card\\('" + key + "'"));
  }
  assert.ok(home.includes('wallet-${key}'));
  assert.match(home, /assets=NW\(\)\+Z\(S\.loans\.map\(rem\)\)/);
  assert.match(home, /key==='income'\|\|key==='expenses'\?I\[c\]:assets/);
  assert.match(home, /key==='income'\?100/);
  assert.match(home, /Math\.abs\(Number\(value\)\|\|0\)\/denominator\*100/);
  assert.doesNotMatch(home, /wealth=NW\(\),ratio=value/);
  assert.match(home, /I\[c\].*Monthly income · 100% baseline/);
  assert.match(home, /E\[c\].*Monthly expenses · share of income/);
  assert.match(home, /Z\(OW\(\)\.map\(rem\)\)/);
  assert.match(home, /Z\(LN\(\)\.map\(rem\)\)/);
  assert.doesNotMatch(home, /wallet-spark|income & expenses|debts & loans|class=tcs/);
});

test('savings report calculates the monthly savings rate as net savings divided by income', () => {
  const reportStart = html.indexOf('function reportRows(){');
  const reportEnd = html.indexOf('\nPG.reports=', reportStart);
  const report = html.slice(reportStart, reportEnd);
  assert.ok(reportStart >= 0 && reportEnd > reportStart, 'report calculations should exist');
  assert.match(report, /if\(r\.t=='sav'\)/);
  assert.match(report, /const\[savings\]=per\('sav'\),\[income\]=per\('inc'\)/);
  assert.match(report, /v\/income\[i\]\*100/);
  assert.match(report, /Net savings/);
  assert.match(report, /Savings rate/);
  assert.match(html, /R\.t==='sav'\?'':sel\('k'/);
});

test('home wealth cards use separate semantic gradients blended with the selected theme', () => {
  assert.match(html, /\.wallet-accounts\{--wallet-accent:/);
  assert.match(html, /\.wallet-income\{--wallet-accent:/);
  assert.match(html, /\.wallet-expenses\{--wallet-accent:/);
  assert.match(html, /\.wallet-investment\{--wallet-accent:/);
  assert.match(html, /\.wallet-debts\{--wallet-accent:/);
  assert.match(html, /\.wallet-loans\{--wallet-accent:/);
  assert.match(html, /\.wallet-savings\{--wallet-accent:/);
  assert.match(html, /color-mix\(in srgb,var\(--wallet-tone\) 17%,var\(--c\)\)/);
  assert.match(html, /linear-gradient\(90deg,var\(--wallet-tone\),var\(--g2\)\)/);
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
  assert.doesNotMatch(investmentPage, /restoreInvestment|أرشفة الأصل|أرشفه|Archive asset|archive it|مؤرشف\\|Archived/);
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
  assert.match(migration, /create or replace function private\.delete_investment_data_impl/i);
  assert.match(migration, /security definer[\s\S]*auth\.uid\(\)/i);
  assert.match(migration, /set search_path to ''/i);
  assert.match(migration, /create or replace function public\.delete_investment_data/i);
  assert.match(migration, /create or replace function private\.update_investment_asset_impl/i);
  assert.match(migration, /delete from public\.investment_trades/);
  assert.match(migration, /delete from public\.transactions/);
  assert.match(migration, /delete from public\.audit_logs/);
  assert.match(migration, /replacement_transaction_id = null/);
  assert.match(migration, /reversal_of = null/);
  assert.match(migration, /if not exists \(\s*select 1 from public\.journal_entries/);
  assert.match(migration, /grant execute on function public\.delete_investment_data[\s\S]*to authenticated/);
});
