-- Reproducible source for the permanent investment edit/delete migration.
-- The migration was applied in Supabase as 20261108040613.
CREATE OR REPLACE FUNCTION private.assert_journal_balanced()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_entry_id uuid;
  v_count integer;
  v_debit numeric;
  v_credit numeric;
begin
  v_entry_id := coalesce(new.journal_entry_id, old.journal_entry_id);

  -- A full transaction deletion cascades its journal entry and lines.
  -- Ignore the deferred line trigger once the parent entry itself no longer exists.
  if not exists (
    select 1 from public.journal_entries
    where id = v_entry_id
  ) then
    return null;
  end if;

  select count(*), coalesce(sum(base_debit), 0), coalesce(sum(base_credit), 0)
    into v_count, v_debit, v_credit
  from public.journal_lines
  where journal_entry_id = v_entry_id;

  if v_count < 2 or abs(v_debit - v_credit) > 0.00000001 then
    raise exception 'Unbalanced journal entry %: debit %, credit %', v_entry_id, v_debit, v_credit
      using errcode = '23514';
  end if;
  return null;
end;
$function$


CREATE OR REPLACE FUNCTION private.update_investment_asset_impl(p_id uuid, p_name text, p_asset_subtype text, p_karat smallint, p_current_unit_price numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_name text;
  v_updated_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_id is null then
    raise exception 'An investment asset ID is required' using errcode = '22023';
  end if;

  v_name := pg_catalog.btrim(coalesce(p_name, ''));
  if v_name = '' or pg_catalog.length(v_name) > 100 then
    raise exception 'Asset name must contain 1 to 100 characters' using errcode = '22023';
  end if;
  if p_asset_subtype not in ('bars','coins','jewelry','sovereigns','scrap','other') then
    raise exception 'Invalid gold subtype' using errcode = '22023';
  end if;
  if p_karat not in (18,21,22,24) then
    raise exception 'Invalid gold karat' using errcode = '22023';
  end if;
  if p_current_unit_price is not null and p_current_unit_price < 0 then
    raise exception 'Current unit price cannot be negative' using errcode = '22023';
  end if;

  update public.investment_assets
     set name = v_name,
         asset_subtype = p_asset_subtype,
         karat = p_karat,
         current_unit_price = p_current_unit_price,
         is_archived = false
   where id = p_id
     and user_id = v_user_id
   returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'Investment asset not found or not owned by this account' using errcode = 'P0002';
  end if;

  insert into public.audit_logs(user_id, action, entity_type, entity_id, details)
  values (
    v_user_id,
    'investment_asset_updated',
    'investment_asset',
    v_updated_id,
    pg_catalog.jsonb_build_object('asset_subtype', p_asset_subtype, 'karat', p_karat)
  );

  return pg_catalog.jsonb_build_object('ok', true, 'action', 'update', 'investment_id', v_updated_id);
end;
$function$


CREATE OR REPLACE FUNCTION public.update_investment_asset(p_id uuid, p_name text, p_asset_subtype text, p_karat smallint, p_current_unit_price numeric)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.update_investment_asset_impl($1, $2, $3, $4, $5);
$function$


grant usage on schema private to authenticated;

revoke all on function private.update_investment_asset_impl(uuid,text,text,smallint,numeric) from public;
revoke all on function private.update_investment_asset_impl(uuid,text,text,smallint,numeric) from anon;
grant execute on function private.update_investment_asset_impl(uuid,text,text,smallint,numeric) to authenticated;
revoke all on function public.update_investment_asset(uuid,text,text,smallint,numeric) from public;
revoke all on function public.update_investment_asset(uuid,text,text,smallint,numeric) from anon;
grant execute on function public.update_investment_asset(uuid,text,text,smallint,numeric) to authenticated;


CREATE OR REPLACE FUNCTION private.delete_investment_data_impl(p_investment_id uuid, p_transaction_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_asset public.investment_assets%rowtype;
  v_selected public.transactions%rowtype;
  v_transaction_ids uuid[] := array[]::uuid[];
  v_deleted_transaction_count integer := 0;
  v_deleted_trade_count integer := 0;
  v_deleted_journal_entry_count integer := 0;
  v_deleted_audit_count integer := 0;
  v_deleted_ledger_count integer := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_investment_id is null then
    raise exception 'An investment asset ID is required' using errcode = '22023';
  end if;

  select *
    into v_asset
  from public.investment_assets
  where id = p_investment_id
    and user_id = v_user_id
  for update;

  if not found then
    raise exception 'Investment asset not found or not owned by this account' using errcode = 'P0002';
  end if;

  if p_transaction_id is not null then
    select *
      into v_selected
    from public.transactions
    where id = p_transaction_id
      and user_id = v_user_id
      and related_investment_id = p_investment_id
      and type in ('investment_buy','investment_sell')
      and not is_voided
    for update;

    if not found then
      raise exception 'Investment transaction not found, already corrected, or not owned by this account' using errcode = 'P0002';
    end if;
  end if;

  -- Include opening-balance postings and any journal posting that touched this asset's
  -- dedicated ledger account, not only the visible buy/sell rows.
  with recursive linked(id) as (
    select t.id
    from public.transactions t
    where t.user_id = v_user_id
      and (
        (p_transaction_id is null and t.related_investment_id = p_investment_id)
        or (p_transaction_id is not null and t.id = p_transaction_id)
      )

    union

    select it.transaction_id
    from public.investment_trades it
    where p_transaction_id is null
      and it.user_id = v_user_id
      and it.investment_id = p_investment_id

    union

    select je.transaction_id
    from public.journal_entries je
    join public.journal_lines jl
      on jl.journal_entry_id = je.id
     and jl.user_id = v_user_id
    where p_transaction_id is null
      and je.user_id = v_user_id
      and jl.ledger_account_id = v_asset.ledger_account_id

    union

    select x.linked_id
    from public.transactions t
    join linked l
      on t.user_id = v_user_id
     and (
       t.id = l.id
       or t.reversal_of = l.id
       or t.replacement_transaction_id = l.id
     )
    cross join lateral (
      values (t.id), (t.reversal_of), (t.replacement_transaction_id)
    ) as x(linked_id)
    where x.linked_id is not null
  )
  select coalesce(pg_catalog.array_agg(id), array[]::uuid[])
    into v_transaction_ids
  from linked;

  if p_transaction_id is not null and v_selected.type = 'investment_buy' and exists (
    select 1
    from public.investment_trades original_trade
    join public.investment_trades later_trade
      on later_trade.investment_id = original_trade.investment_id
     and later_trade.user_id = v_user_id
     and later_trade.side = 'sell'
     and later_trade.occurred_on >= v_selected.occurred_on
     and not (later_trade.transaction_id = any(v_transaction_ids))
    where original_trade.user_id = v_user_id
      and original_trade.transaction_id = p_transaction_id
      and original_trade.side = 'buy'
  ) then
    raise exception 'This investment purchase has later sales. Delete or correct those sales first.'
      using errcode = '23514';
  end if;

  select pg_catalog.count(*)::integer
    into v_deleted_trade_count
  from public.investment_trades
  where user_id = v_user_id
    and (
      (p_transaction_id is null and investment_id = p_investment_id)
      or transaction_id = any(v_transaction_ids)
    );

  select pg_catalog.count(*)::integer
    into v_deleted_journal_entry_count
  from public.journal_entries
  where user_id = v_user_id
    and transaction_id = any(v_transaction_ids);

  delete from public.audit_logs
  where user_id = v_user_id
    and (entity_id = p_investment_id or entity_id = any(v_transaction_ids));
  get diagnostics v_deleted_audit_count = row_count;

  delete from public.investment_trades
  where user_id = v_user_id
    and (
      (p_transaction_id is null and investment_id = p_investment_id)
      or transaction_id = any(v_transaction_ids)
    );

  -- The two self-referencing links are RESTRICT constraints. Clear only links
  -- inside the fully collected correction/reversal chain before deleting it.
  update public.transactions
     set reversal_of = null,
         replacement_transaction_id = null
   where user_id = v_user_id
     and id = any(v_transaction_ids);

  delete from public.transactions
  where user_id = v_user_id
    and id = any(v_transaction_ids);
  get diagnostics v_deleted_transaction_count = row_count;

  if p_transaction_id is not null then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'delete_transaction',
      'investment_id', p_investment_id,
      'deleted_transaction_count', v_deleted_transaction_count,
      'deleted_trade_count', v_deleted_trade_count,
      'deleted_journal_entry_count', v_deleted_journal_entry_count,
      'deleted_audit_count', v_deleted_audit_count,
      'deleted_transaction_ids', pg_catalog.to_jsonb(v_transaction_ids)
    );
  end if;

  delete from public.investment_assets
  where id = p_investment_id
    and user_id = v_user_id;

  if not found then
    raise exception 'Investment asset could not be deleted' using errcode = 'P0002';
  end if;

  delete from public.ledger_accounts
  where id = v_asset.ledger_account_id
    and user_id = v_user_id
    and not exists (
      select 1 from public.journal_lines
      where ledger_account_id = v_asset.ledger_account_id and user_id = v_user_id
    )
    and not exists (
      select 1 from public.wallet_accounts
      where ledger_account_id = v_asset.ledger_account_id and user_id = v_user_id
    )
    and not exists (
      select 1 from public.categories
      where ledger_account_id = v_asset.ledger_account_id and user_id = v_user_id
    )
    and not exists (
      select 1 from public.savings_goals
      where ledger_account_id = v_asset.ledger_account_id and user_id = v_user_id
    )
    and not exists (
      select 1 from public.loans
      where ledger_account_id = v_asset.ledger_account_id and user_id = v_user_id
    )
    and not exists (
      select 1 from public.investment_assets
      where ledger_account_id = v_asset.ledger_account_id and user_id = v_user_id
    );
  get diagnostics v_deleted_ledger_count = row_count;

  if v_deleted_ledger_count <> 1 then
    raise exception 'The investment ledger account still has linked records. No data was deleted.'
      using errcode = '23503';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'delete_asset',
    'investment_id', p_investment_id,
    'deleted_transaction_count', v_deleted_transaction_count,
    'deleted_trade_count', v_deleted_trade_count,
    'deleted_journal_entry_count', v_deleted_journal_entry_count,
    'deleted_audit_count', v_deleted_audit_count,
    'deleted_transaction_ids', pg_catalog.to_jsonb(v_transaction_ids)
  );
end;
$function$


CREATE OR REPLACE FUNCTION public.delete_investment_data(p_investment_id uuid, p_transaction_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.delete_investment_data_impl($1, $2);
$function$


revoke all on function private.delete_investment_data_impl(uuid,uuid) from public;
revoke all on function private.delete_investment_data_impl(uuid,uuid) from anon;
grant execute on function private.delete_investment_data_impl(uuid,uuid) to authenticated;
revoke all on function public.delete_investment_data(uuid,uuid) from public;
revoke all on function public.delete_investment_data(uuid,uuid) from anon;
grant execute on function public.delete_investment_data(uuid,uuid) to authenticated;
