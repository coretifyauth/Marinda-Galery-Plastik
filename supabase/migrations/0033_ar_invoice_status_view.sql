-- View buat filter status di list page AR Invoices (server-side WHERE), nutup
-- memory/scope-debt/ar-invoices-status-filter.md. Mirror pola ap_bills_with_status (0032) --
-- reuse ar_invoice_remaining() (0005, diperbaiki 0020 + 0028) buat `outstanding`, tapi status
-- butuh reducer allocated/deposit_applied/written_off kePisah karena invoiceStatus()
-- (apps/erp/src/lib/ar-invoices/schema.ts) sengaja BEDAKAN retur doang (gak dianggap "sebagian")
-- dari payment/DP/writeoff aktif. Reducer di sini SENGAJA gak filter reversal (persis
-- invoiceStatus() client -- lihat komentar di sana: kalau ada deposit application/writeoff yang
-- di-reverse, itu cuma kejadian lewat unwind pembatalan invoice itu sendiri, jadi udah kena
-- cabang is_cancelled duluan).
create view ar_invoices_with_status
  with (security_invoker = true) as
select
  ai.id,
  ai.customer_id,
  ai.invoice_date,
  ai.due_date,
  ai.description,
  ai.source_ref,
  ai.amount,
  ai.journal_entry_id,
  ai.created_at,
  o.outstanding,
  r.returned,
  case
    when c.is_cancelled then 'dibatalkan'
    when w.written_off > 0 and o.outstanding <= 0.005 then 'dihapusbukukan'
    when o.outstanding <= 0.005 then 'lunas'
    when p.allocated > 0 or d.deposit_applied > 0 then 'sebagian'
    else 'belum'
  end as status
from ar_invoices ai
cross join lateral (select ar_invoice_remaining(ai.id) as outstanding) o
cross join lateral (
  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = ai.journal_entry_id
  ) as is_cancelled
) c
cross join lateral (
  select coalesce(sum(amount), 0) as allocated from ar_payments where invoice_id = ai.id
) p
cross join lateral (
  select coalesce(sum(amount), 0) as deposit_applied from ar_deposit_applications where invoice_id = ai.id
) d
cross join lateral (
  select coalesce(sum(amount), 0) as written_off from ar_bad_debt_writeoffs where invoice_id = ai.id
) w
cross join lateral (
  select coalesce(sum(amount), 0) as returned from ar_credit_notes where invoice_id = ai.id
) r;

grant select on ar_invoices_with_status to authenticated;
