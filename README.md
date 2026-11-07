# WALLET OS — AI API integration (v3)

This package adds an API-backed financial assistant to WALLET OS.

## What's included

- AI settings inside **Settings → AI configuration**.
- Provider choices: OpenAI, OpenRouter, and Groq.
- User-entered model ID and API key.
- A real connection test from the Settings page.
- AI chat with a compact financial snapshot computed from the user's current WALLET OS data.
- A same-origin Vercel serverless function at `/api/ai` that forwards requests to the selected provider.

## Run locally

Do not open `index.html` using `file://`; the API route will not exist in that mode.

1. Install Node.js 20 or newer.
2. From this folder, run `npx vercel dev`.
3. Open the local URL printed by Vercel.
4. Open WALLET OS → Settings → AI configuration.
5. Choose the provider, enter the exact model ID from that provider's dashboard, enter your API key, and save.
6. Press **Test connection**, then open the AI assistant and send a question.

## Deploy

Deploy this folder as a Vercel project. The `api/ai.js` function is deployed as a serverless route, and `index.html` is served as the app.

## Market data sources

- Aden exchange rates are fetched server-side from [exrye.com/aden](https://exrye.com/aden) through `/api/exchange-rates`. The route reads the source's buy/sell table and validates all eight listed currencies before returning data.
- The app keeps the source buy and sell values for display. For indicative currency conversion, it derives the USD-based rates using the midpoint of each buy/sell pair. These are indicative market rates, not executable transfer quotes.
- Exchange rates are refreshed once per Aden calendar day when the app is open. The last successful table is retained in the user's local app data if the source is temporarily unavailable. The Exchange page includes a manual refresh control and displays the fetch time.
- Gold spot is requested from XAUS first (`/api/v1/spot?currency=USD&unit=gram&compact=1`), which returns the troy-ounce and gram values with freshness metadata. The app falls back to Gold API's `/price/XAU` endpoint if XAUS is unavailable. Gold is polled while the app is open; prices are not dealer buy/sell quotes.
- Gold data providers: [XAUS API](https://xaus.com/api/) and [Gold API](https://gold-api.com/docs). The app retains the provider timestamp and marks stale data rather than presenting it as fresh.

## Validation

Run the exchange-rate parser tests with Node.js 20 or newer:

```sh
node --test tests/exchange-rates.test.js
```


## API key handling

- The API key is **not** embedded in the HTML, project ZIP, or `localStorage`.
- The key remains in the current page's JavaScript memory and is sent over HTTPS to this same-origin `/api/ai` function when a request is made.
- The function does not write the key to a database, environment variable, or log; it forwards the request to the chosen provider.
- Refreshing or closing the page clears the key. Enter it again in Settings for a new session.
- This is a personal Bring-Your-Own-Key flow, not a full multi-user secrets vault. The key is still present in the user's browser session while the page is open. For a public multi-user deployment, connect real Supabase Auth and implement server-side per-user secret storage/rotation before launch. Do not use a shared owner key for all users.

## Supported request format

The backend uses the OpenAI-compatible Chat Completions request shape (`POST /chat/completions`) for the three listed providers. Model IDs and billing are controlled by the provider account. Check the provider dashboard for the exact current model ID and usage costs.

## Data sent to the model

The assistant receives a compact snapshot: totals by period, net worth, account balances, top income/expense categories, savings goals, budgets, and aggregate operation count. It does not send the full raw transaction list or transaction notes. The provider still processes the snapshot and chat messages, so only enable the integration with a provider you trust.
