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
