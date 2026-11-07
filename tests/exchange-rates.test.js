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
  const { navigator, api, calls } = harness;
  api.cloudQueueRpc('create_wallet_account', {
    p_name: 'Cash', p_kind: 'cash', p_currency_code: 'SAR', p_request_key: 'stable-wallet-key'
  });
  api.cloudQueueRpc('post_financial_transaction', {
    p_type: 'expense', p_amount: 25, p_currency_code: 'SAR',
    p_account_id: 'local-offline-id', p_idempotency_key: 'stable-transaction-key',
    p_category_id: 'category-id', p_occurred_on: '2026-11-07'
  });
  navigator.onLine = true;
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


function makeGoldChartHelpers(html, state = { base: 'USD', gold: { h: [] } }) {
  const start = html.indexOf('function goldRecordObservation(');
  const end = html.indexOf('\nconst kc=', start);
  assert.ok(start >= 0 && end > start, 'gold trend chart helpers should exist');
  const source = html.slice(start, end);
  const factory = new Function(
    'sm', 'LOC', 'fm', '_', 'S', 'cv',
    'let seq = 0, GOLD_RANGE = 30, GOLD_SELECTED = -1;\n' +
      source +
      '\nreturn { goldRecordObservation, goldTrendMetrics, goldNormalizeDailyCandles, goldDailyMetrics, goldTrendChart, goldHeroCard, portfolioPLRows, portfolioPLChart };'
  );
  return factory(
    points => points.map((point, i) => (i ? 'L' : 'M') + point[0] + ',' + point[1]).join(' '),
    () => 'en-US',
    (value, currency) => currency === 'USD' ? '$' + Number(value).toFixed(2) : String(value),
    value => value.split('|')[1] || value.split('|')[0],
    state,
    value => Number(value)
  );
}

test('gold movement metrics distinguish upward, downward, flat and insufficient histories', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { goldTrendMetrics } = makeGoldChartHelpers(html);
  assert.equal(goldTrendMetrics([{ usd: 4000 }, { usd: 4050 }]).direction, 1);
  assert.equal(goldTrendMetrics([{ usd: 4072 }, { usd: 4050 }]).direction, -1);
  assert.equal(goldTrendMetrics([{ usd: 4072 }, { usd: 4072 }]).direction, 0);
  assert.equal(goldTrendMetrics([{ usd: 4072 }]).direction, 0);
  assert.equal(goldTrendMetrics([{ usd: 4000 }, { usd: 4050 }]).percent, 1.25);
});

test('daily gold chart renders authentic OHLC candles with one trading day per candle', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { goldNormalizeDailyCandles, goldTrendChart, goldDailyMetrics } = makeGoldChartHelpers(html);
  const candles = goldNormalizeDailyCandles({ points: [
    { d: '2026-11-04', o: 4000, h: 4040, l: 3980, c: 4020 },
    { d: '2026-11-05', o: 4020, h: 4060, l: 4010, c: 4045 },
    { d: '2026-11-06', o: 4045, h: 4050, l: 3990, c: 4000 },
    { d: '2026-11-07', o: 4000, h: 4080, l: 3995, c: 4070 },
    { d: '2026-11-07', o: 4000, h: 4080, l: 3995, c: 4070 },
    { d: '2026-11-08', o: 4070, h: 4060, l: 4065, c: 4050 }
  ] });
  assert.equal(candles.length, 4);
  assert.equal(candles[0].d, '2026-11-04');
  assert.equal(candles.at(-1).c, 4070);
  const chart = goldTrendChart({ dailyCandles: candles, usd: 4070 });
  assert.ok(chart.includes('XAU/USD · 1D'));
  assert.ok(chart.includes('Each candle represents one trading day'));
  assert.ok(chart.includes('data-a="goldPoint"'));
  assert.ok(chart.includes('<line'));
  assert.ok(chart.includes('<rect'));
  assert.ok(chart.includes('2026-11-07'));
  assert.equal(goldDailyMetrics({ dailyCandles: candles, usd: 4070 }).direction, 1);
  assert.ok(!chart.includes('saved observations'));
});

