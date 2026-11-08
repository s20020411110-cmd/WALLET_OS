-- Index the two self-referencing correction links used by permanent investment deletion.
create index if not exists idx_transactions_user_reversal_of
  on public.transactions(user_id, reversal_of);

create index if not exists idx_transactions_user_replacement_id
  on public.transactions(user_id, replacement_transaction_id);
