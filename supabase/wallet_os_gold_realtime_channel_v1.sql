-- WALLET OS: authenticated private broadcast access + single-leader gold worker lease.
-- Browsers may only receive the market feed. All publishing and lease RPCs require
-- the server-only service_role credential; no price tick is written to transactions.
begin;

create table if not exists private.gold_market_worker_lease (
  singleton_key text primary key check (singleton_key = 'xau'),
  holder_id text not null,
  lease_expires_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp()
);

revoke all on table private.gold_market_worker_lease from public, anon, authenticated, service_role;
grant usage on schema private to service_role;

create or replace function private.acquire_gold_market_lease_impl(
  p_worker_id text,
  p_lease_seconds integer default 30
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_acquired boolean := false;
begin
  if p_worker_id is null or pg_catalog.length(pg_catalog.btrim(p_worker_id)) < 8
     or pg_catalog.length(p_worker_id) > 128 then
    raise exception 'Invalid worker identity' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 15 or p_lease_seconds > 120 then
    raise exception 'Lease duration must be between 15 and 120 seconds' using errcode = '22023';
  end if;

  insert into private.gold_market_worker_lease as current_lease
    (singleton_key, holder_id, lease_expires_at, updated_at)
  values
    ('xau', p_worker_id, pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds), pg_catalog.clock_timestamp())
  on conflict (singleton_key) do update
    set holder_id = excluded.holder_id,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = pg_catalog.clock_timestamp()
    where current_lease.lease_expires_at <= pg_catalog.clock_timestamp()
       or current_lease.holder_id = excluded.holder_id
  returning true into v_acquired;

  return pg_catalog.coalesce(v_acquired, false);
end;
$function$;

create or replace function private.renew_gold_market_lease_impl(
  p_worker_id text,
  p_lease_seconds integer default 30
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_renewed boolean := false;
begin
  if p_worker_id is null or p_lease_seconds is null or p_lease_seconds < 15 or p_lease_seconds > 120 then
    raise exception 'Invalid worker lease renewal' using errcode = '22023';
  end if;

  update private.gold_market_worker_lease
     set lease_expires_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
         updated_at = pg_catalog.clock_timestamp()
   where singleton_key = 'xau'
     and holder_id = p_worker_id
     and lease_expires_at > pg_catalog.clock_timestamp()
  returning true into v_renewed;

  return pg_catalog.coalesce(v_renewed, false);
end;
$function$;

create or replace function private.release_gold_market_lease_impl(p_worker_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_deleted integer := 0;
begin
  if p_worker_id is null then
    raise exception 'Worker identity is required' using errcode = '22023';
  end if;
  delete from private.gold_market_worker_lease
   where singleton_key = 'xau' and holder_id = p_worker_id;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$function$;

create or replace function public.acquire_gold_market_lease(p_worker_id text, p_lease_seconds integer default 30)
returns boolean
language sql
security invoker
set search_path = ''
as $function$
  select private.acquire_gold_market_lease_impl($1, $2);
$function$;

create or replace function public.renew_gold_market_lease(p_worker_id text, p_lease_seconds integer default 30)
returns boolean
language sql
security invoker
set search_path = ''
as $function$
  select private.renew_gold_market_lease_impl($1, $2);
$function$;

create or replace function public.release_gold_market_lease(p_worker_id text)
returns boolean
language sql
security invoker
set search_path = ''
as $function$
  select private.release_gold_market_lease_impl($1);
$function$;

revoke all on function private.acquire_gold_market_lease_impl(text, integer) from public, anon, authenticated;
revoke all on function private.renew_gold_market_lease_impl(text, integer) from public, anon, authenticated;
revoke all on function private.release_gold_market_lease_impl(text) from public, anon, authenticated;
grant execute on function private.acquire_gold_market_lease_impl(text, integer) to service_role;
grant execute on function private.renew_gold_market_lease_impl(text, integer) to service_role;
grant execute on function private.release_gold_market_lease_impl(text) to service_role;

revoke all on function public.acquire_gold_market_lease(text, integer) from public, anon, authenticated;
revoke all on function public.renew_gold_market_lease(text, integer) from public, anon, authenticated;
revoke all on function public.release_gold_market_lease(text) from public, anon, authenticated;
grant execute on function public.acquire_gold_market_lease(text, integer) to service_role;
grant execute on function public.renew_gold_market_lease(text, integer) to service_role;
grant execute on function public.release_gold_market_lease(text) to service_role;

drop policy if exists wallet_os_authenticated_users_read_gold_market on realtime.messages;
create policy wallet_os_authenticated_users_read_gold_market
on realtime.messages
for select
to authenticated
using (
  (select realtime.topic()) = 'wallet-os-gold-market'
  and realtime.messages.extension = 'broadcast'
  and (select auth.uid()) is not null
  and coalesce((select auth.jwt() ->> 'is_anonymous'), 'false') <> 'true'
);

commit;
