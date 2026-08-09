# POS / Jualan Eceran — Struktur Data & Teknis (AI Context)

Konsep: `memory/domain/pos.md`. Naratif: `docs/architecture/pos-schema.md`. Migration: `supabase/migrations/0023_pos_schema.sql`.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `pos_sales` | Header 1 transaksi kasir | `customers` (nullable), `accounts` (×2: `cash_account_id`, `revenue_account_id`), `journal_entries` (×2: `revenue_journal_entry_id`, `cogs_journal_entry_id`) |
| `pos_sale_lines` | Baris item | `pos_sales` (cascade), `items` |

## Konsep Inti

**Keputusan Desain**

- **1 tabel header, bukan 2 kayak `ar_invoices`+`goods_issues`.** Pola AR/Inventory kepisah karena `ar_invoices` sudah ada duluan sebelum `goods_issues` dibangun (gak mau ubah struktur tabel immutable existing). POS gak punya beban sejarah itu — `pos_sales` langsung nyimpen `revenue_journal_entry_id` + `cogs_journal_entry_id` dari awal.
- **Total gak dipercaya dari client** — beda dari `create_goods_issue` yang nerima `p_amount` mentah (karena `ar_invoices` gak didekomposisi per item). `create_pos_sale` hitung `v_total_amount`/`v_total_cost` dari `SUM(qty × unit_price)`/`SUM(consume_weighted_average(...))` di `p_lines` sendiri, server-side.
- **`create_pos_sale` adalah RPC `security definer` PERTAMA di project ini** (semua RPC lain `security invoker`). Alasan: role baru `cashier` sengaja TIDAK dikasih akses RLS insert ke `journal_entries` (tetap admin/accountant-only, `journal-entry-schema.md`) — kalau dilonggarkan, cashier bisa insert jurnal APAPUN lewat `create_journal_entry` generik, bukan cuma lewat jalur resmi. Definer bikin fungsi ini jalan pakai privilege pemilik fungsi (table owner bypass RLS by default di Postgres, gak ada `FORCE ROW LEVEL SECURITY` dipakai di project ini) — guard role manual di baris PERTAMA body fungsi jadi satu-satunya gerbang keamanan begitu RLS di-bypass. `set search_path = public, pg_temp` dikunci eksplisit (wajib buat SECURITY DEFINER — `pg_temp` HARUS disebut eksplisit, karena Postgres selalu nyari `pg_temp` duluan buat referensi tabel unqualified apa pun isi `search_path`-nya, jadi `public` doang gak cukup nutup celah search_path hijacking — ketauan review `schema-reviewer`).
- **`void_pos_sale` TETAP `security invoker`** — cuma admin/accountant yang akan manggil (void hidup di `apps/erp`, bukan layar kasir `apps/pos`), dan mereka udah lolos RLS `journal_entries_insert` langsung. Gak butuh privilege escalation di sini, beda dari `create_pos_sale`.
- **Role `cashier` ditambah ke lookup table `roles`** (bukan `ALTER TYPE`, `coa-schema.md`). Deskripsi eksplisit nyebut batasannya: cuma bisa lewat `create_pos_sale`.

### `pos_sales` + `pos_sale_lines`

```sql
create table pos_sales (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id),
  sale_date date not null,
  cash_account_id uuid not null references accounts(id),
  revenue_account_id uuid not null references accounts(id),
  revenue_journal_entry_id uuid not null references journal_entries(id),
  cogs_journal_entry_id uuid not null references journal_entries(id),
  source_ref text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create trigger pos_sales_block_edit_delete
  before update or delete on pos_sales
  for each row execute function block_edit_delete();

create table pos_sale_lines (
  id uuid primary key default gen_random_uuid(),
  pos_sale_id uuid not null references pos_sales(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_sold numeric(14,3) not null check (qty_sold > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  line_amount numeric(14,2) not null check (line_amount >= 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);

create trigger pos_sale_lines_block_edit_delete
  before update or delete on pos_sale_lines
  for each row execute function block_edit_delete();
```

### RPC `create_pos_sale` — konsumsi stok + 2 jurnal + header + lines sekaligus

```sql
create function create_pos_sale(
  p_sale_date date, p_source_ref text, p_customer_id uuid,
  p_cash_account_id uuid, p_revenue_account_id uuid,
  p_hpp_account_id uuid, p_finished_good_account_id uuid,
  p_lines jsonb -- array of {"item_id":uuid,"qty_sold":numeric,"unit_price":numeric}
) returns uuid language plpgsql security definer set search_path = public as $$ ... $$;
```

