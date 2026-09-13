-- Items. Ref: memory/architecture/data/items-schema.md.
-- Master data barang yang di-track Inventory. category_id/brand_id digabung langsung ke
-- CREATE TABLE utama di sini (riwayat asli nambah lewat ALTER migration 0023 belakangan --
-- file ini final state).

create table item_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text default (auth.jwt() ->> 'email')
);

create table item_brands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text default (auth.jwt() ->> 'email')
);

comment on column item_categories.created_by is 'Email snapshot saat insert (bukan FK) -- konvensi master data (items/counterparties/accounts/bom), beda dari created_by uuid FK di tabel transaksional sejak 0011+. NULL = data lama / insert di luar jalur aplikasi.';
comment on column item_brands.created_by is 'Email snapshot saat insert (bukan FK) -- konvensi master data (items/counterparties/accounts/bom), beda dari created_by uuid FK di tabel transaksional sejak 0011+. NULL = data lama / insert di luar jalur aplikasi.';

create trigger item_categories_set_updated_at
  before update on item_categories
  for each row execute function set_updated_at();

create trigger item_brands_set_updated_at
  before update on item_brands
  for each row execute function set_updated_at();

create table items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  item_type text not null check (item_type in ('RAW_MATERIAL','FINISHED_GOOD')),
  uom text not null,
  inventory_account_id uuid not null references accounts(id),
  category_id uuid references item_categories(id),
  brand_id uuid references item_brands(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text default (auth.jwt() ->> 'email')
);

comment on column items.created_by is 'Email snapshot saat insert (bukan FK) -- konvensi master data (items/counterparties/accounts/bom), beda dari created_by uuid FK di tabel transaksional sejak 0011+. NULL = data lama / insert di luar jalur aplikasi.';

create trigger items_set_updated_at
  before update on items
  for each row execute function set_updated_at();

-- item_units -- satuan jual (>1 per item boleh), harga per satuan, barcode per satuan.
create table item_units (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items(id),
  unit_label text not null,
  conversion_factor numeric(14,4) not null check (conversion_factor > 0),
  price numeric(14,2) check (price is null or price >= 0),
  is_base boolean not null default false,
  barcode text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text default (auth.jwt() ->> 'email'),
  check ((is_base and conversion_factor = 1) or not is_base),
  unique (item_id, unit_label)
);

comment on column item_units.created_by is 'Email snapshot saat insert (bukan FK) -- konvensi master data (items/counterparties/accounts/bom), beda dari created_by uuid FK di tabel transaksional sejak 0011+. NULL = data lama / insert di luar jalur aplikasi.';

create unique index item_units_one_base_per_item
  on item_units(item_id) where is_base;

create trigger item_units_set_updated_at
  before update on item_units
  for each row execute function set_updated_at();

-- Nested Conversion Factor Guard -- conversion_factor antar satuan 1 item wajib nested rapi
-- (kelipatan bulat, mis. pcs=1 pack=12 box=144) -- syarat presisi buat stok breakdown greedy.
create function check_item_units_nested_conversion() returns trigger
language plpgsql
as $$
declare
  factors numeric(14,4)[];
  f numeric(14,4);
  prev numeric(14,4);
begin
  perform 1 from item_units where item_id = new.item_id and id is distinct from new.id for update;

  select array_agg(conversion_factor order by conversion_factor)
    into factors
  from item_units
  where item_id = new.item_id
    and id is distinct from new.id;

  factors := array_append(factors, new.conversion_factor);
  select array_agg(x order by x) into factors from unnest(factors) x;

  prev := null;
  foreach f in array factors loop
    if prev is not null and f <> prev and mod(f, prev) <> 0 then
      raise exception 'Faktor konversi satuan harus kelipatan bulat dari satuan lain di item yang sama (nested rapi) -- % bukan kelipatan %', f, prev;
    end if;
    prev := f;
  end loop;

  return new;
end;
$$;

