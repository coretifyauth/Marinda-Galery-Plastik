-- View buat filter status di list page AP Deposits (server-side WHERE), nutup
-- memory/scope-debt/ap-deposits-status-filter.md. Status sebelumnya cuma dihitung client-side
-- lewat depositStatus() di lib/ap-deposits/schema.ts dari data nested -- gak bisa di-WHERE-kan.
--
-- Reuse ap_deposit_remaining() (0006) sebagai sumber kebenaran tunggal -- logic sama persis
-- dipakai guard trigger applications/refunds/forfeitures, jadi status view ini gak duplikat
-- aturan "applications exclude-reversed, refunds & forfeitures gak punya jalur reversal".
-- LATERAL biar ap_deposit_remaining() cuma dievaluasi sekali per baris (dipakai buat remaining
-- & status dua-duanya), bukan dipanggil ulang per referensi.
--
-- security_invoker wajib -- tanpa itu view jalan dengan privilege pemilik (bukan RLS pemanggil),
-- jadi kebijakan ap_deposits_select (0006) gak akan ke-enforce buat query lewat view ini.
create view ap_deposits_with_status
  with (security_invoker = true) as
select
  ad.id,
  ad.supplier_id,
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
from ap_deposits ad
cross join lateral (select ap_deposit_remaining(ad.id) as remaining) r;

grant select on ap_deposits_with_status to authenticated;
