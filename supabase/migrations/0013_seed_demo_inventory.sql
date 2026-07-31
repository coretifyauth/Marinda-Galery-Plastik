-- Seed data Inventory untuk story CV Roti Barokah (docs/story/inventory.md), Agustus 2026.
-- items/bom via insert langsung (master data, gak ada RPC khusus, sama pola customers/suppliers).
-- PO/GRN/Production/Goods Issue via RPC create_purchase_order/create_goods_receipt/
-- create_production_order/create_goods_issue biar lewat validasi yang sama kayak app.
-- created_by NULL (auth.uid() kosong di konteks migration).

-- Akun baru yang belum ada di seed COA awal (0003) — Persediaan Barang Jadi,
-- dibutuhkan modul Inventory buat item FINISHED_GOOD (beda akun kontrol dari
-- '1400' Persediaan Bahan Baku, biar kartu stok bahan baku vs barang jadi kepisah).
insert into accounts (code, name, category) values
  ('1420', 'Persediaan Barang Jadi', 'asset');

insert into items (name, item_type, costing_method, uom, inventory_account_id) values
  ('Tepung Terigu', 'RAW_MATERIAL', 'FIFO', 'kg', (select id from accounts where code = '1400')),
  ('Gula Pasir', 'RAW_MATERIAL', 'WEIGHTED_AVERAGE', 'kg', (select id from accounts where code = '1400')),
  ('Roti Tawar', 'FINISHED_GOOD', 'FIFO', 'buah', (select id from accounts where code = '1420'));

-- Resep: 1 batch Roti Tawar = 5kg Tepung Terigu + 1kg Gula Pasir -> 50 buah roti.
insert into bom_headers (finished_item_id, output_qty)
values ((select id from items where name = 'Roti Tawar'), 50);

insert into bom_lines (bom_header_id, raw_material_item_id, qty_per_batch) values
  ((select id from bom_headers where finished_item_id = (select id from items where name = 'Roti Tawar')),
   (select id from items where name = 'Tepung Terigu'), 5),
  ((select id from bom_headers where finished_item_id = (select id from items where name = 'Roti Tawar')),
   (select id from items where name = 'Gula Pasir'), 1);

-- Tahap 1: PO tepung, 1 Agustus. Belum ada journal entry (PO cuma komitmen).
select create_purchase_order(
  (select id from suppliers where name = 'Toko Tepung Makmur'),
  '2026-08-01', '2026-08-05', 'PO-TEPUNG-001',
  jsonb_build_array(
    jsonb_build_object('item_id', (select id from items where name = 'Tepung Terigu'), 'qty_ordered', 50, 'unit_cost_expected', 10000)
  )
);

-- Tahap 2: tepung datang persis sesuai pesanan, 5 Agustus -> Lot #1 @ Rp10.000.
select create_goods_receipt(
  (select id from purchase_orders where source_ref = 'PO-TEPUNG-001'),
  '2026-08-05', 'SJ-TEPUNG-001',
  jsonb_build_array(
    jsonb_build_object(
      'po_line_id', (select id from purchase_order_lines where purchase_order_id = (select id from purchase_orders where source_ref = 'PO-TEPUNG-001')),
      'item_id', (select id from items where name = 'Tepung Terigu'),
      'qty_received', 50, 'unit_cost', 10000
    )
  ),
  'Terima tepung dari Toko Tepung Makmur', 'GRN-TEPUNG-001',
  (select id from accounts where code = '1400'), (select id from accounts where code = '2100')
);

-- Tahap 3: PO+GRN gula, 3 -> 8 Agustus. Penerimaan pertama, jadi avg_cost = Rp13.000.
select create_purchase_order(
  (select id from suppliers where name = 'Toko Gula Sejahtera'),
  '2026-08-03', '2026-08-08', 'PO-GULA-001',
  jsonb_build_array(
    jsonb_build_object('item_id', (select id from items where name = 'Gula Pasir'), 'qty_ordered', 20, 'unit_cost_expected', 13000)
  )
);

