'use strict';

const {
  INSTRUMENT,
  normalizeTwelveDataPrice,
  normalizeXausQuote,
  normalizeGoldApiQuote,
  isFresh,
  backoffDelay
} = require('./market-data');

const TOPIC = 'wallet-os-gold-market';
const PRICE_EVENT = 'price';
const STATUS_EVENT = 'status';
const DEFAULT_STALE_MS = 60_000;
const FALLBACK_INTERVAL_MS = 30_000;
const SNAPSHOT_INTERVAL_MS = 120_000;
const LEASE_SECONDS = 30;
const LEASE_RENEW_MS = 10_000;

class GoldMarketWorker {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.fetch = options.fetch || globalThis.fetch;
    this.WebSocket = options.WebSocket || globalThis.WebSocket;
    this.now = options.now || Date.now;
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.setInterval = options.setInterval || setInterval;
    this.clearInterval = options.clearInterval || clearInterval;
    this.log = options.log || console;
    this.workerId = options.workerId || (globalThis.crypto && crypto.randomUUID
      ? crypto.randomUUID() : 'gold-worker-' + this.now() + '-' + Math.random().toString(16).slice(2));
    this.supabaseUrl = String(this.env.SUPABASE_URL || '').replace(/\/+$/, '');
    this.supabaseSecret = this.env.SUPABASE_SECRET_KEY || '';
    this.twelveDataKey = this.env.TWELVE_DATA_API_KEY || '';
    this.twelveDataApproved = this.env.TWELVE_DATA_USAGE_APPROVED === 'true';
    this.staleAfterMs = Number(this.env.MARKET_STALE_AFTER_MS) || DEFAULT_STALE_MS;
    this.fallbackIntervalMs = Number(this.env.MARKET_FALLBACK_INTERVAL_MS) || FALLBACK_INTERVAL_MS;
    this.snapshotIntervalMs = Number(this.env.MARKET_SNAPSHOT_INTERVAL_MS) || SNAPSHOT_INTERVAL_MS;
    this.ws = null;
    this.primaryStatus = this.twelveDataKey && this.twelveDataApproved ? 'disconnected' :
      (this.twelveDataKey ? 'license-not-confirmed' : 'credentials-missing');
    this.subscriptionActive = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.fallbackTimer = null;
    this.leaseTimer = null;
    this.healthServer = null;
    this.connectTimer = null;
    this.statusTimer = null;
    this.started = false;
    this.stopping = false;
    this.leaseHeld = false;
    this.latestQuote = null;
    this.activeSource = null;
    this.lastPrimaryTickMs = 0;
    this.lastProviderTimestampMs = 0;
    this.lastFingerprint = '';
    this.lastSnapshotMs = 0;
    this.lastSnapshotFingerprint = '';
    this.lastStatusBroadcast = 0;
    this.fallbackBusy = false;
    this.metrics = { received: 0, accepted: 0, duplicates: 0, outOfOrder: 0, malformed: 0, broadcastsFailed: 0, snapshotsWritten: 0 };
  }

  async request(path, options = {}) {
    const response = await this.fetch(this.supabaseUrl + path, {
      ...options,
      signal: options.signal || AbortSignal.timeout(8_000),
      headers: {
        apikey: this.supabaseSecret,
        Authorization: 'Bearer ' + this.supabaseSecret,
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error('Supabase HTTP ' + response.status + (text ? ': ' + text.slice(0, 160) : ''));
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async rpc(name, body) {
    return this.request('/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  async acquireLease() {
    const result = await this.rpc('acquire_gold_market_lease', {
      p_worker_id: this.workerId,
      p_lease_seconds: LEASE_SECONDS
    });
    this.leaseHeld = result === true || (Array.isArray(result) && result[0] === true);
    return this.leaseHeld;
  }

  async renewLease() {
    if (!this.leaseHeld || this.stopping) return false;
    try {
      const result = await this.rpc('renew_gold_market_lease', {
        p_worker_id: this.workerId,
        p_lease_seconds: LEASE_SECONDS
      });
      const renewed = result === true || (Array.isArray(result) && result[0] === true);
      if (!renewed) {
        this.log.error('[gold-worker] lease lost; closing upstream socket');
        await this.stop('lease-lost');
      }
      return renewed;
    } catch (error) {
      this.log.error('[gold-worker] lease renewal failed:', error.message);
      await this.stop('lease-renewal-failed');
      return false;
    }
  }

  async releaseLease() {
    if (!this.leaseHeld) return;
    this.leaseHeld = false;
    try {
      await this.rpc('release_gold_market_lease', { p_worker_id: this.workerId });
    } catch (error) {
      this.log.error('[gold-worker] lease release failed:', error.message);
    }
  }

  statusPayload(overrides = {}) {
    const quote = this.latestQuote;
    const now = this.now();
    let freshness = quote ? quote.freshness_state : 'unavailable';
    let connection = 'unavailable';
    if (quote && isFresh(quote, now, this.staleAfterMs)) {
      connection = quote.source === 'twelvedata-ws' ? 'live' : 'fallback';
      freshness = 'fresh';
    } else if (quote) {
      connection = 'stale';
      freshness = 'stale';
    } else if (this.primaryStatus === 'connecting' || this.primaryStatus === 'subscribing') {
      connection = this.primaryStatus;
    }
    if (overrides.connection_status) connection = overrides.connection_status;
    if (overrides.freshness_state) freshness = overrides.freshness_state;
    return {
      instrument: INSTRUMENT,
      connection_status: connection,
      freshness_state: freshness,
      source: quote ? quote.source : null,
      price_usd_oz: quote ? quote.price_usd_oz : null,
      price_usd_gram: quote ? quote.price_usd_gram : null,
      bid_usd_oz: quote ? quote.bid_usd_oz : null,
      ask_usd_oz: quote ? quote.ask_usd_oz : null,
      provider_timestamp: quote ? quote.provider_timestamp : null,
      received_at: quote ? quote.received_at : null,
      server_time: new Date(now).toISOString(),
      primary_status: this.primaryStatus,
      subscription_active: this.subscriptionActive,
      message: overrides.message || null
    };
  }

  async broadcast(event, payload) {
    const path = '/realtime/v1/api/broadcast/' + encodeURIComponent(TOPIC) +
      '/events/' + encodeURIComponent(event) + '?private=true';
    try {
      await this.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return true;
    } catch (error) {
      this.metrics.broadcastsFailed += 1;
      this.log.error('[gold-worker] Realtime broadcast failed:', error.message);
      return false;
    }
  }

  async publishStatus(overrides = {}) {
    const payload = this.statusPayload(overrides);
    const now = this.now();
    if (!overrides.force && now - this.lastStatusBroadcast < 4_000) return;
    this.lastStatusBroadcast = now;
    await this.broadcast(STATUS_EVENT, payload);
  }

  async persistSnapshot(quote, force = false) {
    if (!quote || !isFresh(quote, this.now(), this.staleAfterMs)) return false;
    const fingerprint = [quote.source, quote.provider_timestamp, quote.price_usd_oz].join('|');
    const now = this.now();
    if (!force && fingerprint === this.lastSnapshotFingerprint) return false;
    if (!force && this.lastSnapshotMs && now - this.lastSnapshotMs < this.snapshotIntervalMs) return false;

    const row = {
      metal_code: 'XAU',
      currency_code: 'USD',
      price_per_troy_ounce: quote.price_usd_oz,
      price_per_gram: quote.price_usd_gram,
      source: quote.source,
      data_state: 'fresh',
      observed_at: quote.provider_timestamp,
      fetched_at: quote.received_at,
      metadata: {
        instrument: INSTRUMENT,
        bid_usd_oz: quote.bid_usd_oz,
        ask_usd_oz: quote.ask_usd_oz,
        connection_status: quote.connection_status,
        provider_timestamp: quote.provider_timestamp,
        server_received_at: quote.received_at
      }
    };

    try {
      const response = await this.fetch(this.supabaseUrl + '/rest/v1/gold_price_quotes', {
        method: 'POST',
        signal: AbortSignal.timeout(8_000),
        headers: {
          apikey: this.supabaseSecret,
          Authorization: 'Bearer ' + this.supabaseSecret,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify(row)
      });
      if (!response.ok) throw new Error('Supabase quote insert HTTP ' + response.status);
      this.lastSnapshotMs = now;
      this.lastSnapshotFingerprint = fingerprint;
      this.metrics.snapshotsWritten += 1;
      return true;
    } catch (error) {
      this.log.error('[gold-worker] historical snapshot failed:', error.message);
      return false;
    }
  }

  async acceptQuote(quote, options = {}) {
    if (!quote) return false;
    const providerMs = Date.parse(quote.provider_timestamp);
    if (!Number.isFinite(providerMs)) {
      this.metrics.malformed += 1;
      return false;
    }
    const fingerprint = [quote.source, quote.provider_timestamp, quote.price_usd_oz].join('|');
    if (fingerprint === this.lastFingerprint) {
      this.metrics.duplicates += 1;
      return false;
    }
    if (providerMs < this.lastProviderTimestampMs) {
      this.metrics.outOfOrder += 1;
      return false;
    }
    if (providerMs === this.lastProviderTimestampMs && this.latestQuote &&
        Number(this.latestQuote.price_usd_oz) === Number(quote.price_usd_oz)) {
      this.metrics.duplicates += 1;
      return false;
    }
    this.lastFingerprint = fingerprint;
    this.lastProviderTimestampMs = providerMs;
    this.latestQuote = quote;
    this.activeSource = quote.source;
    if (quote.source === 'twelvedata-ws') {
      this.lastPrimaryTickMs = this.now();
      this.primaryStatus = 'subscribed';
      this.subscriptionActive = true;
      this.reconnectAttempt = 0;
    }
    this.metrics.accepted += 1;
    if (options.publish !== false) await this.broadcast(PRICE_EVENT, quote);
    await this.persistSnapshot(quote);
    await this.publishStatus({ force: true });
    return true;
  }

  isPrimaryFresh() {
    return !!(this.latestQuote &&
      this.latestQuote.source === 'twelvedata-ws' &&
      this.latestQuote.freshness_state === 'fresh' &&
      this.lastPrimaryTickMs &&
      this.now() - this.lastPrimaryTickMs <= this.staleAfterMs);
  }

  connectPrimary() {
    if (this.stopping || !this.twelveDataKey || !this.twelveDataApproved || !this.WebSocket) return;
    if (this.ws) return;
    this.primaryStatus = 'connecting';
    this.subscriptionActive = false;
    this.publishStatus({ force: true }).catch(() => {});
    const url = 'wss://ws.twelvedata.com/v1/quotes/price?apikey=' + encodeURIComponent(this.twelveDataKey);
    let socket;
    try {
      socket = new this.WebSocket(url);
    } catch (error) {
      this.primaryStatus = 'error';
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    this.connectTimer = this.setTimeout(() => {
      if (this.ws === socket && !this.subscriptionActive) {
        this.primaryStatus = 'connect-timeout';
        try { socket.close(); } catch (_) {}
      }
    }, 15_000);

    socket.addEventListener('open', () => {
      if (this.ws !== socket || this.stopping) return;
      this.primaryStatus = 'subscribing';
      try {
        socket.send(JSON.stringify({ action: 'subscribe', params: { symbols: INSTRUMENT } }));
      } catch (error) {
        this.log.error('[gold-worker] subscribe send failed:', error.message);
        try { socket.close(); } catch (_) {}
        return;
      }
      this.heartbeatTimer = this.setInterval(() => {
        if (this.ws === socket && socket.readyState === 1) {
          try { socket.send(JSON.stringify({ action: 'heartbeat' })); }
          catch (_) { try { socket.close(); } catch (_) {} }
        }
      }, 10_000);
      this.publishStatus({ force: true }).catch(() => {});
    });

    socket.addEventListener('message', event => {
      if (this.ws !== socket || this.stopping) return;
      this.handlePrimaryMessage(event && event.data);
    });

    socket.addEventListener('error', () => {
      if (this.ws === socket) {
        this.primaryStatus = 'error';
        this.publishStatus({ force: true }).catch(() => {});
      }
    });

    socket.addEventListener('close', () => {
      if (this.connectTimer) this.clearTimeout(this.connectTimer);
      this.connectTimer = null;
      if (this.ws !== socket) return;
      this.ws = null;
      this.subscriptionActive = false;
      this.primaryStatus = 'disconnected';
      if (this.heartbeatTimer) this.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.publishStatus({ force: true }).catch(() => {});
      this.runFallback(true).catch(() => {});
      this.scheduleReconnect();
    });
  }

  handlePrimaryMessage(raw) {
    this.metrics.received += 1;
    let message;
    try {
      message = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw));
    } catch (_) {
      this.metrics.malformed += 1;
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.metrics.malformed += 1;
      return;
    }
    if (message.event === 'subscribe-status') {
      const success = Array.isArray(message.success) &&
        message.success.some(item => String(item && item.symbol || '').toUpperCase() === INSTRUMENT);
      const failure = Array.isArray(message.fails) &&
        message.fails.some(item => String(item && item.symbol || '').toUpperCase() === INSTRUMENT);
      if (message.status === 'ok' && success && !failure) {
        if (this.connectTimer) this.clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.primaryStatus = 'subscribed';
        this.subscriptionActive = true;
        this.publishStatus({ force: true }).catch(() => {});
      } else {
        this.primaryStatus = 'subscription-failed';
        this.subscriptionActive = false;
        this.log.error('[gold-worker] XAU/USD subscription was rejected');
        if (this.ws) { try { this.ws.close(); } catch (_) {} }
      }
      return;
    }
    if (message.event === 'price') {
      const quote = normalizeTwelveDataPrice(message, { now: this.now(), staleAfterMs: this.staleAfterMs });
      if (!quote) {
        this.metrics.malformed += 1;
        return;
      }
      this.acceptQuote(quote).catch(error => this.log.error('[gold-worker] tick processing failed:', error.message));
      return;
    }
    if (message.event === 'error' || message.status === 'error' || message.code || message.message) {
      this.primaryStatus = 'provider-error';
      this.subscriptionActive = false;
      this.log.error('[gold-worker] provider status/error received');
      this.publishStatus({ force: true, message: 'Twelve Data connection reported an error' }).catch(() => {});
      if (this.ws) { try { this.ws.close(); } catch (_) {} }
    }
  }

  scheduleReconnect() {
    if (this.stopping || !this.twelveDataKey || !this.twelveDataApproved || this.reconnectTimer) return;
    const delay = backoffDelay(this.reconnectAttempt++, { baseMs: 1_000, maxMs: 30_000, jitter: 0.2 });
    this.reconnectTimer = this.setTimeout(() => {
      this.reconnectTimer = null;
      this.connectPrimary();
    }, delay);
  }

  async fetchJson(url) {
    const response = await this.fetch(url, {
      signal: AbortSignal.timeout(7_000),
      headers: { Accept: 'application/json', 'User-Agent': 'WALLET-OS-Gold-Market/1.0' }
    });
    if (!response.ok) throw new Error('Provider HTTP ' + response.status);
    return response.json();
  }

  async runFallback(force = false) {
    if (this.stopping || this.fallbackBusy) return null;
    if (!force && this.isPrimaryFresh()) return this.latestQuote;
    this.fallbackBusy = true;
    const candidates = [];
    try {
      try {
        const payload = await this.fetchJson('https://xaus.com/api/v1/spot?currency=USD&unit=gram&compact=1');
        const quote = normalizeXausQuote(payload, { now: this.now(), staleAfterMs: 180_000 });
        if (quote) candidates.push(quote);
      } catch (error) {
        this.log.warn('[gold-worker] XAUS fallback unavailable:', error.message);
      }
      const xaus = candidates.find(q => q.source === 'xaus' && isFresh(q, this.now(), 180_000));
      if (xaus && (!this.latestQuote || Date.parse(xaus.provider_timestamp) >= Date.parse(this.latestQuote.provider_timestamp))) {
        await this.acceptQuote(xaus);
        return xaus;
      }

      try {
        const payload = await this.fetchJson('https://api.gold-api.com/price/XAU');
        const quote = normalizeGoldApiQuote(payload, { now: this.now(), staleAfterMs: 180_000 });
        if (quote) candidates.push(quote);
      } catch (error) {
        this.log.warn('[gold-worker] Gold API fallback unavailable:', error.message);
      }
      const goldApi = candidates.find(q => q.source === 'gold-api' && isFresh(q, this.now(), 180_000));
      if (goldApi && (!this.latestQuote || Date.parse(goldApi.provider_timestamp) >= Date.parse(this.latestQuote.provider_timestamp))) {
        await this.acceptQuote(goldApi);
        return goldApi;
      }

      const staleCandidate = candidates
        .filter(q => q && q.freshness_state === 'stale')
        .sort((a, b) => Date.parse(b.provider_timestamp) - Date.parse(a.provider_timestamp))[0];
      if (staleCandidate && (!this.latestQuote ||
          Date.parse(staleCandidate.provider_timestamp) > Date.parse(this.latestQuote.provider_timestamp))) {
        this.latestQuote = staleCandidate;
        this.activeSource = staleCandidate.source;
        this.lastFingerprint = [staleCandidate.source, staleCandidate.provider_timestamp, staleCandidate.price_usd_oz].join('|');
        this.lastProviderTimestampMs = Date.parse(staleCandidate.provider_timestamp);
        await this.broadcast(PRICE_EVENT, staleCandidate);
      }
      const old = this.latestQuote;
      if (old) {
        old.freshness_state = 'stale';
        await this.publishStatus({ force: true, connection_status: 'stale', freshness_state: 'stale' });
      } else {
        await this.publishStatus({ force: true, connection_status: 'unavailable', freshness_state: 'unavailable' });
      }
      return null;
    } finally {
      this.fallbackBusy = false;
    }
  }

  startHealthServer() {
    const http = require('node:http');
    const host = this.env.MARKET_WORKER_HEALTH_HOST || '127.0.0.1';
    const port = Number(this.env.MARKET_WORKER_HEALTH_PORT) || 8787;
    this.healthServer = http.createServer((req, res) => {
      if (req.method !== 'GET' || (req.url !== '/healthz' && req.url !== '/readyz')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"not found"}');
        return;
      }
      const ready = this.leaseHeld && !this.stopping;
      const body = {
        ok: req.url === '/healthz' ? !this.stopping : ready,
        leader: this.leaseHeld,
        primary_status: this.primaryStatus,
        connection_status: this.statusPayload().connection_status,
        freshness_state: this.statusPayload().freshness_state,
        source: this.latestQuote ? this.latestQuote.source : null,
        last_tick_at: this.latestQuote ? this.latestQuote.provider_timestamp : null
      };
      res.writeHead(body.ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    });
    this.healthServer.listen(port, host);
  }

  async start() {
    if (this.started) return;
    if (!this.supabaseUrl || !this.supabaseSecret) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required');
    if (!this.fetch || !this.WebSocket) throw new Error('Node.js 22+ with global WebSocket and fetch is required');
    this.started = true;
    const acquired = await this.acquireLease();
    if (!acquired) {
      this.started = false;
      throw new Error('Another WALLET OS gold market worker currently holds the distributed lease');
    }
    this.startHealthServer();
    this.leaseTimer = this.setInterval(() => this.renewLease().catch(() => {}), LEASE_RENEW_MS);
    this.statusTimer = this.setInterval(() => this.publishStatus({ force: true }).catch(() => {}), 15_000);
    this.fallbackTimer = this.setInterval(() => this.runFallback().catch(error =>
      this.log.error('[gold-worker] fallback cycle failed:', error.message)), this.fallbackIntervalMs);
    await this.publishStatus({ force: true });
    this.connectPrimary();
    await this.runFallback(true);
  }

  async stop(reason = 'shutdown') {
    if (this.stopping) return;
    this.stopping = true;
    this.primaryStatus = reason;
    if (this.reconnectTimer) this.clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) this.clearInterval(this.heartbeatTimer);
    if (this.fallbackTimer) this.clearInterval(this.fallbackTimer);
    if (this.leaseTimer) this.clearInterval(this.leaseTimer);
    if (this.statusTimer) this.clearInterval(this.statusTimer);
    if (this.connectTimer) this.clearTimeout(this.connectTimer);
    this.reconnectTimer = this.heartbeatTimer = this.fallbackTimer = this.leaseTimer = this.statusTimer = this.connectTimer = null;
    const socket = this.ws;
    this.ws = null;
    if (socket) { try { socket.close(1000, 'worker shutdown'); } catch (_) {} }
    if (this.healthServer) await new Promise(resolve => this.healthServer.close(() => resolve()));
    await this.publishStatus({ force: true, connection_status: 'unavailable', message: reason });
    await this.releaseLease();
    this.started = false;
  }
}

module.exports = { GoldMarketWorker, TOPIC, PRICE_EVENT, STATUS_EVENT, DEFAULT_STALE_MS };
