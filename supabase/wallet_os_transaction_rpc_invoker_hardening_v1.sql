begin;

-- Keep the public PostgREST entry points invoker-rights only.
-- The internal SECURITY DEFINER implementations independently enforce auth.uid(),
-- owner-scoped row locks, validation, journaling and atomic rollback.
revoke all on function private.edit_financial_transaction(uuid, jsonb) from public, anon, authenticated;
revoke all on function private.reverse_financial_transaction(uuid, text) from public, anon, authenticated;

grant execute on function private.edit_financial_transaction(uuid, jsonb) to authenticated;
grant execute on function private.reverse_financial_transaction(uuid, text) to authenticated;

alter function public.edit_financial_transaction(uuid, jsonb) security invoker;
alter function public.void_financial_transaction(uuid, text) security invoker;

commit;
