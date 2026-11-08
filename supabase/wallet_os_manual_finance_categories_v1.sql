create or replace function private.create_finance_category(
  p_name text,
  p_direction text,
  p_request_key text default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user uuid := auth.uid();
  v_name text := btrim(coalesce(p_name,''));
  v_base char(3);
  v_existing uuid;
  v_ledger uuid;
  v_category uuid;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  if p_direction not in ('income','expense') then
    raise exception 'Category direction must be income or expense' using errcode='22023';
  end if;
  if length(v_name) not between 1 and 80 then
    raise exception 'Category name must be between 1 and 80 characters' using errcode='22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user::text || ':' || p_direction || ':' || lower(v_name), 0)
  );

  select id into v_existing
  from public.categories
  where user_id=v_user and direction=p_direction and lower(name)=lower(v_name);

  if v_existing is not null then
    return v_existing;
  end if;

  select base_currency into v_base
  from public.profiles
  where id=v_user;

  if v_base is null then
    raise exception 'User profile or base currency is missing';
  end if;

  insert into public.ledger_accounts(
    user_id, account_code, name, account_class, normal_side, currency_code
  )
  values (
    v_user,
    'CAT-CUSTOM-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.replace(gen_random_uuid()::text,'-',''),1,20)),
    v_name,
    p_direction,
    case when p_direction='income' then 'credit' else 'debit' end,
    v_base
  )
  returning id into v_ledger;

  insert into public.categories(user_id,ledger_account_id,name,direction,is_system)
  values(v_user,v_ledger,v_name,p_direction,false)
  returning id into v_category;

  insert into public.audit_logs(user_id,action,entity_type,entity_id,details)
  values(v_user,'category_created','category',v_category,
    jsonb_build_object('direction',p_direction,'name',v_name,'request_key',p_request_key));

  return v_category;
end;
$function$;

create or replace function public.create_finance_category(
  p_name text,
  p_direction text,
  p_request_key text default null
)
returns uuid
language sql
security invoker
set search_path to ''
as $function$
  select private.create_finance_category($1,$2,$3);
$function$;

revoke all on function private.create_finance_category(text,text,text) from public, anon, authenticated;
grant execute on function private.create_finance_category(text,text,text) to authenticated;
revoke all on function public.create_finance_category(text,text,text) from public, anon;
grant execute on function public.create_finance_category(text,text,text) to authenticated;
