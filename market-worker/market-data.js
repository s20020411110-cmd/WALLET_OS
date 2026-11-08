'use strict';

const INSTRUMENT = 'XAU/USD';
const TROY_OUNCE_GRAMS = 31.1034768;
const DEFAULT_STALE_MS = 60_000;
const MAX_FUTURE_SKEW_MS = 30_000;

function positiveNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d{9,13}(?:\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      return n < 1e12 ? n * 1000 : n;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function quoteBase({ price, timestamp, receivedAt, source, bid, ask, connectionStatus, now, staleAfterMs }) {
  const priceOz = positiveNumber(price);
  const providerMs = timestampMs(timestamp);
  if (!priceOz || !providerMs) return null;
  if (providerMs > now + MAX_FUTURE_SKEW_MS) return null;

  const bidValue = bid === null || bid === undefined || bid === '' ? null : positiveNumber(bid);
  const askValue = ask === null || ask === undefined || ask === '' ? null : positiveNumber(ask);
  if ((bid !== null && bid !== undefined && bid !== '' && !bidValue) ||
      (ask !== null && ask !== undefined && ask !== '' && !askValue)) return null;
  if (bidValue && askValue && askValue < bidValue) return null;

  const ageMs = Math.max(0, now - providerMs);
  const freshness = ageMs <= staleAfterMs ? 'fresh' : 'stale';
  return {
    instrument: INSTRUMENT,
    price_usd_oz: priceOz,
    price_usd_gram: priceOz / TROY_OUNCE_GRAMS,
    bid_usd_oz: bidValue,
    ask_usd_oz: askValue,
    provider_timestamp: iso(providerMs),
    provider_timestamp_ms: providerMs,
    received_at: iso(receivedAt),
    source,
    connection_status: connectionStatus,
    freshness_state: freshness,
    age_ms: ageMs
  };
}

function normalizeTwelveDataPrice(message, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const staleAfterMs = options.staleAfterMs || DEFAULT_STALE_MS;
  let payload = message;
  if (typeof message === 'string') {
    try { payload = JSON.parse(message); } catch (_) { return null; }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.event !== 'price') return null;
  if (String(payload.symbol || '').trim().toUpperCase() !== INSTRUMENT) return null;

  return quoteBase({
    price: payload.price,
    timestamp: payload.timestamp,
    receivedAt: now,
    source: 'twelvedata-ws',
    bid: payload.bid,
    ask: payload.ask,
    connectionStatus: 'live',
    now,
    staleAfterMs
  });
}

function normalizeXausQuote(payload, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const state = payload.data_state && payload.data_state.status;
  if (state === 'unavailable') return null;
  const price = positiveNumber(payload.spot_usd_oz || (payload.xau && payload.xau.price));
  const timestamp = payload.price_as_of || (payload.data_state && payload.data_state.as_of) || payload.updated_at;
  const quote = quoteBase({
    price,
    timestamp,
    receivedAt: now,
    source: 'xaus',
    bid: payload.bid,
    ask: payload.ask,
    connectionStatus: 'fallback',
    now,
    staleAfterMs: options.staleAfterMs || 180_000
  });
  if (!quote) return null;
  if (state !== 'fresh' || (Number.isFinite(Number(payload.data_state && payload.data_state.age_seconds)) &&
      Number(payload.data_state.age_seconds) * 1000 > (options.staleAfterMs || 180_000))) {
    quote.freshness_state = 'stale';
  }
  quote.provider_reported_state = state || 'unknown';
  return quote;
}

function normalizeGoldApiQuote(payload, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const quote = quoteBase({
    price: payload.price,
    timestamp: payload.updatedAt || payload.updated_at || payload.timestamp,
    receivedAt: now,
    source: 'gold-api',
    bid: payload.bid,
    ask: payload.ask,
    connectionStatus: 'fallback',
    now,
    staleAfterMs: options.staleAfterMs || 180_000
  });
  if (quote) quote.provider_reported_state = 'unknown';
  return quote;
}

function isFresh(quote, now = Date.now(), staleAfterMs = DEFAULT_STALE_MS) {
  if (!quote || !(Number(quote.price_usd_oz) > 0)) return false;
  const stamp = timestampMs(quote.provider_timestamp);
  return !!stamp && stamp <= now + MAX_FUTURE_SKEW_MS &&
    now - stamp <= staleAfterMs && quote.freshness_state === 'fresh';
}

function backoffDelay(attempt, options = {}) {
  const baseMs = options.baseMs || 1_000;
  const maxMs = options.maxMs || 30_000;
  const jitter = options.jitter === undefined ? 0.2 : options.jitter;
  const random = options.random || Math.random;
  const exponent = Math.max(0, Math.min(12, Number(attempt) || 0));
  const capped = Math.min(maxMs, baseMs * (2 ** exponent));
  return Math.round(capped * (1 - jitter + (2 * jitter * random())));
}

module.exports = {
  INSTRUMENT,
  TROY_OUNCE_GRAMS,
  positiveNumber,
  timestampMs,
  normalizeTwelveDataPrice,
  normalizeXausQuote,
  normalizeGoldApiQuote,
  isFresh,
  backoffDelay
};