select create_goods_receipt(
  (select id from purchase_orders where source_ref = 'PO-GULA-001'),
  '2026-08-08', 'SJ-GULA-001',
  jsonb_build_array(
    jsonb_build_object(
      'po_line_id', (select id from purchase_order_lines where purchase_order_id = (select id from purchase_orders where source_ref = 'PO-GULA-001')),
      'item_id', (select id from items where name = 'Gula Pasir'),
      'qty_received', 20, 'unit_cost', 13000
    )
  ),
  'Terima gula dari Toko Gula Sejahtera', 'GRN-GULA-001',
  (select id from accounts where code = '1400'), (select id from accounts where code = '2100')
);

-- Tahap 4: PO+GRN tepung lagi, 10 -> 15 Agustus. Harga naik jadi Rp11.000 (price
-- variance informasional, gak diblokir) -> Lot #2. Kartu stok tepung: Lot #1 (50kg@10.000) + Lot #2 (50kg@11.000).
select create_purchase_order(
  (select id from suppliers where name = 'Toko Tepung Makmur'),
  '2026-08-10', '2026-08-15', 'PO-TEPUNG-002',
  jsonb_build_array(
    jsonb_build_object('item_id', (select id from items where name = 'Tepung Terigu'), 'qty_ordered', 50, 'unit_cost_expected', 10000)
  )
);

select create_goods_receipt(
  (select id from purchase_orders where source_ref = 'PO-TEPUNG-002'),
  '2026-08-15', 'SJ-TEPUNG-002',
  jsonb_build_array(
    jsonb_build_object(
      'po_line_id', (select id from purchase_order_lines where purchase_order_id = (select id from purchase_orders where source_ref = 'PO-TEPUNG-002')),
      'item_id', (select id from items where name = 'Tepung Terigu'),
      'qty_received', 50, 'unit_cost', 11000
    )
  ),
  'Terima tepung dari Toko Tepung Makmur (harga naik)', 'GRN-TEPUNG-002',
  (select id from accounts where code = '1400'), (select id from accounts where code = '2100')
);

-- Tahap 5: PO+GRN gula lagi, 18 -> 20 Agustus. Harga turun jadi Rp12.000 ->
-- avg_cost dihitung ulang: (20x13.000 + 20x12.000)/40 = Rp12.500.
select create_purchase_order(
  (select id from suppliers where name = 'Toko Gula Sejahtera'),
  '2026-08-18', '2026-08-20', 'PO-GULA-002',
  jsonb_build_array(
    jsonb_build_object('item_id', (select id from items where name = 'Gula Pasir'), 'qty_ordered', 20, 'unit_cost_expected', 13000)
  )
);

select create_goods_receipt(
  (select id from purchase_orders where source_ref = 'PO-GULA-002'),
  '2026-08-20', 'SJ-GULA-002',
  jsonb_build_array(
    jsonb_build_object(
      'po_line_id', (select id from purchase_order_lines where purchase_order_id = (select id from purchase_orders where source_ref = 'PO-GULA-002')),
      'item_id', (select id from items where name = 'Gula Pasir'),
      'qty_received', 20, 'unit_cost', 12000
    )
  ),
  'Terima gula dari Toko Gula Sejahtera (harga turun)', 'GRN-GULA-002',
  (select id from accounts where code = '1400'), (select id from accounts where code = '2100')
);

-- Tahap 6: Produksi 1 batch, 22 Agustus. Konsumsi 5kg tepung (FIFO, Lot #1) +
-- 1kg gula (Weighted Average @ Rp12.500) -> 50 buah roti @ Rp1.250/buah (Lot #P1).
select create_production_order(
  (select id from bom_headers where finished_item_id = (select id from items where name = 'Roti Tawar')),
  50, '2026-08-22', 'PROD-001',
  (select id from accounts where code = '1420'), (select id from accounts where code = '1400')
);

-- Tahap 7: Jual 30 dari 50 roti ke Warung Pak Budi, 25 Agustus. Rp2.000/buah =
-- Rp60.000 pendapatan, HPP FIFO dari Lot #P1 = 30 x Rp1.250 = Rp37.500. Laba kotor Rp22.500.
select create_goods_issue(
  (select id from customers where name = 'Warung Pak Budi'),
  '2026-08-25', 'Jual roti ke Warung Pak Budi', 'Nota grosir #005', 60000,
  (select id from accounts where code = '1300'), (select id from accounts where code = '4200'),
  jsonb_build_array(
    jsonb_build_object('item_id', (select id from items where name = 'Roti Tawar'), 'qty_issued', 30)
  ),
  (select id from accounts where code = '5100'), (select id from accounts where code = '1420')
);
