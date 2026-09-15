-- Pengaturan Aplikasi (app_settings). Ref: docs/architecture/app-settings-schema.md.
--
-- 1 baris singleton isinya 3 domain independen: identitas usaha (kop surat cetakan),
-- status/tarif/akun PPN, dan pelanggan walk-in default POS -- digabung 1 tabel karena
-- ketiganya persis sama pola (1 baris selamanya, select semua user login, update admin
-- doang) dan gak saling berelasi.
--
-- TIDAK ADA seed baris di sini -- baris pertama diisi lewat RPC complete_onboarding
-- (submodule "Onboarding") begitu admin isi identitas usaha & pajak lewat halaman /setup.
-- app_settings kosong justru dipakai sebagai SINYAL "aplikasi belum di-setup" di seluruh
-- sistem (gate redirect ke /setup, guard di accounts_insert/create_account, dst) -- kalau
-- baris ini di-seed migration, sinyal itu gak pernah valid.

create table app_settings (
  id boolean primary key default true check (id),
  -- identitas usaha (kop surat)
  name text not null,
  address text,
  npwp text,
  logo_url text,
  -- pajak (PPN)
  is_active boolean not null default false,
  ppn_rate numeric(5,2) not null default 11,
  ppn_keluaran_account_id uuid references accounts(id),
  ppn_masukan_account_id uuid references accounts(id),
  -- pelanggan walk-in default POS
  walk_in_customer_id uuid not null references counterparties(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

comment on column app_settings.is_active is 'Status wajib pungut PPN (PKP)';
comment on column app_settings.walk_in_customer_id is 'Fallback customer "Pelanggan Umum" buat POS';

create trigger app_settings_set_updated_at
  before update on app_settings
  for each row execute function set_updated_at();

alter table app_settings enable row level security;

create policy app_settings_select on app_settings
  for select using (auth.role() = 'authenticated');

create policy app_settings_update on app_settings
  for update using (
    exists (select 1 from app_user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, update on app_settings to authenticated;
