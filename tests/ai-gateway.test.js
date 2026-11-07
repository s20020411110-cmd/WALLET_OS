const test = require('node:test');
const assert = require('node:assert/strict');
const aiHandler = require('../api/ai.js');

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function makeRequest({ method = 'POST', body = {}, headers = {} } = {}) {
  return { method, body, url: '/api/ai', headers: { host: 'wallet.test', origin: 'https://wallet.test', ...headers } };
}

test('AI Gateway proxy requires a same-origin, authenticated WALLET OS session', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error('fetch should not be called'); };
  try {
    const crossOrigin = makeResponse();
    await aiHandler(makeRequest({ headers: { origin: 'https://attacker.test' } }), crossOrigin);
    assert.equal(crossOrigin.statusCode, 403);

    const noSession = makeResponse();
    await aiHandler(makeRequest({
      body: { provider: 'vercel', model: 'google/gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'Hello' }] }
    }), noSession);
    assert.equal(noSession.statusCode, 401);
    assert.equal(calls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AI Gateway proxy calls the selected model with ZDR and returns the model response', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/auth/v1/user')) {
      return new Response(JSON.stringify({ id: 'test-user-1' }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    if (String(url).endsWith('/v1/chat/completions')) {
      return new Response(JSON.stringify({
        model: 'google/gemini-3.1-flash-lite',
        choices: [{ message: { content: 'WALLET OS connection OK' } }],
        providerMetadata: { gateway: { routing: { planningReasoning: 'ZDR requested; compliant provider selected.' } } }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('Unexpected URL: ' + String(url));
  };
  try {
    const res = makeResponse();
    await aiHandler(makeRequest({
      body: {
        provider: 'vercel',
        model: 'google/gemini-3.1-flash-lite',
        messages: [{ role: 'user', content: 'Reply with exactly: WALLET OS connection OK' }]
      },
      headers: {
        authorization: 'Bearer test-supabase-access-token',
        'x-vercel-oidc-token': 'test-vercel-oidc-token'
      }
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.reply, 'WALLET OS connection OK');
    assert.equal(res.body.model, 'google/gemini-3.1-flash-lite');
    assert.equal(res.body.privacyMode, 'zdr-required');
    assert.match(res.body.routingEvidence, /ZDR requested/);

    const authCall = requests.find(x => x.url.endsWith('/auth/v1/user'));
    assert.equal(authCall.options.headers.apikey, 'sb_publishable_wlBi2KLoDCh0o8K_HbAArQ_O9uy-NLj');
    assert.equal(authCall.options.headers.Authorization, 'Bearer test-supabase-access-token');

    const modelCall = requests.find(x => x.url.endsWith('/v1/chat/completions'));
    assert.equal(modelCall.options.headers.Authorization, 'Bearer test-vercel-oidc-token');
    const payload = JSON.parse(modelCall.options.body);
    assert.equal(payload.model, 'google/gemini-3.1-flash-lite');
    assert.equal(payload.providerOptions.gateway.zeroDataRetention, true);
    assert.equal(payload.providerOptions.gateway.disallowPromptTraining, true);
    assert.equal(payload.stream, false);
    assert.equal(payload.messages[0].content, 'Reply with exactly: WALLET OS connection OK');
  } finally {
    global.fetch = originalFetch;
  }
});

test('AI Gateway proxy fails closed when Vercel OIDC is unavailable', async () => {
  const originalFetch = global.fetch;
  global.fetch = async url => {
    if (String(url).endsWith('/auth/v1/user')) {
      return new Response(JSON.stringify({ id: 'test-user-2' }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    throw new Error('Model endpoint must not be called without OIDC');
  };
  try {
    const res = makeResponse();
    await aiHandler(makeRequest({
      body: { provider: 'vercel', messages: [{ role: 'user', content: 'synthetic check' }] },
      headers: { authorization: 'Bearer test-supabase-access-token' }
    }), res);
    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /OIDC token was not attached/);
  } finally {
    global.fetch = originalFetch;
  }
});


test('gold hero card follows the active theme and remains compact', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /\.gold-hero\{[^}]*background:linear-gradient\(115deg,var\(--c\),var\(--bg\)\)!important/);
  assert.match(html, /\.gold-hero-price\{[^}]*color:var\(--ink\)/);
  assert.match(html, /\.gold-hero-chart\{width:122px/);
  assert.match(html, /--gold-hero-color/);
  assert.match(html, /const AI_GATEWAY_MODEL='google\/gemini-3\.1-flash-lite'/);
  assert.match(html, /provider:'vercel',model:AI_GATEWAY_MODEL/);
  assert.match(html, /Vercel AI Gateway/);
});
