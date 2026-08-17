-- View buat filter status di list page AR Deposits (server-side WHERE), nutup
-- memory/scope-debt/ar-deposits-status-filter.md. Mirror persis ap_deposits_with_status (0031)
-- -- arah kebalik (uang muka DITERIMA dari customer, bukan dibayar ke supplier), formula status
-- identik.
--
-- Reuse ar_deposit_remaining() (0005/migration 0012 pra-squash) sebagai sumber kebenaran
-- tunggal -- logic sama persis dipakai guard trigger applications/refunds/forfeitures. LATERAL
-- biar ar_deposit_remaining() cuma dievaluasi sekali per baris. security_invoker wajib biar RLS
-- ar_deposits_select tetap ke-enforce lewat view.
create view ar_deposits_with_status
  with (security_invoker = true) as
select
  ad.id,
  ad.customer_id,
  ad.deposit_date,
  ad.source_ref,
  ad.amount,
  ad.journal_entry_id,
  ad.created_at,
  r.remaining,
  case
    when r.remaining <= 0.005 then 'selesai'
    when r.remaining < ad.amount then 'sebagian'
    else 'belum_dipakai'
  end as status
from ar_deposits ad
cross join lateral (select ar_deposit_remaining(ad.id) as remaining) r;

grant select on ar_deposits_with_status to authenticated;
