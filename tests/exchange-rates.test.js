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
  for (const name of ['create_wallet_account', 'create_savings_goal_v2', 'create_loan_v2', 'create_investment_asset_v3']) {
    assert.match(html, new RegExp("cloudRpc\\('" + name + "'"));
  }
  assert.match(html, /CLOUD_USER\)\{await cloudUpsertBudget\(item\);await cloudRefresh\(\);return true;\}/);
  assert.match(html, /p_subtype:cloudGoldSubtype\(/);
  assert.match(html, /function cloudGoldSubtype\(/);
});

test('income and expense form types are translated to the ledger RPC contract', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /if\(t==='inc'\|\|t==='exp'\)\{type=t==='inc'\?'income':'expense';cat=cloudCategoryId\(type,v\.cat\);\}/);
});


test('local-first cloud queue supports offline writes and dependent record IDs', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.includes("wos_sync_queue_v1_"));
  assert.ok(html.includes('function cloudQueueRpc('));
  assert.ok(html.includes('function cloudResolveRpcArgs('));
  assert.ok(html.includes('async function cloudSyncPending('));
  assert.ok(html.includes('cloudMapSave(map)'));
  assert.ok(html.includes("addEventListener('online'"));
  assert.ok(html.includes('data-a=sync'));
});

test('PWA shell caches only app files and the pinned Supabase client, not private API responses', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.webmanifest'), 'utf8'));
  assert.ok(html.includes('rel="manifest" href="/manifest.webmanifest"'));
  assert.ok(html.includes("serviceWorker.register('/sw.js'"));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some(icon => icon.src === '/icon.svg'));
  assert.ok(sw.includes('caches.open(CACHE_NAME)'));
  assert.ok(sw.includes("url.hostname.endsWith('.supabase.co')"));
  assert.ok(sw.includes("url.pathname.startsWith('/api/')"));
  assert.ok(sw.includes('supabase-js@2.119.0'));
});


function makeOfflineSyncHarness(html, rpcImpl) {
  const start = html.indexOf('let CLOUD_OFFLINE=');
  const end = html.indexOf('async function cloudRpc', start);
  assert.ok(start >= 0 && end > start, 'offline sync engine should be present');
  const engine = html.slice(start, end);
  const values = new Map();
  let nextId = 0;
  let refreshCount = 0;
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
  const calls = [];
  const navigator = { onLine: false };
  let refreshCount = 0;
  const SB = {
    auth: {
      async getSession() {
        return { data: { session: { user: { id: 'owner-1', email: 'offline@example.com' } } }, error: null };
      }
    },
    async rpc(name, args) {
      calls.push({ name, args: JSON.parse(JSON.stringify(args)) });
      return rpcImpl(name, args);
    }
  };
  const factory = new Function(
    'navigator', 'localStorage', 'document', 'crypto', 'CLOUD_USER',
    'CLOUD_PROFILE_FP', 'CLOUD_CATEGORY_ROWS', 'CLOUD_CATEGORY_IDS', 'S',
    'cloudCategoryIndex', 'cloudBudgetPeriod', 'cloudProfileFingerprint',
    'save', 'cloudRefresh', 'SB', 'cloudLoadCategories',
    engine + '\nreturn { cloudQueueRpc, cloudQueueLoad, cloudSyncPending, cloudMapLoad, isOffline: () => CLOUD_OFFLINE };'
  );
  const api = factory(
    navigator,
    localStorage,
    { querySelector() { return null; } },
    { randomUUID() { nextId += 1; return 'offline-id-' + nextId; } },
    { id: 'owner-1', email: 'offline@example.com' },
    '',
    [],
    {},
    { accs: [], tx: [], goals: [], loans: [], inv: [], bud: [], rates: { SAR: 1 }, base: 'SAR' },
    () => 0,
    () => ({ period_year: 2026, period_month: 11, period_type: 'm', period_week: 0 }),
    () => 'profile-fingerprint',
    () => {},
    async () => { refreshCount += 1; },
    SB,
    async () => {}
  );
  return { navigator, api, calls, getRefreshCount: () => refreshCount };
}

test('offline queue syncs dependent financial postings in order and maps temporary IDs', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const harness = makeOfflineSyncHarness(html, async name => ({
    data: name === 'create_wallet_account' ? 'remote-wallet-id' : 'remote-transaction-id',
    error: null
  }));
  const { navigator, api, calls } = harness;
  const localWallet = api.cloudQueueRpc('create_wallet_account', {
    p_name: 'Cash', p_kind: 'cash', p_currency_code: 'SAR', p_request_key: 'wallet-key'
  });
  api.cloudQueueRpc('post_financial_transaction', {
    p_type: 'expense', p_amount: 25, p_currency_code: 'SAR',
    p_account_id: localWallet, p_idempotency_key: 'transaction-key',
    p_category_id: 'category-id', p_occurred_on: '2026-11-07'
  });
  assert.equal(api.cloudQueueLoad().length, 2);
  navigator.onLine = true;
  assert.equal(await api.cloudSyncPending(true, true), true);
  assert.deepEqual(calls.map(call => call.name), ['create_wallet_account', 'post_financial_transaction']);
  assert.equal(calls[1].args.p_account_id, 'remote-wallet-id');
  assert.equal(api.cloudQueueLoad().length, 0);
  assert.equal(api.cloudMapLoad()[localWallet], 'remote-wallet-id');
  assert.equal(harness.getRefreshCount(), 1);
});

test('offline sync retries a lost response with the same idempotency key', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  let failOnce = true;
  const harness = makeOfflineSyncHarness(html, async name => {
    if (failOnce) {
      failOnce = false;
      throw new TypeError('Failed to fetch');
    }
    return { data: name === 'create_wallet_account' ? 'remote-wallet-id' : 'remote-transaction-id', error: null };
  });
  const { sandbox, api, calls } = harness;
  api.cloudQueueRpc('create_wallet_account', {
    p_name: 'Cash', p_kind: 'cash', p_currency_code: 'SAR', p_request_key: 'stable-wallet-key'
  });
  api.cloudQueueRpc('post_financial_transaction', {
    p_type: 'expense', p_amount: 25, p_currency_code: 'SAR',
    p_account_id: 'local-offline-id', p_idempotency_key: 'stable-transaction-key',
    p_category_id: 'category-id', p_occurred_on: '2026-11-07'
  });
  sandbox.navigator.onLine = true;
  assert.equal(await api.cloudSyncPending(true, false), false);
  assert.equal(api.isOffline(), true);
  assert.equal(api.cloudQueueLoad().length, 2);
  assert.equal(api.cloudQueueLoad()[0].attempts, 1);
  const firstKey = api.cloudQueueLoad()[0].args.p_request_key;
  assert.equal(await api.cloudSyncPending(true, false), true);
  assert.equal(calls[0].args.p_request_key, firstKey);
  assert.equal(calls[1].args.p_request_key, firstKey);
  assert.equal(api.cloudQueueLoad().length, 0);
});
