# WALLET OS — Supabase database

## Hosted project

- Project: wallet-os
- Supabase project ref: lwefgfogrxavxczrznjl
- Region: ap-southeast-1 (Singapore)
- PostgreSQL: 17.11
- State at initial schema build: empty Auth user set and empty financial tables

This is a dedicated project for WALLET OS. It is not the Supabase project used by the portfolio site.

## Applied hosted migrations

| Version | Name | Purpose |
| --- | --- | --- |
| 20261107152547 | wallet_os_finance_core_v1 | Core finance schema, ledger, RPCs, RLS, starter currencies/categories, views |
| 20261107152753 | wallet_os_concurrency_and_fk_indexes_v1 | Transaction row locks, same-currency FX fallback, profile base-currency guard, foreign-key indexes |

The two migrations are visible in the hosted Supabase migration history. Their SQL has not yet been pulled into this repository as local migration files; when the Supabase CLI is available, export the hosted history into supabase/migrations/ and commit that exact output before making future schema changes from a local branch.

## Data model

- profiles: one-to-one with Supabase Auth users, preferred base currency, language and time zone.
- currencies: supported currency codes and minor-unit metadata.
- ledger_accounts: per-user chart of accounts (assets, liabilities, equity, income and expenses).
- wallet_accounts: cash, bank, mobile, card and other user wallets.
- categories: user-owned income and expense categories; starter categories are added at sign-up.
- transactions: business transaction metadata, original currency, FX snapshots and idempotency fingerprint.
- journal_entries / journal_lines: double-entry postings in original and base-currency values.
- savings_goals, loans, investment_assets, investment_trades: related financial products and positions.
- budgets: monthly limits by expense category.
- exchange_rate_quotes, gold_price_quotes: source-tagged market observations, timestamps and freshness status.
- audit_logs: owner-scoped record of financial mutations.

Views:
- wallet_account_balances calculates wallet balance from journal lines.
- monthly_financial_summary provides transaction totals by month, currency and type.

All financial quantities use PostgreSQL NUMERIC, not floating-point types.

## RPC contract

Authenticated clients should use these functions instead of writing directly to ledger or transaction tables:

- create_wallet_account(...)
- create_savings_goal(...)
- create_loan(...)
- create_investment_asset(...)
- post_financial_transaction(...)

Transaction types accepted by the posting RPC:
income, expense, transfer, saving_deposit, saving_withdrawal, loan_disbursement, loan_payment, investment_buy, and investment_sell.

The posting RPC:
1. Requires a valid Auth identity and an owner-scoped account/product reference.
2. Rejects missing/invalid FX snapshots for the user's base currency.
3. Uses an owner-scoped idempotency key and rejects reuse with a different payload.
4. Locks wallet/product rows while validating and posting.
5. Checks insufficient available funds for applicable outgoing transactions.
6. Writes transaction metadata and journal lines in one database transaction.
7. Balances every journal entry in base currency using a deferred constraint trigger.
8. Writes an audit event after successful posting.

## Security posture

- RLS is enabled and forced on all 16 public tables.
- User-owned rows use auth.uid() ownership predicates.
- Public/anonymous access is revoked from the financial tables.
- Authenticated clients have read-only access to the ledger and financial records; budgets and selected profile fields have limited write grants.
- Journal and transaction mutations are routed through authenticated RPCs.
- Public RPC wrappers are SECURITY INVOKER; privileged implementation functions are placed in the non-exposed private schema and require auth.uid().
- Views use security_invoker=true.
- No service-role or secret key belongs in browser code or source control.

## Validation record

A transaction-scoped integration test with temporary synthetic Auth identities was executed and rolled back. It successfully tested:

- User profile/category bootstrap and wallet creation with opening balance.
- Income and expense postings.
- Same-currency and cross-currency transfers.
- Idempotent retry returning the original transaction.
- Savings deposit and withdrawal.
- Borrowed-loan disbursement and repayment.
- Investment purchase and partial sale.
- Insufficient-funds rejection without a persisted transaction.
- Rejection of an idempotency key reused with a different payload.
- No direct authenticated insert/update privilege on journal lines.
- Cross-user RLS isolation.

Successful test summary: 11 posted transactions, 11 journal entries, 24 journal lines; base-currency debits equalled credits. The enclosing test transaction was rolled back, leaving no test users or test finance records behind.

Post-change Supabase Security Advisor: no findings.
Post-change Performance Advisor: only informational unused-index findings on the empty database; the earlier unindexed-foreign-key findings were addressed.
Post-change Health Advisor: no findings.

## Not yet connected to the browser app

The current index.html still stores its data in localStorage and has a local-only sign-in mechanism. The database does not automatically sync with those local records yet. The next implementation phase must add Supabase Auth and a deliberate local-data import/reconciliation flow before treating WALLET OS as a persistent multi-user app.
