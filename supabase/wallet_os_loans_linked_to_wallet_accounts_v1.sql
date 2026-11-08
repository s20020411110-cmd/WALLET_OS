create or replace function private.create_loan_from_account_v1(
  p_name text,
  p_kind text,
  p_principal numeric,
  p_currency_code character,
  p_account_id uuid,
  p_interest_rate numeric default 0,
  p_start_date date default null,
  p_due_date date default null,
  p_installment_amount numeric default 0,
  p_installment_count integer default 0,
  p_fx_rate_to_base numeric default null,
  p_request_key text default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user uuid := auth.uid();
  v_base char(3);
  v_wallet public.wallet_accounts%rowtype;
  v_ledger uuid;
  v_id uuid;
  v_fp text;
  v_existing text;
  v_rate numeric(24,12);
  v_wallet_balance numeric(24,8);
  v_tx uuid;
  v_entry uuid;
  v_amount_base numeric(24,8);
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  if length(btrim(coalesce(p_name,''))) not between 1 and 120
     or p_principal is null or p_principal<=0 then
    raise exception 'Invalid loan details' using errcode='22023';
  end if;
  if p_kind not in ('borrowed','owed') then
    raise exception 'Loan kind must be borrowed or owed' using errcode='22023';
  end if;
  if coalesce(p_interest_rate,0)<0 or coalesce(p_installment_amount,0)<0
     or coalesce(p_installment_count,0)<0 then
    raise exception 'Invalid loan terms' using errcode='22023';
  end if;
  if length(btrim(coalesce(p_request_key,''))) not between 8 and 160 then
    raise exception 'A request key is required' using errcode='22023';
  end if;
  if not exists(select 1 from public.currencies where code=p_currency_code and active) then
    raise exception 'Unsupported currency';
  end if;
  select base_currency into v_base from public.profiles where id=v_user;
  v_rate:=coalesce(p_fx_rate_to_base,case when p_currency_code=v_base then 1 end);
  if v_rate is null or v_rate<=0 then
    raise exception 'A valid FX rate to base currency is required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user::text||':'||p_request_key,0)
  );
  v_fp:=md5(jsonb_build_object(
    'name',btrim(p_name),'kind',p_kind,'principal',p_principal,
    'currency',p_currency_code,'account',p_account_id,
    'rate',coalesce(p_interest_rate,0),'start',p_start_date,'due',p_due_date,
    'installment',coalesce(p_installment_amount,0),'count',coalesce(p_installment_count,0),
    'fx',v_rate
  )::text);
  select id,request_fingerprint into v_id,v_existing
  from public.loans where user_id=v_user and request_key=p_request_key;
  if v_id is not null then
    if v_existing<>v_fp then
      raise exception 'Idempotency key reused with different loan data' using errcode='22023';
    end if;
    return v_id;
  end if;

  select * into v_wallet from public.wallet_accounts
  where id=p_account_id and user_id=v_user and not is_archived
  for update;
  if not found then raise exception 'The selected account was not found or is archived'; end if;
  if v_wallet.currency_code<>p_currency_code then
    raise exception 'The linked account and loan must use the same currency';
  end if;
  if p_kind='owed' and not v_wallet.allow_overdraft then
    select coalesce(sum(jl.amount_debit-jl.amount_credit),0) into v_wallet_balance
    from public.journal_lines jl
    where jl.ledger_account_id=v_wallet.ledger_account_id
      and jl.user_id=v_user and jl.currency_code=p_currency_code;
    if v_wallet_balance<p_principal then
      raise exception 'Insufficient funds to lend this amount';
    end if;
  end if;

  insert into public.ledger_accounts(
    user_id,account_code,name,account_class,normal_side,currency_code
  )
  values(
    v_user,
    'LOAN-'||pg_catalog.replace(gen_random_uuid()::text,'-',''),
    btrim(p_name),
    case when p_kind='borrowed' then 'liability' else 'asset' end,
    case when p_kind='borrowed' then 'credit' else 'debit' end,
    p_currency_code
  )
  returning id into v_ledger;
  insert into public.loans(
    user_id,ledger_account_id,name,kind,principal,currency_code,interest_rate,
    start_date,due_date,installment_amount,installment_count,request_key,request_fingerprint
  )
  values(
    v_user,v_ledger,btrim(p_name),p_kind,p_principal,p_currency_code,
    coalesce(p_interest_rate,0),p_start_date,p_due_date,
    coalesce(p_installment_amount,0),coalesce(p_installment_count,0),
    p_request_key,v_fp
  )
  returning id into v_id;

  v_amount_base:=round(p_principal*v_rate,8);
  insert into public.transactions(
    user_id,type,amount,currency_code,occurred_on,source_account_id,
    related_loan_id,fx_rate_to_base,idempotency_key,request_fingerprint,note
  )
  values(
    v_user,'loan_disbursement',p_principal,p_currency_code,
    coalesce(p_start_date,current_date),v_wallet.id,v_id,v_rate,
    'loan-disbursement:'||v_id::text,
    md5(v_id::text||v_wallet.id::text||p_principal::text||p_currency_code::text),
    case when p_kind='borrowed' then 'Loan proceeds received' else 'Money lent / receivable opened' end
  )
  returning id into v_tx;
  insert into public.journal_entries(
    user_id,transaction_id,base_currency,description,occurred_on
  )
  values(
    v_user,v_tx,v_base,
    case when p_kind='borrowed' then 'Loan proceeds received' else 'Money lent / receivable opened' end,
    coalesce(p_start_date,current_date)
  )
  returning id into v_entry;

  if p_kind='borrowed' then
    insert into public.journal_lines(
      user_id,journal_entry_id,ledger_account_id,currency_code,
      amount_debit,base_debit,fx_rate_to_base
    )
    values(v_user,v_entry,v_wallet.ledger_account_id,p_currency_code,
      p_principal,v_amount_base,v_rate);
    insert into public.journal_lines(
      user_id,journal_entry_id,ledger_account_id,currency_code,
      amount_credit,base_credit,fx_rate_to_base
    )
    values(v_user,v_entry,v_ledger,p_currency_code,p_principal,v_amount_base,v_rate);
  else
    insert into public.journal_lines(
      user_id,journal_entry_id,ledger_account_id,currency_code,
      amount_debit,base_debit,fx_rate_to_base
    )
    values(v_user,v_entry,v_ledger,p_currency_code,p_principal,v_amount_base,v_rate);
    insert into public.journal_lines(
      user_id,journal_entry_id,ledger_account_id,currency_code,
      amount_credit,base_credit,fx_rate_to_base
    )
    values(v_user,v_entry,v_wallet.ledger_account_id,p_currency_code,p_principal,v_amount_base,v_rate);
  end if;

  insert into public.audit_logs(user_id,action,entity_type,entity_id,details)
  values(v_user,'loan_created','loan',v_id,jsonb_build_object(
    'principal',p_principal,'currency',p_currency_code,'kind',p_kind,
    'wallet_account_id',v_wallet.id,'transaction_id',v_tx
  ));
  return v_id;
end;
$function$;

create or replace function public.create_loan_from_account_v1(
  p_name text,
  p_kind text,
  p_principal numeric,
  p_currency_code character,
  p_account_id uuid,
  p_interest_rate numeric default 0,
  p_start_date date default null,
  p_due_date date default null,
  p_installment_amount numeric default 0,
  p_installment_count integer default 0,
  p_fx_rate_to_base numeric default null,
  p_request_key text default null
)
returns uuid
language sql
security invoker
set search_path to ''
as $function$
  select private.create_loan_from_account_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12);
$function$;

revoke all on function private.create_loan_from_account_v1(text,text,numeric,character,uuid,numeric,date,date,numeric,integer,numeric,text)
  from public,anon,authenticated;
grant execute on function private.create_loan_from_account_v1(text,text,numeric,character,uuid,numeric,date,date,numeric,integer,numeric,text)
  to authenticated;
revoke all on function public.create_loan_from_account_v1(text,text,numeric,character,uuid,numeric,date,date,numeric,integer,numeric,text)
  from public,anon;
grant execute on function public.create_loan_from_account_v1(text,text,numeric,character,uuid,numeric,date,date,numeric,integer,numeric,text)
  to authenticated;
