# Counterparty — Schema (Finalized)

Cross-cutting, bukan bagian dari 1 modul tunggal — dipakai bareng AR, AP, Inventory (PO/SO), dan POS. Fase 1 dari order-generalization (keputusan owner, 2026-09-03, ketiga fase closed 2026-09-04). Migration: `0059_counterparty_schema.sql`.

## Keputusan

- **Gabung `customers`+`suppliers` jadi 1 tabel `counterparties`** — dicek langsung strukturnya sebelum digabung: 6 dari 8 kolom identik (bedanya cuma `credit_limit`/`overdue_threshold_days`, konsep risiko piutang yang cuma relevan customer). Peran dicatat lewat tabel junction terpisah `counterparty_type_mapping` (bukan kolom `type` tunggal) — biar 1 pihak bisa berperan customer DAN supplier sekaligus kalau suatu saat dibutuhkan.
- **Proteksi type-safety: TRIGGER, bukan RPC-only `security definer`** — keputusan owner eksplisit. Trigger `counterparty_role_guard()` (generik, dipakai 11 tabel via `TG_ARGV`) nempel di pola yang udah ada di project ini (mirror `item_units_nested_conversion_guard`), gak ngubah filosofi akses tabel transaksional (PO/SO/AR/AP tetap boleh insert langsung asal role admin/accountant, sama kayak sebelumnya — bukan RPC-only kayak POS sale).
- **Backfill PAKAI ID ASLI dari `customers`/`suppliers`**, bukan ID baru — UUID gak pernah collide antar 2 tabel beda (dijaga eksplisit lewat pre-flight check). Konsekuensinya: 11 tabel yang tadinya FK ke `customers`/`suppliers` **gak perlu backfill data sama sekali** buat migrasi ini — cukup `DROP`+`ADD CONSTRAINT` nunjuk ke tabel baru (DDL murni, bukan row-level `UPDATE`, gak kena trigger `block_edit_delete` apa pun).
- **`customers`/`suppliers` (tabel lama) sengaja belum di-drop** — masih ada di database, tapi udah gak ada 1 pun FK/RPC/frontend yang nunjuk ke situ lagi (semua caller, termasuk `/customers`+`/suppliers` UI dan puluhan form transaksi, udah dipindah ke `counterparties` bareng migration ini). Drop-nya jadi migration terpisah nanti — sengaja gak digabung, biar ada jeda observasi sebelum data lama beneran hilang.

## DDL

### `counterparties` — master data pihak (customer dan/atau supplier)

```sql
create table counterparties (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  payment_term_days int not null check (payment_term_days > 0),
  credit_limit numeric(14,2) check (credit_limit is null or credit_limit > 0),
  overdue_threshold_days int check (overdue_threshold_days is null or overdue_threshold_days > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Struktur identik gabungan `customers`+`suppliers` lama — `credit_limit`/`overdue_threshold_days` cuma dipakai jalur Credit Hold AR (`create_ar_invoice`), gak relevan buat pihak yang cuma berperan supplier tapi kolomnya tetap ada di semua baris (nullable, konsisten 1 tabel 1 bentuk). **Beda dari `customers`/`suppliers` lama**: `payment_term_days` gak lagi punya `DEFAULT` di level kolom (dulu `customers` default 7, `suppliers` default 14 — beda default gak bisa dipertahankan di 1 kolom yang sama) — RPC `create_counterparty` yang nentuin default per pemanggilan (`p_payment_term_days default 7`, form `/suppliers` selalu kirim eksplisit 14).

**DDL & RPC di atas dokumentasi state migration `0059` (histori).** Kolom `credit_limit`/`overdue_threshold_days` **didrop total migration `0065`** (2026-09-05) bareng pencabutan fitur Credit Hold — lihat `memory/architecture/data/transactions-schema.md`. `create_counterparty` juga direcreate `0065` tanpa parameter `p_credit_limit`/`p_overdue_threshold_days` (signature terkini: `(p_name text, p_role text, p_contact text default null, p_payment_term_days int default 7)`).

### `counterparty_type_mapping` — peran (customer/supplier), bisa lebih dari 1 per pihak

```sql
create table counterparty_type_mapping (
  id uuid primary key default gen_random_uuid(),
  counterparty_id uuid not null references counterparties(id),
  role text not null check (role in ('customer', 'supplier')),
  unique (counterparty_id, role)
);
```

Role sekali ditetapkan gak berubah lagi — gak ada policy `update`, cuma `select`+`insert` (plus `delete` lewat `delete_counterparty()`, `security definer`).

## Trigger `counterparty_role_guard()` — proteksi type-safety, 11 tabel

Fungsi generik, `TG_ARGV[0]` = nama kolom (`customer_id`/`supplier_id`), `TG_ARGV[1]` = role wajib (`customer`/`supplier`). Extract nilai kolom dari `NEW` pakai `to_jsonb(new) ->> nama_kolom` (gak perlu fungsi terpisah per tabel). NULL diizinkan lolos (kolom nullable, mis. `pos_sales.customer_id` — walk-in kios).

```sql
create function counterparty_role_guard() returns trigger as $$
declare
  v_column_name text := TG_ARGV[0];
  v_required_role text := TG_ARGV[1];
  v_counterparty_id uuid;
