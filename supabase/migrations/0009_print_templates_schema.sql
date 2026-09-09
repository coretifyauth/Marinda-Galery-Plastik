-- Ref: memory/architecture/data/print-templates-schema.md

create table company_settings (
  id boolean primary key default true,
  name text not null,
  address text,
  npwp text,
  logo_url text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  constraint company_settings_singleton check (id)
);

create trigger company_settings_set_updated_at
  before update on company_settings
  for each row execute function set_updated_at();

alter table company_settings enable row level security;

create policy company_settings_select on company_settings
  for select using (auth.role() = 'authenticated');

create policy company_settings_update on company_settings
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, update on company_settings to authenticated;

insert into company_settings (id, name) values (true, 'Nama Perusahaan Belum Diisi');

create table document_signatories (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  sort_order int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger document_signatories_set_updated_at
  before update on document_signatories
  for each row execute function set_updated_at();

alter table document_signatories enable row level security;

create policy document_signatories_select on document_signatories
  for select using (auth.role() = 'authenticated');

create policy document_signatories_insert on document_signatories
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

create policy document_signatories_update on document_signatories
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

-- Beda dari pola item_categories/charge_categories (delete ditutup total) --
-- document_signatories aman di-hard-delete, gak ada FK dari tabel manapun ke id-nya.
create policy document_signatories_delete on document_signatories
  for delete using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, insert, update, delete on document_signatories to authenticated;
