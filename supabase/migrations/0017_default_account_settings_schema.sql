-- ============================================================
-- Default Account Settings — memory/scope-debt equivalent: banyak form transaksi
-- (AR Invoice, AP Bill, Goods Issue, Goods Receipt, Production Order, Sales Order,
-- AR/AP Deposit, dan hampir semua panel aksi di halaman detail — retur, write-off,
-- payment, refund, terapkan/hanguskan DP) membiarkan user memilih BEBAS akun COA
-- (leaf account manapun) untuk baris yang sebenarnya SELALU resolve ke 1 akun yang
-- sama tiap kali. Ini sudah kejadian jadi bug nyata: panel Retur AP Bill pernah
-- kena "Akun Utang Usaha (debit)" diisi akun Kas, jurnal excess salah arah.
--
-- default_account_settings: 1 baris = 1 "slot peran akun" yang dipakai berulang
-- lintas modul (mis. role_key 'ar.receivable' dipakai create_ar_invoice DAN
-- create_warranty_replacement DAN apply_ar_deposit DAN record_ar_payment, dst --
-- semuanya selalu akun 1300 Piutang Usaha yang sama). Form FE lookup by role_key,
-- render read-only (bukan Select bebas), admin bisa reassign lewat halaman Settings
-- kalau suatu saat akunnya perlu diganti -- tanpa deploy kode baru.
--
-- Pola singleton-per-baris niru tax_settings (baris diseed migration ini, admin
-- cuma UPDATE, gak ada INSERT baru dari UI -- role_key yang valid ditentukan kode
-- FE, bukan bebas ditambah admin). BEDA dari ar_invoice_charge_types dkk (katalog
-- kategori pendapatan/beban TAMBAHAN yang tetap ada & TIDAK diganti mekanisme ini --
-- itu tempat user genuinely punya pilihan; role_key di sini cuma buat baris PRIMER
-- yang gak pernah punya pilihan bisnis).
--
-- fixed_asset_account_presets: BEDA pola -- Fixed Assets butuh 3 akun sekaligus
-- (aset/akumulasi/beban) dan aset BARU (jenis belum ada presetnya) tetap mungkin
-- muncul, jadi bukan singleton fixed-role kayak di atas. Katalog preset (mirip
-- ar_invoice_charge_types) -- admin daftarkan 1 preset per JENIS aset (mis. "Rak
-- Display Toko", "Mobil Pickup Antar Barang"), form Fixed Assets pilih 1 preset
-- (bukan 3 akun terpisah) -- mencegah kombinasi akun aset+akumulasi yang gak
-- sepasang (mis. aset Rak dipasangkan akumulasi punya Mobil Pickup).
-- ============================================================

create table default_account_settings (
  id uuid primary key default gen_random_uuid(),
  role_key text not null unique,
  label text not null,
  account_id uuid not null references accounts(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create trigger default_account_settings_set_updated_at
  before update on default_account_settings
  for each row execute function set_updated_at();

create table fixed_asset_account_presets (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  asset_account_id uuid not null references accounts(id),
  accumulated_depreciation_account_id uuid not null references accounts(id),
  depreciation_expense_account_id uuid not null references accounts(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger fixed_asset_account_presets_set_updated_at
  before update on fixed_asset_account_presets
  for each row execute function set_updated_at();

-- ============================================================
-- Seed default_account_settings -- role_key -> akun, sesuai chart of accounts
-- saat ini (supabase/migrations/0002_seed_coa.sql + 0004/0005/0006 tambahan).
-- ============================================================

insert into default_account_settings (role_key, label, account_id) values
  ('ar.receivable', 'Piutang Usaha', (select id from accounts where code = '1300')),
  ('ar.revenue', 'Pendapatan Penjualan (Grosir/Termin)', (select id from accounts where code = '4200')),
  ('ar.contra_revenue', 'Retur & Potongan Penjualan', (select id from accounts where code = '4900')),
  ('ar.deposit_liability', 'Uang Muka Penjualan', (select id from accounts where code = '2300')),
  ('ar.writeoff_expense', 'Beban Piutang Tak Tertagih', (select id from accounts where code = '5700')),
  ('ar.return_credit_liability', 'Saldo Kredit Retur Customer', (select id from accounts where code = '2500')),
  ('ar.other_revenue', 'Pendapatan Lain-lain', (select id from accounts where code = '4300')),
  ('ap.payable', 'Utang Usaha', (select id from accounts where code = '2100')),
  ('ap.return_credit_asset', 'Piutang Retur Supplier', (select id from accounts where code = '1350')),
  ('ap.deposit_asset', 'Uang Muka Pembelian', (select id from accounts where code = '1360')),
  ('ap.deposit_loss_expense', 'Beban Kerugian Uang Muka', (select id from accounts where code = '5800')),
  ('inventory.raw_material', 'Persediaan Bahan Baku', (select id from accounts where code = '1400')),
  ('inventory.finished_good', 'Persediaan Barang Jadi', (select id from accounts where code = '1420')),
  ('inventory.hpp', 'Harga Pokok Penjualan', (select id from accounts where code = '5100')),
  ('inventory.damage_loss_expense', 'Beban Kerugian Barang Rusak', (select id from accounts where code = '5900')),
  ('cash.tunai', 'Kas Toko (pembayaran tunai)', (select id from accounts where code = '1100')),
  ('cash.bank', 'Kas di Bank (transfer/QRIS)', (select id from accounts where code = '1200'));

-- ============================================================
-- Seed fixed_asset_account_presets -- 2 pasang yang sudah ada (dari
-- 0016_rename_legacy_fixed_asset_accounts.sql). Admin bisa tambah preset baru
-- lewat Settings begitu ada jenis aset baru (perlu migration terpisah dulu buat
-- bikin trio akun barunya -- form Chart of Accounts sengaja gak bisa bikin akun
-- is_contra, lihat docs/story/fixed-assets.md).
-- ============================================================

insert into fixed_asset_account_presets (
  label, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id
) values
  (
    'Rak Display Toko',
    (select id from accounts where code = '1610'),
    (select id from accounts where code = '1630'),
    (select id from accounts where code = '5600')
  ),
  (
    'Mobil Pickup Antar Barang',
    (select id from accounts where code = '1620'),
    (select id from accounts where code = '1640'),
    (select id from accounts where code = '5610')
  );

-- ============================================================
-- RLS + Grant -- pola default_account_settings niru tax_settings (select semua
-- authenticated, update admin doang, GAK ADA insert policy -- role_key yang valid
-- ditentukan kode FE, baris cuma diseed migration ini). Pola fixed_asset_account_presets
-- niru ar_invoice_charge_types (select semua authenticated, insert+update admin,
-- nonaktifkan pakai archived_at bukan delete).
-- ============================================================

alter table default_account_settings enable row level security;

create policy default_account_settings_select on default_account_settings
  for select using (auth.role() = 'authenticated');

create policy default_account_settings_update on default_account_settings
  for update using (
    exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

alter table fixed_asset_account_presets enable row level security;

create policy fixed_asset_account_presets_select on fixed_asset_account_presets
  for select using (auth.role() = 'authenticated');

create policy fixed_asset_account_presets_insert on fixed_asset_account_presets
  for insert with check (
    exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

create policy fixed_asset_account_presets_update on fixed_asset_account_presets
  for update using (
    exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, update on default_account_settings to authenticated;
grant select, insert, update on fixed_asset_account_presets to authenticated;
