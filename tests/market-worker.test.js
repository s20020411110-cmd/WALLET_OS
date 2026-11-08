'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  INSTRUMENT,
  TROY_OUNCE_GRAMS,
  normalizeTwelveDataPrice,
  normalizeXausQuote,
  normalizeGoldApiQuote,
  isFresh,
  backoffDelay
} = require('../market-worker/market-data');
const { GoldMarketWorker, TOPIC } = require('../market-worker/worker');

const NOW = Date.parse('2026-11-08T12:00:00.000Z');

function tdTick(overrides = {}) {
  return {
    event: 'price',
    symbol: 'XAU/USD',
    timestamp: Math.floor(NOW / 1000),
    price: 2750.5,
    bid: 2750.4,
    ask: 2750.6,
    ...overrides
  };
}

function makeWorker(overrides = {}) {
  const worker = new GoldMarketWorker({
    env: {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SECRET_KEY: 'test-only-secret',
      TWELVE_DATA_API_KEY: 'test-only-twelve-key',
      TWELVE_DATA_USAGE_APPROVED: 'true'
    },
    now: () => NOW,
    log: { log() {}, warn() {}, error() {} },
    ...overrides
  });
  worker.broadcast = async () => true;
  worker.publishStatus = async () => true;
  worker.persistSnapshot = async () => true;
  return worker;
}

test('Twelve Data XAU/USD price message is normalized to ounce and gram', () => {
  const quote = normalizeTwelveDataPrice(tdTick(), { now: NOW });
  assert.equal(quote.instrument, INSTRUMENT);
  assert.equal(quote.price_usd_oz, 2750.5);
  assert.equal(quote.price_usd_gram, 2750.5 / TROY_OUNCE_GRAMS);
  assert.equal(quote.bid_usd_oz, 2750.4);
  assert.equal(quote.ask_usd_oz, 2750.6);
  assert.equal(quote.source, 'twelvedata-ws');
  assert.equal(quote.freshness_state, 'fresh');
  assert.equal(quote.provider_timestamp, new Date(NOW).toISOString());
});

test('Twelve Data rejects malformed, wrong-symbol, invalid-price and invalid-time messages', () => {
  assert.equal(normalizeTwelveDataPrice('{not-json', { now: NOW }), null);
  assert.equal(normalizeTwelveDataPrice(null, { now: NOW }), null);
  assert.equal(normalizeTwelveDataPrice({ event: 'subscribe-status', status: 'ok' }, { now: NOW }), null);
  assert.equal(normalizeTwelveDataPrice(tdTick({ symbol: 'XAG/USD' }), { now: NOW }), null);
  assert.equal(normalizeTwelveDataPrice(tdTick({ price: 0 }), { now: NOW }), null);
  assert.equal(normalizeTwelveDataPrice(tdTick({ price: 'NaN' }), { now: NOW }), null);
  assert.equal(normalizeTwelveDataPrice(tdTick({ timestamp: 'not-a-time' }), { now: NOW }), null);
  assert.equal(normalizeTwelveDataPrice(tdTick({ timestamp: Math.floor(NOW / 1000) + 600 }), { now: NOW }), null);
  assert.equal(normalizeTwelveDataPrice(tdTick({ bid: 2800, ask: 2799 }), { now: NOW }), null);
});

test('missing bid and ask remain null instead of becoming zero', () => {
  const quote = normalizeTwelveDataPrice(tdTick({ bid: undefined, ask: undefined }), { now: NOW });
  assert.equal(quote.bid_usd_oz, null);
  assert.equal(quote.ask_usd_oz, null);
});

test('XAUS and Gold API fallback normalizers preserve their provider and freshness state', () => {
  const stamp = new Date(NOW).toISOString();
  const xaus = normalizeXausQuote({
    spot_usd_oz: 2750,
    per_gram_usd: 2750 / TROY_OUNCE_GRAMS,
    price_as_of: stamp,
    data_state: { status: 'fresh', age_seconds: 1 }
  }, { now: NOW });
  assert.equal(xaus.source, 'xaus');
  assert.equal(xaus.freshness_state, 'fresh');

  const stale = normalizeXausQuote({
    spot_usd_oz: 2740,
    price_as_of: new Date(NOW - 600_000).toISOString(),
    data_state: { status: 'stale', age_seconds: 600 }
  }, { now: NOW });
  assert.equal(stale.freshness_state, 'stale');

  assert.equal(normalizeXausQuote({
    spot_usd_oz: 2750,
    price_as_of: stamp,
    data_state: { status: 'unavailable' }
  }, { now: NOW }), null);

  const goldApi = normalizeGoldApiQuote({
    price: 2749,
    updatedAt: new Date(NOW).toISOString()
  }, { now: NOW });
  assert.equal(goldApi.source, 'gold-api');
  assert.equal(goldApi.price_usd_gram, 2749 / TROY_OUNCE_GRAMS);
});

