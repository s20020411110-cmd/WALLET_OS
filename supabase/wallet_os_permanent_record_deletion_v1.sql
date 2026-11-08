-- WALLET OS: owner-scoped permanent deletion and loan-origination corrections.
-- Public RPC wrappers use SECURITY INVOKER. Private implementations use SECURITY DEFINER
-- with an empty search_path and enforce auth.uid() before touching owner-owned rows.
begin;

CREATE OR REPLACE FUNCTION private.activate_owned_financial_records_impl()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := auth.uid();
  v_total integer := 0;
  v_count integer := 0;
begin
  if v_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;

  update public.wallet_accounts set is_archived = false
   where user_id = v_user and is_archived = true;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  update public.loans set is_archived = false
   where user_id = v_user and is_archived = true;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  update public.savings_goals set is_archived = false
   where user_id = v_user and is_archived = true;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  update public.investment_assets set is_archived = false
   where user_id = v_user and is_archived = true;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  return v_total;
end;
$function$;

CREATE OR REPLACE FUNCTION public.activate_owned_financial_records()
 RETURNS integer
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.activate_owned_financial_records_impl();
$function$;

CREATE OR REPLACE FUNCTION private.delete_financial_item_impl(p_entity text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := auth.uid();
  v_ledger uuid;
  v_related_loan_ids uuid[] := array[]::uuid[];
  v_transaction_ids uuid[] := array[]::uuid[];
  v_loan_id uuid;
  v_related_ledger uuid;
  v_deleted_transactions integer := 0;
begin
  if v_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_id is null then raise exception 'A record ID is required' using errcode = '22023'; end if;
  if p_entity not in ('loan','goal','wallet','budget') then
    raise exception 'Unsupported financial record type' using errcode = '22023';
  end if;

  if p_entity = 'budget' then
    delete from public.budgets where id = p_id and user_id = v_user;
    if not found then raise exception 'Budget not found or not owned by this account' using errcode = 'P0002'; end if;
    return pg_catalog.jsonb_build_object('ok',true,'entity',p_entity,'action','delete','id',p_id);
  elsif p_entity = 'loan' then
    select ledger_account_id into v_ledger
      from public.loans where id = p_id and user_id = v_user for update;
  elsif p_entity = 'goal' then
    select ledger_account_id into v_ledger
      from public.savings_goals where id = p_id and user_id = v_user for update;
  elsif p_entity = 'wallet' then
    select ledger_account_id into v_ledger
      from public.wallet_accounts where id = p_id and user_id = v_user for update;
    if found and (select count(*) from public.wallet_accounts where user_id = v_user) <= 1 then
      raise exception 'At least one wallet account must remain' using errcode = '23514';
    end if;
    update public.budgets
       set account_id = null
     where user_id = v_user and account_id = p_id;

    select coalesce(
      pg_catalog.array_agg(distinct t.related_loan_id) filter (where t.related_loan_id is not null),
      array[]::uuid[]
    )
      into v_related_loan_ids
      from public.transactions t
     where t.user_id = v_user
       and t.type = 'loan_disbursement'
       and t.source_account_id = p_id;
  end if;

  if v_ledger is null and p_entity <> 'wallet' then
    raise exception 'Record not found or not owned by this account' using errcode = 'P0002';
  end if;
  if v_ledger is null and p_entity = 'wallet' then
    raise exception 'Wallet account not found or not owned by this account' using errcode = 'P0002';
  end if;

  with recursive linked(id) as (
    select t.id
      from public.transactions t
     where t.user_id = v_user
       and (
         (p_entity = 'loan' and t.related_loan_id = p_id)
         or (p_entity = 'goal' and t.related_goal_id = p_id)
         or (p_entity = 'wallet' and (
              t.source_account_id = p_id
              or t.destination_account_id = p_id
              or t.related_loan_id = any(v_related_loan_ids)
         ))
         or exists (
              select 1
                from public.journal_entries je
                join public.journal_lines jl
                  on jl.journal_entry_id = je.id
                 and jl.user_id = v_user
               where je.transaction_id = t.id
                 and je.user_id = v_user
                 and jl.ledger_account_id = v_ledger
         )
       )
    union
    select candidate.id
      from linked current_link
      join public.transactions current_tx
        on current_tx.id = current_link.id
       and current_tx.user_id = v_user
      cross join lateral (
        select child.id
          from public.transactions child
         where child.user_id = v_user
           and (child.reversal_of = current_tx.id
             or child.replacement_transaction_id = current_tx.id)
        union
        select current_tx.reversal_of
         where current_tx.reversal_of is not null
        union
        select current_tx.replacement_transaction_id
         where current_tx.replacement_transaction_id is not null
      ) candidate(id)
  )
  select coalesce(pg_catalog.array_agg(distinct id), array[]::uuid[])
    into v_transaction_ids
    from linked;

  delete from public.audit_logs
   where user_id = v_user
     and (
       entity_id = p_id
       or entity_id = any(v_transaction_ids)
       or entity_id = any(v_related_loan_ids)
     );

  -- Clear the two self-referencing RESTRICT links only inside the selected
  -- transaction/correction component before deleting its records.
  update public.transactions
     set reversal_of = null,
         replacement_transaction_id = null
   where user_id = v_user
     and id = any(v_transaction_ids);

  delete from public.transactions
   where user_id = v_user
     and id = any(v_transaction_ids);
  get diagnostics v_deleted_transactions = row_count;

  if p_entity = 'loan' then
    delete from public.loans where id = p_id and user_id = v_user;
    if not found then raise exception 'Loan could not be deleted' using errcode = 'P0002'; end if;
    delete from public.ledger_accounts la
     where la.id = v_ledger and la.user_id = v_user
       and not exists (select 1 from public.journal_lines jl where jl.ledger_account_id = la.id and jl.user_id = v_user);
  elsif p_entity = 'goal' then
    delete from public.savings_goals where id = p_id and user_id = v_user;
    if not found then raise exception 'Savings goal could not be deleted' using errcode = 'P0002'; end if;
    delete from public.ledger_accounts la
     where la.id = v_ledger and la.user_id = v_user
       and not exists (select 1 from public.journal_lines jl where jl.ledger_account_id = la.id and jl.user_id = v_user);
  elsif p_entity = 'wallet' then
    delete from public.wallet_accounts where id = p_id and user_id = v_user;
    if not found then raise exception 'Wallet account could not be deleted' using errcode = 'P0002'; end if;
    delete from public.ledger_accounts la
     where la.id = v_ledger and la.user_id = v_user
       and not exists (select 1 from public.journal_lines jl where jl.ledger_account_id = la.id and jl.user_id = v_user);

    foreach v_loan_id in array v_related_loan_ids loop
      select ledger_account_id into v_related_ledger
        from public.loans where id = v_loan_id and user_id = v_user for update;
      if v_related_ledger is not null then
        delete from public.loans where id = v_loan_id and user_id = v_user;
        delete from public.ledger_accounts la
         where la.id = v_related_ledger and la.user_id = v_user
           and not exists (select 1 from public.journal_lines jl where jl.ledger_account_id = la.id and jl.user_id = v_user);
      end if;
    end loop;
  end if;

  return pg_catalog.jsonb_build_object(
    'ok',true,'entity',p_entity,'action','delete','id',p_id,
    'deleted_transactions',v_deleted_transactions,
    'deleted_related_loans',pg_catalog.to_jsonb(v_related_loan_ids)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_financial_item(p_entity text, p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.delete_financial_item_impl($1,$2);
$function$;

CREATE OR REPLACE FUNCTION private.delete_financial_transaction_impl(p_transaction_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := auth.uid();
  v_original public.transactions%rowtype;
  v_ids uuid[] := array[]::uuid[];
  v_deleted integer := 0;
  v_result jsonb;
begin
  if v_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_transaction_id is null then raise exception 'A transaction ID is required' using errcode = '22023'; end if;

  select * into v_original
    from public.transactions
   where id = p_transaction_id and user_id = v_user
   for update;
  if not found then raise exception 'Transaction not found or not owned by this account' using errcode = 'P0002'; end if;

  if v_original.type = 'loan_disbursement' then
    return private.delete_financial_item_impl('loan',v_original.related_loan_id);
  elsif v_original.type in ('investment_buy','investment_sell') then
    return private.delete_investment_data_impl(v_original.related_investment_id,p_transaction_id);
  end if;

  with recursive linked(id) as (
    select p_transaction_id
    union
    select candidate.id
      from linked current_link
      join public.transactions current_tx
        on current_tx.id = current_link.id and current_tx.user_id = v_user
      cross join lateral (
        select child.id
          from public.transactions child
         where child.user_id = v_user
           and (child.reversal_of = current_tx.id
             or child.replacement_transaction_id = current_tx.id)
        union
        select current_tx.reversal_of
         where current_tx.reversal_of is not null
        union
        select current_tx.replacement_transaction_id
         where current_tx.replacement_transaction_id is not null
      ) candidate(id)
  )
  select coalesce(pg_catalog.array_agg(distinct id),array[]::uuid[])
    into v_ids
    from linked;

  delete from public.audit_logs
   where user_id = v_user and entity_id = any(v_ids);
  update public.transactions
     set reversal_of = null,
         replacement_transaction_id = null
   where user_id = v_user and id = any(v_ids);
  delete from public.transactions
   where user_id = v_user and id = any(v_ids);
  get diagnostics v_deleted = row_count;

  return pg_catalog.jsonb_build_object(
    'ok',true,'action','delete_transaction',
    'transaction_id',p_transaction_id,
    'deleted_transactions',v_deleted,
    'deleted_transaction_ids',pg_catalog.to_jsonb(v_ids)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_financial_transaction(p_transaction_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.delete_financial_transaction_impl($1);
$function$;

CREATE OR REPLACE FUNCTION private.edit_financial_transaction(p_transaction_id uuid, p_payload jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := auth.uid();
  v_original public.transactions%rowtype;
  v_new_id uuid;
  v_reversal_id uuid;
  v_type text;
  v_amount numeric;
  v_currency char(3);
  v_account uuid;
  v_loan_id uuid;
  v_key text;
  v_paid numeric := 0;
begin
  if v_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_transaction_id is null then raise exception 'A transaction ID is required' using errcode = '22023'; end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception 'A valid replacement transaction is required' using errcode = '22023';
  end if;

  select * into v_original
    from public.transactions
   where id = p_transaction_id and user_id = v_user
   for update;
  if not found or v_original.is_voided then
    raise exception 'Transaction not found, already corrected, or not editable' using errcode = 'P0002';
  end if;

  v_type := p_payload->>'p_type';
  v_amount := nullif(p_payload->>'p_amount','')::numeric;
  v_currency := nullif(p_payload->>'p_currency_code','')::char(3);
  v_account := nullif(p_payload->>'p_account_id','')::uuid;
  v_loan_id := nullif(p_payload->>'p_related_loan_id','')::uuid;
  v_key := coalesce(nullif(p_payload->>'p_idempotency_key',''),'edit-'||gen_random_uuid()::text);

  if v_amount is null or v_amount <= 0 or v_currency is null or v_account is null then
    raise exception 'The replacement transaction is incomplete or unsupported' using errcode = '22023';
  end if;

  if v_original.type = 'loan_disbursement' then
    if v_type <> 'loan_disbursement'
       or v_loan_id is distinct from v_original.related_loan_id
       or v_currency <> v_original.currency_code then
      raise exception 'Loan origination must remain linked to the same loan and currency' using errcode = '22023';
    end if;
    select coalesce(sum(t.amount),0) into v_paid
      from public.transactions t
     where t.user_id = v_user
       and t.related_loan_id = v_original.related_loan_id
       and t.type = 'loan_payment'
       and not t.is_voided;
    if v_amount + 0.00000001 < v_paid then
      raise exception 'The revised principal cannot be lower than payments already recorded' using errcode = '23514';
    end if;
  elsif v_type not in ('income','expense','transfer','saving_deposit','saving_withdrawal','loan_payment','investment_buy','investment_sell') then
    raise exception 'The replacement transaction type is unsupported' using errcode = '22023';
  end if;

  v_reversal_id := private.reverse_financial_transaction(p_transaction_id,'Edited by user');

  v_new_id := private.post_financial_transaction(
    v_type,
    v_amount,
    v_currency,
    v_account,
    v_key,
    nullif(p_payload->>'p_category_id','')::uuid,
    nullif(p_payload->>'p_destination_account_id','')::uuid,
    nullif(p_payload->>'p_related_goal_id','')::uuid,
    v_loan_id,
    nullif(p_payload->>'p_related_investment_id','')::uuid,
    nullif(p_payload->>'p_target_amount','')::numeric,
    nullif(p_payload->>'p_target_currency_code','')::char(3),
    nullif(p_payload->>'p_fx_rate_to_base','')::numeric,
    nullif(p_payload->>'p_target_fx_rate_to_base','')::numeric,
    nullif(p_payload->>'p_quantity','')::numeric,
    coalesce(nullif(p_payload->>'p_occurred_on','')::date,current_date),
    nullif(p_payload->>'p_note',''),
    coalesce(nullif(p_payload->>'p_is_recurring','')::boolean,false)
  );

  update public.transactions
     set replacement_transaction_id = v_new_id
   where id = p_transaction_id and user_id = v_user;

  if v_original.type = 'loan_disbursement' then
    update public.loans
       set principal = v_amount,
           start_date = coalesce(nullif(p_payload->>'p_occurred_on','')::date,start_date),
           is_archived = false
     where id = v_original.related_loan_id and user_id = v_user;
    if not found then raise exception 'The linked loan no longer exists' using errcode = 'P0002'; end if;
  end if;

  insert into public.audit_logs(user_id,action,entity_type,entity_id,details)
  values(
    v_user,'transaction_corrected','transaction',p_transaction_id,
    pg_catalog.jsonb_build_object(
      'reversal_transaction_id',v_reversal_id,
      'replacement_transaction_id',v_new_id,
      'loan_principal_updated',v_original.type='loan_disbursement'
    )
  );

  return v_new_id;
end;
$function$;


alter function public.activate_owned_financial_records() security invoker;
alter function public.delete_financial_item(text, uuid) security invoker;
alter function public.delete_financial_transaction(uuid) security invoker;

grant usage on schema private to authenticated;

revoke all on function private.activate_owned_financial_records_impl() from public, anon, authenticated;
grant execute on function private.activate_owned_financial_records_impl() to authenticated;
revoke all on function public.activate_owned_financial_records() from public, anon;
grant execute on function public.activate_owned_financial_records() to authenticated;

revoke all on function private.delete_financial_item_impl(text, uuid) from public, anon, authenticated;
grant execute on function private.delete_financial_item_impl(text, uuid) to authenticated;
revoke all on function public.delete_financial_item(text, uuid) from public, anon;
grant execute on function public.delete_financial_item(text, uuid) to authenticated;

revoke all on function private.delete_financial_transaction_impl(uuid) from public, anon, authenticated;
grant execute on function private.delete_financial_transaction_impl(uuid) to authenticated;
revoke all on function public.delete_financial_transaction(uuid) from public, anon;
grant execute on function public.delete_financial_transaction(uuid) to authenticated;

revoke all on function private.edit_financial_transaction(uuid, jsonb) from public, anon, authenticated;
grant execute on function private.edit_financial_transaction(uuid, jsonb) to authenticated;


commit;
