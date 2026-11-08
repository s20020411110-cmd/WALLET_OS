# WALLET OS Gold Market Worker

This is a separate, persistent Node.js process. It is deliberately not a Vercel Function: the worker owns one long-lived Twelve Data WebSocket and uses a Supabase distributed lease so overlapping deployments cannot create a second upstream connection.

## Data flow

`Twelve Data WebSocket (XAU/USD)` → `market-worker` → private Supabase Realtime Broadcast (`wallet-os-gold-market`) → authenticated WALLET OS browsers.

When the primary stream is not subscribed or its last valid tick becomes stale, the worker checks XAUS first and Gold API second. It never blends prices. The active source, provider time, server receive time and freshness state accompany each message. Invalid, duplicate and out-of-order provider messages are ignored.

Price ticks are broadcast immediately. The existing `public.gold_price_quotes` table is written only for a changed valid price and no more often than `MARKET_SNAPSHOT_INTERVAL_MS` (default: 120 seconds). A market tick never posts a wallet transaction, journal entry or balance update.

## Runtime

- Node.js 22.2 or later (built-in `WebSocket` and `fetch`; no third-party runtime packages).
- One continuously running container/process. Keep a single replica; the Supabase lease is a second guard against duplicate workers.
- The worker's local `/healthz` and `/readyz` endpoints bind to loopback by default.

Copy `.env.example` to a private environment file and set `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. The Supabase secret key must remain server-side. Set `TWELVE_DATA_API_KEY` only after obtaining a valid key. The worker deliberately refuses to open the Twelve Data socket unless `TWELVE_DATA_USAGE_APPROVED=true`.

Run locally:

```sh
cd market-worker
cp .env.example .env
# Fill the server-only secrets in .env; do not commit it.
node index.js
```

Container build from the repository root:

```sh
docker build -f market-worker/Dockerfile -t wallet-os-gold-market-worker market-worker
```

Run the image with the variables from `.env.example` supplied by the host's secret manager. Run exactly one replica. Do not put secrets in image build arguments or source control. The optional health endpoint should remain private to the container host.

## Required Supabase setup

Apply `supabase/wallet_os_gold_realtime_channel_v1.sql`, then `wallet_os_gold_realtime_rls_initplan_v1.sql` and `wallet_os_gold_worker_lease_coalesce_fix_v1.sql`. It creates a server-only lease table and RPCs and grants authenticated users read-only access to the private gold broadcast topic. The worker's secret key is the only credential allowed to call lease RPCs or insert historical quote rows.

In Supabase Dashboard → Realtime → Settings, disable **Allow public access** so private-channel authorization is enforced globally. The application subscribes with `config.private=true`; only authenticated sessions can receive this topic. No browser client may send to the topic.

## Twelve Data entitlement gate

The official Twelve Data commodity catalog lists `XAU/USD` as Gold Spot. Its price WebSocket costs one WS credit per subscribed symbol. Basic/Grow individual subscriptions are limited to trial symbols; full instrument streaming is available on Pro individual and Venture business plans. That streaming entitlement is not sufficient by itself for public production display: Twelve Data's current usage policy says individual plans are personal/internal and prohibit third-party commercial display or redistribution. Business plans support commercial display subject to exchange licensing; non-US data needs additional approval and redistribution requires a separate agreement.

Do not set `TWELVE_DATA_USAGE_APPROVED=true` until the Twelve Data account owner has verified the XAU/USD subscription and obtained the required commercial, regional and redistribution rights for the exact WALLET OS use case. Until the gate is approved, the worker continues using XAUS and Gold API fallbacks.

For planning only, Twelve Data's current Business pricing page lists Venture at $499/month on monthly billing or $4,990/year (equivalent to $414/month on annual billing), with 2,500 WS credits on the displayed tier. The personal Pro individual plan currently lists 500+ WS credits depending on the selected tier, but it is not a substitute for business display/redistribution rights. Confirm the exact quote, exchange terms and XAU/USD entitlement with Twelve Data sales before purchase; pricing and licensing can change. One shared XAU/USD subscription consumes one WS credit, not one per WALLET OS user. Sources: https://twelvedata.com/pricing-business and https://support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage.
## Reliability and data rules

- One connection is held per elected worker. Subscribe once to XAU/USD; send the documented heartbeat every 10 seconds.
- Reconnect uses capped exponential backoff with jitter. A failed or stale primary never overwrites a newer valid quote.
- Quotes are normalized to USD/troy ounce and USD/gram using 31.1034768 grams per troy ounce.
- Bid/ask are nullable when the provider does not return them.
- The last valid quote remains available as stale when upstream data is unavailable; it is never silently labelled live.
- Fallback source order is XAUS then Gold API. The frontend uses its existing Vercel fallback route when the Realtime worker heartbeat is absent.

## Deployment boundary

The WALLET OS Vercel project currently uses the Hobby plan and its environment-variable listing is empty. Vercel Functions cannot provide this persistent upstream WebSocket process. This change does not provision a paid host or create a worker deployment. A persistent container host (existing or newly approved) and the server-only credentials above are still required before live streaming can run in production.
