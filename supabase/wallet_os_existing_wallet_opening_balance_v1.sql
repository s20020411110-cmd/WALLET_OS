create or replace function private.set_wallet_opening_balance_v1(
  p_account_id uuid,
  p_opening_balance numeric,
  p_opening_fx_rate numeric default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user uuid := auth.uid();
  v_wallet public.wallet_accounts%rowtype;
  v_base char(3);
  v_rate numeric(24,12);
  v_equity uuid;
  v_existing public.transactions%rowtype;
  v_tx uuid;
  v_entry uuid;
  v_fp text;
  v_base_amount numeric(24,8);
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  if p_opening_balance is null or p_opening_balance<0 then
    raise exception 'Opening balance must be zero or positive' using errcode='22023';
  end if;

  select * into v_wallet
  from public.wallet_accounts
  where id=p_account_id and user_id=v_user and not is_archived
  for update;
  if not found then
    raise exception 'The selected account was not found or is archived';
  end if;

  select id,request_fingerprint,* into v_existing
  from public.transactions
  where user_id=v_user and idempotency_key='opening:'||v_wallet.id::text;
  if found then
    v_fp:=md5(v_wallet.id::text||p_opening_balance::text||v_wallet.currency_code::text);
    if v_existing.request_fingerprint<>v_fp then
      raise exception 'An opening balance has already been recorded for this account with a different amount'
        using errcode='22023';
    end if;
    return v_existing.id;
  end if;

  if exists(
    select 1 from public.transactions t
    where t.user_id=v_user
      and (t.source_account_id=v_wallet.id or t.destination_account_id=v_wallet.id)
  ) or exists(
    select 1 from public.journal_lines jl
    where jl.user_id=v_user and jl.ledger_account_id=v_wallet.ledger_account_id
  ) then
    raise exception 'Opening balance can only be set before the account has any financial activity'
      using errcode='55000';
  end if;

  if p_opening_balance=0 then
    return null;
  end if;

  select base_currency into v_base from public.profiles where id=v_user;
  v_rate:=coalesce(p_opening_fx_rate,case when v_wallet.currency_code=v_base then 1 end);
  if v_rate is null or v_rate<=0 then
    raise exception 'A valid FX rate to base currency is required';
  end if;
  select id into v_equity from public.ledger_accounts
  where user_id=v_user and system_key='opening_equity';
  if v_equity is null then
    raise exception 'Opening balance equity account is missing';
  end if;

  v_fp:=md5(v_wallet.id::text||p_opening_balance::text||v_wallet.currency_code::text);
  v_base_amount:=round(p_opening_balance*v_rate,8);
  insert into public.transactions(
    user_id,type,amount,currency_code,occurred_on,source_account_id,
    fx_rate_to_base,idempotency_key,request_fingerprint,note
  )
  values(
    v_user,'opening_balance',p_opening_balance,v_wallet.currency_code,current_date,
    v_wallet.id,v_rate,'opening:'||v_wallet.id::text,v_fp,'Opening balance'
  )
  returning id into v_tx;

  insert into public.journal_entries(user_id,transaction_id,base_currency,description,occurred_on)
  values(v_user,v_tx,v_base,'Opening balance',current_date)
  returning id into v_entry;

  insert into public.journal_lines(
    user_id,journal_entry_id,ledger_account_id,currency_code,
    amount_debit,base_debit,fx_rate_to_base
  )
  values(v_user,v_entry,v_wallet.ledger_account_id,v_wallet.currency_code,
    p_opening_balance,v_base_amount,v_rate);

  insert into public.journal_lines(
    user_id,journal_entry_id,ledger_account_id,currency_code,
    amount_credit,base_credit,fx_rate_to_base
  )
  values(v_user,v_entry,v_equity,v_base,v_base_amount,v_base_amount,1);

  insert into public.audit_logs(user_id,action,entity_type,entity_id,details)
  values(v_user,'wallet_opening_balance_set','wallet_account',v_wallet.id,
    jsonb_build_object('opening_balance',p_opening_balance,'currency',v_wallet.currency_code,'transaction_id',v_tx));
  return v_tx;
end;
$function$;

create or replace function public.set_wallet_opening_balance_v1(
  p_account_id uuid,
  p_opening_balance numeric,
  p_opening_fx_rate numeric default null
)
returns uuid
language sql
security invoker
set search_path to ''
as $function$
  select private.set_wallet_opening_balance_v1($1,$2,$3);
$function$;

revoke all on function private.set_wallet_opening_balance_v1(uuid,numeric,numeric)
  from public,anon,authenticated;
grant execute on function private.set_wallet_opening_balance_v1(uuid,numeric,numeric)
  to authenticated;
revoke all on function public.set_wallet_opening_balance_v1(uuid,numeric,numeric)
  from public,anon;
grant execute on function public.set_wallet_opening_balance_v1(uuid,numeric,numeric)
  to authenticated;
