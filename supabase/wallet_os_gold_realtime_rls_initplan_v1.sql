-- Avoid per-row JWT function evaluation in the market Broadcast read policy.
begin;

drop policy if exists wallet_os_authenticated_users_read_gold_market on realtime.messages;
create policy wallet_os_authenticated_users_read_gold_market
on realtime.messages
for select
to authenticated
using (
  (select realtime.topic()) = 'wallet-os-gold-market'
  and realtime.messages.extension = 'broadcast'
  and (select auth.uid()) is not null
  and coalesce(((select auth.jwt()) ->> 'is_anonymous'), 'false') <> 'true'
);

commit;
