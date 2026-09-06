# Goods Receipt — Schema (Finalized)

Spine: `goods_receipt_notes` (+ `goods_receipt_lines`). Bukti penerimaan barang fisik
dari supplier, dibuat bersamaan dengan `transactions` (`create_ap_bill`, lihat
`transactions-schema.md`). Ref konsep bisnis: `docs/domain/inventory.md` +
`memory/domain/inventory.md` bagian "Purchase Order & Sales Order + Penerimaan Barang
(3-Way Matching)". Migration awal: `0004_inventory_schema.sql`, PPN:
`0012_grn_compound_ppn.sql`, PO opsional: `0058_purchase_order_not_mandatory.sql`,
rename ke `orders`: `0060_orders_schema.sql`.

## Keputusan

- **Goods Receipt Note (GRN) dan Bill dibuat bersamaan** (1 RPC, 1 langkah) — asumsi
  proses pembelian informal (nota = bukti kirim + tagihan sekaligus, gak ada jeda waktu
  antara barang datang dan tagihan resmi). Ini menghindari kebutuhan akun perantara
  "Barang Diterima Belum Ditagih" (GR/IR clearing) yang dipakai ERP besar buat kasus
  barang datang duluan tagihan nyusul — dicatat sebagai catatan terbuka (bukan
  scope-debt formal, belum ada file tracking-nya) kalau nanti proses pembeliannya
  berkembang butuh jeda waktu.
- **`order_id` opsional sejak `0058`** — GRN boleh berdiri sendiri tanpa order (beli
  dadakan), mirror `goods-issue-schema.md` yang udah opsional dari awal.

## `goods_receipt_notes` + `goods_receipt_lines`

Bukti penerimaan fisik — **`bill_id` selalu wajib** (dibuat bersamaan, tiap GRN pasti
punya tagihan), **`order_id` opsional sejak `0058`** (nullable, kolom di-rename dari
`purchase_order_id` di migration `0060` — lihat `orders-schema.md`). Kolom
`delivery_note_ref` (nomor Surat Jalan dari supplier) murni referensi teks, gak jadi
entity/ledger tersendiri. Lines mencatat `qty_received` & `unit_cost` **riil** — kalau
baris nunjuk order line (`order_line_id`, di-rename dari `po_line_id` di `0060`,
keisi), bisa beda dari `unit_price` di order line (selisih ini informasional/reporting,
gak diblokir keras, cuma qty yang dijaga trigger anti-over-receipt terhadap
`order_lines.qty_ordered`); kalau `order_line_id` NULL (jalur langsung), gak ada
pembanding sama sekali, item/qty/harga input manual sepenuhnya. Immutable (reuse
`block_edit_delete`), sama pola `transactions`.

Insert `goods_receipt_lines` inilah yang **memicu** penambahan Persediaan: update
`inventory_balances` (avg_cost dihitung ulang, weighted, lihat `inventory-ledger-schema.md`)
— mekanisme ini identik di kedua jalur (dari order/langsung).

```sql
create table goods_receipt_notes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id), -- dulu purchase_order_id -> purchase_orders(id), rename migration 0060
  bill_id uuid not null references transactions(id), -- dulu references ap_bills(id), repoint migration 0064
  delivery_note_ref text,
  receipt_date date not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create trigger goods_receipt_notes_block_edit_delete
  before update or delete on goods_receipt_notes
  for each row execute function block_edit_delete();

create table goods_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  grn_id uuid not null references goods_receipt_notes(id) on delete cascade,
  order_line_id uuid references order_lines(id), -- dulu po_line_id -> purchase_order_lines(id), rename migration 0060
  item_id uuid not null references items(id),
  qty_received numeric(14,3) not null check (qty_received > 0),
  unit_cost numeric(14,2) not null check (unit_cost > 0)
);

create trigger goods_receipt_lines_block_edit_delete
  before update or delete on goods_receipt_lines
  for each row execute function block_edit_delete();
```

## Trigger `goods_receipt_notes_order_direction_guard`

`goods_receipt_notes.order_id`, kalau diisi, cuma boleh nunjuk `orders` dengan
`direction='PURCHASE'`. Gak bisa dijamin FK biasa (FK cuma jamin ID-nya ada, gak jamin
kolom lain di baris yang ditunjuk sesuai), butuh trigger sendiri — pola sama proteksi
type-safety `counterparty_role_guard`. `NULL` tetap lolos (jalur langsung tanpa order).

```sql
create function goods_receipt_notes_order_direction_guard() returns trigger as $$
begin
  if new.order_id is null then
    return new;
  end if;

  if not exists (select 1 from orders where id = new.order_id and direction = 'PURCHASE') then
    raise exception 'Order % bukan Purchase Order -- gak bisa dipakai di goods receipt', new.order_id;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger goods_receipt_notes_order_direction_guard_trigger
  before insert on goods_receipt_notes
  for each row execute function goods_receipt_notes_order_direction_guard();
```

## Trigger `goods_receipt_lines_no_over_receipt` (ditulis ulang `0058`, kolom disesuaikan `0060`)

Menolak `qty_received` yang bikin total penerimaan per order line ngelewatin
`qty_ordered` — **skip total kalau `order_line_id` NULL** (jalur langsung tanpa order
gak punya apa pun buat dibandingkan), mirror persis pola `goods_issue_lines_no_over_issue`
(`goods-issue-schema.md`) yang udah skip kalau `order_line_id` null. Signature trigger
function gak berubah dari `0058` — `0060` cuma `create or replace` isi body-nya (ganti
referensi `purchase_order_lines`/`po_line_id` jadi `order_lines`/`order_line_id`), aman
tanpa `drop function`:

