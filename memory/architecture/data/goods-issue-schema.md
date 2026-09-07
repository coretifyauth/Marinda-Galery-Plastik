# Goods Issue — Schema (Finalized)

Spine: `goods_issues` (+ `goods_issue_lines`). Kebalikan GRN — barang jadi **keluar**
karena terjual, dibuat bersamaan dengan `transactions` (`create_ar_invoice`, lihat
`transactions-schema.md`). Ref konsep bisnis: `docs/domain/inventory.md` +
`memory/domain/inventory.md` bagian "Penjualan & Pengakuan HPP". Migration awal:
`0004_inventory_schema.sql`, Sales Order: `0024_sales_orders_schema.sql`, Compounding &
PPN: `0025_compound_transactional_entries_schema.sql`, rename ke `orders`:
`0060_orders_schema.sql`.

## `goods_issues` + `goods_issue_lines`

Header: **wajib nunjuk `invoice_id`** (dibuat bersamaan dengan `transactions` baris
`type='INBOUND'`, dulu `ar_invoices` — sama pola GRN+Bill), **`journal_entry_id`**
(Debit HPP, Kredit Persediaan Barang Jadi — **jurnal tambahan**, terpisah dari jurnal
invoice yang sudah ada Debit Piutang/Kredit Pendapatan). Lines: `item_id` (barang
jadi), `qty_issued`, `total_cost` (dari Weighted Average, sama mekanisme
`production_order_lines`, via `consume_weighted_average` — `inventory-ledger-schema.md`).
Immutable (reuse `block_edit_delete`).

```sql
create table goods_issues (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references transactions(id), -- dulu references ar_invoices(id), repoint migration 0064
  journal_entry_id uuid not null references journal_entries(id),
  issue_date date not null,
  source_ref text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create trigger goods_issues_block_edit_delete
  before update or delete on goods_issues
  for each row execute function block_edit_delete();

create table goods_issue_lines (
  id uuid primary key default gen_random_uuid(),
  goods_issue_id uuid not null references goods_issues(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_issued numeric(14,3) not null check (qty_issued > 0),
  total_cost numeric(14,2) not null check (total_cost > 0),
  order_line_id uuid references order_lines(id), -- nullable, migration 0024 (so_line_id), rename dari `sales_order_lines(id)` migration 0060, lihat `orders-schema.md`
  unit_price numeric(14,2) check (unit_price is null or unit_price >= 0) -- migration 0078, lihat submodule di bawah
);

alter table goods_issue_lines add constraint goods_issue_lines_unit_price_xor_order_line
  check (unit_price is null or order_line_id is null); -- migration 0078

create trigger goods_issue_lines_block_edit_delete
  before update or delete on goods_issue_lines
  for each row execute function block_edit_delete();
```

### `unit_price` — migration `0078_pos_sales_simplify_rely_on_goods_issue.sql`

Nullable, mutual exclusivity dengan `order_line_id` (constraint eksplisit, bukan cuma konvensi caller). Muncul dari simplifikasi `pos_sales`/`pos_sale_lines`/`pos_sale_extra_credit_lines` (drop total, `memory/architecture/data/pos-schema.md`) — harga jual per baris item POS SATU-SATUNYA data yang genuinely gak ada tempat lain nyimpennya (beda dari `qty_issued`/`item_id` yang emang duplikat), jadi dipindah ke sini alih-alih tabel salinan terpisah. Cuma keisi kalau `order_line_id` NULL (jalur POS/walk-in tanpa SO) — kalau ada `order_line_id`, harga tetap bersumber dari `order_lines.unit_price` (1 sumber kebenaran, pola sama `ar-invoices/[id]/view.tsx`). `create_goods_issue` nerima lewat `p_lines` (key opsional `"unit_price"`, `jsonb ->> 'unit_price'` = NULL kalau caller gak kirim — non-POS caller, mis. modul goods-issues manual, otomatis dapet NULL tanpa perubahan apa pun di sisi mereka).

## Trigger `goods_issue_lines_order_direction_guard` (baru, migration `0060`)

Mirror `goods_receipt_notes_order_direction_guard` (`goods-receipt-schema.md`), arah
kebalik: `goods_issue_lines.order_line_id`, kalau diisi, cuma boleh nunjuk baris
`order_lines` dari order dengan `direction='SALE'`. `NULL` tetap lolos (jalur jual
langsung tanpa Sales Order).

