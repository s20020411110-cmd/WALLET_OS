const PROVIDERS = Object.freeze({
  openai: 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions'
});

const AI_GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1';
const AI_GATEWAY_MODEL = 'google/gemini-3.1-flash-lite';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://lwefgfogrxavxczrznjl.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_wlBi2KLoDCh0o8K_HbAArQ_O9uy-NLj';
const rateBuckets = new Map();
const MAX_REQUESTS_PER_MINUTE = 20;

function json(res, status, body) {
  return res.status(status).setHeader('Cache-Control', 'no-store').json(body);
}

const NATIVE_APP_ORIGIN = 'https://localhost';

function applyNativeCors(req, res) {
  const origin = String(req.headers && req.headers.origin || '').trim();
  if (origin !== NATIVE_APP_ORIGIN) return false;
  res.setHeader('Access-Control-Allow-Origin', NATIVE_APP_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
  return true;
}

function sameOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;
  if (origin === NATIVE_APP_ORIGIN) return true;
  const host = String((req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '')
    .split(',')[0].trim().toLowerCase();
  try {
    return Boolean(host) && new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function getHeader(req, name) {
  const headers = req.headers || {};
  return String(headers[name] || headers[name.toLowerCase()] || '').trim();
}

function getVercelOidcToken(req) {
  const runtimeToken = typeof process !== 'undefined' && process.env
    ? process.env.VERCEL_OIDC_TOKEN : '';
  return String(runtimeToken || getHeader(req, 'x-vercel-oidc-token') || '').trim();
}

function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return { error: 'Invalid JSON request.' }; }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Invalid request body.' };
  }
  return { body };
}

function cleanMessages(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 14) {
    return { error: 'The conversation must contain between 1 and 14 messages.' };
  }
  const result = [];
  let totalLength = 0;
  for (const item of input) {
    const role = item && item.role;
    const content = item && item.content;
    if (!['system', 'user', 'assistant'].includes(role) || typeof content !== 'string' || content.length > 16000) {
      return { error: 'Invalid message format or message too long.' };
    }
    totalLength += content.length;
    if (totalLength > 48000) return { error: 'The conversation is too long.' };
    result.push({ role, content });
  }
  return { messages: result };
}

function rateAllowed(userId) {
  const now = Date.now();
  const prior = rateBuckets.get(userId) || [];
  const recent = prior.filter(time => now - time < 60000);
  if (recent.length >= MAX_REQUESTS_PER_MINUTE) {
    rateBuckets.set(userId, recent);
    return false;
  }
  recent.push(now);
  rateBuckets.set(userId, recent);
  if (rateBuckets.size > 2000) {
    for (const [key, values] of rateBuckets) {
      if (!values.some(time => now - time < 60000)) rateBuckets.delete(key);
    }
  }
  return true;
}

async function verifySupabaseUser(req) {
  const authorization = getHeader(req, 'authorization');
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) return { ok: false, status: 401, error: 'Sign in to your WALLET OS cloud account to use the hosted AI assistant.' };

  try {
    const response = await fetch(SUPABASE_URL + '/auth/v1/user', {
      method: 'GET',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: 'Bearer ' + match[1]
      },
      cache: 'no-store'
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: 401, error: 'Your session has expired. Sign in again and retry.' };
    }
    if (!response.ok) {
      return { ok: false, status: 503, error: 'Unable to verify your WALLET OS session right now.' };
    }
    const user = await response.json().catch(() => null);
    if (!user || typeof user.id !== 'string' || !user.id) {
      return { ok: false, status: 401, error: 'The WALLET OS session could not be verified.' };
    }
    return { ok: true, userId: user.id };
  } catch {
    return { ok: false, status: 503, error: 'Unable to reach WALLET OS authentication. Check your connection and retry.' };
  }
}

async function gatewayHealth(req, res) {
  const oidcToken = getVercelOidcToken(req);
  if (!oidcToken) {
    return json(res, 503, {
      ok: false,
      gateway: 'unavailable',
      error: 'Vercel did not attach an OIDC token to this function request.'
    });
  }
  try {
    const endpoint = AI_GATEWAY_URL + '/models/google/gemini-3.1-flash-lite/endpoints';
    const upstream = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + oidcToken },
      cache: 'no-store'
    });
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return json(res, 502, {
        ok: false,
        gateway: 'unreachable',
        error: 'AI Gateway model check returned HTTP ' + upstream.status + '.'
      });
    }
    const endpoints = Array.isArray(data && data.data) ? data.data
      : Array.isArray(data && data.endpoints) ? data.endpoints : [];
    const noTrainingCount = endpoints.filter(item => item && item.has_no_training === true).length;
    return json(res, 200, {
      ok: true,
      gateway: 'reachable',
      model: AI_GATEWAY_MODEL,
      noPromptTrainingEndpoints: endpoints.length ? noTrainingCount : null
    });
  } catch {
    return json(res, 502, { ok: false, gateway: 'unreachable', error: 'Unable to reach AI Gateway.' });
  }
}