```sql
create function goods_receipt_lines_no_over_receipt() returns trigger as $$
declare
  v_qty_ordered numeric;
  v_qty_received numeric;
  v_item_name text;
begin
  if new.order_line_id is null then
    return new;
  end if;

  select qty_ordered into v_qty_ordered from order_lines where id = new.order_line_id;
  select coalesce(sum(qty_received), 0) into v_qty_received
    from goods_receipt_lines where order_line_id = new.order_line_id;

  if v_qty_received + new.qty_received > v_qty_ordered then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Penerimaan item "%" melebihi qty dipesan (sisa %, coba terima %)',
      v_item_name, v_qty_ordered - v_qty_received, new.qty_received;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger goods_receipt_lines_no_over_receipt_trigger
  before insert on goods_receipt_lines
  for each row execute function goods_receipt_lines_no_over_receipt();
```

## RPC `create_goods_receipt` — GRN + Bill + update Persediaan sekaligus

Titik paling padat di modul ini — 1 pemanggilan RPC memicu 4 hal atomik: (1) resolve
`v_supplier_id` (dari order kalau `p_order_id` diisi — WAJIB `direction='PURCHASE'`,
dicek langsung di body RPC ini juga selain trigger `goods_receipt_notes_order_direction_guard`
— dari `p_supplier_id` manual kalau enggak), hitung total amount dari lines + gabung
sama `p_extra_debit_lines` kalau ada, (2) panggil `create_ap_bill` (reuse,
`transactions-schema.md`) buat bikin bill+jurnal utang, ikut kirim `p_apply_tax`, (3)
insert `goods_receipt_notes`+`goods_receipt_lines`, (4) per line: hitung ulang
`avg_cost` (weighted) & update `inventory_balances` (`inventory-ledger-schema.md`).
Trigger `goods_receipt_lines_no_over_receipt` jalan otomatis pas langkah (3).

**Kategori Campur & PPN (migration `0012_grn_compound_ppn.sql`)** — 2 param di akhir
signature (`p_extra_debit_lines` default `null`, `p_apply_tax` default `false`),
additive, gak berubah lagi sejak itu.

**Guard cancel (migration `0024`, sekarang `cancel_order`)** — order yang UDAH
dibatalkan gak bisa lagi jadi dasar GRN baru, dicek awal body (`if exists (... orders
where id = p_order_id and cancelled_at is not null) then raise exception ...`).

**Param rename `0060`, BUKAN perubahan signature struktural** — `p_purchase_order_id`
jadi `p_order_id` (tipe/urutan param lain gak berubah), `p_lines` isinya `order_line_id`
gantiin `po_line_id`. `create or replace` langsung, gak perlu `drop function` (beda dari
perubahan `0058` yang nambah/ubah daftar parameter beneran, WAJIB `drop function if
exists` dulu — pelajaran dari bug `0011`/`0012` `create_ap_bill` yang udah pernah
kejadian persis di project ini).

**Catatan validasi supplier jalur langsung (gak berubah dari `0058`)** — body ini masih
cek `not exists (select 1 from suppliers where id = p_supplier_id)`, nunjuk ke tabel
`suppliers` LEGACY yang belum di-drop (`0059`, lihat `memory/architecture/data/counterparty-schema.md`),
BUKAN `counterparties`. Perilaku ini gak disentuh migration `0060` (bukan bagian dari
Fase 3 — warisan langsung dari `0058`), dicatat di sini biar gak dikira kelupaan pas
baca ulang.

```sql
create function create_goods_receipt(
  p_order_id uuid, -- dulu p_purchase_order_id, rename migration 0060, nullable sejak 0058
  p_receipt_date date, p_delivery_note_ref text,
  p_lines jsonb, -- array of {"order_line_id":uuid|null,"item_id":uuid,"qty_received":numeric,"unit_cost":numeric}
  p_bill_description text, p_bill_source_ref text,
  p_debit_account_id uuid, p_payable_account_id uuid,
  p_extra_debit_lines jsonb default null, -- array of {"account_id":uuid,"amount":numeric} -- Beban tambahan (ongkir, dst), BUKAN kategori Persediaan
  p_apply_tax boolean default false,
  p_supplier_id uuid default null -- wajib diisi kalau p_order_id NULL
) returns uuid language plpgsql security invoker as $$ ... $$;
```

Full body: `supabase/migrations/0004_inventory_schema.sql` (definisi awal) ->
`supabase/migrations/0012_grn_compound_ppn.sql` (kategori campur & PPN) ->
`supabase/migrations/0058_purchase_order_not_mandatory.sql` (PO opsional) ->
`supabase/migrations/0060_orders_schema.sql` (rename ke `orders`/`order_lines`, bentuk
final saat ini).

## RLS & Grant

Pola identik AR/AP: `select` terbuka semua `authenticated`, `insert` cuma
`admin`/`accountant`. `goods_receipt_notes`/`goods_receipt_lines` **gak ada policy
`update`/`delete`** (immutable total, 2 lapis proteksi — RLS default-deny + trigger
`block_edit_delete`).

```sql
grant select, insert on goods_receipt_notes to authenticated;
grant select, insert on goods_receipt_lines to authenticated;
```

Detail lengkap: `supabase/migrations/0012_inventory_schema.sql`.
