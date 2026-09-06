# Orders — Schema (Finalized)

Spine: `orders` (+ `order_lines`). Komitmen pesan ke supplier (`direction='PURCHASE'`)
atau dari customer (`direction='SALE'`) — tahap sebelum realisasi fisik (`goods-receipt-schema.md`/
`goods-issue-schema.md`). Ref konsep bisnis: `docs/domain/inventory.md` +
`memory/domain/inventory.md`. Migration: `0060_orders_schema.sql` (gabungan
`purchase_orders`+`sales_orders`/`purchase_order_lines`+`sales_order_lines`, versi lama
sebelum `0060`).

## Keputusan

- **`purchase_orders`+`sales_orders` digabung jadi `orders`+`order_lines`** (Fase 3
  order-generalization, 2026-09-04, keputusan owner). Dibedakan kolom `direction`
  (`'PURCHASE'`/`'SALE'`), bukan lagi 2 tabel + 2 RPC terpisah. Baru bisa dikerjakan
  sekarang karena 2 prasyaratnya udah selesai: Fase 1 (`0059_counterparty_schema.sql`)
  bikin `counterparty_id` punya 1 tabel rujukan buat kedua arah
  (`counterparty-schema.md`), Fase 2 (`0058_purchase_order_not_mandatory.sql`) bikin PO
  dan SO beneran simetris (dua-duanya opsional, dua-duanya bebas tipe item) — begitu
  ketiga alasan historis PO/SO dipisah (wajib/opsional, tipe item, tabel counterparty
  beda) tercabut semua, gak ada lagi alasan struktural buat 2 tabel terpisah.
- **Yang TETAP terpisah (gak ikut digabung): layer fulfillment + finansial di bawahnya**
  — `create_goods_receipt` (direction `PURCHASE`, `goods-receipt-schema.md`) dan
  `create_goods_issue` (direction `SALE`, `goods-issue-schema.md`) tetap 2 RPC beda
  total, karena efek jurnalnya beneran beda (1 sisi cuma update Persediaan lewat
  `create_ap_bill`, sisi lain bikin 2 jurnal sekaligus — Piutang/Pendapatan DAN
  HPP/Persediaan lewat `create_ar_invoice`). Ini crux kenapa Fase 3 BUKAN generalisasi
  penuh seluruh alur beli/jual — cuma layer komitmen (`orders`) yang digabung, layer
  realisasi fisik tetap 2 tabel/2 RPC berbeda, masing-masing dijaga trigger
  direction-match sendiri karena gak bisa dijamin FK biasa.
- **3-way matching di sisi pembelian (Purchase Order -> GRN -> Bill) OPSIONAL**
  (migration `0058_purchase_order_not_mandatory.sql`, 2026-09-03), mirror padanannya di
  sisi jual (Sales Order -> Goods Issue -> Invoice) yang udah opsional dari awal. Goods
  Receipt/Goods Issue boleh dibuat langsung tanpa order sama sekali (beli/jual dadakan)
  — kedua sisi simetris penuh soal opsionalitas.
- **`orders` gak bikin journal entry**, kedua arah. Order murni komitmen/rencana, belum
  ada pertukaran aset/liability — journal entry baru muncul pas GRN+Bill
  (`direction='PURCHASE'`) atau Goods Issue+Invoice (`direction='SALE'`) dibuat.

## `orders` + `order_lines`

Header (`counterparty_id`, `direction`, `order_date`, `expected_date`, `source_ref`,
`cancelled_at`, `status`) + lines (`item_id`, `qty_ordered`, `unit_price`) — 1 struktur
buat kedua arah, gantiin `purchase_orders`/`purchase_order_lines` (kolom
`unit_cost_expected` dulu, sekarang `unit_price`) dan `sales_orders`/`sales_order_lines`.
`status` (`OPEN`/`PARTIALLY_RECEIVED`|`PARTIALLY_FULFILLED`/`FULLY_RECEIVED`|`FULLY_FULFILLED`/`CANCELLED`,
tergantung `direction`) kolom asli sejak awal tabel ini ada — Fase 3 dibangun setelah
`0053_denormalize_transactional_status.sql`, jadi gak pernah lewat fase "derived view"
kayak `purchase_orders`/`sales_orders` dulu.

