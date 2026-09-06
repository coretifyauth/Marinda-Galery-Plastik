# Production Orders — Schema (Finalized)

Spine: `production_orders` (+ `production_order_lines`). Kejadian produksi beneran,
menjalankan resep dari `bom-schema.md`. Ref konsep bisnis: `docs/domain/inventory.md` +
`memory/domain/inventory.md` bagian "Produksi". Migration: `0012_inventory_schema.sql`,
`item_id` + backfill: `0042_inventory_movements_schema.sql`.

## `production_orders` + `production_order_lines`

Header: `bom_header_id`, `qty_produced`, `production_date`, **`journal_entry_id`**
(wajib, dibuat via `create_journal_entry`: Debit Persediaan Barang Jadi, Kredit
Persediaan Bahan Baku, di level akun kontrol — bukan per-item). Lines: snapshot tiap
bahan baku yang dikonsumsi (`item_id`, `qty_consumed`, `total_cost` — hasil dari
Weighted Average lookup, via `consume_weighted_average`,
`inventory-ledger-schema.md`). Immutable (reuse `block_edit_delete`).

**Scope biaya produksi**: `production_order_lines` saat ini cuma menghitung dari bahan
baku yang dikonsumsi (`consume_weighted_average`) — belum ada alokasi biaya tenaga
kerja langsung atau overhead pabrik, walau secara prinsip *full absorption costing*
keduanya wajib ikut masuk HPP. Butuh mekanisme alokasi terpisah yang belum dibangun.

```sql
create table production_orders (
  id uuid primary key default gen_random_uuid(),
  bom_header_id uuid not null references bom_headers(id),
  item_id uuid not null references items(id), -- migration 0042, backfill dari bom_headers.finished_item_id
  qty_produced numeric(14,3) not null check (qty_produced > 0),
  production_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create trigger production_orders_block_edit_delete
  before update or delete on production_orders
  for each row execute function block_edit_delete();

create table production_order_lines (
  id uuid primary key default gen_random_uuid(),
  production_order_id uuid not null references production_orders(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_consumed numeric(14,3) not null check (qty_consumed > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);

create trigger production_order_lines_block_edit_delete
  before update or delete on production_order_lines
  for each row execute function block_edit_delete();
```

## `production_orders.item_id` — kolom baru + perbaikan `create_production_order` (migration `0042`)

Sebelumnya item hasil produksi cuma didapat gak langsung lewat `bom_header_id ->
bom_headers.finished_item_id`. Ditambah (backfill dari situ) supaya composite FK
`inventory_movements` (`inventory-ledger-schema.md`) ke tabel ini bisa seragam kayak 9
sumber lain, bukan dikecualikan pakai trigger validasi terpisah.

```sql
alter table production_orders add column item_id uuid references items(id);

update production_orders po
set item_id = bh.finished_item_id
from bom_headers bh
where po.bom_header_id = bh.id;

alter table production_orders alter column item_id set not null;

alter table production_orders add constraint production_orders_id_item_id_key unique (id, item_id);
```

Backfill aman dari risiko orphan — `bom_header_id` sejak awal (`0004_inventory_schema.sql`)
selalu `not null references bom_headers(id)` dan gak pernah dilonggarkan di migration
manapun, `bom_headers` gak pernah hard-delete (cuma `is_active`) — jadi JOIN backfill
dijamin match semua baris existing.

`create_production_order` (`create or replace`, signature tetap sama) diperbaiki di
migration yang sama supaya ngisi `item_id` di `INSERT INTO production_orders` pakai
`v_finished_item_id` yang sudah dihitung dari `bom_headers` sejak awal fungsi —
sebelumnya dihitung tapi cuma dipakai buat `inventory_balances`, gak pernah ditulis
balik ke header. **WAJIB atomik sama penambahan kolom** — kalau enggak RPC ini gagal
total begitu kolom jadi `NOT NULL`.

## RPC `create_production_order` — jalankan resep + jurnal produksi sekaligus

Ambil `bom_lines` dari `bom_header_id`, hitung `batch_multiplier = qty_produced /
output_qty`, konsumsi tiap bahan baku (Weighted Average, via
`consume_weighted_average`), total biayanya jadi jurnal (Debit Persediaan Barang Jadi,
Kredit Persediaan Bahan Baku), lalu barang jadi hasil produksi nambah
`inventory_balances`. **Detail teknis**: `id` production order digenerate duluan
(`gen_random_uuid()`) sebelum baris headernya di-insert, dipakai sebagai
`consumption_ref` pas konsumsi jalan — perlu karena `production_order_lines` (yang FK
ke header) baru bisa di-insert setelah total biaya (yang butuh hasil konsumsi)
diketahui buat bikin jurnal duluan; header jurnal-dulu-baris-belakangan ini pola yang
sama kayak `create_ap_bill`/`create_ar_invoice`, cuma di sini urutannya lebih panjang
karena ada langkah konsumsi di tengah.

```sql
create function create_production_order(
  p_bom_header_id uuid, p_qty_produced numeric, p_production_date date, p_source_ref text,
  p_finished_good_debit_account_id uuid, p_raw_material_credit_account_id uuid
) returns uuid language plpgsql security invoker as $$ ... $$;
```

Full body: `supabase/migrations/0012_inventory_schema.sql` (base) ->
`0042_inventory_movements_schema.sql` (nulis `item_id` ke header) ->
`0049_inventory_movements_production_order.sql` (insert `inventory_movements`).

## RLS & Grant

Pola identik AR/AP: `select` terbuka semua `authenticated`, `insert` cuma
`admin`/`accountant`. Transaksional — **gak ada policy `update`/`delete`**.

```sql
grant select, insert on production_orders to authenticated;
grant select, insert on production_order_lines to authenticated;
```

Detail lengkap: `supabase/migrations/0012_inventory_schema.sql`.
