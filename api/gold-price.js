const OZ = 31.1034768;
const MAX_AGE_MS = 180000;
const json = (res, status, body) => res
  .status(status)
  .setHeader('Content-Type', 'application/json; charset=utf-8')
  .setHeader('Cache-Control', 'no-store')
  .json(body);

async function timed(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'WALLET-OS/1.0' }
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function positive(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const numeric = Number(value);
  if (/^\d{9,13}(?:\.\d+)?$/.test(value.trim()) && Number.isFinite(numeric)) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedQuote({ priceOz, priceGram, stamp, source, bid, ask, fetchedAt }) {
  const received = new Date().toISOString();
  return {
    ok: true,
    instrument: 'XAU/USD',
    source,
    price_usd_oz: priceOz,
    price_usd_gram: priceGram || priceOz / OZ,
    bid_usd_oz: positive(bid),
    ask_usd_oz: positive(ask),
    price_as_of: new Date(stamp).toISOString(),
    provider_timestamp: new Date(stamp).toISOString(),
    received_at: received,
    fetched_at: fetchedAt || received,
    connection_status: 'fallback',
    freshness_state: 'fresh',
    data_state: 'fresh',
    fallback: true
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const failures = [];
  const now = Date.now();

  try {
    const payload = await timed('https://xaus.com/api/v1/spot?currency=USD&unit=gram&compact=1');
    const priceOz = positive(payload && payload.spot_usd_oz);
    const priceGram = positive(payload && payload.per_gram_usd) ||
      positive(payload && payload.xau && payload.xau.price);
    const stamp = timestamp(payload && (
      payload.price_as_of ||
      (payload.data_state && payload.data_state.as_of) ||
      payload.updated_at
    ));
    const age = stamp === null ? Infinity : now - stamp;
    const providerState = payload && payload.data_state && payload.data_state.status;
    const reportedAge = Number(payload && payload.data_state && payload.data_state.age_seconds);
    const ageValid = Number.isFinite(age) && age >= -30000 && age <= MAX_AGE_MS;
    const reportedAgeValid = !Number.isFinite(reportedAge) || reportedAge * 1000 <= MAX_AGE_MS;
    if (priceOz && priceGram && ageValid && reportedAgeValid && providerState === 'fresh') {
      return json(res, 200, normalizedQuote({
        priceOz,
        priceGram,
        stamp,
        source: 'xaus',
        bid: payload.bid,
        ask: payload.ask,
        fetchedAt: payload.fetched_at
      }));
    }
    failures.push('XAUS quote missing, stale, or invalid');
  } catch (error) {
    failures.push('XAUS: ' + String(error && error.message || error));
  }

  try {
    const payload = await timed('https://api.gold-api.com/price/XAU');
    const priceOz = positive(payload && payload.price);
    const stamp = timestamp(payload && (payload.updatedAt || payload.updated_at || payload.timestamp));
    const age = stamp === null ? Infinity : now - stamp;
    if (priceOz && Number.isFinite(age) && age >= -30000 && age <= MAX_AGE_MS) {
      return json(res, 200, normalizedQuote({
        priceOz,
        priceGram: priceOz / OZ,
        stamp,
        source: 'gold-api',
        bid: payload.bid,
        ask: payload.ask,
        fetchedAt: payload.fetchedAt
      }));
    }
    failures.push('Gold API quote missing, stale, or invalid');
  } catch (error) {
    failures.push('Gold API: ' + String(error && error.message || error));
  }

  return json(res, 503, {
    ok: false,
    instrument: 'XAU/USD',
    connection_status: 'unavailable',
    freshness_state: 'unavailable',
    error: 'No fresh gold quote is currently available',
    failures,
    fetched_at: new Date().toISOString()
  });
}
