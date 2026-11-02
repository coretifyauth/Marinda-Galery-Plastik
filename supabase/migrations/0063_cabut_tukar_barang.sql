-- 0063_cabut_tukar_barang.sql
-- Fitur Tukar Barang (AP, tukar barang rusak ke supplier) dan Penggantian Barang Garansi (AR) dicabut -- keputusan owner
-- 2026-11-02, belum dipakai di operasional (data live saat itu: 1 baris uji OUTBOUND, 0 baris INBOUND).
--
-- Yang dicabut hanya JALUR PEMBUATAN BARU. Tabel replacements / replacement_lines TIDAK di-drop: barisnya immutable,
-- punya jurnal, dan dirujuk inventory_movements (FK replacement_line_id), jadi baris yang sudah ada tetap sebagai riwayat
-- baca-saja. Konsekuensi yang disengaja:
--   * purchase_returned_qty / sales_returned_qty tetap menghitung baris lama sebagai klaim qty.
--   * cancel_ap_bill / cancel_ar_invoice tetap menolak tagihan/invoice yang punya baris lama.
-- Tidak ada migration yang mengubah dua fungsi itu -- kalau baris uji itu perlu dibereskan, putuskan terpisah.
--
-- Nomor dokumen 'purchase_replacements' / 'warranty_replacements' di document_number_types dibiarkan (tidak dipakai lagi).

-- Supabase CLI menjalankan tiap statement TERPISAH (bukan satu transaksi per file) -- transaksi harus eksplisit supaya gagal di tengah = batal semua.
begin;

drop function create_replacement(text, uuid, date, text, jsonb, uuid, uuid);

-- Guard qty hanya berjalan saat insert baris baru; tanpa insert lagi, trigger dan fungsinya tidak berguna.
drop trigger replacement_lines_no_over_claim_trigger on replacement_lines;
drop function replacement_lines_no_over_claim();

drop policy replacements_insert on replacements;
drop policy replacement_lines_insert on replacement_lines;
revoke insert on replacements from authenticated;
revoke insert on replacement_lines from authenticated;

commit;
