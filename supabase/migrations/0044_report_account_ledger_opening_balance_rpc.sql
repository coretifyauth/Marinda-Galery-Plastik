-- Opening balance RPC untuk General Ledger & tab Ledger /accounts/[id].
-- Replikasi SQL dari `fetchAccountLedgerPage` di apps/erp/src/lib/reports/ledger.ts.
--
-- `p_before_offset` = page * pageSize — jumlah baris SEBELUM halaman yang sedang
-- ditampilkan. RPC menghitung jumlah debit+credit dari `p_before_offset` baris
-- pertama (urut entry_date ASC, id ASC) untuk akun ini sampai p_as_of — ini adalah
-- saldo pembuka yang dipakai buat nge-seed saldo berjalan di baris pertama halaman.
--
-- URUTAN HARUS PERSIS SAMA dengan order di ledger.ts:
--   .order("entry_date", { ascending: true })
--   .order("id", { ascending: true })
-- kalau beda, offset tidak nyambung sama baris yang ditampilkan, saldo berjalan salah.
--
-- Ref: memory/brief.md item `journal-lines-unbounded-aggregate.md` (status: Selesai,
-- tapi migration `0041_report_account_ledger_opening_balance_rpc.sql` gak pernah dibuat).

create function report_account_ledger_opening_balance(
  p_account_id uuid,
  p_as_of date,
  p_before_offset int
)
returns table (debit numeric, credit numeric)
language sql
security invoker
as $$
  select
    coalesce(sum(debit), 0) as debit,
    coalesce(sum(credit), 0) as credit
  from (
    select jl.debit, jl.credit
    from journal_lines jl
    join journal_entries je on je.id = jl.journal_entry_id
    where jl.account_id = p_account_id
      and je.entry_date <= p_as_of
    order by je.entry_date asc, jl.id asc
    limit p_before_offset
  ) sub
$$;

grant execute on function report_account_ledger_opening_balance(uuid, date, int) to authenticated;
