-- 0055_relax_item_unit_nested_guard.sql
-- Longgarkan Nested Conversion Factor Guard (0005): faktor konversi antar satuan 1 barang TIDAK
-- lagi wajib kelipatan bulat dari satuan di bawahnya. Konteks: barang dengan kemasan nyata yang
-- gak nested (mis. Lembar=1, Bungkus=100, Pack=1000, Sak=19200 -- 19200 bukan kelipatan 1000)
-- ditolak trigger lama padahal datanya benar.
--
-- Kenapa aman: tampilan stok gabungan (apps/erp/src/lib/stock-display.ts) greedy terbesar->terkecil
-- dan sisanya selalu jatuh ke satuan dasar (faktor 1, dijamin ada & unik lewat check is_base +
-- item_units_one_base_per_item) -- hasilnya tetap tepat walau faktor gak nested; paling banter
-- kombinasi satuannya kurang ringkas. Stok/HPP selalu di satuan dasar, gak terpengaruh.
--
-- Pengganti: faktor wajib bilangan bulat (numeric(14,4) memang nyimpen pecahan; satuan jual
-- pecahan gak punya arti di bisnis ini dan merusak breakdown). ADD CONSTRAINT memvalidasi data
-- existing -- kalau ada baris pecahan, migration gagal (sengaja, bukan diam-diam dilewati).

drop trigger item_units_nested_conversion_guard on item_units;
drop function check_item_units_nested_conversion();

alter table item_units
  add constraint item_units_conversion_factor_whole
  check (conversion_factor = trunc(conversion_factor));
