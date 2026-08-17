-- View buat filter status di list page AP Bills (server-side WHERE), nutup
-- memory/scope-debt/ap-bills-status-filter.md. Mirror pola ap_deposits_with_status (0031).
--
-- `outstanding` reuse ap_bill_remaining() (0006, diperbaiki 0010) -- sumber kebenaran tunggal,
-- gak duplikat reducer. Tapi status BUKAN cuma "outstanding vs amount" kayak AP Deposits --
-- billStatus() (apps/erp/src/lib/ap-bills/schema.ts) sengaja BEDAKAN retur (ap_credit_notes) dari
-- pembayaran/DP: retur doang yang ngurangin outstanding TANPA payment/DP aktif tetap dianggap
-- "belum" (bukan "sebagian"), karena customer belum benar-benar bayar apa pun. Makanya butuh
-- `allocated` (SUM ap_payments) dan `deposit_applied` (SUM ap_deposit_applications aktif) kePisah
-- dari outstanding buat threshold "sebagian". `is_cancelled` mirror cek reverses_entry_id yang
-- sebelumnya dihitung client-side dari query terpisah (reversedEntryIds).
--
-- `deposit_applied` exclude application yang ter-reverse (beda dari billStatus() client yang sum
-- mentah tanpa filter) -- aman karena satu-satunya jalur reversal application adalah
-- cancel_ap_bill() sendiri (0006), yang selalu reverse journal_entry_id bill barengan, jadi bill
-- manapun yang punya application ter-reverse otomatis udah is_cancelled = true duluan sebelum
-- cabang "sebagian" pernah dicek -- gak pernah nyebabin hasil beda.
create view ap_bills_with_status
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
  end as status
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

grant select on ap_bills_with_status to authenticated;
