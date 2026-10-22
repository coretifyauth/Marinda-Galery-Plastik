\set ON_ERROR_STOP on
-- Tes NEGATIF 0058 (database LOKAL saja, setelah stage-0057.sql, SEBELUM 0058 sungguhan).
-- Menyisipkan barang masuk alur lama bernilai 0 yang sudah dibatalkan TANPA jurnal (bentuk yang mungkin ada di
-- database lain, karena 0056 melewati jurnal kalau nilai 0), lalu menjalankan 0058 di atasnya. Harus GAGAL
-- dengan pesan "bentuknya gak sesuai" dan -- karena dibungkus transaksi yang tidak pernah di-commit -- gak
-- meninggalkan apa pun. Pemakaian (dari root repo):
--   ( cat supabase/tests/tagihan-dulu-barang-menyusul/negative-0058-setup.sql
--     cat supabase/migrations/0058_hapus_alur_barang_masuk_tanpa_tagihan.sql ) \
--   | docker exec -i supabase_db_<project_id> psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1
-- Lalu cek: skema archive tidak ada dan jumlah barang masuk INBOUND tidak berubah.
begin;
alter table goods_notes disable trigger goods_notes_inbound_from_bill_guard_trigger;
insert into goods_notes (type, counterparty_id, note_date, inbound_flow, source_ref)
  values ('INBOUND', 'a0000000-0000-0000-0000-000000000001', '2026-10-28', 'deferred', 'GRN-NOL-1');
insert into goods_note_cancellations (goods_note_id)
  select id from goods_notes where source_ref = 'GRN-NOL-1';
alter table goods_notes enable trigger goods_notes_inbound_from_bill_guard_trigger;
-- (migration 0058 menyusul dari stdin; harus berhenti di pagar bentuk data)
