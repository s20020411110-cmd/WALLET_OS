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
| 20261107153427 | wallet_os_app_integration_v2 | Versioned RPCs and schema fields required by browser sync and local-data import |
| 20261107153651 | wallet_os_wallet_types_v1 | Adds the savings wallet type used by the application |
| 20261107155054 | wallet_os_gold_subtypes_v1 | Persists the gold item subtype used by the investment UI |
| 20261107173757 | wallet_os_sync_integrity_hardening_v1 | Composite unique key for budget upserts, unique per-user request keys, serialized goal/loan creation retries |
| 20261108031600 | personal_wallet_transaction_corrections_v1 | Audited transaction reversal and replacement editing workflow |
| 20261108033136 | wallet_os_budget_names_and_account_links_v1 | Custom budget names and owner-validated account links |
| 20261108033953 | wallet_os_cloud_management_actions_v1 | Cloud metadata management actions through dedicated RPCs |
| 20261108034311 | wallet_os_cloud_management_security_hardening_v1 | Hardened owner checks and cloud management permissions |
| 20261108040613 | wallet_os_permanent_investment_deletion_v1 | Atomic permanent deletion of investment assets and linked history |
| 20261108041330 | wallet_os_transaction_correction_link_indexes_v1 | Indexes for transaction correction/reversal relationships |
| 20261108045807 | wallet_os_transaction_rpc_invoker_hardening_v1 | Public transaction edit/void wrappers changed to SECURITY INVOKER |
| 20261108051315 | wallet_os_duplicate_request_indexes_cleanup_v1 | Removed four identical redundant request-key indexes |
| 20261108061254 | wallet_os_manual_finance_categories_v1 | Owner-scoped manual income/expense categories with matching ledger accounts |
| 20261108062844 | wallet_os_loans_linked_to_wallet_accounts_v1 | Atomic loan/receivable origination linked to the selected wallet and journal |

The first six migrations remain recorded in the hosted Supabase migration history; the eight later hardening/correction migrations above are tracked as SQL files in this repository. The exact SQL for the original core schema migrations has not yet been exported into supabase/migrations/. Preserve hosted history as the source of truth and export/review the original SQL before future local schema work rather than reconstructing it from this guide.

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

Income and expense categories are user-extensible. A manual category is created with its own owner-scoped category row and corresponding income/expense ledger account; browser clients do not receive direct category insert privileges.

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

Current Supabase Security Advisor: the only remaining warning is auth_leaked_password_protection (leaked-password checks disabled). This is a project-level Supabase Auth setting, not a database table setting; enable it in Authentication → Password Security when the project plan supports it. The connected database tools do not expose this Auth configuration action.
Current Performance Advisor: all four duplicate_index warnings were removed by wallet_os_duplicate_request_indexes_cleanup_v1. Informational unused_index notices remain; do not drop those indexes until representative workload/query-plan evidence shows they are unnecessary. The project has limited usage history, so these counters are not sufficient to justify further index removal.

The sync-integrity hardening migration was verified by reading back all four new unique indexes and checking that goal/loan v2 creation functions contain the owner-scoped advisory lock. A follow-up full Auth-backed integration SQL test was not completed in the final pass because the database execution gateway blocked the long test request; the prior rollback-only ledger integration test remains the successful full-posting test evidence.

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
- New loan and receivable records use `create_loan_from_account_v1`: the user selects the cash/bank wallet, and a single journal posting both opens the liability/receivable and updates that wallet. Borrowed proceeds debit the wallet and credit the loan liability; money lent debits the receivable and credits the selected wallet. The operation is idempotent and checks wallet ownership, currency and available funds for receivables.
- Income sources and expense categories are entered as text; a matching owner-scoped category is resolved before posting. Manual budget expense categories use the same category registry, and spending is matched by category ID plus an optional selected wallet.
- Wallet, savings goal, loan and investment creation use their dedicated RPCs; the UI forms now write to Supabase when signed in.
- Gold asset subtypes (bars, coins, jewelry, sovereigns, scrap, other) are persisted in `investment_assets.asset_subtype` through `create_investment_asset_v3`.
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
- Cloud transaction edits use an audited reversal-and-replacement flow; cloud deletions use the owner-scoped audited void RPC. Both require explicit confirmation in the UI.
- Gold/investment asset deletion is a dedicated permanent-delete workflow that removes linked investment history atomically; the gold page does not offer archive/restore actions.
- Loan, goal, account and budget metadata changes route through dedicated cloud-management RPCs rather than the former cloud-blocked message.
- Market quote persistence/ingestion for the FX and gold quote tables is not yet wired to Supabase; current prices continue through the app's API paths.

### Deployment status
- Repository: `s20020411110-cmd/WALLET_OS`, branch `main`; linked to the separate Vercel project `wallet-os`.
- Stable production URL: https://wallet-os-s20020411110-8096.vercel.app
- Production deployment is intentionally deferred during the current QA/fix pass; no deployment, rollback, or Vercel project-setting change is part of this work.
- Last verified production deployment at the prior QA checkpoint was source commit `53863bc3a2b0008c89f3886c6a61e41935939d51`. Current `main` is newer; do not treat the latest source fixes as live until a later deployment is permitted and verified.