```sql
create function goods_issue_lines_order_direction_guard() returns trigger as $$
begin
  if new.order_line_id is null then
    return new;
  end if;

  if not exists (
    select 1 from order_lines ol join orders o on o.id = ol.order_id
    where ol.id = new.order_line_id and o.direction = 'SALE'
  ) then
    raise exception 'Baris order % bukan dari Sales Order -- gak bisa dipakai di goods issue', new.order_line_id;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger goods_issue_lines_order_direction_guard_trigger
  before insert on goods_issue_lines
  for each row execute function goods_issue_lines_order_direction_guard();
```

## Trigger `goods_issue_lines_no_over_issue` (kolom disesuaikan `0060`)

Mirror persis `goods_receipt_lines_no_over_receipt` (`goods-receipt-schema.md`), cuma
**skip kalau `order_line_id` null** (jalur jual langsung gak kena guard ini sama
sekali). Signature trigger function gak berubah dari sebelumnya — `0060` cuma `create
or replace` isi body-nya (ganti referensi `sales_order_lines`/`so_line_id` jadi
`order_lines`/`order_line_id`):

```sql
create function goods_issue_lines_no_over_issue() returns trigger as $$
declare
  v_qty_ordered numeric;
  v_qty_issued numeric;
  v_item_name text;
begin
  if new.order_line_id is null then
    return new;
  end if;

  select qty_ordered into v_qty_ordered from order_lines where id = new.order_line_id;
  select coalesce(sum(qty_issued), 0) into v_qty_issued
    from goods_issue_lines where order_line_id = new.order_line_id;

  if v_qty_issued + new.qty_issued > v_qty_ordered then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Pengiriman item "%" melebihi qty dipesan di Sales Order (sisa %, coba kirim %)',
      v_item_name, v_qty_ordered - v_qty_issued, new.qty_issued;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger goods_issue_lines_no_over_issue_trigger
  before insert on goods_issue_lines
  for each row execute function goods_issue_lines_no_over_issue();
```

## RPC `create_goods_issue` — invoice + konsumsi barang jadi + jurnal HPP sekaligus

Panggil `create_ar_invoice` (reuse, `transactions-schema.md`) dulu buat jurnal Debit
Piutang/Kredit Pendapatan, lalu konsumsi tiap barang jadi yang terjual (Weighted
Average), total biayanya jadi jurnal **kedua** (Debit HPP, Kredit Persediaan Barang
Jadi — titik HPP diakui). Trik `id`-digenerate-duluan yang sama kayak
`create_production_order` (`production-orders-schema.md`). Awal body sekarang juga cek
langsung (selain trigger `goods_issue_lines_order_direction_guard`) — kalau ada baris
`p_lines` yang nunjuk `order_line_id` dari order yang udah `cancelled_at`, `raise
exception` sebelum lanjut.

**Riwayat signature**: `p_lines` nambah key opsional `so_line_id` per baris (`0024`,
gak ubah signature level fungsi) -> parameter level fungsi berubah jadi
`p_credit_lines`+`p_apply_tax` gantiin `p_amount`+`p_revenue_account_id` (`0025`,
alasannya `create_ar_invoice` yang dipanggilnya berubah signature, `drop function` dulu
karena breaking) -> key `so_line_id` di `p_lines` di-rename jadi `order_line_id`
(`0060`, cuma rename isi jsonb, bukan parameter level fungsi, `create or replace`
aman).

```sql
create function create_goods_issue(
  p_customer_id uuid, p_invoice_date date, p_description text, p_source_ref text,
  p_credit_lines jsonb, -- array of {"account_id":uuid,"amount":numeric} -- diteruskan ke create_ar_invoice
  p_receivable_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_issued":numeric,"order_line_id":uuid|null}
  p_hpp_account_id uuid, p_finished_good_account_id uuid,
  p_apply_tax boolean default false
) returns uuid language plpgsql security invoker as $$ ... $$;
```

`p_lines` (item + `order_line_id`) dan seluruh logika konsumsi stok/jurnal HPP **TIDAK
berubah** oleh rename `0060` — cuma nama key jsonb yang berubah.

Full body: `supabase/migrations/0004_inventory_schema.sql` (base) ->
`0024_sales_orders_schema.sql` (nambah `so_line_id`) ->
`0025_compound_transactional_entries_schema.sql` (`p_credit_lines`) ->
`0060_orders_schema.sql` (rename `so_line_id` -> `order_line_id`, bentuk final saat
ini).

## RLS & Grant

Pola identik AR/AP: `select` terbuka semua `authenticated`, `insert` cuma
`admin`/`accountant`. Transaksional — **gak ada policy `update`/`delete`** (immutable,
2 lapis proteksi sama kayak journal entry — RLS default-deny + trigger
`block_edit_delete`).

```sql
grant select, insert on goods_issues to authenticated;
grant select, insert on goods_issue_lines to authenticated;
```

Detail lengkap: `supabase/migrations/0012_inventory_schema.sql`.
