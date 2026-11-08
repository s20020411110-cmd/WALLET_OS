begin;

-- The original owner-scoped request-key unique indexes already enforce these
-- constraints. The uq_* copies are byte-for-byte equivalent standalone indexes
-- and are not owned by constraints, so remove only the redundant copies.
drop index if exists public.uq_budgets_owner_category_period;
drop index if exists public.uq_investment_assets_request;
drop index if exists public.uq_loans_request;
drop index if exists public.uq_savings_goals_request;

commit;
