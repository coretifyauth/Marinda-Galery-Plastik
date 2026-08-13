-- Revisi 0021_item_unit_barcode.sql: format kode internal diganti dari sequence
-- polos (SKU-000001) jadi format konsisten sama dokumen lain di seluruh project
-- (SKU-2026-00001) -- reuse generate_document_number() (0011_document_numbering.sql)
-- alih-alih sequence terpisah. Lihat memory/architecture/data/inventory-schema.md
-- submodule "Kode Scan Barang (Barcode/QR per Satuan Jual)" buat rasional lengkap
-- (kenapa reuse ini AMAN buat identitas permanen, beda dari kekhawatiran awal).
--
-- item_units.barcode (kolom, constraint unique) dari 0021 TIDAK berubah -- cuma
-- mekanisme GENERATE kode internalnya yang diganti.

drop function if exists generate_item_unit_barcode();
drop sequence if exists item_unit_barcode_seq;

-- doc_type ini SENGAJA bukan nama tabel transaksional (beda dari 29 doc_type lain
-- di document_number_types) -- gak ada tabel "item_unit_barcodes" tersendiri, kode
-- ini nempel ke SEBAGIAN baris item_units (yang user pilih generate, on-demand),
-- bukan otomatis 1 nomor per baris kayak dokumen transaksi lain.
insert into document_number_types (doc_type, prefix, label) values
  ('item_unit_barcodes', 'SKU', 'Kode Scan Barang (item_units.barcode)');
