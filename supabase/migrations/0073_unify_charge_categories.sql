-- Gabung pos_charge_types + ar_invoice_charge_types + ap_bill_expense_categories jadi 1 tabel
-- generic `charge_categories` (module POS/AR/AP). Beda dari unifikasi payments/credit_notes/dst
-- (0069-0072): ketiga tabel ini murni katalog master data, gak ada FK dari tabel manapun (account_id
-- diresolusi ke charge_lines/create_transaction pas insert, category_id gak pernah disimpan) -- jadi
-- gak ada reducer/trigger sinkron status yang perlu diporting, cuma data + RLS.

-- 1. Tabel baru
create table charge_categories (
  id uuid primary key default gen_random_uuid(),
  module text not null check (module in ('pos', 'ar', 'ap')),
  name text not null,
  account_id uuid not null references accounts(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index charge_categories_module_idx on charge_categories(module);

create trigger charge_categories_set_updated_at
  before update on charge_categories
  for each row execute function set_updated_at();

-- 2. Backfill, ID asli dipertahankan
insert into charge_categories (id, module, name, account_id, archived_at, created_at, updated_at)
select id, 'pos', name, account_id, archived_at, created_at, updated_at from pos_charge_types
union all
select id, 'ar', name, account_id, archived_at, created_at, updated_at from ar_invoice_charge_types
union all
select id, 'ap', name, account_id, archived_at, created_at, updated_at from ap_bill_expense_categories;

-- 3. RLS & Grant (pola identik ketiga tabel lama)
alter table charge_categories enable row level security;

create policy charge_categories_select on charge_categories for select using (auth.role() = 'authenticated');
create policy charge_categories_insert on charge_categories for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);
create policy charge_categories_update on charge_categories for update using (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);
-- sengaja gak ada policy DELETE, sama pola lama -> RLS default deny

grant select, insert, update on charge_categories to authenticated;

-- 4. Drop tabel lama (cascade trigger/index/RLS/grant)
drop table if exists pos_charge_types;
drop table if exists ar_invoice_charge_types;
drop table if exists ap_bill_expense_categories;
