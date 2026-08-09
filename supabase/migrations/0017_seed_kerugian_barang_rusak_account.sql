-- Akun baru buat Kerugian Barang Rusak (migration 0015 sisi AR, 0016 sisi AP) -- di-insert
-- di migration seed terpisah, bukan di migration schema, pola sama semua akun baru lain
-- (1350, 1360, 2300, 2500, 4300, 5700, 5800, dst). Dipakai bareng kedua sisi -- baris
-- RESALABLE/DAMAGED di AR Credit Note, dan Opsi C (create_purchase_writeoff) di AP.

insert into accounts (code, name, category) values
  ('5900', 'Beban Kerugian Barang Rusak', 'expense');