test('freshness validation rejects stale and missing quotes', () => {
  const fresh = normalizeTwelveDataPrice(tdTick(), { now: NOW });
  assert.equal(isFresh(fresh, NOW, 60_000), true);
  assert.equal(isFresh(fresh, NOW + 61_000, 60_000), false);
  assert.equal(isFresh(null, NOW), false);
});

test('reconnect backoff grows exponentially, is capped and remains jittered', () => {
  assert.equal(backoffDelay(0, { jitter: 0, random: () => 0.5 }), 1000);
  assert.equal(backoffDelay(1, { jitter: 0, random: () => 0.5 }), 2000);
  assert.equal(backoffDelay(9, { jitter: 0, random: () => 0.5 }), 30000);
  assert.equal(backoffDelay(2, { jitter: 0.2, random: () => 0 }), 3200);
});

test('worker sends the documented XAU/USD subscription and heartbeat', () => {
  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = {}; this.sent = []; FakeSocket.last = this; }
    addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
    emit(name, data = {}) { for (const handler of this.listeners[name] || []) handler(data); }
    send(message) { this.sent.push(JSON.parse(message)); }
    close() { this.readyState = 3; this.emit('close'); }
    open() { this.readyState = 1; this.emit('open'); }
  }
  const worker = makeWorker({ WebSocket: FakeSocket });
  worker.publishStatus = async () => true;
  worker.runFallback = async () => null;
  worker.scheduleReconnect = () => {};
  worker.connectPrimary();
  const socket = FakeSocket.last;
  assert.match(socket.url, /^wss:\/\/ws\.twelvedata\.com\/v1\/quotes\/price\?apikey=/);
  socket.open();
  assert.deepEqual(socket.sent[0], {
    action: 'subscribe',
    params: { symbols: 'XAU/USD' }
  });
  for (const timer of [worker.heartbeatTimer]) if (timer) clearInterval(timer);
  worker.reconnectTimer && clearTimeout(worker.reconnectTimer);
  worker.connectTimer && clearTimeout(worker.connectTimer);
  worker.ws = null;
});

test('worker marks XAU/USD active only after a successful subscription acknowledgement', () => {
  const worker = makeWorker();
  worker.handlePrimaryMessage(JSON.stringify({
    event: 'subscribe-status', status: 'ok',
    success: [{ symbol: 'XAU/USD', type: 'Physical Currency' }], fails: []
  }));
  assert.equal(worker.primaryStatus, 'subscribed');
  assert.equal(worker.subscriptionActive, true);

  const failed = makeWorker();
  failed.handlePrimaryMessage(JSON.stringify({
    event: 'subscribe-status', status: 'ok',
    success: [], fails: [{ symbol: 'XAU/USD', message: 'Not entitled' }]
  }));
  assert.equal(failed.primaryStatus, 'subscription-failed');
  assert.equal(failed.subscriptionActive, false);
});

test('incoming valid price tick is accepted once; duplicates and out-of-order ticks are ignored', async () => {
  const worker = makeWorker();
  const published = [];
  worker.broadcast = async (event, payload) => { published.push({ event, payload }); return true; };
  const first = normalizeTwelveDataPrice(tdTick(), { now: NOW });
  assert.equal(await worker.acceptQuote(first), true);
  assert.equal(worker.latestQuote.price_usd_oz, 2750.5);
  assert.equal(await worker.acceptQuote(first), false);
  const older = normalizeTwelveDataPrice(tdTick({
    timestamp: Math.floor((NOW - 5_000) / 1000),
    price: 2749
  }), { now: NOW });
  assert.equal(await worker.acceptQuote(older), false);
  assert.equal(worker.metrics.accepted, 1);
  assert.equal(worker.metrics.duplicates, 1);
  assert.equal(worker.metrics.outOfOrder, 1);
  assert.equal(published.filter(item => item.event === 'price').length, 1);
});

