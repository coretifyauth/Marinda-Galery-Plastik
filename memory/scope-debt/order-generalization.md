# Generalisasi Purchase + Sales -> Order (+ Counterparty)

**Modul asal:** cross-cutting (Inventory: Purchase Order/Sales Order + AR/AP: Customer/Supplier) — hasil diskusi arsitektur dengan owner, bukan gap yang ketemu pas bangun fitur. **Status:** Ditunda. Gabungan dari 3 keputusan yang tadinya dicatat terpisah (`counterparty-generalization.md` + `purchase-order-not-mandatory.md`, keduanya digabung ke sini dan dihapus 2026-09-03).

## Kasus

Owner mengusulkan generalisasi objek pembelian dan penjualan yang sekarang terpisah jadi lebih sedikit objek:
- `customers`+`suppliers` -> `counterparties` (+ `counterparty_type_mapping` buat role, biar 1 entitas bisa jadi customer DAN supplier sekaligus)
- `purchase_orders`+`sales_orders` -> `orders`+`order_lines` (dibedakan kolom `direction`)

Alasan PO dan SO dipertahankan terpisah dari awal ada 3 pilar, dan ketiganya sudah tercabut lewat diskusi ini:
1. **PO wajib sebelum penerimaan barang, SO opsional** — diputuskan owner (2026-09-03) buat disamakan, dua-duanya jadi opsional (Fase 2 di bawah).
2. **PO dibatasi item `RAW_MATERIAL`, SO bebas semua tipe** — sudah selesai diseragamkan (dropdown PO di `apps/erp/src/app/(app)/purchase-orders/page.tsx` gak lagi difilter `item_type`; 0 perubahan schema karena pembatasannya emang cuma UI, gak pernah ada CHECK/trigger DB).
3. **`supplier_id` FK ke `suppliers`, `customer_id` FK ke `customers` — 2 tabel beda** — ada desain kredibel buat disatukan (Fase 1 di bawah).

Begitu ketiganya tercabut, gak ada lagi alasan struktural PO dan SO tetap 2 tabel terpisah. Ini **beda dari Invoice/Bill (AR/AP)** yang tetap harus terpisah — divergensinya independen dari 3 poin di atas (kebijakan retur additive-vs-exclusive, kebijakan deposit, dst — murni beda kebijakan bisnis yang berkembang independen, BUKAN scope file ini; kasus retur AR-vs-AP sendiri sudah selesai diseragamkan lewat migration `0057_ar_warranty_replacement_independent.sql`).

## Urutan pengerjaan (wajib, ada dependency)

```
Fase 1: Counterparty   (customers+suppliers -> counterparties + counterparty_type_mapping)
Fase 2: PO Not Mandatory (PO jadi opsional, biar simetris sama SO)
Fase 3: Orders          (purchase_orders+sales_orders -> orders+order_lines)
```

Fase 3 **gak bisa jalan tanpa Fase 1 beres** — `orders.counterparty_id` butuh tabel `counterparties` sudah ada. Fase 2 independen dari Fase 1 (bisa duluan/bareng), tapi harus beres SEBELUM Fase 3 biar `orders` gak mewarisi asimetri wajib/opsional dari `purchase_orders` lama.

---

## Fase 1 — Counterparty

Dicek langsung strukturnya — 6 dari 8 kolom `customers`/`suppliers` identik:

```
customers: id, name, contact, payment_term_days, credit_limit, overdue_threshold_days, archived_at, created_at, updated_at
suppliers: id, name, contact, payment_term_days,                                        archived_at, created_at, updated_at
```

Bedanya cuma `credit_limit`+`overdue_threshold_days` (dipakai buat cek credit hold pas `create_ar_invoice`, konsep risiko piutang yang cuma relevan ke customer).

```sql
create table counterparties (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  payment_term_days int not null check (payment_term_days > 0),
  credit_limit numeric(14,2) check (credit_limit is null or credit_limit > 0),        -- cuma relevan role customer
  overdue_threshold_days int check (overdue_threshold_days is null or overdue_threshold_days > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table counterparty_type_mapping (
  id uuid primary key default gen_random_uuid(),
  counterparty_id uuid not null references counterparties(id),
  role text not null check (role in ('customer','supplier')),
  unique (counterparty_id, role)
);
```

**Kenapa perlu didesain dulu, gak langsung digarap:**

1. **Type-safety enforcement — RPC-level SAJA GAK CUKUP.** `purchase_order_lines`/`sales_order_lines` (dan tabel transaksional AR/AP lain) punya INSERT policy LANGSUNG ke tabel (`purchase_order_lines_insert`, `sales_order_lines_insert`, `supabase/migrations/0004_inventory_schema.sql`) — beda dari `pos_sales` yang cuma bisa ditulis lewat RPC `security definer`. Validasi yang cuma ditaruh di RPC bisa dilewati kalau ada yang insert langsung ke tabel (role admin/accountant punya akses itu). Dua opsi buat proteksi yang beneran nempel:
   - (a) Trigger di tabel transaksional yang cek `counterparty_type_mapping` (niru pola `item_units_nested_conversion_guard`, `memory/architecture/data/inventory-schema.md`).
   - (b) Ubah filosofi akses jadi RPC-only `security definer` (niru pola POS sale) — perubahan besar TERPISAH yang mengubah pola akses SEMUA modul transaksional, bukan cuma buat kebutuhan ini.

