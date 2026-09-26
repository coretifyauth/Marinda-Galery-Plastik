-- Cash Flow — Investing & Financing classification RPC.
-- Replikasi SQL persis dari `classifyInvestingFinancing` di
-- apps/erp/src/lib/reports/cash-flow.ts (reference implementation buat test doang,
-- production sekarang panggil RPC ini lewat `fetchInvestingFinancing`).
--
-- Ref: memory/brief.md item `journal-lines-unbounded-aggregate.md` (status: Selesai,
-- tapi migration `0040_report_cash_flow_investing_financing_rpc.sql` gak pernah dibuat).

create function report_cash_flow_investing_financing(
  p_start_date date,
  p_end_date date
)
returns table (investing numeric, financing numeric)
language sql
security invoker
as $$
  with kas_accounts as (
    select id from accounts
    where parent_id = (select id from accounts where code = '1000' limit 1)
  ),
  fixed_asset_accounts as (
    select id from accounts
    where parent_id = (select id from accounts where code = '1600' limit 1)
    and is_contra = false
  ),
  -- entry yang punya minimal 1 baris Kas di rentang tanggal ini
  entries_with_cash as (
    select distinct je.id as entry_id
    from journal_entries je
    join journal_lines jl on jl.journal_entry_id = je.id
    where je.entry_date between p_start_date and p_end_date
      and jl.account_id in (select id from kas_accounts)
  ),
  -- semua baris non-Kas dari entry-entry di atas
  qualifying_lines as (
    select jl.account_id, jl.debit, jl.credit
    from journal_lines jl
    join entries_with_cash ec on ec.entry_id = jl.journal_entry_id
    where jl.account_id not in (select id from kas_accounts)
  )
  select
    coalesce(sum(case
      when ql.account_id in (select id from fixed_asset_accounts) then ql.credit - ql.debit
      else 0
    end), 0) as investing,
    coalesce(sum(case
      when a.category = 'equity' or a.code = '2200' then ql.credit - ql.debit
      else 0
    end), 0) as financing
  from qualifying_lines ql
  join accounts a on a.id = ql.account_id
$$;

grant execute on function report_cash_flow_investing_financing(date, date) to authenticated;
