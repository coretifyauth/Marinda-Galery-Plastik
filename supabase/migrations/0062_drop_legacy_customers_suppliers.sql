-- Drop tabel legacy `customers`/`suppliers` -- digantikan `counterparties`+
-- `counterparty_type_mapping` sejak migration 0059 (Fase 1 order-generalization,
-- 2026-09-03), sengaja belum di-drop waktu itu buat jeda observasi
-- (memory/architecture/data/counterparty-schema.md). Diverifikasi ulang sebelum drop
-- ini:
--   - Gak ada 1 pun FK yang masih nunjuk ke 2 tabel ini (semua 11 tabel yang dulu FK
--     ke customers/suppliers sudah direpoint ke counterparties oleh 0059; tabel baru
--     manapun yang lahir setelah 0059 -- termasuk `orders`, 0060 -- dari awal udah
--     langsung pakai counterparty_id).
--   - Gak ada 1 pun query frontend (apps/erp, apps/pos) yang nge-`.from("customers")`
--     atau `.from("suppliers")` -- halaman /customers dan /suppliers tetap ada
--     sebagai nama route/URL (keputusan UI), tapi keduanya query counterparties.
--   - 1 RPC yang KETAUAN masih baca `suppliers` langsung (create_goods_receipt,
--     jalur terima barang tanpa PO) sudah diperbaiki migration 0061 SEBELUM
--     migration ini -- tanpa fix itu, drop ini bakal langsung mecahin jalur
--     tersebut ("relation suppliers does not exist").
--   - `delete_customer`/`delete_supplier` (0013_master_data_smart_delete.sql) udah
--     didrop duluan di 0059 pas digantikan `delete_counterparty` -- baris di bawah
--     murni defensif/dokumentasi (`if exists` bikin no-op aman), bukan drop baru.

drop function if exists delete_customer(uuid);
drop function if exists delete_supplier(uuid);

drop table customers;
drop table suppliers;
