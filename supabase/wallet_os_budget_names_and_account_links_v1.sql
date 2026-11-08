-- WALLET OS: user-entered budget names and optional wallet account links.
-- Existing budgets are preserved; old rows receive their matching expense-category name.
alter table public.budgets
  add column if not exists budget_name text,
  add column if not exists account_id uuid;

update public.budgets b
set budget_name = coalesce(nullif(trim(b.budget_name), ''), c.name, 'ميزانية')
from public.categories c
where c.id = b.category_id
  and c.user_id = b.user_id
  and (b.budget_name is null or trim(b.budget_name) = '');

update public.budgets
set budget_name = 'ميزانية'
where budget_name is null or trim(budget_name) = '';

alter table public.budgets
  alter column budget_name set default 'ميزانية',
  alter column budget_name set not null;

alter table public.budgets
  add constraint budgets_budget_name_check
  check (length(trim(budget_name)) between 1 and 80);

alter table public.budgets
  add constraint budgets_account_id_fkey
  foreign key (account_id) references public.wallet_accounts(id) on delete set null;

create index if not exists idx_budgets_user_account
  on public.budgets(user_id, account_id);

drop policy if exists budgets_insert_own on public.budgets;
create policy budgets_insert_own on public.budgets
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.categories c
      where c.id = budgets.category_id
        and c.user_id = (select auth.uid())
        and c.direction = 'expense'
    )
    and (
      account_id is null
      or exists (
        select 1 from public.wallet_accounts a
        where a.id = budgets.account_id
          and a.user_id = (select auth.uid())
          and not a.is_archived
      )
    )
  );

drop policy if exists budgets_update_own on public.budgets;
create policy budgets_update_own on public.budgets
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.categories c
      where c.id = budgets.category_id
        and c.user_id = (select auth.uid())
        and c.direction = 'expense'
    )
    and (
      account_id is null
      or exists (
        select 1 from public.wallet_accounts a
        where a.id = budgets.account_id
          and a.user_id = (select auth.uid())
          and not a.is_archived
      )
    )
  );
