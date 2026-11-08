-- Cloud management actions for loans, savings goals, investment assets, wallets and budgets.
-- All writes are scoped to auth.uid(); ledger transactions are never deleted here.
alter table public.savings_goals
  add column if not exists is_paused boolean not null default false;

create or replace function public.manage_financial_item(
  p_entity text,
  p_id uuid,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_name text;
  v_num numeric;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_id is null then raise exception 'A record ID is required'; end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then raise exception 'Invalid payload'; end if;
  if p_action not in ('update','archive','restore','pause','delete') then raise exception 'Unsupported action'; end if;

  if p_entity = 'loan' then
    if p_action = 'update' then
      if p_payload ? 'name' then
        v_name := pg_catalog.btrim(p_payload->>'name');
        if v_name = '' or pg_catalog.length(v_name) > 120 then raise exception 'Loan name must contain 1 to 120 characters'; end if;
      end if;
      if p_payload ? 'interest_rate' then
        v_num := nullif(p_payload->>'interest_rate','')::numeric;
        if v_num is null or v_num < 0 then raise exception 'Interest rate must be zero or greater'; end if;
      end if;
      if p_payload ? 'installment_amount' then
        v_num := nullif(p_payload->>'installment_amount','')::numeric;
        if v_num is null or v_num < 0 then raise exception 'Installment amount must be zero or greater'; end if;
      end if;
      if p_payload ? 'installment_count' then
        v_num := nullif(p_payload->>'installment_count','')::numeric;
        if v_num is null or v_num < 0 or v_num <> pg_catalog.trunc(v_num) then raise exception 'Installment count must be a non-negative integer'; end if;
      end if;
      update public.loans
         set name = case when p_payload ? 'name' then v_name else name end,
             interest_rate = case when p_payload ? 'interest_rate' then (p_payload->>'interest_rate')::numeric else interest_rate end,
             start_date = case when p_payload ? 'start_date' then nullif(p_payload->>'start_date','')::date else start_date end,
             due_date = case when p_payload ? 'due_date' then nullif(p_payload->>'due_date','')::date else due_date end,
             installment_amount = case when p_payload ? 'installment_amount' then (p_payload->>'installment_amount')::numeric else installment_amount end,
             installment_count = case when p_payload ? 'installment_count' then (p_payload->>'installment_count')::integer else installment_count end
       where id = p_id and user_id = v_user_id and not is_archived;
    elsif p_action in ('archive','restore') then
      update public.loans set is_archived = (p_action = 'archive')
       where id = p_id and user_id = v_user_id;
    else raise exception 'Unsupported loan action';
    end if;

  elsif p_entity = 'goal' then
    if p_action = 'update' then
      if p_payload ? 'name' then
        v_name := pg_catalog.btrim(p_payload->>'name');
        if v_name = '' or pg_catalog.length(v_name) > 100 then raise exception 'Goal name must contain 1 to 100 characters'; end if;
      end if;
      if p_payload ? 'target_amount' then
        v_num := nullif(p_payload->>'target_amount','')::numeric;
        if v_num is null or v_num <= 0 then raise exception 'Goal target must be greater than zero'; end if;
      end if;
      update public.savings_goals
         set name = case when p_payload ? 'name' then v_name else name end,
             target_amount = case when p_payload ? 'target_amount' then (p_payload->>'target_amount')::numeric else target_amount end,
             target_date = case when p_payload ? 'target_date' then nullif(p_payload->>'target_date','')::date else target_date end
       where id = p_id and user_id = v_user_id and not is_archived;
    elsif p_action in ('archive','restore') then
      update public.savings_goals set is_archived = (p_action = 'archive')
       where id = p_id and user_id = v_user_id;
    elsif p_action = 'pause' then
      if not (p_payload ? 'is_paused') then raise exception 'Pause state is required'; end if;
      update public.savings_goals set is_paused = (p_payload->>'is_paused')::boolean
       where id = p_id and user_id = v_user_id and not is_archived;
    else raise exception 'Unsupported goal action';
    end if;

  elsif p_entity = 'investment' then
    if p_action = 'update' then
      if p_payload ? 'name' then
        v_name := pg_catalog.btrim(p_payload->>'name');
        if v_name = '' or pg_catalog.length(v_name) > 100 then raise exception 'Asset name must contain 1 to 100 characters'; end if;
      end if;
      if p_payload ? 'asset_subtype' and p_payload->>'asset_subtype' not in ('bars','coins','jewelry','sovereigns','scrap','other') then raise exception 'Invalid asset subtype'; end if;
      if p_payload ? 'karat' then
        v_num := (p_payload->>'karat')::numeric;
        if v_num not in (18,21,22,24) then raise exception 'Invalid gold karat'; end if;
      end if;
      if p_payload ? 'current_unit_price' then
        v_num := nullif(p_payload->>'current_unit_price','')::numeric;
        if v_num is not null and v_num < 0 then raise exception 'Current unit price cannot be negative'; end if;
      end if;
      update public.investment_assets
         set name = case when p_payload ? 'name' then v_name else name end,
             asset_subtype = case when p_payload ? 'asset_subtype' then p_payload->>'asset_subtype' else asset_subtype end,
             karat = case when p_payload ? 'karat' then (p_payload->>'karat')::smallint else karat end,
             current_unit_price = case when p_payload ? 'current_unit_price' then nullif(p_payload->>'current_unit_price','')::numeric else current_unit_price end
       where id = p_id and user_id = v_user_id and not is_archived;
    elsif p_action in ('archive','restore') then
      update public.investment_assets set is_archived = (p_action = 'archive')
       where id = p_id and user_id = v_user_id;
    else raise exception 'Unsupported investment action';
    end if;

  elsif p_entity = 'wallet' then
    if p_action = 'update' then
      if p_payload ? 'name' then
        v_name := pg_catalog.btrim(p_payload->>'name');
        if v_name = '' or pg_catalog.length(v_name) > 80 then raise exception 'Account name must contain 1 to 80 characters'; end if;
      end if;
      if p_payload ? 'kind' and p_payload->>'kind' not in ('cash','bank','mobile','card','savings','other') then raise exception 'Invalid account type'; end if;
      update public.wallet_accounts
         set name = case when p_payload ? 'name' then v_name else name end,
             kind = case when p_payload ? 'kind' then p_payload->>'kind' else kind end,
             allow_overdraft = case when p_payload ? 'allow_overdraft' then (p_payload->>'allow_overdraft')::boolean else allow_overdraft end
       where id = p_id and user_id = v_user_id and not is_archived;
    elsif p_action = 'archive' then
      if (select pg_catalog.count(*) from public.wallet_accounts where user_id = v_user_id and not is_archived) <= 1 then
        raise exception 'The last active account cannot be archived';
      end if;
      update public.wallet_accounts set is_archived = true where id = p_id and user_id = v_user_id;
    elsif p_action = 'restore' then
      update public.wallet_accounts set is_archived = false where id = p_id and user_id = v_user_id;
    else raise exception 'Unsupported wallet action';
    end if;

  elsif p_entity = 'budget' then
    if p_action = 'delete' then
      delete from public.budgets where id = p_id and user_id = v_user_id;
    else raise exception 'Unsupported budget action';
    end if;
  else
    raise exception 'Unsupported financial record type';
  end if;

  if not found then raise exception 'The record was not found, is not owned by this account, or is no longer editable'; end if;
  return pg_catalog.jsonb_build_object('ok', true, 'entity', p_entity, 'action', p_action, 'id', p_id);
end;
$function$;

revoke all on function public.manage_financial_item(text, uuid, text, jsonb) from public;
revoke all on function public.manage_financial_item(text, uuid, text, jsonb) from anon;
grant execute on function public.manage_financial_item(text, uuid, text, jsonb) to authenticated;
