-- Ref: memory/architecture/data/default-account-settings-schema.md

create table default_account_settings (
  id uuid primary key default gen_random_uuid(),
  role_key text not null unique,
  label text not null,
  account_id uuid not null references accounts(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table default_account_settings enable row level security;

create policy default_account_settings_select on default_account_settings
  for select using (auth.role() = 'authenticated');

create policy default_account_settings_update on default_account_settings
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, update on default_account_settings to authenticated;

insert into default_account_settings (role_key, label, account_id)
  select 'ar.receivable', 'Piutang Usaha', id from accounts where code = '1300';
insert into default_account_settings (role_key, label, account_id)
  select 'ar.revenue', 'Pendapatan Penjualan Grosir', id from accounts where code = '4200';
insert into default_account_settings (role_key, label, account_id)
  select 'ar.contra_revenue', 'Retur & Potongan Penjualan', id from accounts where code = '4900';
insert into default_account_settings (role_key, label, account_id)
  select 'ar.deposit_liability', 'Uang Muka Penjualan', id from accounts where code = '2300';
insert into default_account_settings (role_key, label, account_id)
  select 'ar.writeoff_expense', 'Beban Piutang Tak Tertagih', id from accounts where code = '5700';
insert into default_account_settings (role_key, label, account_id)
  select 'ar.return_credit_liability', 'Saldo Kredit Retur Customer', id from accounts where code = '2500';
insert into default_account_settings (role_key, label, account_id)
  select 'ar.other_revenue', 'Pendapatan Lain-lain', id from accounts where code = '4300';
insert into default_account_settings (role_key, label, account_id)
  select 'ap.payable', 'Utang Usaha', id from accounts where code = '2100';
insert into default_account_settings (role_key, label, account_id)
  select 'ap.return_credit_asset', 'Piutang Retur Supplier', id from accounts where code = '1350';
insert into default_account_settings (role_key, label, account_id)
  select 'ap.deposit_asset', 'Uang Muka Pembelian', id from accounts where code = '1360';
insert into default_account_settings (role_key, label, account_id)
  select 'ap.deposit_loss_expense', 'Beban Kerugian Uang Muka', id from accounts where code = '5800';
insert into default_account_settings (role_key, label, account_id)
  select 'inventory.raw_material', 'Persediaan Bahan Baku', id from accounts where code = '1400';
insert into default_account_settings (role_key, label, account_id)
  select 'inventory.finished_good', 'Persediaan Barang Jadi', id from accounts where code = '1420';
insert into default_account_settings (role_key, label, account_id)
  select 'inventory.hpp', 'Harga Pokok Penjualan', id from accounts where code = '5100';
insert into default_account_settings (role_key, label, account_id)
  select 'inventory.damage_loss_expense', 'Beban Kerugian Barang Rusak', id from accounts where code = '5900';
insert into default_account_settings (role_key, label, account_id)
  select 'inventory.shortage_expense', 'Beban Selisih Persediaan', id from accounts where code = '6000';
insert into default_account_settings (role_key, label, account_id)
  select 'inventory.surplus_revenue', 'Pendapatan Selisih Persediaan', id from accounts where code = '4400';
insert into default_account_settings (role_key, label, account_id)
  select 'cash.tunai', 'Kas Toko', id from accounts where code = '1100';
insert into default_account_settings (role_key, label, account_id)
  select 'cash.bank', 'Kas di Bank', id from accounts where code = '1200';

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

alter table fixed_asset_account_presets enable row level security;

create policy fixed_asset_account_presets_select on fixed_asset_account_presets
  for select using (auth.role() = 'authenticated');

create policy fixed_asset_account_presets_insert on fixed_asset_account_presets
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

create policy fixed_asset_account_presets_update on fixed_asset_account_presets
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, insert, update on fixed_asset_account_presets to authenticated;

insert into fixed_asset_account_presets
  (label, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id)
  select 'Rak Display Toko',
    (select id from accounts where code = '1610'),
    (select id from accounts where code = '1630'),
    (select id from accounts where code = '5600');
insert into fixed_asset_account_presets
  (label, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id)
  select 'Mobil Pickup Antar Barang',
    (select id from accounts where code = '1620'),
    (select id from accounts where code = '1640'),
    (select id from accounts where code = '5610');
