-- Aggregate account balances RPC — dipakai Trial Balance, Income Statement,
-- Balance Sheet, dan Cash Flow (fetchLinesUpTo / fetchAccountBalancesBetween
-- di apps/erp/src/lib/reports/balances.ts).
--
-- Dua-duanya murni fungsi baca yang mensubset journal_lines join journal_entries
-- per tanggal, GROUP BY akun — agregat tetap di database bukan fetch raw lalu
-- reduce di JS (batasi max_rows PostgREST yang tumbuh).
--
-- Ref: memory/brief.md item `journal-lines-unbounded-aggregate.md` (status: Selesai,
-- tapi migration `0039_report_account_balances_rpc.sql` yang disebut gak pernah
-- benar-benar dibuat, jadi semua laporan keuangan error). File ini adalah
-- re-creation dengan nomor migration 0042 (0039-0041 sudah direferensi untuk
-- AR changes di brief.md).
--
-- create or replace (bukan create polos) -- kedua fungsi ini ternyata udah ada di database
-- live dari luar riwayat migration yang tercatat (sama kasusnya kayak ap_deposits_with_status/
-- ar_deposits_with_status di 0036), signature (nama+tipe argumen) sama persis jadi aman
-- di-replace, gak perlu drop dulu.

create or replace function report_account_balances_up_to(
  p_as_of date
)
returns table (account_id uuid, debit numeric, credit numeric)
language sql
security invoker
as $$
  select
    jl.account_id,
    coalesce(sum(jl.debit), 0),
    coalesce(sum(jl.credit), 0)
  from journal_lines jl
  join journal_entries je on je.id = jl.journal_entry_id
  where je.entry_date <= p_as_of
  group by jl.account_id
$$;

create or replace function report_account_balances_between(
  p_start_date date,
  p_end_date date,
  p_exclude_entry_ids uuid[] default '{}'
)
returns table (account_id uuid, debit numeric, credit numeric)
language sql
security invoker
as $$
  select
    jl.account_id,
    coalesce(sum(jl.debit), 0),
    coalesce(sum(jl.credit), 0)
  from journal_lines jl
  join journal_entries je on je.id = jl.journal_entry_id
  where je.entry_date between p_start_date and p_end_date
    and jl.journal_entry_id <> all(coalesce(p_exclude_entry_ids, '{}'))
  group by jl.account_id
$$;

grant execute on function report_account_balances_up_to(date) to authenticated;
grant execute on function report_account_balances_between(date, date, uuid[]) to authenticated;
