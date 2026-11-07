const PROVIDERS = Object.freeze({
  openai: 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions'
});

function json(res, status, body) {
  return res.status(status).setHeader('Cache-Control', 'no-store').json(body);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Method not allowed.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return json(res, 400, { error: 'Invalid JSON request.' }); }
  }
  if (!body || typeof body !== 'object') {
    return json(res, 400, { error: 'Invalid request body.' });
  }

  const provider = String(body.provider || '');
  const endpoint = PROVIDERS[provider];
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  const messages = Array.isArray(body.messages) ? body.messages : [];

  if (!endpoint) return json(res, 400, { error: 'Unsupported provider.' });
  if (!apiKey || apiKey.length > 500) return json(res, 400, { error: 'A valid API key is required.' });
  if (!model || model.length > 160) return json(res, 400, { error: 'A valid model ID is required.' });
  if (!messages.length || messages.length > 14) return json(res, 400, { error: 'The conversation must contain between 1 and 14 messages.' });

  const cleanMessages = [];
  for (const item of messages) {
    const role = item && item.role;
    const content = item && item.content;
    if (!['system', 'user', 'assistant'].includes(role) || typeof content !== 'string' || content.length > 12000) {
      return json(res, 400, { error: 'Invalid message format or message too long.' });
    }
    cleanMessages.push({ role, content });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);
  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(provider === 'openrouter' ? { 'X-Title': 'WALLET OS' } : {})
      },
      body: JSON.stringify({ model, messages: cleanMessages, stream: false }),
      signal: controller.signal
    });

    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const message = data && data.error && typeof data.error.message === 'string'
        ? data.error.message
        : `The provider returned HTTP ${upstream.status}.`;
      return json(res, upstream.status, { error: message.slice(0, 500) });
    }

    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
    let reply = '';
    if (typeof content === 'string') reply = content;
    else if (Array.isArray(content)) reply = content.map(part => part && (part.text || part.content) || '').join('');
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
