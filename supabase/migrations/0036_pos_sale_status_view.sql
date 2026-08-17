-- View buat filter status "Dibatalkan"/"Normal" di list page POS Sales (server-side WHERE),
-- nutup memory/scope-debt/pos-sales-status-filter.md. Status sebelumnya dihitung client-side
-- lewat query terpisah ke journal_entries.reverses_entry_id (variabel reversedEntryIds di
-- apps/erp/src/app/(app)/pos-sales/page.tsx) -- gak bisa di-WHERE-kan langsung.
--
-- `total` (SUM pos_sale_lines.line_amount) juga dipindah ke view biar list gak perlu lagi embed
-- pos_sale_lines nested cuma buat di-reduce ulang di client.
create view pos_sales_with_status
  with (security_invoker = true) as
select
  ps.id,
  ps.customer_id,
  ps.sale_date,
  ps.cash_account_id,
  ps.revenue_journal_entry_id,
  ps.source_ref,
  ps.created_at,
  t.total,
  case when c.is_cancelled then 'dibatalkan' else 'normal' end as status
from pos_sales ps
cross join lateral (
  select coalesce(sum(line_amount), 0) as total from pos_sale_lines where pos_sale_id = ps.id
) t
cross join lateral (
  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = ps.revenue_journal_entry_id
  ) as is_cancelled
) c;

grant select on pos_sales_with_status to authenticated;