```sql
create table orders (
  id uuid primary key default gen_random_uuid(),
  counterparty_id uuid not null references counterparties(id),
  direction text not null check (direction in ('PURCHASE','SALE')),
  order_date date not null,
  expected_date date,
  source_ref text not null,
  cancelled_at timestamptz,
  status text not null default 'OPEN',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index orders_counterparty_id_idx on orders(counterparty_id);
create index orders_direction_idx on orders(direction);
create index orders_order_date_idx on orders(order_date desc);
create index orders_status_idx on orders(status);

create table order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_ordered numeric(14,3) not null check (qty_ordered > 0),
  unit_price numeric(14,2) not null check (unit_price > 0)
);

create index order_lines_order_id_idx on order_lines(order_id);
create index order_lines_item_id_idx on order_lines(item_id);
```

## Trigger `orders_counterparty_direction_guard`

`direction='PURCHASE'` cuma boleh nunjuk `counterparty_id` yang terdaftar role
`supplier` di `counterparty_type_mapping`, `direction='SALE'` cuma boleh role
`customer`. Konsepnya niru `counterparty_role_guard()` (`0059`,
`counterparty-schema.md`) tapi ditulis sebagai trigger BEFORE INSERT khusus tabel ini
(bukan fungsi generik `TG_ARGV` lintas banyak tabel), karena role yang divalidasi
ditentukan dari kolom `direction` di baris yang sama, bukan hardcode per tabel:

```sql
create function orders_counterparty_direction_guard() returns trigger as $$
declare
  v_required_role text;
begin
  v_required_role := case new.direction when 'PURCHASE' then 'supplier' when 'SALE' then 'customer' end;

  if not exists (
    select 1 from counterparty_type_mapping
    where counterparty_id = new.counterparty_id and role = v_required_role
  ) then
    raise exception 'Pihak % bukan % terdaftar -- gak bisa dipakai di order direction %',
      new.counterparty_id, v_required_role, new.direction;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger orders_counterparty_direction_guard_trigger
  before insert on orders
  for each row execute function orders_counterparty_direction_guard();
```

## Immutability + Cancel (`cancelled_at`)

`orders_block_edit_delete_or_cancel()` gabungan `purchase_orders_block_edit_delete_or_cancel`+`sales_orders_block_edit_delete_or_cancel`
(`0024`, aturan freeze-nya sama persis, cuma nama kolom beda) jadi 1 fungsi niru pola
selective-lock `accounts_published_lock` (`coa-schema.md`): bandingin tuple SEMUA kolom
selain `id`/`cancelled_at`/`status`, tolak kalau ada yang berubah ATAU kalau
`cancelled_at` udah keisi (sekali dibatalkan, gak bisa diapa-apain lagi termasuk
dibatalkan ulang). Trigger terpisah `orders_sync_status_on_cancel` (BEFORE UPDATE) set
`status='CANCELLED'` langsung begitu `cancelled_at` baru keisi — gak lewat
`recompute_order_status()` (submodule "Status sync" di bawah), karena trigger
immutability di atas bakal nolak update susulan apa pun begitu `cancelled_at` udah
kepasang. `order_lines` TETAP full-immutable (`block_edit_delete` generik) — baris gak
pernah berubah pas header dibatalkan.

```sql
create function orders_block_edit_delete_or_cancel() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Order gak pernah bisa dihapus';
  end if;

  if old.cancelled_at is not null then
    raise exception 'Order % udah dibatalkan, gak bisa diubah lagi', old.id;
  end if;

  if (old.counterparty_id, old.direction, old.order_date, old.expected_date, old.source_ref,
      old.created_by, old.created_at)
     is distinct from
     (new.counterparty_id, new.direction, new.order_date, new.expected_date, new.source_ref,
      new.created_by, new.created_at) then
    raise exception 'orders immutable kecuali cancelled_at/status';
  end if;

  return new;
end;
$$ language plpgsql;

create trigger orders_block_edit_delete
  before update or delete on orders
  for each row execute function orders_block_edit_delete_or_cancel();

create trigger orders_sync_status_on_cancel_trigger
  before update on orders
  for each row execute function orders_sync_status_on_cancel();

create trigger order_lines_block_edit_delete
  before update or delete on order_lines
  for each row execute function block_edit_delete();
```