2. **Strategi migrasi data**: `customers`+`suppliers` existing (dengan histori transaksi yang udah FK ke tabel masing-masing) perlu dipindah ke `counterparties` tanpa mem-break FK yang udah ada di puluhan tabel transaksional — urutan hati-hati: buat tabel baru -> backfill data -> alih FK satu-satu -> drop tabel lama, bukan 1 migration sekali jalan.

**Audit dampak lengkap (dicek langsung ke semua migration, bukan cuma dugaan):**

*Lapis 1 — FK langsung, WAJIB direpoint ke `counterparties(id)`:*
- Sisi customer (6 tabel): `ar_invoices.customer_id`, `ar_payments.customer_id`, `ar_deposits.customer_id`, `ar_return_credits.customer_id`, `sales_orders.customer_id`, `pos_sales.customer_id` (nullable).
- Sisi supplier (5 tabel): `ap_bills.supplier_id`, `ap_payments.supplier_id`, `ap_return_credits.supplier_id`, `ap_deposits.supplier_id`, `purchase_orders.supplier_id`.

*Lapis 2 — lookup runtime di dalam RPC (bukan kolom tersimpan, tapi baca tabel langsung saat eksekusi):*
- `create_ar_invoice` (`0005_ar_schema.sql:784-787`) — baca `customers.payment_term_days` (hitung `due_date`) + `customers.credit_limit`/`overdue_threshold_days` (Credit Hold) tiap invoice baru.
- `create_ap_bill` (`0011_document_numbering.sql:135`) — baca `suppliers.payment_term_days` buat `due_date`, pola sama.
- `delete_customer`/`delete_supplier` (`0013_master_data_smart_delete.sql:73-99`) — RPC smart-delete (hard delete kalau belum pernah dipakai, fallback arsip kalau udah), 2 RPC terpisah yang perlu digabung jadi 1 `delete_counterparty` atau tetap 2 wrapper tipis.

*Lapis 3 — query frontend (paling lebar, tapi mekanis/rendah risiko):* 9 file `apps/erp`/`apps/pos` query `customers` langsung, 6 file query `suppliers` langsung, plus 12 file nested-select `customers(name)` dan 10 file `suppliers(name)` (dropdown pemilih, kolom nama di list/detail) tersebar di `/ar-invoices`, `/ar-payments`, `/ar-deposits`, `/sales-orders`, `/customers`, `apps/pos`, dan padanan AP-nya.

**Batas radius penting**: tabel yang cuma nunjuk ke `ar_invoices`/`ap_bills`/`sales_orders`/`purchase_orders` (BUKAN ke `customers`/`suppliers` langsung) — `ar_credit_notes`, `inventory_returns`, `warranty_replacements`, `goods_issues`, `ap_credit_notes`, `purchase_replacements`, `purchase_writeoffs`, `goods_receipt_notes`, dst — **gak kena dampak sama sekali**, karena FK mereka nunjuk ke `ar_invoices.id`/`ap_bills.id` yang ID-nya gak berubah. Walau AR/AP total puluhan tabel, yang beneran kena cuma 1 lapis turunan langsung dari `customers`/`suppliers` (Lapis 1 di atas).

3. **Belum ada bukti kebutuhan konkret** buat kasus "1 entitas jadi customer DAN supplier sekaligus" di cerita bisnis — pertimbangan tambahan soal urgensi, bukan penghalang desain.

---

## Fase 2 — PO Tidak Lagi Wajib

Saat ini `create_goods_receipt` mewajibkan `purchase_order_id` (`goods_receipt_notes.purchase_order_id` kolom `not null`, `supabase/migrations/0004_inventory_schema.sql`) — gak ada jalur terima barang tanpa PO sama sekali. Beda dari Sales Order yang udah opsional sejak migration `0024` (`goods_issue_lines.so_line_id` nullable).

**Perubahan teknis:**
- `goods_receipt_notes.purchase_order_id` jadi nullable.
- `goods_receipt_lines.po_line_id` (saat ini `not null`) ikut jadi nullable — GRN tanpa PO berarti baris GRN-nya gak nunjuk `po_line_id` manapun.
- Trigger `goods_receipt_lines_no_over_receipt` perlu skip pengecekan kalau `po_line_id` NULL — mirror pola `goods_issue_lines_no_over_issue` yang udah skip kalau `so_line_id` null.
- `create_goods_receipt` RPC perlu terima `p_purchase_order_id`/`po_line_id` sebagai opsional.
- UI `/goods-receipts` perlu jalur "terima barang langsung tanpa PO".

**Catatan:** kalau Fase 3 (Orders) dikerjakan SETELAH fase ini, perubahan di atas cukup diterapkan sekali ke `orders`/`order_lines` langsung (gak perlu diterapkan dulu ke `purchase_orders` lama lalu dimigrasi lagi) — tapi keputusan SIMETRINYA (PO jadi opsional) tetap harus diputuskan di sini duluan, terlepas dari kapan implementasi schema-nya jalan.

