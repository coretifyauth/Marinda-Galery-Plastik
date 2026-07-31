-- Seed data Fixed Assets untuk story CV Roti Barokah (docs/story/fixed-assets.md).
-- fixed_assets via RPC create_fixed_asset, penyusutan via post_depreciation,
-- akuisisi via create_journal_entry manual (bukan RPC khusus, sama pola akuisisi generik).
-- created_by NULL (auth.uid() kosong di konteks migration).

-- Akun baru yang belum ada di seed COA awal (0003) — 2 akun kontra-asset
-- (Akumulasi Penyusutan, is_contra=true) + 2 akun Beban Penyusutan, child dari
-- 1600 Aset Tetap / berdiri sendiri sebagai leaf kategori expense.
insert into accounts (code, name, category, is_contra, parent_id) values
  ('1630', 'Akumulasi Penyusutan Oven', 'asset', true, (select id from accounts where code = '1600')),
  ('1640', 'Akumulasi Penyusutan Motor', 'asset', true, (select id from accounts where code = '1600'));

insert into accounts (code, name, category) values
  ('5600', 'Beban Penyusutan Oven', 'expense'),
  ('5610', 'Beban Penyusutan Motor', 'expense');

-- Tahap 1: Akuisisi Oven, 10 Januari 2025, dibayar KUR (Utang Bank).
select create_fixed_asset(
  'Oven Tambahan',
  (select id from accounts where code = '1610'),
  (select id from accounts where code = '1630'),
  (select id from accounts where code = '5600'),
  15000000, 0, 60, '2025-01-10',
  'straight_line', null
);

select create_journal_entry(
  '2025-01-10', 'Beli oven tambahan (KUR)', 'KUR-OVEN-001',
  jsonb_build_array(
    jsonb_build_object('account_id', (select id from accounts where code = '1610'), 'debit', 15000000, 'credit', 0),
    jsonb_build_object('account_id', (select id from accounts where code = '2200'), 'debit', 0, 'credit', 15000000)
  )
);

-- Tahap 2: Akuisisi Motor, 15 Januari 2025, dibayar KUR.
select create_fixed_asset(
  'Motor Antar',
  (select id from accounts where code = '1620'),
  (select id from accounts where code = '1640'),
  (select id from accounts where code = '5610'),
  24000000, 2400000, 48, '2025-01-15',
  'declining_balance', 0.40
);

select create_journal_entry(
  '2025-01-15', 'Beli motor antar (KUR)', 'KUR-MOTOR-001',
  jsonb_build_array(
    jsonb_build_object('account_id', (select id from accounts where code = '1620'), 'debit', 24000000, 'credit', 0),
    jsonb_build_object('account_id', (select id from accounts where code = '2200'), 'debit', 0, 'credit', 24000000)
  )
);

-- Tahap 3: Penyusutan Oven, straight-line Rp250.000/bulan, 12x posting bulanan
-- sepanjang 2025 -> Akumulasi Rp3.000.000, Nilai Buku Rp12.000.000.
select post_depreciation((select id from fixed_assets where name = 'Oven Tambahan'), '2025-01-31', 'PENYST-OVEN-2025-01');
select post_depreciation((select id from fixed_assets where name = 'Oven Tambahan'), '2025-02-28', 'PENYST-OVEN-2025-02');
select post_depreciation((select id from fixed_assets where name = 'Oven Tambahan'), '2025-03-31', 'PENYST-OVEN-2025-03');
select post_depreciation((select id from fixed_assets where name = 'Oven Tambahan'), '2025-04-30', 'PENYST-OVEN-2025-04');
select post_depreciation((select id from fixed_assets where name = 'Oven Tambahan'), '2025-05-31', 'PENYST-OVEN-2025-05');
select post_depreciation((select id from fixed_assets where name = 'Oven Tambahan'), '2025-06-30', 'PENYST-OVEN-2025-06');
select post_depreciation((select id from fixed_assets where name = 'Oven Tambahan'), '2025-07-31', 'PENYST-OVEN-2025-07');
select post_depreciation((select id from fixed_assets where name = 'Oven Tambahan'), '2025-08-31', 'PENYST-OVEN-2025-08');
select post_depreciation((select id from fixed_assets where name = 'Oven Tambahan'), '2025-09-30', 'PENYST-OVEN-2025-09');
select post_depreciation((select id from fixed_assets where name = 'Oven Tambahan'), '2025-10-31', 'PENYST-OVEN-2025-10');
select post_depreciation((select id from fixed_assets where name = 'Oven Tambahan'), '2025-11-30', 'PENYST-OVEN-2025-11');
select post_depreciation((select id from fixed_assets where name = 'Oven Tambahan'), '2025-12-31', 'PENYST-OVEN-2025-12');

-- Tahap 4: Penyusutan Motor, declining balance 40%/tahun, 1x posting tahunan
-- (beda cadence dari oven -> period fleksibel, bukan dihardcode bulanan).
-- Tahun 1: 24.000.000 x 40% = Rp9.600.000 -> Akumulasi 9.600.000, Nilai Buku 14.400.000.
select post_depreciation((select id from fixed_assets where name = 'Motor Antar'), '2025-12-31', 'PENYST-MOTOR-2025');