test('daily candle validator rejects incomplete OHLC rows instead of fabricating missing opens', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { goldNormalizeDailyCandles } = makeGoldChartHelpers(html);
  const valid = goldNormalizeDailyCandles({ points: [
    { t: 1794009600, o: 4000, h: 4020, l: 3990, c: 4010 },
    { d: '2026-11-06', o: 4050, h: 4040, l: 4020, c: 4030 },
    { d: 'invalid-date', o: 1, h: 2, l: 0.5, c: 1.5 },
    { d: '2026-11-07', h: 4080, l: 4000, c: 4050 }
  ] });
  assert.equal(valid.length, 1);
  assert.equal(valid[0].o, 4000);
});
test('gold price observations preserve legacy values and record observation time and source', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const state = { gold: { h: [4000, 4010] } };
  const { goldRecordObservation } = makeGoldChartHelpers(html, state);
  goldRecordObservation(4020, '2026-11-07T10:02:00.000Z', 'xaus');
  assert.deepEqual(state.gold.h, [4000, 4010, 4020]);
  assert.equal(state.gold.history.length, 3);
  assert.equal(state.gold.history[0].observedAt, null);
  assert.equal(state.gold.history[2].priceAt, '2026-11-07T10:02:00.000Z');
  assert.equal(state.gold.history[2].source, 'xaus');
});


test('gold price card uses daily candlesticks, not rapid saved spot samples', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { goldHeroCard } = makeGoldChartHelpers(html);
  const candles = [
    { d: '2026-11-06', o: 4000, h: 4060, l: 3990, c: 4020 },
    { d: '2026-11-07', o: 4020, h: 4080, l: 4010, c: 4070 }
  ];
  const card = goldHeroCard({ dailyCandles: candles, history: [{ usd: 10 }, { usd: 50000 }], usd: 4070, src: 'xaus', t: '2026-11-07T12:00:00Z' });
  assert.ok(card.includes('XAU/USD · 1D'));
  assert.ok(card.includes('Daily candles'));
  assert.ok(card.includes('gold-hero-chart'));
  assert.ok(card.includes('2026-11-07'));
  assert.ok(card.includes('$4,070.00'));
  assert.ok(card.includes('class="gold-hero-change up"'));
  assert.ok(!card.includes('$50,000.00'));
  const noCandles = goldHeroCard({ history: [{ usd: 4000 }, { usd: 4050 }], usd: 4050 });
  assert.ok(noCandles.includes('Waiting for daily candle data'));
  assert.ok(noCandles.includes('gold-hero-wait'));
});
 + Number(value).toFixed(2) : String(value),
    value => value.split('|')[1] || value.split('|')[0],
    state,
    value => Number(value)
  );
}

test('gold movement metrics distinguish upward, downward, flat and insufficient histories', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { goldTrendMetrics } = makeGoldChartHelpers(html);
  assert.equal(goldTrendMetrics([{ usd: 4000 }, { usd: 4050 }]).direction, 1);
  assert.equal(goldTrendMetrics([{ usd: 4072 }, { usd: 4050 }]).direction, -1);
  assert.equal(goldTrendMetrics([{ usd: 4072 }, { usd: 4072 }]).direction, 0);
  assert.equal(goldTrendMetrics([{ usd: 4072 }]).direction, 0);
  assert.equal(goldTrendMetrics([{ usd: 4000 }, { usd: 4050 }]).percent, 1.25);
});

test('gold trend chart changes to green or red and exposes selectable ranges and readings', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { goldTrendChart } = makeGoldChartHelpers(html);
  const rising = goldTrendChart({ history: [{ usd: 4000 }, { usd: 4050 }], usd: 4050, src: 'xaus' });
  const falling = goldTrendChart({ history: [{ usd: 4072 }, { usd: 4050 }], usd: 4050, src: 'xaus' });
  const single = goldTrendChart({ history: [{ usd: 4072 }], usd: 4072, src: 'xaus' });
  assert.ok(rising.includes('--gold-trend:#16a34a'));
  assert.ok(rising.includes('Upward trend'));
  assert.ok(rising.includes('data-a="goldRange"'));
  assert.ok(rising.includes('data-a="goldPoint"'));
  assert.ok(falling.includes('--gold-trend:#dc2626'));
  assert.ok(falling.includes('Downward trend'));
  assert.ok(single.includes('Trend not established yet'));
  assert.ok(single.includes('At least two observations'));
});