begin
  v_counterparty_id := (to_jsonb(new) ->> v_column_name)::uuid;
  if v_counterparty_id is null then
    return new;
  end if;
  if not exists (
    select 1 from counterparty_type_mapping
    where counterparty_id = v_counterparty_id and role = v_required_role
  ) then
    raise exception 'Pihak % bukan % terdaftar -- gak bisa dipakai di sini', v_counterparty_id, v_required_role;
  end if;
  return new;
end;
$$ language plpgsql;
```

**Awalnya 11 tabel terpasang** (migration `0059`, `before insert`, cukup insert-only karena semua kolom `customer_id`/`supplier_id` di tabel-tabel ini immutable write-once — dijaga trigger selective-lock lain yang udah ada, dikonfirmasi lewat `schema-reviewer` nyisir tuple immutable check di `0053_denormalize_transactional_status.sql`+`0024_purchase_order_sales_order_cancel.sql`). Sejak itu, tabel-tabel yang dulu punya `customer_id`/`supplier_id` terpisah (2 kolom, 2 tabel kembar) satu per satu digabung jadi 1 tabel generic dengan 1 kolom `counterparty_id` tunggal — **fungsi `counterparty_role_guard()` tetap dipakai (gak ditulis ulang)**, cuma sekarang dipasang sebagai SEPASANG trigger per tabel (`_inbound`/`_outbound`, masing-masing `TG_ARGV` beda role) yang saling eksklusif lewat kondisi `WHEN` pada kolom `direction`/`type` di baris yang sama, bukan lagi 1 trigger per tabel yang hardcode 1 kolom:
- `orders` (migration `0060`, gantiin `sales_orders`/`purchase_orders`) — `orders_counterparty_role_guard_inbound`/`_outbound`, dari kolom `direction`. Detail: `memory/architecture/data/orders-schema.md`.
- `transactions` (migration `0064`, gantiin `ar_invoices`/`ap_bills`) — `transactions_counterparty_role_guard_inbound`/`_outbound`, dari kolom `type`. Detail: `memory/architecture/data/transactions-schema.md`.
- `payments` (gantiin `ar_payments`/`ap_payments`), `deposits` (gantiin `ar_deposits`/`ap_deposits`), `return_credits` (gantiin `ar_return_credits`/`ap_return_credits`) — pola identik, masing-masing `<tabel>_counterparty_role_guard_inbound`/`_outbound` dari kolom `type`. Detail: `memory/architecture/data/payments-schema.md`, `deposits-schema.md`, `return-credits-schema.md`.

`credit_notes` sengaja **gak punya kolom `counterparty_id` sama sekali** — pihaknya ditelusuri gak langsung lewat `transaction_id` -> `transactions.counterparty_id`, jadi gak butuh trigger role-guard sendiri (detail: `memory/architecture/data/credit-notes-schema.md`).

Sisa **1 tabel** yang masih dijaga pola asli migration `0059` (1 trigger, 1 kolom hardcode via `TG_ARGV`, karena kolomnya emang cuma 1 arah dan nullable):

| Sisi customer (`role='customer'`) | Sisi supplier (`role='supplier'`) |
|---|---|
| `pos_sales.customer_id` (nullable) | — |

## Repoint 11 FK constraint — fungsi introspeksi, bukan tebak nama

`_repoint_fk_to_counterparties(p_table regclass, p_column name)` — helper migration-only (di-drop lagi di akhir migration), baca `pg_constraint`/`pg_attribute` langsung buat nemuin nama constraint FK lama yang beneran ada (bukan asumsi konvensi penamaan), drop, lalu bikin constraint baru bernama eksplisit `<table>_<column>_fkey` nunjuk `counterparties(id)`. Dipanggil 11 kali (1 per tabel di tabel Trigger di atas).

## RPC `create_counterparty` — bikin pihak baru + role dalam 1 transaksi

```sql
create function create_counterparty(
  p_name text,
  p_role text, -- 'customer' atau 'supplier'
  p_contact text default null,
  p_payment_term_days int default 7,
  p_credit_limit numeric default null,
  p_overdue_threshold_days int default null
) returns uuid
language plpgsql security invoker as $$ ... $$;
```

`security invoker` — insert pertama (`counterparties`) kena RLS `counterparties_insert`, insert kedua (`counterparty_type_mapping`) kena RLS `counterparty_type_mapping_insert`, dua-duanya admin/accountant-gated. Gak ada guard role manual duplikat di body function (beda dari `delete_counterparty` yang `security definer` dan karena itu WAJIB guard manual — RLS di-bypass). Dipakai `/customers` (`p_role: "customer"`) dan `/suppliers` (`p_role: "supplier"`) — gantiin insert langsung ke tabel `customers`/`suppliers` lama, mencegah baris `counterparties` "yatim" tanpa role kalau salah satu insert gagal di tengah jalan.

## RPC `delete_counterparty` — gabung `delete_customer`+`delete_supplier`

`security definer`, pola sama `delete_item` (`0013_master_data_smart_delete.sql`) — hapus `counterparty_type_mapping` DULU di blok `begin/exception` yang sama (dianggap konfigurasi peran, bukan riwayat transaksi eksternal), baru `counterparties`-nya. `foreign_key_violation` (dari salah satu 11 tabel di atas yang masih nunjuk) ditangkap, fallback arsip (`archived_at`) — bukan hard delete gagal total.

## Dampak ke `create_ar_invoice`/`create_ap_bill` (histori — kedua RPC ini sudah didrop `0065`)

Pas migration `0059`: sumber lookup `payment_term_days`/`credit_limit`/`overdue_threshold_days` pindah dari `customers`/`suppliers` ke `counterparties` — **satu-satunya perubahan**, seluruh logic lain (credit hold, PPN, journal building) byte-identik ke versi sebelumnya, dikonfirmasi `schema-reviewer` line-by-line. RPC `create_ar_invoice`/`create_ap_bill` sendiri kemudian digantikan RPC generic `create_transaction` (migration `0063`-`0065`, lihat `memory/architecture/data/transactions-schema.md`), yang gak ngecek credit hold sama sekali (fitur itu dicabut total).

## Dampak frontend

42 file (`apps/erp` + `apps/pos`) disapu — nama relasi nested-select `customers(...)`/`suppliers(...)` jadi `counterparties(...)` di semua query yang nampilin nama pihak dari tabel lain (AR Invoice/Payment/Deposit/Return Credit, AP Bill/Payment/Deposit/Return Credit, PO, SO, Goods Receipt/Issue, POS Sale). Dropdown pemilih customer/supplier di form transaksi (bukan cuma display nama) difilter lewat `counterparty_type_mapping!inner(role)` + `.eq("counterparty_type_mapping.role", "customer"/"supplier")` — biar supplier gak nongol di dropdown "pilih customer" dan sebaliknya. `/customers`+`/suppliers` (halaman + `[id]` detail) dipindah penuh ke `counterparties` (load, edit, arsipkan, hapus via `delete_counterparty`).

## RLS & Grant

Pola identik `customers`/`suppliers` lama: `select` semua `authenticated`, `insert`+`update` role-gated admin/accountant, **gak ada** policy `delete` (arsip lewat `archived_at` + `delete_counterparty()` security definer). `counterparty_type_mapping` cuma `select`+`insert` (gak ada `update`, role sekali ditetapkan gak berubah).
