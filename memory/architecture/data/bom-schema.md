# Bill of Materials — Schema (Finalized)

Spine: `bom_headers` (+ `bom_lines`). Resep produksi — master data mutable, dikonsumsi
`production_orders` (`production-orders-schema.md`). Ref konsep bisnis:
`docs/domain/inventory.md` + `memory/domain/inventory.md` bagian "Produksi". Migration:
`0012_inventory_schema.sql`.

## Keputusan

- **BOM adalah master data mutable**, bukan transaksional immutable — resep boleh
  direvisi. Ini aman karena `production_orders`/`production_order_lines`
  (`production-orders-schema.md`) **snapshot** qty & biaya aktual pas produksi terjadi
  (gak look-up ulang ke `bom_lines` di kemudian hari) — pola sama seperti `due_date` di
  AR/AP yang snapshot dari `payment_term_days` pas insert, gak retroaktif kalau master
  data berubah belakangan.

## `bom_headers` + `bom_lines`

Resep — master data mutable (bukan transaksional). Header: `finished_item_id`,
`output_qty` (qty barang jadi per 1 batch resep), `is_active`. Lines:
`raw_material_item_id`, `qty_per_batch`. Boleh direvisi kapan pun — produksi yang sudah
terjadi gak retroaktif berubah karena `production_order_lines` snapshot angka aktual,
bukan look-up ulang ke sini. `bom_headers` cukup `update` (nonaktifin lewat
`is_active`, gak perlu hapus baris); `bom_lines` boleh `delete` (ganti komposisi resep =
hapus+tambah baris, wajar buat master data mutable).

```sql
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
```

## RLS & Grant

Master data mutable — beda dari tabel transaksional lain: `select` semua
`authenticated`, `insert`/`update` cuma `admin`/`accountant`; `bom_lines` malah dapat
`delete` juga (komposisi resep boleh diubah bebas, hapus+tambah baris).

```sql
grant select, insert, update on bom_headers to authenticated;
grant select, insert, update, delete on bom_lines to authenticated;
```

Detail lengkap: `supabase/migrations/0012_inventory_schema.sql`.
