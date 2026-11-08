'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function makeHarness(initialGold) {
  const start = html.indexOf('function applyGoldRealtimeQuote(');
  const statusStart = html.indexOf('function applyGoldRealtimeStatus(', start);
  const statusEnd = html.indexOf('\nasync function stopGoldRealtime()', statusStart);
  assert.ok(start >= 0 && statusStart > start && statusEnd > statusStart, 'market application functions should exist');
  const quoteFunction = html.slice(start, statusStart);
  const statusFunction = html.slice(statusStart, statusEnd);
  const state = {
    gold: {
      usd: 2500,
      gramUsd: 2500 / 31.1034768,
      src: 'twelvedata-ws',
      state: 'fresh',
      t: new Date().toISOString(),
      ...initialGold
    },
    inv: [{ id: 'asset-1', price: 2550, cur: 'USD', q0: 1, c0: 2550 }],
    tx: [{ id: 'buy-1', amount: 2550, type: 'investment_buy' }],
    accs: [{ id: 'wallet-1', balance: 900 }]
  };
  const calls = { saves: 0, observations: [], renders: 0, builds: 0 };
  const documentMock = {
    querySelector() { return null; },
    activeElement: { tagName: 'BODY' }
  };
  const factory = new Function(
    'S', 'document', 'saveGoldLocalOnly', 'goldRecordObservation',
    'renderGoldMarketStatus', 'build',
    'let GOLD_RT_STATE={connection_status:"unavailable",freshness_state:"unavailable",source:null,provider_timestamp:null,received_at:null,server_time:null};' +
    'let GOLD_RT_LAST_STATUS_AT=0,LV={dir:0,ok:0},NA=0;' +
    quoteFunction + '\n' + statusFunction +
    '\nreturn {applyGoldRealtimeQuote,applyGoldRealtimeStatus,getState:()=>GOLD_RT_STATE,getLastStatus:()=>GOLD_RT_LAST_STATUS_AT,getLive:()=>LV};'
  );
  const api = factory(
    state,
    documentMock,
    () => { calls.saves += 1; },
    (...args) => calls.observations.push(args),
    () => { calls.renders += 1; },
    () => { calls.builds += 1; }
  );
  return { api, state, calls };
}

function quote(overrides = {}) {
  const stamp = new Date().toISOString();
  const price = 2800;
  return {
    instrument: 'XAU/USD',
    price_usd_oz: price,
    price_usd_gram: price / 31.1034768,
    bid_usd_oz: 2799.9,
    ask_usd_oz: 2800.1,
    provider_timestamp: stamp,
    received_at: stamp,
    source: 'twelvedata-ws',
    connection_status: 'live',
    freshness_state: 'fresh',
    ...overrides
  };
}

test('valid real-time tick updates spot value and recalculates through existing gold state only', () => {
  const { api, state, calls } = makeHarness();
  const transactionBefore = structuredClone(state.tx);
  const walletBefore = structuredClone(state.accs);
  const assetBefore = structuredClone(state.inv);
  assert.equal(api.applyGoldRealtimeQuote(quote()), true);
  assert.equal(state.gold.usd, 2800);
  assert.equal(state.gold.gramUsd, 2800 / 31.1034768);
  assert.equal(state.gold.marketQuote.instrument, 'XAU/USD');
  assert.equal(state.gold.marketQuote.source, 'twelvedata-ws');
  assert.equal(calls.observations.length, 1);
  assert.equal(calls.saves, 1);
  assert.equal(calls.builds, 1);
  assert.deepEqual(state.tx, transactionBefore);
  assert.deepEqual(state.accs, walletBefore);
  assert.deepEqual(state.inv, assetBefore);
});

