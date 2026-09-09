-- Ref: memory/architecture/data/tax-settings-schema.md

create table tax_settings (
  id boolean primary key default true check (id),
  is_active boolean not null default false,
  ppn_rate numeric(5,2) not null default 11,
  ppn_keluaran_account_id uuid references accounts(id),
  ppn_masukan_account_id uuid references accounts(id),
  updated_at timestamptz not null default now()
);

alter table tax_settings enable row level security;

create policy tax_settings_select on tax_settings
  for select using (auth.role() = 'authenticated');

create policy tax_settings_update on tax_settings
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, update on tax_settings to authenticated;

-- Singleton seed wajib (app fetch error kalau kosong) -- default kolom lain dipakai apa
-- adanya, is_active tetap false sampai admin aktifkan manual.
insert into tax_settings (id) values (true);
