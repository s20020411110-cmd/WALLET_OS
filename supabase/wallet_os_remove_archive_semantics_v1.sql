-- WALLET OS no longer exposes archive/restore as a user workflow.
-- Reactivate only this authenticated user's existing wallet, loan, goal and asset rows.
-- Transaction history and financial records are preserved.
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

alter function public.activate_owned_financial_records() security invoker;
grant usage on schema private to authenticated;
revoke all on function private.activate_owned_financial_records_impl() from public, anon, authenticated;
grant execute on function private.activate_owned_financial_records_impl() to authenticated;
revoke all on function public.activate_owned_financial_records() from public, anon;
grant execute on function public.activate_owned_financial_records() to authenticated;

commit;
