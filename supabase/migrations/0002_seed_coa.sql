-- Seed data Chart of Accounts — kode akun generik saja (bukan cerita/transaksi).
-- Konsolidasi dari migration historis 0003 (seed dasar) + kode akun yang tadinya
-- nyebar di seed-seed modul lain (0013, 0015, 0023, 0025, 0030, 0032, 0036) — dipindah
-- ke sini karena akun itu bagian dari referensi COA, bukan cerita/skenario spesifik.
-- Transaksi/customer/invoice dari seed-seed itu TIDAK ikut dibawa (sengaja dihapus,
-- story akan dibangun ulang dari nol sebagai task terpisah).

-- Header dulu (parent_id null), leaf nunjuk ke header via subquery by code (code unique).

insert into accounts (code, name, category) values
  ('1000', 'Kas', 'asset'),
  ('1300', 'Piutang Usaha', 'asset'),
  ('1350', 'Piutang Retur Supplier', 'asset'),
  ('1400', 'Persediaan Bahan Baku', 'asset'),
  ('1420', 'Persediaan Barang Jadi', 'asset'),
  ('1600', 'Aset Tetap', 'asset'),
  ('2100', 'Utang Usaha', 'liability'),
  ('2200', 'Utang Bank', 'liability'),
  ('2300', 'Uang Muka Penjualan', 'liability'),
  ('2500', 'Saldo Kredit Retur Customer', 'liability'),
  ('3100', 'Modal Pemilik', 'equity'),
  ('3200', 'Laba Ditahan', 'equity'),
  ('4100', 'Pendapatan Penjualan Toko', 'revenue'),
  ('4200', 'Pendapatan Penjualan Grosir', 'revenue'),
  ('4300', 'Pendapatan Lain-lain', 'revenue'),
  ('5100', 'Harga Pokok Penjualan', 'expense'),
  ('5200', 'Beban Gaji Karyawan', 'expense'),
  ('5300', 'Beban Sewa Toko', 'expense'),
  ('5400', 'Beban Listrik dan Air', 'expense'),
  ('5500', 'Beban Bunga Bank', 'expense'),
  ('5600', 'Beban Penyusutan Oven', 'expense'),
  ('5610', 'Beban Penyusutan Motor', 'expense'),
  ('5700', 'Beban Piutang Tak Tertagih', 'expense');

insert into accounts (code, name, category, is_contra) values
  ('4900', 'Retur & Potongan Penjualan', 'revenue', true);

insert into accounts (code, name, category, parent_id) values
  ('1100', 'Kas Toko', 'asset', (select id from accounts where code = '1000')),
  ('1200', 'Kas di Bank', 'asset', (select id from accounts where code = '1000')),
  ('1610', 'Peralatan Oven', 'asset', (select id from accounts where code = '1600')),
  ('1620', 'Kendaraan Motor', 'asset', (select id from accounts where code = '1600'));

insert into accounts (code, name, category, is_contra, parent_id) values
  ('1630', 'Akumulasi Penyusutan Oven', 'asset', true, (select id from accounts where code = '1600')),
  ('1640', 'Akumulasi Penyusutan Motor', 'asset', true, (select id from accounts where code = '1600'));
