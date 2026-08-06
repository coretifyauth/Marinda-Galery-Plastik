-- Seed data AP Credit Note (Retur Barang ke Supplier) untuk story CV Roti Barokah
-- (docs/story/accounts-payable.md skenario 6-10). Lanjutan cross-modul dari
-- docs/story/inventory.md (bill Toko Gula Sejahtera Tahap 3 'GRN-GULA-001' & Tahap 5
-- 'GRN-GULA-002', 0013_seed_demo_inventory.sql) -- posisi akhir Gula Pasir per 25 Agustus
-- 2026: qty_on_hand 39kg, avg_cost Rp12.500/kg.

-- Akun baru yang belum ada di seed COA awal (0003) -- Piutang Retur Supplier, dibutuhkan
-- migration 0035 (ap_credit_notes/ap_return_credits). Pola sama '1420 Persediaan Barang
-- Jadi' (0013)/'2400 Saldo Kredit Customer' (0028): akun baru di-insert di seed, bukan di
-- migration schema.
insert into accounts (code, name, category) values
  ('1350', 'Piutang Retur Supplier', 'asset');

-- ============================================================
-- Skenario 6: Retur (Opsi A), bill 'GRN-GULA-001' belum lunas. 29 Agustus 2026, 4kg apek
-- @ avg_cost Rp12.500 = Rp50.000. Utang Usaha bill ini turun 260.000 -> 210.000.
-- ============================================================
select create_ap_credit_note(
  (select id from ap_bills where source_ref = 'GRN-GULA-001'),
  '2026-08-29', 'Retur-GULA-001', 50000,
  (select id from accounts where code = '2100'), (select id from accounts where code = '1400'),
  jsonb_build_array(
    jsonb_build_object('item_id', (select id from items where name = 'Gula Pasir'), 'qty_returned', 4)
  )
);

-- ============================================================
-- Skenario 7: Retur (Opsi A), bill 'Nota beli #SUP-020' (Skenario 1 AP, Rp300.000, udah
-- lunas 19 Juli 2026) -- financial-only (bill ini dibuat sebelum modul Inventory ada, gak
-- ada GRN). 30 Agustus 2026, potongan Rp50.000 -> outstanding udah 0, jadi seluruhnya
-- excess -> otomatis jadi ap_return_credits (Piutang Retur Supplier).
-- ============================================================
select create_ap_credit_note(
  (select id from ap_bills where source_ref = 'Nota beli #SUP-020'),
  '2026-08-30', 'Retur-GULA-002', 50000,
  (select id from accounts where code = '2100'), (select id from accounts where code = '1400'),
  null,
  (select id from accounts where code = '1350')
);

-- ============================================================
-- Skenario 8: Tukar barang (Opsi B), bill 'GRN-GULA-002' (Rp240.000, belum lunas, due 27
-- Agustus) -- BERDIRI SENDIRI, gak lewat create_ap_credit_note. 31 Agustus 2026, 3kg apek
-- @ Rp12.500 = Rp37.500 ditukar barang baik. Utang Usaha bill ini TETAP Rp240.000 penuh.
-- ============================================================
select create_purchase_replacement(
  (select id from ap_bills where source_ref = 'GRN-GULA-002'),
  '2026-08-31', 'Tukar-GULA-001',
  jsonb_build_array(
    jsonb_build_object('item_id', (select id from items where name = 'Gula Pasir'), 'qty', 3)
  ),
  (select id from accounts where code = '1400')
);

-- ============================================================
-- Skenario 9 & 10: Bill baru 2 September 2026 (10kg Gula Pasir @ Rp12.000 = Rp120.000),
-- saldo ap_return_credits dari Skenario 7 (Rp50.000) dipakai sebagian: Rp30.000 motong
-- bill baru ini, sisa Rp20.000 dicairkan tunai.
-- ============================================================
select create_ap_bill(
  (select id from suppliers where name = 'Toko Gula Sejahtera'),
  '2026-09-02', 'Ambil gula lagi dari Toko Gula Sejahtera', 'Nota beli #SUP-030', 120000,
  (select id from accounts where code = '1400'), (select id from accounts where code = '2100')
);

select apply_ap_return_credit(
  (select credit_note_id_lookup.credit_id from (
    select arc.id as credit_id
    from ap_return_credits arc
    join ap_credit_notes acn on acn.id = arc.credit_note_id
    where acn.source_ref = 'Retur-GULA-002'
  ) as credit_note_id_lookup),
  (select id from ap_bills where source_ref = 'Nota beli #SUP-030'),
  30000, '2026-09-02', 'Terapkan-Kredit-Retur-001',
  (select id from accounts where code = '1350'), (select id from accounts where code = '2100')
);

select refund_ap_return_credit(
  (select credit_note_id_lookup.credit_id from (
    select arc.id as credit_id
    from ap_return_credits arc
    join ap_credit_notes acn on acn.id = arc.credit_note_id
    where acn.source_ref = 'Retur-GULA-002'
  ) as credit_note_id_lookup),
  20000, '2026-09-02', 'Refund-Kredit-Retur-001',
  (select id from accounts where code = '1350'), (select id from accounts where code = '1200')
);
