-- RPC agregat Investing/Financing buat Cash Flow, DB-side (bukan fetch raw journal_lines
-- lalu klasifikasi di TypeScript). Ref: memory/scope-debt/journal-lines-unbounded-aggregate.md.
--
-- Duplikat business logic dari classifyInvestingFinancing (apps/erp/src/lib/reports/cash-flow.ts).
-- WAJIB diubah BARENG kalau logic klasifikasi Investing/Financing berubah (kode akun Kas '1000',
-- Aset Tetap '1600', atau daftar kode liability financing '2200') -- classifyInvestingFinancing
-- di TypeScript sekarang HANYA dipakai sebagai reference implementation buat test
-- (reports.test.ts), gak dipanggil dari jalur production lagi (getCashFlow pakai RPC ini).
-- Gak ada mekanisme otomatis buat jaga 2 tempat ini tetap sinkron -- kalau logic klasifikasi
-- di TypeScript berubah, migration baru yang mirror perubahannya ke sini WAJIB dibuat.

create or replace function report_cash_flow_investing_financing(
  p_start_date date,
  p_end_date date
)
returns table(investing numeric, financing numeric)
language sql
stable
security invoker
as $$
  with kas_accounts as (
    select a.id
    from accounts a
    join accounts p on a.parent_id = p.id
    where p.code = '1000'
  ),
  fixed_asset_accounts as (
    select a.id
    from accounts a
    join accounts p on a.parent_id = p.id
    where p.code = '1600' and not a.is_contra
  ),
  period_lines as (
    select jl.journal_entry_id, jl.account_id, jl.credit - jl.debit as contribution
    from journal_lines jl
    join journal_entries je on je.id = jl.journal_entry_id
    where je.entry_date between p_start_date and p_end_date
  ),
  entries_with_kas as (
    select distinct journal_entry_id
    from period_lines
    where account_id in (select id from kas_accounts)
  ),
  classified_lines as (
    select pl.account_id, pl.contribution, a.category, a.code
    from period_lines pl
    join accounts a on a.id = pl.account_id
    where pl.journal_entry_id in (select journal_entry_id from entries_with_kas)
      and pl.account_id not in (select id from kas_accounts)
  )
  select
    coalesce(sum(contribution) filter (where account_id in (select id from fixed_asset_accounts)), 0) as investing,
    coalesce(sum(contribution) filter (where category = 'equity' or code in ('2200')), 0) as financing
  from classified_lines;
$$;

grant execute on function report_cash_flow_investing_financing(date, date) to authenticated;
