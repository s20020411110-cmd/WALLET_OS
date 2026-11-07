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

## Browser integration

The current main-branch browser app is connected to this project using the pinned Supabase JavaScript client and the publishable key only.

### Authentication
- Email/password sign-up and sign-in use Supabase Auth.
- The browser restores a persisted Auth session at startup.
- Sign-out revokes the local session; password reset uses Supabase Auth email.
- A local-only guest mode remains available, but it does not synchronize to Supabase.
- The former local password-hash login is no longer used to authenticate cloud accounts.


### Supabase Auth URL configuration

In Supabase Dashboard → Authentication → URL Configuration, set the Site URL to:

`https://wallet-os-s20020411110-8096.vercel.app`

Add that same origin (and any custom production domain later adopted) to the allowed Redirect URLs. The app sets email-confirmation and password-reset redirects to the current application origin. This setting cannot be changed through the connected Supabase database tools used for this implementation, so verify it in the dashboard before relying on email confirmation/reset links.

### Cloud data mapping
- Accounts are loaded from `wallet_account_balances`; balances are derived from journal lines.
- Activity, savings goals, loans, investment positions/trades, categories and budgets are loaded from the authenticated user's rows.
- Income/expense/transfer/savings/loan/investment operations use `post_financial_transaction`.
- Wallet, savings goal, loan and investment creation use their dedicated RPCs.
- Budgets use an owner-scoped upsert with period type/week fields.
- Profile name, base currency and language sync to the user's `profiles` row.

### Local import and recovery
- When a cloud user has no financial records and local data exists, the app asks whether to import that device's data.
- A JSON safety copy is written to localStorage under `wos_pre_cloud_backup_<user-id>` before import.
- Import state is tracked separately per user; deterministic legacy idempotency keys allow a partial import to be retried without duplicating completed items.
- The import maps local account IDs to cloud UUIDs and reconstructs all linked records and journal postings.
- Existing records with incompatible currency relationships or missing links stop the import with an explicit error rather than silently changing the financial meaning.
- Users should retain the local browser profile/safety copy until they have reconciled the imported balances and transaction history.

### UI boundaries
- Cloud journal entries are immutable through the old edit/delete controls. They are hidden/blocked for cloud accounts; an accounting correction workflow is required for changes.
- Some metadata management actions (such as renaming/removing already-synced cloud entities) remain disabled until dedicated audited update/archive RPCs are added.
- Market quote persistence/ingestion for the FX and gold quote tables is not yet wired to the existing client-side market feeds.

### Deployment status
- The repository is linked to the separate Vercel project `wallet-os` (team `s20020411110-8096`).
- Latest production deployment `dpl_36hP8Hw5U1MfgmhLzCXgViMeHc9L` is `READY` for commit `a1723019e4c9ae0ef49f9867f7792765df31ee0c`; the latest code update is redeploying automatically after each main-branch push.
- Production deployment URLs are public; SSO protection remains enabled for preview deployments.
- Project URL: https://wallet-os-s20020411110-8096.vercel.app

## Remaining integration work

- Verify an actual user sign-up/sign-in through the deployed URL, including the configured email-confirmation behavior.
- Verify a representative local-data import against a real user account and reconcile opening balances before removing or archiving the device copy.
- Build audited update/archive RPCs for cloud entity metadata and a correction/reversal workflow for posted transactions.
- Add trusted server-side ingestion for the exchange-rate and gold-quote tables; the app currently continues to fetch/retain market quotes through its existing browser/API path.
- Validate the production project's access-protection and domain settings with the intended users.