test('fallback selects XAUS first and does not query Gold API when XAUS is fresh', async () => {
  const worker = makeWorker();
  const calls = [];
  const stamp = new Date(NOW).toISOString();
  worker.fetchJson = async url => {
    calls.push(url);
    return {
      spot_usd_oz: 2751,
      per_gram_usd: 2751 / TROY_OUNCE_GRAMS,
      price_as_of: stamp,
      data_state: { status: 'fresh', age_seconds: 1 }
    };
  };
  const accepted = [];
  worker.acceptQuote = async quote => { accepted.push(quote); return true; };
  await worker.runFallback(true);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /xaus\.com/);
  assert.equal(accepted[0].source, 'xaus');
});

test('fallback activates Gold API only when XAUS does not return a valid fresh quote', async () => {
  const worker = makeWorker();
  const calls = [];
  worker.fetchJson = async url => {
    calls.push(url);
    if (url.includes('xaus.com')) {
      return { spot_usd_oz: 0, data_state: { status: 'unavailable' } };
    }
    return { price: 2748, updatedAt: new Date(NOW).toISOString() };
  };
  const accepted = [];
  worker.acceptQuote = async quote => { accepted.push(quote); return true; };
  await worker.runFallback(true);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /xaus\.com/);
  assert.match(calls[1], /gold-api\.com/);
  assert.equal(accepted[0].source, 'gold-api');
});

test('gold snapshot write is throttled and only targets the market quote table', async () => {
  const calls = [];
  const worker = makeWorker({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 201, text: async () => '' };
    }
  });
  const quote = normalizeTwelveDataPrice(tdTick(), { now: NOW });
  assert.equal(await worker.persistSnapshot(quote, true), true);
  assert.equal(await worker.persistSnapshot(quote, false), false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rest\/v1\/gold_price_quotes$/);
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.metal_code, 'XAU');
  assert.equal(payload.currency_code, 'USD');
  assert.equal(payload.price_per_troy_ounce, 2750.5);
  assert.equal(payload.source, 'twelvedata-ws');
  assert.doesNotMatch(calls[0].url, /transactions|journal/);
});

test('Realtime broadcast uses private JSON event endpoint and unwrapped payload', async () => {
  const calls = [];
  const worker = makeWorker({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => '{}' };
    }
  });
  const payload = { instrument: 'XAU/USD', price_usd_oz: 2750.5 };
  assert.equal(await worker.broadcast('price', payload), true);
  assert.match(calls[0].url, /\/realtime\/v1\/api\/broadcast\/wallet-os-gold-market\/events\/price\?private=true$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), payload);
  assert.equal(calls[0].options.headers.apikey, 'test-only-secret');
});

test('worker will not open Twelve Data without an explicit provider rights gate', () => {
  const worker = makeWorker({
    env: {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SECRET_KEY: 'test-only-secret',
      TWELVE_DATA_API_KEY: 'test-only-twelve-key',
      TWELVE_DATA_USAGE_APPROVED: 'false'
    }
  });
  assert.equal(worker.primaryStatus, 'license-not-confirmed');
  assert.equal(worker.twelveDataApproved, false);
});

test('frontend contains no worker or Twelve Data secret and no one-second price polling', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /TWELVE_DATA_API_KEY|SUPABASE_SECRET_KEY|sb_secret_/i);
  assert.doesNotMatch(html, /setInterval\([^)]*live\([^)]*\)\s*,\s*1000\)/);
  assert.match(html, /wallet-os-gold-market/);
});

test('worker snapshot and posting logic never mutates financial transaction endpoints', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'market-worker', 'worker.js'), 'utf8');
  assert.match(source, /\/rest\/v1\/gold_price_quotes/);
  assert.doesNotMatch(source, /\/rest\/v1\/transactions|post_financial_transaction|journal_entries|journal_lines/);
  assert.match(source, /snapshotIntervalMs/);
});

test('Vercel fallback returns stale/unavailable status instead of fabricating or zero-filling', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'gold-price.js'), 'utf8');
  assert.match(source, /Cache-Control', 'no-store/);
  assert.match(source, /providerState === 'fresh'/);
  assert.match(source, /return json\(res, 503/);
  assert.match(source, /freshness_state: 'unavailable'/);
  assert.match(source, /priceOz \/ OZ/);
});
