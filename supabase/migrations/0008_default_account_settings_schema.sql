-- Default Akun. Ref: docs/architecture/default-account-settings-schema.md.
--
-- TIDAK ADA seed baris di sini -- 19 role_key wajib diisi lewat RPC complete_onboarding
-- (submodule "Onboarding" di file terpisah), bukan migration, karena account_id-nya
-- bergantung ke akun COA yang juga gak lagi di-seed migration (lihat 0002_coa_schema.sql).

create table app_default_account_settings (
  id uuid primary key default gen_random_uuid(),
  role_key text not null unique,
  label text not null,
  account_id uuid not null references accounts(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table app_default_account_settings enable row level security;

create policy app_default_account_settings_select on app_default_account_settings
  for select using (auth.role() = 'authenticated');

create policy app_default_account_settings_update on app_default_account_settings
  for update using (
    exists (select 1 from app_user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, update on app_default_account_settings to authenticated;