## Remaining integration work

- In Supabase Dashboard → Authentication → URL Configuration, set Site URL to `https://wallet-os-s20020411110-8096.vercel.app` and add this origin to allowed Redirect URLs. The Auth configuration cannot be updated by the currently connected Supabase tools.
- Enable Leaked Password Protection in Authentication → Password Security (HaveIBeenPwned/Pwned Passwords check). Supabase documents this as a Pro-plan-and-above feature; the current connected tools cannot change project Auth configuration. Re-run the Security Advisor after enabling it.
- Verify an actual user sign-up/sign-in through the deployed URL after the redirect allowlist is configured, including email-confirmation behavior.
- Verify a representative local-data import against a real user account and reconcile opening balances before removing or archiving the device copy.
- Build audited update/archive RPCs for cloud entity metadata and a correction/reversal workflow for posted transactions.
- Add trusted server-side ingestion for the exchange-rate and gold-quote tables; the app currently continues to fetch/retain market quotes through its existing browser/API path.
- Validate the production project's access-protection and domain settings with the intended users.

## Finance workflow integration — 2026-11-08

- Account creation accepts the current cash/bank/e-wallet opening balance. Cloud opening balances are posted through the existing double-entry `create_wallet_account` RPC; local balances include the saved opening amount plus subsequent transactions.
- Income sources and expense categories are manually entered. Custom category creation is persisted through `create_finance_category`, creates the corresponding ledger account, returns the existing owner category on a repeated name, and is queued/remapped safely when offline.
- Budgets accept a manually entered name and expense category. Optional wallet links constrain the spending calculation to that account; otherwise the budget tracks all matching-category spending.
- Loans payable and receivables are separated into distinct pages. Both retain a common payment ledger, but origination is now account-linked through `create_loan_from_account_v1` so borrowed proceeds increase the selected wallet while receivables reduce the wallet that funds the lending.
- Transaction history and loan cards show the loan/receivable origination movement. That originating journal row is protected from generic transaction editing/deletion, which would otherwise detach the cash movement from the loan principal.
- A rollback-only Supabase integration check created a temporary wallet with 100 SAR, originated a 40 SAR borrowed loan and a 20 SAR receivable, then verified a 120 SAR wallet balance, a 40 SAR loan liability, a 20 SAR receivable asset and balanced journal entries. A separate rollback-only check verified manual expense-category creation, its ledger account and duplicate-name reuse. Both enclosing transactions were rolled back; no test records were left behind.
- The new loan RPC wrapper is SECURITY INVOKER; its private implementation is SECURITY DEFINER with an empty search path, checks `auth.uid()` ownership and has execute grants only for authenticated users. The anon role has no execute permission.
- Deployment remains deliberately deferred. These source and database changes are not claimed to be live on the production URL.

## QA and integrity follow-up — 2026-11-08

- Latest `main` QA commit: `cf95742f87b18654b8c97a2485b9dcf27e8280e1`. GitHub Actions test run `42450033861` passed 66/66 tests (0 failed, 0 skipped). Android Debug APK run `42450033918` completed successfully, including artifact verification and upload (artifact `13605291363`, SHA-256 `00dad613938ceb289d18c312d4708d496bd685216fe4722589e4bb4380e67acb`). This is a Debug build, not a signed Release package.
- Application regression tests include actual helper execution for a synthetic multi-currency ledger scenario: transfers, savings deposit/withdrawal, borrowed and receivable debt payments, archived liability inclusion in gross assets, and a partial investment sale with weighted-average cost.
- HTML escaping regression coverage checks form values, profile fields, CSV preview, recent transactions, and the final alert renderer. Loan/goal alert text is escaped at the final HTML sink.
- Supabase currently reports 16/16 public tables with RLS enabled and FORCE RLS enabled. Public/anonymous roles have no direct financial-table SELECT access. Both financial summary views use security_invoker=true.
- No public SECURITY DEFINER routines remain. User-callable privileged financial routines are in private, set an empty search_path, and do not grant execution to anon. The public transaction edit/void wrappers are SECURITY INVOKER.
- Four identical standalone unique indexes were removed; the original per-user unique indexes remain. The Performance Advisor no longer reports duplicate indexes. Informational unused-index notices remain for later workload-based review.
- A read-only integrity pass found no unbalanced journal entries, transactions missing journal postings, journal entries without lines, investment trades missing transaction links, or invalid open investment quantities at the time checked. No real financial records were inserted, edited, or deleted for tests.
- The Supabase Security Advisor still reports one external Auth setting warning: leaked-password protection is disabled. This project-level Auth setting must be enabled in the Supabase Dashboard (and may require Pro plan or above); it cannot be changed by ordinary Postgres SQL through the connected tools.
- No production deployment was performed as part of this QA follow-up.
