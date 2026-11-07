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
    json(value) { this.body = value; return this; },
    end() { this.ended = true; return this; }
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

test('AI Gateway proxy blocks prompt training and returns the model response', async () => {
  const originalFetch = global.fetch;
  const originalOidc = process.env.VERCEL_OIDC_TOKEN;
  process.env.VERCEL_OIDC_TOKEN = 'test-runtime-vercel-oidc-token';
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
        providerMetadata: { gateway: { routing: { planningReasoning: 'No prompt training requested; compliant provider selected.' } } }
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
        authorization: 'Bearer test-supabase-access-token'
      }
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.reply, 'WALLET OS connection OK');
    assert.equal(res.body.model, 'google/gemini-3.1-flash-lite');
    assert.equal(res.body.privacyMode, 'no-prompt-training');
    assert.match(res.body.routingEvidence, /No prompt training requested/);

    const authCall = requests.find(x => x.url.endsWith('/auth/v1/user'));
    assert.equal(authCall.options.headers.apikey, 'sb_publishable_wlBi2KLoDCh0o8K_HbAArQ_O9uy-NLj');
    assert.equal(authCall.options.headers.Authorization, 'Bearer test-supabase-access-token');

    const modelCall = requests.find(x => x.url.endsWith('/v1/chat/completions'));
    assert.equal(modelCall.options.headers.Authorization, 'Bearer test-runtime-vercel-oidc-token');
    const payload = JSON.parse(modelCall.options.body);
    assert.equal(payload.model, 'google/gemini-3.1-flash-lite');
    assert.equal(payload.providerOptions.gateway.disallowPromptTraining, true);
    assert.equal(payload.providerOptions.gateway.zeroDataRetention, undefined);
    assert.equal(payload.stream, false);
    assert.equal(payload.messages[0].content, 'Reply with exactly: WALLET OS connection OK');
  } finally {
    global.fetch = originalFetch;
    if (originalOidc === undefined) delete process.env.VERCEL_OIDC_TOKEN;
    else process.env.VERCEL_OIDC_TOKEN = originalOidc;
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
  assert.match(html, /z\.version===2&&AI_PROVIDERS\.includes\(z\.provider\)/);
  assert.match(html, /version:2/);
});


test('AI Gateway health check verifies the OIDC model endpoint without generating text', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, options = {}) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({
      data: [
        { provider: 'google', has_no_training: true },
        { provider: 'vertex', has_no_training: false }
      ]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const res = makeResponse();
    const req = makeRequest({
      method: 'GET',
      body: {},
      headers: { 'x-vercel-oidc-token': 'test-vercel-oidc-token' }
    });
    req.url = '/api/ai?health=1';
    await aiHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.gateway, 'reachable');
    assert.equal(res.body.model, 'google/gemini-3.1-flash-lite');
    assert.equal(res.body.noPromptTrainingEndpoints, 1);
    assert.match(captured.url, /models\/google\/gemini-3\.1-flash-lite\/endpoints$/);
    assert.equal(captured.options.headers.Authorization, 'Bearer test-vercel-oidc-token');
  } finally {
    global.fetch = originalFetch;
  }
});


test('AI Gateway rejects requests when no no-training provider is available', async () => {
  const originalFetch = global.fetch;
  global.fetch = async url => {
    if (String(url).endsWith('/auth/v1/user')) {
      return new Response(JSON.stringify({ id: 'test-user-3' }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    if (String(url).endsWith('/v1/chat/completions')) {
      return new Response(JSON.stringify({
        error: 'No providers available that disallow prompt training for model: google/gemini-3.1-flash-lite.',
        type: 'no_providers_available',
        statusCode: 400
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('Unexpected URL: ' + String(url));
  };
  try {
    const res = makeResponse();
    await aiHandler(makeRequest({
      body: {
        provider: 'vercel',
        messages: [{ role: 'user', content: 'synthetic private-data test' }]
      },
      headers: {
        authorization: 'Bearer test-supabase-access-token',
        'x-vercel-oidc-token': 'test-vercel-oidc-token'
      }
    }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'NO_TRAINING_UNAVAILABLE');
    assert.match(res.body.error, /No providers available/);
  } finally {
    global.fetch = originalFetch;
  }
});


test('Capacitor Android preflight is allowed only from the bundled app origin', async () => {
  const native = makeResponse();
  await aiHandler({
    method: 'OPTIONS',
    url: '/api/ai',
    headers: {
      host: 'wallet.test',
      origin: 'https://localhost',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type'
    }
  }, native);
  assert.equal(native.statusCode, 204);
  assert.equal(native.headers['access-control-allow-origin'], 'https://localhost');
  assert.match(native.headers['access-control-allow-methods'], /POST/);
  assert.match(native.headers['access-control-allow-headers'], /Authorization/);

  const attacker = makeResponse();
  await aiHandler({
    method: 'OPTIONS',
    url: '/api/ai',
    headers: { host: 'wallet.test', origin: 'https://attacker.test' }
  }, attacker);
  assert.equal(attacker.statusCode, 403);
});

test('AI API accepts the explicitly configured native app origin', async () => {
  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = async url => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      model: 'gpt-test',
      choices: [{ message: { content: 'native connection OK' } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const res = makeResponse();
    await aiHandler(makeRequest({
      body: {
        provider: 'openai',
        apiKey: 'synthetic-test-key',
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'synthetic test' }]
      },
      headers: { origin: 'https://localhost' }
    }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.reply, 'native connection OK');
    assert.equal(res.headers['access-control-allow-origin'], 'https://localhost');
    assert.equal(requestedUrl, 'https://api.openai.com/v1/chat/completions');
  } finally {
    global.fetch = originalFetch;
  }
});