---

## Fase 3 — Orders

```sql
create table orders (
  id uuid primary key default gen_random_uuid(),
  counterparty_id uuid not null references counterparties(id),   -- butuh Fase 1 beres
  direction text not null check (direction in ('PURCHASE','SALE')),
  order_date date not null,
  expected_date date,
  source_ref text not null,
  cancelled_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_ordered numeric(14,3) not null check (qty_ordered > 0),
  unit_price numeric(14,2) not null check (unit_price > 0)
);

-- Type-safety BARU, gak ada padanannya sebelum ini — pastikan direction='PURCHASE' cuma
-- boleh nunjuk counterparty berperan supplier, direction='SALE' cuma boleh nunjuk
-- counterparty berperan customer.
create function orders_counterparty_direction_guard() returns trigger as $$ ... $$;
```

**Yang TETAP harus terpisah** (gak ikut digabung): layer fulfillment + finansial di bawahnya, karena arah beneran menentukan RPC yang beda total —
- `direction='PURCHASE'` -> `create_goods_receipt` (update `inventory_balances` langsung, panggil `create_ap_bill`)
- `direction='SALE'` -> `create_goods_issue` (2 jurnal sekaligus: Piutang/Pendapatan DAN HPP/Persediaan, panggil `create_ar_invoice`)

`goods_receipt_notes.order_id` cuma boleh nunjuk order `direction='PURCHASE'`, `goods_issue_lines.order_line_id` cuma boleh nunjuk `direction='SALE'` — butuh trigger sendiri (gak bisa dijamin FK biasa), pola sama proteksi type-safety Fase 1.

### Struktur yang HILANG kalau Fase 3 selesai

| Kategori | Nama | Digantikan oleh |
|---|---|---|
| Tabel | `purchase_orders` | `orders` (`direction='PURCHASE'`) |
| Tabel | `purchase_order_lines` | `order_lines` |
| Tabel | `sales_orders` | `orders` (`direction='SALE'`) |
| Tabel | `sales_order_lines` | `order_lines` |
| RPC | `create_purchase_order()`, `create_sales_order()` | 1 `create_order(p_direction, ...)` |
| RPC | `cancel_purchase_order()`, `cancel_sales_order()` | 1 `cancel_order()` |
| Trigger | `purchase_orders_block_edit_delete_or_cancel`, `sales_orders_block_edit_delete_or_cancel` | 1 `orders_block_edit_delete_or_cancel` |
| RLS Policy | `purchase_orders_insert/update`, `sales_orders_insert/update`, `purchase_order_lines_insert`, `sales_order_lines_insert` | `orders_insert/update`, `order_lines_insert` |
| View | `purchase_orders_with_status` (`0034`), `sales_orders_with_status` (`0035`) | 1 `orders_with_status` |
| Kolom FK | `goods_receipt_notes.purchase_order_id` | `goods_receipt_notes.order_id` |
| Kolom FK | `goods_receipt_lines.po_line_id` | `goods_receipt_lines.order_line_id` |
| Kolom FK | `goods_issue_lines.so_line_id` | `goods_issue_lines.order_line_id` |
| Param RPC | `create_goods_receipt(p_purchase_order_id, ...)` | `create_goods_receipt(p_order_id, ...)` |
| Param RPC | `create_goods_issue(..., so_line_id di p_lines)` | `create_goods_issue(..., order_line_id di p_lines)` |

### Migrasi data — bukan cuma ganti nama tabel

`customers`+`suppliers` harus pindah ke `counterparties`+`counterparty_type_mapping` DULU (Fase 1), baru `purchase_orders`+`sales_orders` bisa pindah ke `orders` (butuh `counterparty_id` valid). Tabel transaksional lain yang FK ke ID lama (`ar_invoices`, `ap_bills`, `goods_receipt_notes`, dst) immutable (`block_edit_delete`) — nge-update FK-nya ke ID baru butuh migrasi terkontrol (bukan `UPDATE` biasa yang bakal ketolak trigger), pola serupa backfill besar yang udah pernah dilakukan project ini (`inventory_movements`, migration `0042`-`0052`).

## Referensi

- `memory/architecture/data/ar-schema.md` — DDL `customers`, submodule "Credit Hold"
- `memory/architecture/data/ap-schema.md` — DDL `suppliers`
- `memory/architecture/data/inventory-schema.md` — DDL `purchase_orders`/`sales_orders`, pola `item_units_nested_conversion_guard` sebagai rujukan trigger type-safety
- `memory/domain/inventory.md` — submodule "Purchase Order & Penerimaan Barang" dan "Sales Order & Pemenuhan Bertahap"
- `memory/architecture/data/ar-schema.md` submodule "Penukaran Barang Pasca-Retur (Garansi)" — kasus generalisasi TERPISAH (AR/AP retur, sudah selesai lewat migration `0057`), bukan bagian dari file ini