Guard role manual di baris pertama (`user_roles.role_name in ('admin','accountant','cashier')`), lalu loop `p_lines`: tiap baris manggil `consume_weighted_average(item_id, qty_sold)` (raise exception sendiri kalau stok kurang — no-oversell, no partial write karena masih di 1 transaksi Postgres). Dua `create_journal_entry` terpisah (Kas/Bank↔Pendapatan Toko, HPP↔Persediaan), baru insert `pos_sales` + loop insert `pos_sale_lines`.

Full body: `supabase/migrations/0023_pos_schema.sql`.

### RPC `void_pos_sale` — reversing entry, pola `cancel_ar_invoice`

```sql
create function void_pos_sale(
  p_sale_id uuid, p_entry_date date, p_source_ref text
) returns uuid language plpgsql security invoker as $$ ... $$;
```

Cek dulu `pos_sales` ada & belum pernah dibatalkan (`exists (select 1 from journal_entries where reverses_entry_id = revenue_journal_entry_id)`), lalu `reverse_journal_entry` ke KEDUA jurnal (`revenue_journal_entry_id` dan `cogs_journal_entry_id`), baru `update inventory_balances` manual buat balikin `qty_on_hand` (reversing entry cuma bereskan sisi jurnal, gak otomatis balikin stok — beda dari `consume_weighted_average` yang manggil `update` juga tapi arah kebalik). `avg_cost` gak disentuh, sama pola restock retur `RESALABLE` di AR. **Di-agregasi per `item_id` dulu** (`group by item_id` sebelum `update ... from`) — bukan `UPDATE...FROM` langsung ke `pos_sale_lines` mentah, karena kalau 1 sale punya >1 baris `item_id` yang sama (kasir scan SKU sama 2x), join langsung cuma makan 1 baris match (perilaku Postgres yang terdokumentasi, bukan menjumlahkan) — bug nyata yang ketauan `schema-reviewer`, diperbaiki sebelum migration ini dianggap siap.

Full body: `supabase/migrations/0023_pos_schema.sql`.

### RLS & Grant

Beda dari semua tabel transaksional lain di project ini — **gak ada policy/grant `insert` sama sekali** ke `authenticated` (bukan cuma "dibatasi role tertentu" kayak AR/AP/Inventory). Satu-satunya jalur nulis adalah `create_pos_sale` (`security definer`, bypass RLS lewat privilege pemilik fungsi). `select` tetap terbuka semua `authenticated`, pola sama modul lain.

```sql
alter table pos_sales enable row level security;
alter table pos_sale_lines enable row level security;

create policy pos_sales_select on pos_sales
  for select using (auth.role() = 'authenticated');

create policy pos_sale_lines_select on pos_sale_lines
  for select using (auth.role() = 'authenticated');

grant select on pos_sales to authenticated;
grant select on pos_sale_lines to authenticated;
```

Role baru:

```sql
insert into roles (name, description) values
  ('cashier', 'Bikin POS Sale doang lewat create_pos_sale — gak punya akses insert langsung ke journal_entries/tabel finansial lain manapun');
```

Detail lengkap: `supabase/migrations/0023_pos_schema.sql`.

## Pembatalan (Void)

**Peta Data (ERD)**

Gak ada tabel baru. Status "dibatalkan" derived dari `exists (select 1 from journal_entries where reverses_entry_id = pos_sales.revenue_journal_entry_id)` — pola sama `ar_invoices` (`ar-schema.md`).

**Interaksi Antar Tabel**

`void_pos_sale` nyentuh 2 `journal_entries` (bukan 1 kayak `cancel_ar_invoice`) karena `pos_sales` dari awal emang selalu punya 2 jurnal terpisah. Juga nyentuh `inventory_balances` langsung (update manual, bukan lewat `consume_weighted_average`) — beda dari RPC lain yang cuma baca/kurangin stok, ini satu-satunya RPC POS yang NAMBAH `qty_on_hand` balik.

## Glossary

- **`pos_sales`/`pos_sale_lines`**: header+baris 1 transaksi kasir tunai, gak pernah nyentuh `ar_invoices`.
- **`create_pos_sale`**: RPC `security definer` pertama di project — guard role manual, bukan RLS, jadi gerbang keamanan utamanya.
- **`void_pos_sale`**: RPC `security invoker` biasa — pembatalan, balikin 2 jurnal + stok.
- **Role `cashier`**: role baru, cuma bisa lewat `create_pos_sale`, gak punya akses insert `journal_entries` langsung.
