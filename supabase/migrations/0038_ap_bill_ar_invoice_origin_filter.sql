-- Nambah kolom `origin` ke ap_bills_with_status (0032) & ar_invoices_with_status (0033), biar
-- kolom "Tipe" yang udah ada di list /ap-bills & /ar-invoices (badge "Dari GRN"/"Bill Langsung",
-- "Dari Sales Order"/"Goods Issue Langsung"/"Financial Only") bisa difilter server-side juga --
-- sebelumnya cuma dihitung client-side lewat billOrigin()/invoiceOrigin()
-- (apps/erp/src/lib/ap-bills/schema.ts, ar-invoices/schema.ts) dari embed nested
-- goods_receipt_notes/goods_issues yang gak bisa di-WHERE-kan.
--
-- CREATE OR REPLACE VIEW dipakai (bukan migration baru bikin view baru) karena cuma NAMBAH 1
-- kolom di akhir daftar kolom -- Postgres izinin ini tanpa drop, grant existing tetap berlaku,
-- gak perlu migration baru buat view yang sama. Kolom status/outstanding/dst SENGAJA disalin
-- persis dari 0032/0033, gak ada perubahan logic status apa pun di sini.

create or replace view ap_bills_with_status
  with (security_invoker = true) as
select
  ab.id,
  ab.supplier_id,
  ab.bill_date,
  ab.due_date,
  ab.description,
  ab.source_ref,
  ab.supplier_document_ref,
  ab.amount,
  ab.journal_entry_id,
  ab.created_at,
  o.outstanding,
  case
    when c.is_cancelled then 'dibatalkan'
    when o.outstanding <= 0.005 then 'lunas'
    when p.allocated > 0 or d.deposit_applied > 0 then 'sebagian'
    else 'belum'
  end as status,
  case
    when exists (select 1 from goods_receipt_notes grn where grn.bill_id = ab.id) then 'grn'
    else 'langsung'
  end as origin
from ap_bills ab
cross join lateral (select ap_bill_remaining(ab.id) as outstanding) o
cross join lateral (
  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = ab.journal_entry_id
  ) as is_cancelled
) c
cross join lateral (
  select coalesce(sum(amount), 0) as allocated from ap_payments where bill_id = ab.id
) p
cross join lateral (
  select coalesce(sum(ada.amount), 0) as deposit_applied
  from ap_deposit_applications ada
  where ada.bill_id = ab.id
    and not exists (select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id)
) d;

create or replace view ar_invoices_with_status
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
  end as status,
  case
    when not exists (select 1 from goods_issues gi where gi.invoice_id = ai.id) then 'financial_only'
    when exists (
      select 1 from goods_issues gi
      join goods_issue_lines gil on gil.goods_issue_id = gi.id
      where gi.invoice_id = ai.id and gil.so_line_id is not null
    ) then 'sales_order'
    else 'goods_issue'
  end as origin
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
