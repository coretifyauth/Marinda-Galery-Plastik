-- RPC saldo pembuka (opening balance) buat 1 halaman ledger akun, dipakai General Ledger
-- (/general-ledger) dan tab Ledger (/accounts/[id]) supaya saldo berjalan per baris tetap
-- benar begitu ledger dipaginate (bukan lagi fetch SEMUA baris sekaligus, rawan kena
-- max_rows PostgREST). Ref: memory/scope-debt/journal-lines-unbounded-aggregate.md.
--
-- p_before_offset = jumlah baris SEBELUM halaman yang lagi ditampilkan, dalam urutan
-- (entry_date, id) -- urutan ini HARUS PERSIS SAMA dengan `.order()` yang dipakai query
-- halaman ledger-nya sendiri (apps/erp/src/lib/reports/ledger.ts), kalau enggak offset-nya
-- gak nyambung dan saldo berjalan bisa salah tanpa error apa pun.

create or replace function report_account_ledger_opening_balance(
  p_account_id uuid,
  p_as_of date,
  p_before_offset int
)
returns table(debit numeric, credit numeric)
language sql
stable
security invoker
as $$
  select coalesce(sum(sub.debit), 0), coalesce(sum(sub.credit), 0)
  from (
    select jl.debit, jl.credit
    from journal_lines jl
    join journal_entries je on je.id = jl.journal_entry_id
    where jl.account_id = p_account_id and je.entry_date <= p_as_of
    order by je.entry_date, jl.id
    limit p_before_offset
  ) sub;
$$;

grant execute on function report_account_ledger_opening_balance(uuid, date, int) to authenticated;
