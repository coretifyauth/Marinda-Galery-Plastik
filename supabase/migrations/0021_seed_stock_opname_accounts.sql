-- Akun baru buat Stock Opname (migration 0020) -- di-insert di migration seed terpisah,
-- bukan di migration schema, pola sama semua akun baru lain (1350, 1360, 5700, 5800, 5900,
-- dst). 2 akun terpisah (bukan 1 akun netting) -- keputusan bisnis biar laporan tetap
-- nunjukin rincian per barang, bukan cuma hasil bersih gabungan.

insert into accounts (code, name, category) values
  ('6000', 'Beban Selisih Persediaan', 'expense'),
  ('4400', 'Pendapatan Selisih Persediaan', 'revenue');