test('invalid and malformed quotes are rejected without changing spot or wallet data', () => {
  const { api, state, calls } = makeHarness();
  const previous = state.gold.usd;
  assert.equal(api.applyGoldRealtimeQuote(null), false);
  assert.equal(api.applyGoldRealtimeQuote({ ...quote(), instrument: 'XAG/USD' }), false);
  assert.equal(api.applyGoldRealtimeQuote({ ...quote(), price_usd_oz: 0 }), false);
  assert.equal(api.applyGoldRealtimeQuote({ ...quote(), price_usd_gram: 0 }), false);
  assert.equal(api.applyGoldRealtimeQuote({ ...quote(), provider_timestamp: 'bad-date' }), false);
  assert.equal(api.applyGoldRealtimeQuote({ ...quote(), received_at: '' }), false);
  assert.equal(state.gold.usd, previous);
  assert.equal(state.accs[0].balance, 900);
  assert.equal(calls.saves, 0);
  assert.equal(calls.builds, 0);
});

test('older provider timestamps and duplicate ticks do not change the displayed market price', () => {
  const { api, state, calls } = makeHarness();
  const current = quote();
  assert.equal(api.applyGoldRealtimeQuote(current), true);
  const acceptedPrice = state.gold.usd;
  const older = quote({
    price_usd_oz: 2700,
    price_usd_gram: 2700 / 31.1034768,
    provider_timestamp: new Date(Date.parse(current.provider_timestamp) - 5000).toISOString()
  });
  assert.equal(api.applyGoldRealtimeQuote(older), false);
  const observationCount = calls.observations.length;
  assert.equal(api.applyGoldRealtimeQuote(current), true);
  assert.equal(state.gold.usd, acceptedPrice);
  assert.equal(calls.observations.length, observationCount);
  assert.equal(calls.builds, 1);
});

test('manual spot override and recorded asset acquisition values are not overwritten by ticks', () => {
  const { api, state, calls } = makeHarness({ usd: 2600, gramUsd: 2600 / 31.1034768, src: 'manual' });
  const txBefore = structuredClone(state.tx);
  const assetsBefore = structuredClone(state.inv);
  assert.equal(api.applyGoldRealtimeQuote(quote()), true);
  assert.equal(state.gold.usd, 2600);
  assert.equal(state.gold.gramUsd, 2600 / 31.1034768);
  assert.equal(state.gold.src, 'manual');
  assert.equal(state.gold.marketQuote.price_usd_oz, 2800);
  assert.deepEqual(state.tx, txBefore);
  assert.deepEqual(state.inv, assetsBefore);
  assert.equal(calls.observations.length, 0);
});

test('status event can mark a preserved price stale without replacing it with zero', () => {
  const { api, state, calls } = makeHarness();
  assert.equal(api.applyGoldRealtimeQuote(quote()), true);
  const lastPrice = state.gold.usd;
  assert.equal(api.applyGoldRealtimeStatus({
    instrument: 'XAU/USD',
    connection_status: 'stale',
    freshness_state: 'stale',
    source: 'twelvedata-ws',
    provider_timestamp: state.gold.marketQuote.provider_timestamp,
    received_at: state.gold.marketQuote.received_at,
    server_time: new Date().toISOString(),
    subscription_active: false
  }), true);
  assert.equal(api.getState().connection_status, 'stale');
  assert.equal(api.getState().freshness_state, 'stale');
  assert.equal(state.gold.usd, lastPrice);
  assert.equal(state.accs[0].balance, 900);
  assert.ok(calls.saves >= 1);
});

test('gold application uses local-only persistence and does not post finance RPCs', () => {
  const quoteStart = html.indexOf('function applyGoldRealtimeQuote(');
  const quoteEnd = html.indexOf('\nfunction applyGoldRealtimeStatus(', quoteStart);
  const implementation = html.slice(quoteStart, quoteEnd);
  assert.match(implementation, /saveGoldLocalOnly\(\)/);
  assert.doesNotMatch(implementation, /save\(\)|cloudRpc\(|post_financial_transaction|SB\.rpc/);
  assert.match(html, /SB\.channel\('wallet-os-gold-market',\{config:\{private:true\}\}\)/);
  assert.match(html, /startGoldRealtime\(\)\.catch/);
  assert.match(html, /setInterval\(updateGoldMarketAge,1000\)/);
  assert.doesNotMatch(html, /setInterval\(\(\)=>live\(\),1000\)/);
});
