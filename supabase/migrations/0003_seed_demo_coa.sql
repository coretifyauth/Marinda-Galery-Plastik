-- Seed data COA untuk story CV Roti Barokah (docs/story/chart-of-accounts.md).
-- Bukan schema, tapi data demo yang beneran dipakai lintas fase roadmap
-- (Journal Entry, AR, AP, dst bakal posting ke akun-akun ini).

-- Header dulu (parent_id null), leaf nunjuk ke header via subquery by code (code unique).

insert into accounts (code, name, category) values
  ('1000', 'Kas', 'asset'),
  ('1300', 'Piutang Usaha', 'asset'),
  ('1400', 'Persediaan Bahan Baku', 'asset'),
  ('1600', 'Aset Tetap', 'asset'),
  ('2100', 'Utang Usaha', 'liability'),
  ('2200', 'Utang Bank', 'liability'),
  ('3100', 'Modal Pemilik', 'equity'),
  ('3200', 'Laba Ditahan', 'equity'),
  ('4100', 'Pendapatan Penjualan Toko', 'revenue'),
  ('4200', 'Pendapatan Penjualan Grosir', 'revenue'),
  ('5100', 'Harga Pokok Penjualan', 'expense'),
  ('5200', 'Beban Gaji Karyawan', 'expense'),
  ('5300', 'Beban Sewa Toko', 'expense'),
  ('5400', 'Beban Listrik dan Air', 'expense'),
  ('5500', 'Beban Bunga Bank', 'expense');

insert into accounts (code, name, category, parent_id) values
  ('1100', 'Kas Toko', 'asset', (select id from accounts where code = '1000')),
  ('1200', 'Kas di Bank', 'asset', (select id from accounts where code = '1000')),
  ('1610', 'Peralatan Oven', 'asset', (select id from accounts where code = '1600')),
  ('1620', 'Kendaraan Motor', 'asset', (select id from accounts where code = '1600'));
