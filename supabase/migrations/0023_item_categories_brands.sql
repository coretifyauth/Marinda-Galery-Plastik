-- Kategori & Brand Barang -- lihat memory/architecture/data/inventory-schema.md submodule
-- "Kategori & Brand Barang". Katalog terkontrol opsional buat pengelompokan/filter barang pas
-- katalog udah banyak -- pola identik ar_invoice_charge_types/ap_bill_expense_categories/
-- pos_charge_types, bedanya gak ada account_id (bukan konsep akuntansi).

create table item_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table item_brands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger item_categories_set_updated_at
  before update on item_categories
  for each row execute function set_updated_at();

create trigger item_brands_set_updated_at
  before update on item_brands
  for each row execute function set_updated_at();

-- Nullable -- 1 barang maksimal 1 kategori & 1 brand (FK tunggal, bukan tabel jembatan
-- many-to-many), barang existing otomatis NULL di keduanya, gak perlu backfill.
alter table items add column category_id uuid references item_categories(id);
alter table items add column brand_id uuid references item_brands(id);

-- RLS & Grant -- pola sama persis ar_invoice_charge_types (katalog master data): select
-- semua authenticated, insert/update admin doang. Gak ada policy delete -- nonaktifkan
-- pakai archived_at.
alter table item_categories enable row level security;
alter table item_brands enable row level security;

create policy item_categories_select on item_categories for select using (auth.role() = 'authenticated');
create policy item_categories_insert on item_categories for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);
create policy item_categories_update on item_categories for update using (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);

create policy item_brands_select on item_brands for select using (auth.role() = 'authenticated');
create policy item_brands_insert on item_brands for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);
create policy item_brands_update on item_brands for update using (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);

grant select, insert, update on item_categories to authenticated;
grant select, insert, update on item_brands to authenticated;
