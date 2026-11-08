'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadHandler(fetchImpl) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'gold-price.js'), 'utf8')
    .replace('export default async function handler', 'module.exports = async function handler');
  const sandbox = {
    module: { exports: {} },
    exports: {},
    fetch: fetchImpl,
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Number,
    String,
    Math,
    JSON,
    Object,
    Infinity
  };
  vm.runInNewContext(source, sandbox, { filename: 'api/gold-price.js' });
  return sandbox.module.exports;
}

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('gold price endpoint accepts a fresh XAUS quote and returns the normalized contract', async () => {
  const now = Date.now();
  const handler = loadHandler(async () => ({
    ok: true,
    json: async () => ({
      spot_usd_oz: 2800,
      per_gram_usd: 2800 / 31.1034768,
      price_as_of: new Date(now).toISOString(),
      data_state: { status: 'fresh', age_seconds: 1 }
    })
  }));
  const res = responseRecorder();
  await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.source, 'xaus');
  assert.equal(res.body.instrument, 'XAU/USD');
  assert.equal(res.body.price_usd_oz, 2800);
  assert.equal(res.body.price_usd_gram, 2800 / 31.1034768);
  assert.equal(res.body.freshness_state, 'fresh');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('stale XAUS is not displayed as fresh; endpoint uses Gold API only after validation', async () => {
  const now = Date.now();
  let calls = 0;
  const handler = loadHandler(async url => {
    calls += 1;
    if (String(url).includes('xaus.com')) {
      return {
        ok: true,
        json: async () => ({
          spot_usd_oz: 2790,
          per_gram_usd: 2790 / 31.1034768,
          price_as_of: new Date(now - 600_000).toISOString(),
          data_state: { status: 'stale', age_seconds: 600 }
        })
      };
    }
    return {
      ok: true,
      json: async () => ({ price: 2801, updatedAt: new Date(now).toISOString() })
    };
  });
  const res = responseRecorder();
  await handler({ method: 'GET' }, res);
  assert.equal(calls, 2);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.source, 'gold-api');
  assert.equal(res.body.price_usd_oz, 2801);
  assert.equal(res.body.freshness_state, 'fresh');
});

test('gold API stale response produces unavailable status instead of old/fabricated price', async () => {
  const now = Date.now();
  const handler = loadHandler(async url => ({
    ok: true,
    json: async () => String(url).includes('xaus.com')
      ? { spot_usd_oz: 0, data_state: { status: 'unavailable' } }
      : { price: 2700, updatedAt: new Date(now - 900_000).toISOString() }
  }));
  const res = responseRecorder();
  await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.freshness_state, 'unavailable');
  assert.equal(res.body.price_usd_oz, undefined);
});

test('gold price API rejects non-GET requests', async () => {
  const handler = loadHandler(async () => { throw new Error('fetch must not run'); });
  const res = responseRecorder();
  await handler({ method: 'POST' }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'GET');
});
