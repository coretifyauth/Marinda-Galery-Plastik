-- Bill of Materials. Ref: memory/architecture/data/bom-schema.md.
-- Resep produksi -- master data mutable (bukan transaksional immutable), boleh direvisi
-- kapan pun. production_orders/production_order_lines (0011) snapshot qty & biaya aktual
-- pas produksi terjadi, gak look-up ulang ke bom_lines belakangan -- jadi revisi resep di
-- sini gak pernah retroaktif ubah histori produksi yang sudah terjadi.

create table bom_headers (
  id uuid primary key default gen_random_uuid(),
  finished_item_id uuid not null references items(id),
  output_qty numeric(14,3) not null check (output_qty > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger bom_headers_set_updated_at
  before update on bom_headers
  for each row execute function set_updated_at();

create table bom_lines (
  id uuid primary key default gen_random_uuid(),
  bom_header_id uuid not null references bom_headers(id) on delete cascade,
  raw_material_item_id uuid not null references items(id),
  qty_per_batch numeric(14,3) not null check (qty_per_batch > 0)
);

-- RLS & Grant -- master data mutable, beda dari tabel transaksional lain: select semua
-- authenticated, insert/update cuma admin/accountant; bom_lines dapat delete juga (ganti
-- komposisi resep = hapus+tambah baris, wajar buat master data mutable).

alter table bom_headers enable row level security;

create policy bom_headers_select on bom_headers
  for select using (auth.role() = 'authenticated');

create policy bom_headers_insert on bom_headers
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy bom_headers_update on bom_headers
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table bom_lines enable row level security;

create policy bom_lines_select on bom_lines
  for select using (auth.role() = 'authenticated');

create policy bom_lines_insert on bom_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy bom_lines_update on bom_lines
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy bom_lines_delete on bom_lines
  for delete using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

grant select, insert, update on bom_headers to authenticated;
grant select, insert, update, delete on bom_lines to authenticated;
