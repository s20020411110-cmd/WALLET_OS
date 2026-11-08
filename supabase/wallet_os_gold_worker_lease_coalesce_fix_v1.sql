-- Correct SQL syntax in the worker lease helpers (COALESCE is a SQL expression).
begin;

CREATE OR REPLACE FUNCTION private.acquire_gold_market_lease_impl(p_worker_id text, p_lease_seconds integer DEFAULT 30)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  return coalesce(v_acquired, false);
end;
$function$;

CREATE OR REPLACE FUNCTION private.renew_gold_market_lease_impl(p_worker_id text, p_lease_seconds integer DEFAULT 30)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  return coalesce(v_renewed, false);
end;
$function$;

revoke all on function private.acquire_gold_market_lease_impl(text,integer) from public,anon,authenticated;
revoke all on function private.renew_gold_market_lease_impl(text,integer) from public,anon,authenticated;
grant execute on function private.acquire_gold_market_lease_impl(text,integer) to service_role;
grant execute on function private.renew_gold_market_lease_impl(text,integer) to service_role;

commit;