create trigger item_units_nested_conversion_guard
  before insert or update of conversion_factor on item_units
  for each row execute function check_item_units_nested_conversion();

-- delete_item -- Smart Delete Master Data. item_units dihapus di blok sama (dianggap
-- konfigurasi item, bukan riwayat transaksi eksternal) -- fallback arsip kalau item-nya
-- sendiri masih dipakai (foreign_key_violation).
create function delete_item(p_item_id uuid) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from user_roles ur
    where ur.user_id = auth.uid() and ur.role_name = 'admin'
  ) then
    raise exception 'Cuma admin yang boleh menghapus item';
  end if;

  begin
    delete from item_units where item_id = p_item_id;
    delete from items where id = p_item_id;
    return 'deleted';
  exception when foreign_key_violation then
    update items set archived_at = now(), updated_at = now() where id = p_item_id;
    return 'archived';
  end;
end;
$$;

grant execute on function delete_item(uuid) to authenticated;

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

alter table items enable row level security;

create policy items_select on items for select using (auth.role() = 'authenticated');
create policy items_insert on items for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);
create policy items_update on items for update using (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);

grant select, insert, update on items to authenticated;

alter table item_units enable row level security;

create policy item_units_select on item_units for select using (auth.role() = 'authenticated');
create policy item_units_insert on item_units for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);
create policy item_units_update on item_units for update using (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);
create policy item_units_delete on item_units for delete using (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);

grant select, insert, update, delete on item_units to authenticated;

-- generate_item_unit_barcode -- generate+assign kode scan item_units jadi 1 RPC atomik
-- dengan retry-on-conflict. Depends on generate_document_number() (document_number_counters,
-- 0007_document_numbering_schema.sql) -- file ini (0005) urut LEBIH AWAL dari 0007, tapi
-- referensi forward ini aman: body plpgsql cuma resolve nama fungsi saat DIPANGGIL, bukan
-- saat CREATE FUNCTION, dan replay migration selalu selesai penuh (0001..N) sebelum RPC
-- ini pernah benar-benar dipanggil aplikasi. Ditaruh di sini (bukan di 0007) biar tetap 1:1
-- sama docs/architecture/items-schema.md (submodule Kode Scan Barang), bukan document-numbering.
--
-- Kenapa retry-on-conflict: kalau kode yang di-generate ternyata sudah kepake di baris LAIN
-- (mis. data lama yang barcode-nya diketik manual saat seed/testing, bukan lewat RPC ini),
-- update kedua gagal duplicate key dan nomor yang sudah kepake di counter jadi hangus (lihat
-- kronologi di memory/brief.md). RPC ini loop: kalau update kena unique_violation, generate
-- nomor berikutnya dan coba lagi -- user gak pernah lihat error gara-gara ini.
create function generate_item_unit_barcode(p_unit_id uuid) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
  v_attempt int := 0;
  v_max_attempts constant int := 20;
begin
  if not exists (
    select 1 from user_roles ur
    where ur.user_id = auth.uid() and ur.role_name = 'admin'
  ) then
    raise exception 'Cuma admin yang boleh generate kode scan';
  end if;

  if not exists (select 1 from item_units where id = p_unit_id) then
    raise exception 'Satuan jual tidak ditemukan';
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_code := generate_document_number('item_unit_barcodes');
    begin
      update item_units set barcode = v_code where id = p_unit_id;
      if not found then
        raise exception 'Satuan jual tidak ditemukan atau sudah dihapus';
      end if;
      return v_code;
    exception when unique_violation then
      if v_attempt >= v_max_attempts then
        raise exception 'Gagal generate kode scan unik setelah % percobaan', v_attempt;
      end if;
      -- kode ini hangus (counter sudah maju, gak dipakai baris manapun) -- lanjut loop coba nomor berikutnya
    end;
  end loop;
end;
$$;

grant execute on function generate_item_unit_barcode(uuid) to authenticated;
