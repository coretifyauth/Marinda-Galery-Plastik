-- Seed data AR Credit Note untuk story CV Roti Barokah (docs/story/accounts-receivable.md
-- Skenario 5 & 6), September 2026. Lanjutan dari 0008 (seed AR) & 0013 (seed Inventory).

-- Akun kontra-revenue, diprediksi di chart-of-accounts.md sejak Fase 6, baru dipakai sekarang.
insert into accounts (code, name, category, is_contra) values
  ('4900', 'Retur & Potongan Penjualan', 'revenue', true);

-- Roti Tawar gampang basi — window retur pendek, 3 hari sejak invoice (Skenario 6 di
-- bawah retur persis di H+3, sengaja pas biar nunjukin batas atas window masih diterima).
update items set return_window_days = 3 where name = 'Roti Tawar';

-- Skenario 5: retur financial-only, Warung Kang Ade. Invoice 12 Juli (900.000, lunas 26 Juli)
-- gak lewat create_goods_issue (predates modul Inventory) -> p_lines null, 1 jurnal.
select create_ar_credit_note(
  (select id from ar_invoices where source_ref = 'Nota grosir #004'),
  '2026-09-05', 'Retur roti apek 5 warung Kang Ade', 50000,
  (select id from accounts where code = '4900'), (select id from accounts where code = '1300')
);

-- Skenario 6: retur full, Warung Pak Budi. Invoice 25 Agustus (Nota grosir #005) lewat
-- create_goods_issue -> p_lines terisi, 2 jurnal + stok balik. 3 dari 30 roti apek.
select create_ar_credit_note(
  (select id from ar_invoices where source_ref = 'Nota grosir #005'),
  '2026-08-28', 'Retur roti apek 3 warung Pak Budi', 6000,
  (select id from accounts where code = '4900'), (select id from accounts where code = '1300'),
  jsonb_build_array(
    jsonb_build_object('item_id', (select id from items where name = 'Roti Tawar'), 'qty_returned', 3)
  ),
  (select id from accounts where code = '5100'), (select id from accounts where code = '1420')
);