test('gold price observations preserve legacy values and record observation time and source', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const state = { gold: { h: [4000, 4010] } };
  const { goldRecordObservation } = makeGoldChartHelpers(html, state);
  goldRecordObservation(4020, '2026-11-07T10:02:00.000Z', 'xaus');
  assert.deepEqual(state.gold.h, [4000, 4010, 4020]);
  assert.equal(state.gold.history.length, 3);
  assert.equal(state.gold.history[0].observedAt, null);
  assert.equal(state.gold.history[2].priceAt, '2026-11-07T10:02:00.000Z');
  assert.equal(state.gold.history[2].source, 'xaus');
});


test('gold spot hero matches the compact dark market card and reflects real saved movement', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { goldHeroCard } = makeGoldChartHelpers(html);
  const rising = goldHeroCard({ history: [{ usd: 4000 }, { usd: 4050 }], usd: 4050, src: 'xaus', t: '2026-11-07T12:00:00Z' });
  const falling = goldHeroCard({ history: [{ usd: 4072 }, { usd: 4050 }], usd: 4050, src: 'gold-api', t: '2026-11-07T12:00:00Z' });
  const single = goldHeroCard({ history: [{ usd: 4050 }], usd: 4050, src: 'xaus' });
  assert.ok(rising.includes('class="cd gold-hero"'));
  assert.match(html, /\.gold-hero\{display:flex;direction:ltr;/);
  assert.match(html, /\.gold-hero-copy\{[^}]*direction:ltr;text-align:left\}/);
  assert.ok(rising.includes('class="gold-hero-change up"'));
  assert.ok(rising.includes('+1.25%'));
  assert.ok(rising.includes('#16a34a'));
  assert.ok(rising.includes('gold-hero-chart'));
  assert.ok(rising.includes('$4,050.00'));
  assert.ok(falling.includes('class="gold-hero-change down"'));
  assert.ok(falling.includes('-0.54%'));
  assert.ok(falling.includes('#dc2626'));
  assert.ok(single.includes('class="gold-hero-change flat"'));
  assert.ok(single.includes('gold-hero-wait'));
  assert.ok(single.includes('Not enough readings'));
  assert.ok(!single.includes('0.00%'));
});

test('portfolio P/L chart separates realized and unrealized gains and losses by asset', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { portfolioPLRows, portfolioPLChart } = makeGoldChartHelpers(html);
  const assets = [
    { a: { n: 'Gold bar', cur: 'USD' }, p: { v: 1450, c: 1000, pl: 120 } },
    { a: { n: 'Gold coin', cur: 'USD' }, p: { v: 800, c: 1000, pl: -50 } }
  ];
  const rows = portfolioPLRows(assets);
  assert.equal(rows[0].total, 570);
  assert.equal(rows[0].unrealized, 450);
  assert.equal(rows[0].realized, 120);
  assert.equal(rows[1].total, -250);
  const chart = portfolioPLChart(assets);
  assert.ok(chart.includes('Total P/L'));
  assert.ok(chart.includes('Realized'));
  assert.ok(chart.includes('Unrealized'));
  assert.ok(chart.includes('Gold bar'));
  assert.ok(chart.includes('Gold coin'));
  assert.ok(chart.includes('pl-bar up'));
  assert.ok(chart.includes('pl-bar down'));
  assert.ok(chart.includes('$320.00'));
});

test('investment page binds the lower chart and summary to total realized plus unrealized P/L', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /plRows=portfolioPLRows\(A\),pl=Z\(plRows\.map\(row=>row\.total\)\)/);
  assert.match(html, /portfolioPLChart\(A\)/);
  assert.match(html, /const unrealized=p\.v-p\.c,total=unrealized\+p\.pl/);
  assert.match(html, /interval=1d/);
  assert.match(html, /symbol=xau&range=3mo&interval=1d/);
});