## RPC `create_order` / `cancel_order` — gantiin `create_purchase_order`+`create_sales_order`, `cancel_purchase_order`+`cancel_sales_order`

`create_order` terima `p_direction` eksplisit (`raise exception` kalau bukan
`'PURCHASE'`/`'SALE'`), insert header + lines sekaligus. Murni insert, **gak ada journal
entry** (order cuma komitmen). `cancel_order` baca `direction` lebih dulu, baru branch
guard-nya: `PURCHASE` cek `goods_receipt_lines` (via `order_lines`) udah ada realisasi
apa belum, `SALE` cek `goods_issue_lines` — mirror persis `cancel_purchase_order`/`cancel_sales_order`
(`0024`), cuma sekarang 1 fungsi. `security invoker`, murni stempel status — **gak
bikin/balikin jurnal apa pun** (order emang gak pernah punya jurnal, beda dari
`cancel_ar_invoice`/`cancel_ap_bill` yang bikin reversing entry).

```sql
create function create_order(
  p_direction text,
  p_counterparty_id uuid,
  p_order_date date,
  p_expected_date date,
  p_source_ref text,
  p_lines jsonb -- array of {"item_id":uuid,"qty_ordered":numeric,"unit_price":numeric}
) returns uuid language plpgsql security invoker as $$ ... $$;

create function cancel_order(p_order_id uuid) returns void
  language plpgsql security invoker as $$ ... $$;
```

Full body: `supabase/migrations/0060_orders_schema.sql`.

## `purchase_orders_with_status` / `sales_orders_with_status` — TETAP 2 view, terfilter `direction`, di atas 1 tabel `orders`

Rencana awal Fase 3 nyebut 1 view gabungan `orders_with_status`. Migration `0060`
sengaja PAKAI 2 view terfilter `direction` di atas 1 tabel `orders`, bukan 1 view
gabungan — biar `queries.ts` existing (`apps/erp/src/lib/purchase-orders/queries.ts` +
`.../sales-orders/queries.ts`) tetap query `FROM` nama view yang sama, cuma nama kolom
yang berubah, DAN biar list page `/purchase-orders`/`/sales-orders` tetap 2 halaman
terpisah — keputusan UI yang dipertahankan sengaja, bukan keharusan DB.

```sql
create view purchase_orders_with_status
  with (security_invoker = true) as
select id, counterparty_id, direction, order_date, expected_date, source_ref, created_at,
       cancelled_at, status
from orders
where direction = 'PURCHASE';

create view sales_orders_with_status
  with (security_invoker = true) as
select id, counterparty_id, direction, order_date, expected_date, source_ref, created_at,
       cancelled_at, status
from orders
where direction = 'SALE';

grant select on purchase_orders_with_status to authenticated;
grant select on sales_orders_with_status to authenticated;
```

View status LAMA (`0034_purchase_order_status_view.sql`/`0035_sales_order_status_view.sql`,
sempat `select` polos di atas kolom `status` yang didenormalisasi `0053`) di-`drop`
eksplisit di migration `0060` sebelum tabel lama ikut di-`drop`, digantikan versi di
atas — nama & bentuk kolom identik, cuma sumbernya sekarang `orders` terfilter, bukan
`purchase_orders`/`sales_orders` polos.

## Status sync — `recompute_order_status` gabungan `recompute_purchase_order_status`+`recompute_sales_order_status`

