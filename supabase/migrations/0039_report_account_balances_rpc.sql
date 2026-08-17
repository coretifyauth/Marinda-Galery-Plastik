-- RPC agregat saldo akun (DB-side SUM/GROUP BY), gantiin fetch+reduce client-side
-- yang rawan kena max_rows PostgREST (supabase/config.toml) begitu journal_lines
-- tumbuh lewat 1000 baris per query. Ref: memory/scope-debt/journal-lines-unbounded-aggregate.md,
-- memory/architecture/app/tech-stack-decisions.md bagian "Agregat/saldo dari tabel append-only".

create or replace function report_account_balances_up_to(p_as_of date)
returns table(account_id uuid, debit numeric, credit numeric)
language sql
stable
security invoker
as $$
  select jl.account_id, sum(jl.debit) as debit, sum(jl.credit) as credit
  from journal_lines jl
  join journal_entries je on je.id = jl.journal_entry_id
  where je.entry_date <= p_as_of
  group by jl.account_id;
$$;

grant execute on function report_account_balances_up_to(date) to authenticated;

create or replace function report_account_balances_between(
  p_start_date date,
  p_end_date date,
  p_exclude_entry_ids uuid[] default '{}'
)
returns table(account_id uuid, debit numeric, credit numeric)
language sql
stable
security invoker
as $$
  select jl.account_id, sum(jl.debit) as debit, sum(jl.credit) as credit
  from journal_lines jl
  join journal_entries je on je.id = jl.journal_entry_id
  where je.entry_date between p_start_date and p_end_date
    and not coalesce(jl.journal_entry_id = any(p_exclude_entry_ids), false)
  group by jl.account_id;
$$;

grant execute on function report_account_balances_between(date, date, uuid[]) to authenticated;
