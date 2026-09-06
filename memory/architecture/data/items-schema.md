# Items — Schema (Finalized)

Spine: `items` (+ `item_units`, `item_brands`, `item_categories`). Master data barang
yang di-track Inventory. Ref konsep bisnis: `docs/domain/inventory.md` +
`memory/domain/inventory.md`.

## Keputusan

- **Penamaan tabel: master data gak pakai prefix modul, transaksional pakai.** Pola ini
  udah established di AR/AP (`counterparties` polos, tapi `transactions` pakai prefix
  konsep). `items` konsisten sama pola itu (master data, polos).
- **`items.uom` tetap 1 satuan dasar** — dipakai semua pelacakan stok/costing (PO/GRN/BOM/
  production/goods issue), gak diubah oleh fitur satuan jual (`item_units`).

## `items`

Bisa bahan baku (`RAW_MATERIAL`) atau barang jadi (`FINISHED_GOOD`). Kolom penting:
- `uom` — satuan dasar (kg, gram, pcs, dst). Satuan JUAL ke customer (boleh beda, boleh
  lebih dari 1) ada di `item_units` di bawah.
- `inventory_account_id` — FK ke `accounts` (COA), akun **kontrol** (misal "Persediaan
  Bahan Baku" / "Persediaan Barang Jadi"). Satu akun ini menaungi banyak item sekaligus
  — detail per-item hidup di subledger Inventory (`items`+`inventory_balances`, lihat
  `inventory-ledger-schema.md`), bukan sebagai akun terpisah per item di COA (pola sama
  `transactions`+`counterparties`: 1 akun "Piutang Usaha" menaungi banyak customer).
- `archived_at` — pola sama `counterparties` (`state-naming-convention.md`), item lama
  gak boleh dihapus keras.
- **`default_price` sempat ada** (nullable, migration `0018_items_default_price.sql`) —
  **di-drop lagi migration `0019_item_units_schema.sql`**, digantiin `item_units` begitu
  ketauan item bisa dijual dalam >1 satuan, gak cukup 1 kolom flat per item.

```sql
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
  updated_at timestamptz not null default now()
);

create trigger items_set_updated_at
  before update on items
  for each row execute function set_updated_at();
```

`set_updated_at()` reuse dari `coa-schema.md`. `category_id`/`brand_id` (nullable,
migration `0023_item_categories_brands.sql`) ditambah belakangan.

### RLS & Grant (`items`)

Pola identik AR/AP: `select` terbuka semua `authenticated`, `insert` cuma
`admin`/`accountant`. Beda dari tabel transaksional — `items` dapat policy `update` juga
(`+archived_at` lewat update biasa). Gak ada policy/grant `delete` langsung — tapi sejak
`0013_master_data_smart_delete.sql` ada jalur terkontrol lewat RPC `delete_item()`
(`security definer`, `coa-schema.md` submodule "Smart Delete Master Data").

```sql
grant select, insert, update on items to authenticated;
```

## Kategori & Brand Barang — migration `0023_item_categories_brands.sql`

Katalog terkontrol opsional buat pengelompokan barang pas jumlahnya udah banyak — pola
identik `charge_categories` (`transactions-schema.md`, dipakai bareng AR/AP/POS),
bedanya gak ada `account_id` (kategori/brand bukan konsep akuntansi).

### Keputusan Desain

- **Katalog terkontrol (FK), bukan teks bebas** — nyegah variasi penulisan ("Lion Star"
  vs "lion star") yang bikin filter/grouping meleset.
- **2 tabel independen** (`item_categories`, `item_brands`), bukan 1 tabel serba-guna
  dengan kolom `type` — kategori dan brand konsepnya beda, gak ada alasan buat digabung.
- **FK tunggal (`items.category_id`/`items.brand_id`), bukan tabel jembatan many-to-many**
  — scope sekarang cuma "1 barang 1 kategori/brand", bukan sistem tagging multi-kategori.
- **Nullable, gak ada backfill wajib** — barang existing otomatis `NULL` di kedua kolom.
- **CRUD langsung lewat tabel** (sama `item_units`), gak ada RPC — murni metadata
  deskriptif, 0 sentuhan ke jurnal/RPC transaksi manapun.

### `item_categories` + `item_brands`

```sql
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

alter table items add column category_id uuid references item_categories(id);
alter table items add column brand_id uuid references item_brands(id);
```

- `archived_at` — pola sama `items`/`counterparties`, baris lama gak boleh dihapus keras
  kalau udah pernah dipakai barang manapun.
- `items.category_id`/`items.brand_id` — nullable, `references` polos (bukan `not null`),
  gak ada `on delete` khusus (baris katalog gak pernah di-hard-delete, cuma diarsipkan).

### RLS & Grant (Kategori & Brand)

Pola sama persis `charge_categories` (katalog master data) — BUKAN pola `item_units`
(yang admin+accountant, ada delete).
`select` semua `authenticated`, `insert`/`update` **admin doang**. **Gak ada** policy
`delete` — nonaktifkan pakai `archived_at`.

```sql
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
```

Full body: `supabase/migrations/0023_item_categories_brands.sql`.

## Satuan Jual & Harga (Multi Unit of Measure) — migration `0019_item_units_schema.sql`

Gantiin `items.default_price` (migration `0018`, di-drop di sini) — item bisa punya >1
satuan (misal "buah" dan "lusin"), masing-masing punya faktor konversi ke satuan dasar
(`items.uom`, gak berubah) dan harga sendiri.

### Keputusan Desain

- **`items.uom` tetap 1 satuan dasar, gak diubah** — `item_units` cuma nambah lapisan
  satuan tambahan per item, gak menggantikan satuan dasar buat pelacakan stok.
- **0 perubahan ke RPC transaksi manapun.** `create_order`, `create_goods_receipt`,
  `create_goods_issue`, `create_production_order`, `record_stock_opname` semua tetap
  nerima qty di satuan dasar. Konversi "N satuan → qty satuan dasar" murni logic UI,
  terjadi SEBELUM RPC dipanggil — bukan server-side.
- **CRUD langsung lewat tabel, bukan RPC** — `item_units` itu master data mutable, mirror
  pola `bom_lines` (`bom-schema.md`).
- **Base unit direpresentasikan sebagai baris `item_units` juga** (`is_base=true`,
  `conversion_factor=1`), bukan kolom terpisah di `items`.
- **Input UI di-generalisasi ke semua form qty-per-item** (`components/ui/multi-uom-qty-input.tsx`,
  UI-only, 0 perubahan skema) — PO, Goods Receipt, Goods Issue, qty produksi Production
  Order, qty hasil hitung Stock Opname semua pakai komponen yang sama: input simultan
  per satuan (`Σ(qty_input × conversion_factor)` dijumlah jadi 1 qty satuan dasar).

### `item_units`

```sql
create table item_units (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items(id),
  unit_label text not null,
  conversion_factor numeric(14,4) not null check (conversion_factor > 0),
  price numeric(14,2) check (price is null or price >= 0),
  is_base boolean not null default false,
  barcode text unique, -- migration 0021/0022, lihat "Kode Scan Barang" di bawah
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((is_base and conversion_factor = 1) or not is_base),
  unique (item_id, unit_label)
);

create unique index item_units_one_base_per_item
  on item_units(item_id) where is_base;

create trigger item_units_set_updated_at
  before update on item_units
  for each row execute function set_updated_at();
```

- `conversion_factor` — berapa satuan dasar (`items.uom`) = 1 unit satuan jual ini. Baris
  `is_base=true` wajib `conversion_factor=1` (check constraint), `unit_label`-nya
  konvensinya harus sama persis `items.uom` (input-trust, gak ada trigger cross-table).
- `price` — nullable, gak semua item/satuan punya harga jual standar.
- `item_units_one_base_per_item` — partial unique index, mastiin maksimal 1 baris base
  per item.
- Item boleh 0 baris (gak dijual langsung, misal bahan baku) sampai berapa pun baris.

### Migrasi data dari `items.default_price` (migration `0019`, sekali jalan)

```sql
insert into item_units (item_id, unit_label, conversion_factor, price, is_base)
select id, uom, 1, default_price, true
from items
where default_price is not null;

alter table items drop column default_price;
```

### RLS & Grant (Satuan Jual & Harga)

Pola sama `bom_lines` (master data mutable, anak dari item) — `select` semua
`authenticated`, `insert`/`update`/`delete` cuma `admin`/`accountant`.

```sql
grant select, insert, update, delete on item_units to authenticated;
```

## Nested Conversion Factor Guard — migration `0025_item_units_nested_conversion_guard.sql`

Syarat data buat tampilan stok breakdown greedy (box/pack/pcs, `apps/erp/src/lib/stock-display.ts`
+ `apps/pos/src/lib/stock-display.ts`) bisa diandalkan — breakdown greedy
(`floor(sisa/factor)` diulang dari satuan terbesar ke terkecil) cuma presisi kalau
`conversion_factor` antar satuan 1 item **nested rapi** (tiap angka kelipatan bulat dari
angka di bawahnya, mis. pcs=1, pack=12, box=144 — bukan pcs=1, pack=12, box=100).

```sql
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
```

- **`for update` row lock di baris sibling item yang sama** — tanpa lock 2 transaksi
  concurrent bisa lolos validasi masing-masing sendiri-sendiri padahal kombinasi
  akhirnya gak nested.
- Migration ini juga jalanin backfill check yang scan SEMUA item existing yang udah
  punya >1 baris `item_units` — kalau ada yang udah gak nested SEBELUM migration ini,
  `raise exception` dan migration gagal total.
- Trigger cuma fire `before insert or update of conversion_factor` — update kolom lain
  gak memicu re-validasi.

Full body: `supabase/migrations/0025_item_units_nested_conversion_guard.sql`.

## Kode Scan Barang (Barcode/QR per Satuan Jual) — migration `0021_item_unit_barcode.sql` + `0022_item_unit_barcode_reuse_document_numbering.sql`

Nambah kolom identitas scan buat kasir POS — ditaruh di `item_units` (satuan jual),
bukan `items`, karena kemasan fisik beda (dus/pcs/pack) biasanya punya barcode/label
beda-beda di dunia nyata. Kolom `item_units.barcode` sudah ditulis di DDL final di atas.

### Keputusan Desain

- **Level `item_units`, bukan `items`** — 1 barang boleh dijual >1 satuan, tiap satuan
  kemasan fisiknya beda, jadi kodenya juga wajib bisa beda-beda per satuan.
- **Nullable & opsional per baris, independen** — barang yang gak pernah discan
  (dijual manual/timbang/katalog) boleh kosong selamanya.
- **`unique` global lintas tabel, BUKAN scoped per item** — barcode dus produk A gak
  boleh sama barcode pcs produk B.
- **Gak ada validasi format** (bukan EAN-13/UPC checksum) — kolom nerima teks apa aja.
- **Format kode internal `SKU-2026-00001`, REUSE `generate_document_number()`**
  (`document-numbering-schema.md`) — revisi `0022`, gantiin percobaan pertama (sequence
  bespoke `item_unit_barcode_seq`, format `SKU-000001` polos, migration `0021`).
- **`doc_type = 'item_unit_barcodes'` — PENGECUALIAN dari konvensi "doc_type = nama
  tabel transaksional"** (lihat `document-numbering-schema.md`) — gak ada tabel
  `item_unit_barcodes` beneran, kode ini nempel ke SEBAGIAN baris `item_units` yang user
  pilih generate on-demand.
- **CRUD langsung lewat tabel** — `generate_document_number()` cuma ngembaliin teks kode,
  TIDAK langsung nulis ke `item_units`. UI yang nyimpen lewat `update` biasa.
- **Render QR + cetak label murni fitur UI** (client-side) — gak ada tabel/kolom
  penyimpanan gambar.

### Riwayat: percobaan pertama (migration `0021`, sudah di-drop migration `0022`)

Migration `0021` awalnya bikin sequence bespoke `item_unit_barcode_seq` + fungsi
`generate_item_unit_barcode()` (`security invoker`, `language sql`, format
`SKU-000001`). Migration `0022` men-`drop function`+`drop sequence` keduanya — gak ada
objek lain yang mereferensikannya. Disimpan di sini sebagai riwayat evolusi keputusan.

Full body: `supabase/migrations/0021_item_unit_barcode.sql` (kolom + percobaan pertama,
sudah di-drop) + `supabase/migrations/0022_item_unit_barcode_reuse_document_numbering.sql`
(mekanisme final).
