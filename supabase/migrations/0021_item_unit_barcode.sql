-- Kode Scan Barang (Barcode/QR per Satuan Jual) -- lihat memory/architecture/data/inventory-schema.md
-- submodule "Kode Scan Barang (Barcode/QR per Satuan Jual)". Kode disimpan di level item_units
-- (satuan jual), BUKAN items -- barang yang dijual >1 satuan (pcs/lusin/pack) kemasan fisiknya
-- beda-beda, kodenya juga wajib bisa beda-beda per satuan (lihat docs/domain/inventory.md buat
-- alasan bisnis lengkap). Nullable & opsional per baris -- gak semua satuan wajib punya kode.

alter table item_units add column barcode text unique;

-- Sequence buat auto-generate kode internal (tombol "Buat Kode" di UI, dipakai buat barang yang
-- gak punya barcode pabrik) -- BEDA dari document_number_counters (reset tahunan per jenis
-- dokumen TRANSAKSI). Kode ini identitas MASTER DATA, sekali dibuat permanen, gak pernah
-- reset/berubah -- cukup 1 sequence global, gak perlu tabel counter kayak document numbering.
create sequence item_unit_barcode_seq;

-- security invoker (default) -- beda dari generate_document_number() yang security definer,
-- karena di situ document_number_counters sengaja gak ada grant/policy write sama sekali.
-- Di sini cukup grant usage langsung ke sequence-nya, gak perlu bypass privilege apa pun.
create function generate_item_unit_barcode() returns text
language sql
as $$
  select 'SKU-' || lpad(nextval('item_unit_barcode_seq')::text, 6, '0');
$$;

grant usage on sequence item_unit_barcode_seq to authenticated;
grant execute on function generate_item_unit_barcode() to authenticated;