1 fungsi, branch di dalam berdasar `direction` (karena "sumber realisasi" beda —
`goods_receipt_lines` vs `goods_issue_lines`, lihat `goods-receipt-schema.md`/
`goods-issue-schema.md` — walau formula `CASE`-nya identik): `cancelled_at` menang
duluan (langsung `return`, karena `orders_block_edit_delete_or_cancel` nolak SEMUA
update lanjutan begitu `cancelled_at` kepasang, termasuk dari fungsi ini kalau gak
di-skip), baru `bool_and()` per baris `order_lines` dibandingkan realisasinya.
`PURCHASE` -> `OPEN`/`PARTIALLY_RECEIVED`/`FULLY_RECEIVED`; `SALE` ->
`OPEN`/`PARTIALLY_FULFILLED`/`FULLY_FULFILLED`. Dipicu trigger `AFTER INSERT` di 3
tabel: `order_lines` (`order_lines_sync_order_status_trigger`), `goods_receipt_lines`
(`goods_receipt_lines_sync_order_status_trigger`, skip kalau `order_line_id` null),
`goods_issue_lines` (`goods_issue_lines_sync_order_status_trigger`, skip kalau
`order_line_id` null) — trigger lama `goods_receipt_lines_sync_po_status_trigger`/`goods_issue_lines_sync_so_status_trigger`
(`0053`) di-drop & diganti (nempel di tabel yang TETAP ADA, bodinya masih nunjuk tabel
lama yang bakal hilang).

```sql
create function recompute_order_status(p_order_id uuid) returns void as $$
declare
  v_direction text;
  v_cancelled_at timestamptz;
  v_all_done boolean;
  v_none_done boolean;
  v_status text;
begin
  select direction, cancelled_at into v_direction, v_cancelled_at from orders where id = p_order_id;
  if not found then
    return;
  end if;

  if v_cancelled_at is not null then
    return;
  end if;

  if v_direction = 'PURCHASE' then
    select
      coalesce(bool_and(coalesce(gr.received, 0) >= ol.qty_ordered - 0.0005), true),
      coalesce(bool_and(coalesce(gr.received, 0) <= 0.0005), true)
      into v_all_done, v_none_done
    from order_lines ol
    left join lateral (
      select sum(grl.qty_received) as received
      from goods_receipt_lines grl
      where grl.order_line_id = ol.id
    ) gr on true
    where ol.order_id = p_order_id;

    v_status := case
      when v_all_done then 'FULLY_RECEIVED'
      when v_none_done then 'OPEN'
      else 'PARTIALLY_RECEIVED'
    end;
  else
    select
      coalesce(bool_and(coalesce(gi.issued, 0) >= ol.qty_ordered - 0.0005), true),
      coalesce(bool_and(coalesce(gi.issued, 0) <= 0.0005), true)
      into v_all_done, v_none_done
    from order_lines ol
    left join lateral (
      select sum(gil.qty_issued) as issued
      from goods_issue_lines gil
      where gil.order_line_id = ol.id
    ) gi on true
    where ol.order_id = p_order_id;

    v_status := case
      when v_all_done then 'FULLY_FULFILLED'
      when v_none_done then 'OPEN'
      else 'PARTIALLY_FULFILLED'
    end;
  end if;

  update orders set status = v_status where id = p_order_id;
end;
$$ language plpgsql security definer set search_path = public;
```

Full body (backfill data lama dari `purchase_orders`/`sales_orders`, DDL, RPC lengkap):
`supabase/migrations/0060_orders_schema.sql`.

## RLS & Grant

Pola identik AR/AP: `select` terbuka semua `authenticated`, `insert` cuma
`admin`/`accountant`. `order_lines` tetap **gak ada policy `update`/`delete`**
(immutable total, 2 lapis proteksi — RLS default-deny + trigger `block_edit_delete`).
`orders` dapat 1 policy `update` (role gate sama pola `insert`), tapi kolom mana yang
boleh berubah dijaga trigger `orders_block_edit_delete_or_cancel()`, BUKAN `WITH CHECK`
per-kolom (pola sama `accounts_update`/`accounts_published_lock` di `coa-schema.md`).

```sql
grant select, insert, update on orders to authenticated; -- update cuma buat cancelled_at/status (dijaga trigger)
grant select, insert on order_lines to authenticated;
```