module.exports = async function handler(req, res) {
  const nativeOrigin = applyNativeCors(req, res);
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    if (!nativeOrigin) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
    return res.status(204).end();
  }
  if (req.method === 'GET') {
    const url = new URL(req.url || '/', 'https://' + (getHeader(req, 'host') || 'localhost'));
    if (url.searchParams.get('health') === '1') return gatewayHealth(req, res);
    res.setHeader('Allow', 'POST, GET');
    return json(res, 405, { error: 'Use GET ?health=1 for a non-billing gateway connectivity check.' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, GET');
    return json(res, 405, { error: 'Method not allowed.' });
  }
  if (!sameOrigin(req)) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });

  const contentLength = Number(getHeader(req, 'content-length') || 0);
  if (contentLength > 64000) return json(res, 413, { error: 'Request is too large.' });

  const parsed = readBody(req);
  if (parsed.error) return json(res, 400, { error: parsed.error });
  const body = parsed.body;
  const prepared = cleanMessages(body.messages);
  if (prepared.error) return json(res, 400, { error: prepared.error });

  if (body.provider === 'vercel') {
    const user = await verifySupabaseUser(req);
    if (!user.ok) return json(res, user.status, { error: user.error });
    if (!rateAllowed(user.userId)) {
      return json(res, 429, { error: 'AI request limit reached. Wait one minute before trying again.' });
    }

    const oidcToken = getVercelOidcToken(req);
    if (!oidcToken) {
      return json(res, 503, {
        error: 'Vercel AI Gateway authentication is unavailable for this deployment. The OIDC token was not attached.'
      });
    }

    const timerController = new AbortController();
    const timer = setTimeout(() => timerController.abort(), 55000);
    try {
      const upstream = await fetch(AI_GATEWAY_URL + '/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + oidcToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: AI_GATEWAY_MODEL,
          messages: prepared.messages,
          stream: false,
          temperature: 0.25,
          max_tokens: 1200,
          providerOptions: {
            gateway: {
              disallowPromptTraining: true
            }
          }
        }),
        signal: timerController.signal
      });

      const data = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        const message = data && typeof data.error === 'string'
          ? data.error
          : data && data.error && typeof data.error.message === 'string'
            ? data.error.message
            : 'AI Gateway returned HTTP ' + upstream.status + '.';
        const errorType = data && (data.type || data.code || (data.error && data.error.type));
        const privacyError = errorType === 'no_providers_available'
          || /no.?training|prompt.?training|training.*provider|provider.*available|no_providers_available/i.test(message);
        return json(res, upstream.status, {
          error: message.slice(0, 500),
          code: privacyError ? 'NO_TRAINING_UNAVAILABLE' : 'AI_GATEWAY_ERROR'
        });
      }

      const content = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content : null;
      let reply = '';
      if (typeof content === 'string') reply = content;
      else if (Array.isArray(content)) {
        reply = content.map(part => part && (part.text || part.content) || '').join('');
      }
      if (!reply.trim()) return json(res, 502, { error: 'The AI model returned an empty response.' });

      const routeInfo = data && data.providerMetadata && data.providerMetadata.gateway
        && data.providerMetadata.gateway.routing;
      const planningReasoning = routeInfo && typeof routeInfo.planningReasoning === 'string'
        ? routeInfo.planningReasoning.slice(0, 300) : null;
      return json(res, 200, {
        reply: reply.trim(),
        model: data.model || AI_GATEWAY_MODEL,
        privacyMode: 'no-prompt-training',
        routingEvidence: planningReasoning
      });
    } catch (error) {
      const message = error && error.name === 'AbortError'
        ? 'The AI model request timed out.'
        : 'Unable to reach Vercel AI Gateway. Check deployment connectivity and try again.';
      return json(res, 502, { error: message });
    } finally {
      clearTimeout(timer);
    }
  }

  const provider = String(body.provider || '');
  const endpoint = PROVIDERS[provider];
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : '';

  if (!endpoint) return json(res, 400, { error: 'Unsupported provider.' });
  if (!apiKey || apiKey.length > 500) return json(res, 400, { error: 'A valid API key is required.' });
  if (!model || model.length > 160) return json(res, 400, { error: 'A valid model ID is required.' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);
  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        ...(provider === 'openrouter' ? { 'X-Title': 'WALLET OS' } : {})
      },
      body: JSON.stringify({ model, messages: prepared.messages, stream: false }),
      signal: controller.signal
    });

    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const message = data && data.error && typeof data.error.message === 'string'
        ? data.error.message
        : 'The provider returned HTTP ' + upstream.status + '.';
      return json(res, upstream.status, { error: message.slice(0, 500) });
    }

    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : null;
    let reply = '';
    if (typeof content === 'string') reply = content;
    else if (Array.isArray(content)) {
      reply = content.map(part => part && (part.text || part.content) || '').join('');
    }
    if (!reply.trim()) return json(res, 502, { error: 'The provider returned an empty response.' });
    return json(res, 200, { reply: reply.trim(), model: data.model || model });
  } catch (error) {
    const message = error && error.name === 'AbortError'
      ? 'The provider request timed out.'
      : 'Unable to reach the selected AI provider. Check provider availability and the deployment network.';
    return json(res, 502, { error: message });
  } finally {
    clearTimeout(timer);
  }
};
