-- The market worker is the only writer of source-tagged gold quote snapshots.
-- Browser users can read the table under existing RLS, but cannot insert/update/delete.
begin;

grant insert on table public.gold_price_quotes to service_role;
revoke insert, update, delete on table public.gold_price_quotes from anon, authenticated;

commit;
