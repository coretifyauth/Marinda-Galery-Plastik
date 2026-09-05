# Transactions — Schema (Finalized)

Gantiin `ar_invoices` (AR) + `ap_bills` (AP) — digabung jadi 1 tabel generic `transactions`
(kolom `type` `'INBOUND'`/`'OUTBOUND'`), migration `0063`-`0066` (2026-09-05). Histori
keputusan & proses eksekusi lengkap: `memory/scope-debt/ar-ap-unify-transactions.md`
(ditutup — lihat `git log` buat detail proses kalau perlu). Ref konsep bisnis gak berubah:
`docs/domain/accounts-receivable.md` (piutang) + `docs/domain/accounts-payable.md`
(utang) — cuma penyimpanannya yang digabung, substansi akuntansi tetap persis sama
(Debit Piutang vs Kredit Utang, dst).

Pola sama kayak `counterparty-schema.md` (gabung `customers`+`suppliers`): dokumen ini
gantiin bagian "Konsep Inti" `ar-schema.md`+`ap-schema.md` yang lama. Submodule LAIN di
2 file itu (Retur Barang, Penukaran Barang, Uang Muka/DP, dst) TETAP di file masing-masing
— tabelnya gak ikut digabung, cuma kolom `invoice_id`/`bill_id`-nya sekarang FK ke
`transactions(id)` (bukan `ar_invoices(id)`/`ap_bills(id)` lagi).

## Keputusan

- **`ar_invoices`+`ap_bills` ternyata cermin sempurna** — baris FIXED (Piutang debit vs
  Utang kredit) + baris VARIABEL (kategori) + baris opsional PPN, cuma beda arah
  debit/kredit. Klaim lama "AR bikin 2 jurnal, AP cuma 1" itu salah atribusi — jurnal ganda
  (HPP/Persediaan) itu punya `create_goods_issue`/`create_goods_receipt` (pemanggil),
  bukan `create_ar_invoice`/`create_ap_bill` sendiri.
- **Credit Hold DICABUT total** (keputusan owner, 2026-09-05) — `create_ar_invoice` dulu
  cek `counterparties.credit_limit`/`overdue_threshold_days` sebelum bikin invoice,
  `raise exception` kalau kelewat. `create_transaction` gak pernah punya cek ini sejak
  awal (bukan dihapus belakangan — desainnya emang gak masukin). Kolom
  `credit_limit`/`overdue_threshold_days` di `counterparties` ikut didrop (migration
  `0065`), UI edit-nya di halaman customer juga disapu bersih.
- **"Piutang Tak Tertagih" (Bad Debt Write-off) DICABUT total** juga (dibundel sama
  keputusan Credit Hold, sama-sama bikin AR/AP asimetris) — `ar_bad_debt_writeoffs` +
  RPC `write_off_ar_invoice` didrop (migration `0064`+`0065`). AR gak lagi punya jalur
  formal buat nyatet piutang macet jadi beban — kalau kebutuhan ini muncul lagi, dirancang
  ulang dari nol (bukan diaktifkan lagi begitu saja, gak ada mekanisme "recovery").
- **`supplier_document_ref`** — 1 kolom nullable, nomor nota asli supplier, cuma keisi
  `type='OUTBOUND'`. Satu-satunya sisa asimetri struktural yang DIPERTAHANKAN (bukan
  dicabut) — kecil, gampang ditoleransi sebagai kolom nullable.
- **ID asli dipertahankan pas backfill** (migration `0064`) — `transactions.id` buat baris
  lama SAMA PERSIS `ar_invoices.id`/`ap_bills.id` lama, biar tabel turunan (`ar_payments`,
  `ar_credit_notes`, `warranty_replacements`, `goods_issues`, dst di sisi AR;
  `ap_payments`, `ap_credit_notes`, `purchase_replacements`, `purchase_writeoffs`,
  `goods_receipt_notes`, dst di sisi AP) cukup di-repoint constraint-nya doang lewat
  `_repoint_fk`, gak perlu backfill data per-baris. Pola sama `counterparties` (`0059`)
  dan `orders` (`0060`).
- **Vocabulary `origin` diunifikasi** (migration `0066`) — `financial_only` (gak ada
  barang fisik) / `order` (barang fisik DAN dari Order — SO buat INBOUND, PO buat
  OUTBOUND) / `goods_movement` (barang fisik tapi BUKAN dari Order). Sebelumnya AR pakai
  `financial_only`/`sales_order`/`goods_issue`, AP pakai `langsung`/`grn` — vocabulary
  beda buat konsep yang sama. Sisi AP malah dapet granularitas BARU lewat unifikasi ini
  (dulu cuma cek "ada `goods_receipt_notes` apa enggak", sekarang bedain juga
  `order_id` keisi/enggak, mirror persis `order_line_id` di sisi AR).
- **Gak ada tabel/tahap "draft"** — transaksi final begitu dibuat & lolos validasi, sama
  prinsip kayak Journal Entry.
- **`due_date` snapshot, bukan generated column** — dihitung sekali di RPC dari
  `counterparties.payment_term_days` pas transaksi dibuat, disimpan sebagai kolom biasa.
- **Immutability sama pola Journal Entry lama** — RLS gak ada policy `UPDATE`/`DELETE` +
  trigger `block_edit_delete` sebagai jaring kedua, KECUALI kolom denormalized
  (`outstanding`/`returned`/`status`/`origin`) yang boleh diubah trigger
  `recompute_transaction_status` (pola sama `0053`, lihat submodule di bawah).
- Money pakai `numeric(14,2)`, bukan float (invariant `AGENT.md`).

## DDL

### `transactions` — piutang (`type='INBOUND'`) & utang (`type='OUTBOUND'`) timbul, 1 tabel generic

```sql
create table transactions (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INBOUND', 'OUTBOUND')), -- INBOUND=piutang(dulu ar_invoices), OUTBOUND=utang(dulu ap_bills)
  counterparty_id uuid not null references counterparties(id),
  date date not null,               -- dulu invoice_date / bill_date
  due_date date not null,           -- snapshot pas dibuat
  description text,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  outstanding numeric(14,2) not null,
  returned numeric(14,2) not null default 0,     -- cuma relevan type='INBOUND', selalu 0 buat OUTBOUND
  status text not null default 'belum',
  origin text not null default 'financial_only',
  supplier_document_ref text,                    -- cuma keisi type='OUTBOUND'
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index transactions_counterparty_id_idx on transactions(counterparty_id);
create index transactions_journal_entry_id_idx on transactions(journal_entry_id);
create index transactions_type_idx on transactions(type);
```

Guard type-safety counterparty (pola `counterparty_role_guard` dari `counterparty-schema.md`)
— INBOUND wajib pihak berperan `customer`, OUTBOUND wajib `supplier`:

```sql
create trigger transactions_counterparty_role_guard_inbound
  before insert on transactions
  for each row when (new.type = 'INBOUND')
  execute function counterparty_role_guard('counterparty_id', 'customer');

create trigger transactions_counterparty_role_guard_outbound
  before insert on transactions
  for each row when (new.type = 'OUTBOUND')
  execute function counterparty_role_guard('counterparty_id', 'supplier');
```

### `transaction_lines` — baris VARIABEL (kategori + PPN), gantiin `ar_invoice_credit_lines`+`ap_bill_debit_lines`

```sql
create table transaction_lines (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id),
  account_id uuid not null references accounts(id),
  amount numeric(14,2) not null check (amount > 0),
  is_tax boolean not null default false
);

create index transaction_lines_transaction_id_idx on transaction_lines(transaction_id);
```

Arah baris (debit vs kredit) gak disimpan sebagai kolom — ditentuin runtime dari
`transactions.type` pas `create_transaction` nyusun `p_journal_lines`, sama pola
`create_order(p_direction,...)`.

## Trigger — Immutability

```sql
create trigger transactions_block_edit_delete
  before update or delete on transactions
  for each row execute function block_edit_delete();

create trigger transaction_lines_block_edit_delete
  before update or delete on transaction_lines
  for each row execute function block_edit_delete();
```

## RPC `create_transaction` — bikin transaksi + journal entry sekaligus (migration `0063`)

`security invoker`, reuse `create_journal_entry` — gak pernah insert manual ke
`journal_entries`/`journal_lines`. Cabang `p_type` cuma nentuin arah debit/kredit baris
FIXED (control account) dan baris VARIABEL/PPN — persis pola `create_order(p_direction,...)`.

```sql
create function create_transaction(
  p_type text,                  -- 'INBOUND' | 'OUTBOUND'
  p_counterparty_id uuid,
  p_date date,
  p_description text,
  p_source_ref text,
  p_lines jsonb,                -- array of {"account_id":uuid,"amount":numeric} -- BUKAN termasuk PPN
  p_control_account_id uuid,    -- INBOUND: Piutang Usaha, OUTBOUND: Utang Usaha
  p_apply_tax boolean default false,
  p_supplier_document_ref text default null   -- cuma dipakai type='OUTBOUND'
) returns uuid
```

Validasi: `p_type` harus `'INBOUND'`/`'OUTBOUND'`, `p_lines` wajib minimal 1 baris dan tiap
baris `amount > 0` (fail-fast, sebelum jurnal dibuat). PPN dihitung server-side dari
`tax_settings` (singleton, `ar-schema.md` submodule "Compounding & PPN") — sama pola
`create_ar_invoice`/`create_ap_bill` lama, gak pernah dipercaya dari input klien.

Full body: `supabase/migrations/0063_transactions_schema.sql`.

## `ar_invoice_remaining`/`ap_bill_remaining` — target `transactions`

Signature & fungsi gak berubah dari sebelumnya, cuma `from ar_invoices`/`from ap_bills`
diganti `from transactions` (migration `0064`+`0065` — reducer `ar_bad_debt_writeoffs`
di `ar_invoice_remaining` sempat dipertahankan sementara di `0064` selagi tabelnya masih
ada, dicabut beneran di `0065` bareng drop tabelnya). Detail reducer lengkap tetap di
`ar-schema.md`/`ap-schema.md` masing-masing (gak diulang di sini, fungsinya sendiri gak
pindah nama/lokasi konsep, cuma target tabelnya yang diganti).

## `recompute_transaction_status(p_transaction_id)` — gantiin `recompute_ar_invoice_status`+`recompute_ap_bill_status` (migration `0064`, origin CASE diupdate `0066`)

Unifikasi 2 fungsi denormalisasi status lama (`0053`) jadi 1, cabang by `type`. Cabang
status `'dihapusbukukan'` (butuh reducer write-off) DIHAPUS — write-off gak lagi fitur
aktif. `SECURITY DEFINER` (pola sama `recompute_ar_invoice_status` lama) — tabel
`transactions` cuma grant `select, insert`, trigger yang nulis `outstanding`/`status`/
`origin` butuh privilege lebih.

```sql
create function recompute_transaction_status(p_transaction_id uuid) returns void as $$
declare
  v_type text; v_journal_entry_id uuid; v_outstanding numeric; v_returned numeric;
  v_is_cancelled boolean; v_allocated numeric; v_deposit_applied numeric;
  v_status text; v_origin text;
begin
  select type, journal_entry_id into v_type, v_journal_entry_id from transactions where id = p_transaction_id;
  if not found then return; end if;

  select exists (select 1 from journal_entries je where je.reverses_entry_id = v_journal_entry_id) into v_is_cancelled;

  if v_type = 'INBOUND' then
    -- reducer ar_invoice_remaining/ar_credit_notes/ar_payments/ar_deposit_applications,
    -- status lunas/sebagian/belum/dibatalkan, origin financial_only/order/goods_movement
    -- (cek goods_issues + goods_issue_lines.order_line_id) -- detail: 0064+0066.
  else
    -- reducer ap_bill_remaining/ap_payments/ap_deposit_applications (deposit_applied exclude
    -- reversed -- asimetri sengaja, disalin apa adanya dari recompute_ap_bill_status lama),
    -- origin financial_only/order/goods_movement (cek goods_receipt_notes + order_id).
  end if;
end;
$$ language plpgsql security definer set search_path = public;
```

Dipanggil dari trigger `AFTER INSERT` di semua tabel reducer (`ar_payments`,
`ar_credit_notes`, `ar_deposit_applications`, `warranty_replacements`, `goods_issues`,
`goods_issue_lines` di sisi AR; `ap_payments`, `ap_credit_notes`, `ap_deposit_applications`,
`goods_receipt_notes` di sisi AP) + 1 trigger gabungan di `journal_entries`
(`journal_entries_sync_reversal_status`, dipakai bareng AR/AP Deposits + POS Sales).
Full body & daftar lengkap trigger wrapper: `supabase/migrations/0064_transactions_backfill_and_repoint.sql`
+ `0066_unify_transaction_origin_vocabulary.sql`.

## `ar_invoices_with_status`/`ap_bills_with_status` — 2 view TETAP terpisah di atas `transactions`

Mirror deviasi sengaja yang udah dipakai `orders` (`purchase_orders_with_status`/
`sales_orders_with_status`, `0060`) — nama tabel fisik digabung, tapi 2 view tetap
terpisah difilter `type`, biar `queries.ts`/kode consuming existing gak perlu diubah
namanya sama sekali.

```sql
create or replace view ar_invoices_with_status
  with (security_invoker = true) as
select
  id, counterparty_id as customer_id, date as invoice_date, due_date, description, source_ref, amount,
  journal_entry_id, created_at, outstanding::numeric as outstanding, returned::numeric as returned,
  status, origin
from transactions
where type = 'INBOUND';

create or replace view ap_bills_with_status
  with (security_invoker = true) as
select
  id, counterparty_id as supplier_id, date as bill_date, due_date, description, source_ref, supplier_document_ref,
  amount, journal_entry_id, created_at, outstanding::numeric as outstanding, status, origin
from transactions
where type = 'OUTBOUND';
```

Cast `::numeric` (bukan `numeric(14,2)`) di `outstanding`/`returned` WAJIB — kolom asli
`ar_invoices.outstanding`/`ap_bills.outstanding` (dari `0053`, sekarang udah didrop) dulu
bertipe `numeric` polos, `CREATE OR REPLACE VIEW` gagal "cannot change data type of view
column" kalau typmod-nya beda dari view lama.

## RLS Policy

Pola identik `ar_invoices`/`ap_bills` lama — `select` semua `authenticated`, `insert`
cuma `admin`/`accountant`, **sengaja gak ada** policy `UPDATE`/`DELETE` (RLS default deny
+ trigger `block_edit_delete` = 2 lapis immutability).

```sql
alter table transactions enable row level security;

create policy transactions_select on transactions
  for select using (auth.role() = 'authenticated');

create policy transactions_insert on transactions
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- transaction_lines: pola identik.
```

## Grant

```sql
grant select, insert on transactions to authenticated;
grant select, insert on transaction_lines to authenticated;
```

RPC (`create_transaction`) otomatis kepakai `authenticated` selama grant `execute`
default Postgres gak dicabut — konsisten sama semua RPC lain di project ini.

## Pemanggil — `create_goods_issue`/`create_goods_receipt`

Signature EKSTERNAL gak berubah sama sekali (migration `0064`) — cuma body internal-nya
ganti manggil `create_transaction('INBOUND'/'OUTBOUND', ...)` gantiin
`create_ar_invoice(...)`/`create_ap_bill(...)`. Jurnal HPP/Persediaan yang dibikin
`create_goods_issue`/`create_goods_receipt` SENDIRI (terpisah dari `create_transaction`)
sama sekali gak kesentuh — detail lengkap tetap di `inventory-schema.md`.

## Migrasi struktural (riwayat singkat — detail lengkap `memory/scope-debt/ar-ap-unify-transactions.md`, sudah ditutup)

- `0063` — bikin `transactions`/`transaction_lines`/`create_transaction`, jalan paralel,
  `ar_invoices`/`ap_bills` lama gak disentuh.
- `0064` — backfill (ID asli dipertahankan), repoint FK 11 tabel turunan
  (`ar_payments`, `ar_credit_notes`, `ar_deposit_applications`, `warranty_replacements`,
  `goods_issues` di AR; `ap_payments`, `ap_credit_notes`, `ap_deposit_applications`,
  `purchase_replacements`, `purchase_writeoffs`, `goods_receipt_notes` di AP), unify
  `recompute_transaction_status`, alihkan `create_goods_issue`/`create_goods_receipt` +
  2 form frontend (`/ar-invoices`, `/ap-bills`) ke `create_transaction`. Tabel lama
  DIBEKUKAN (gak ada lagi tulis/baca), belum didrop.
- `0065` — drop beneran `ar_invoices`/`ap_bills`/`ar_invoice_credit_lines`/
  `ap_bill_debit_lines`/`ar_bad_debt_writeoffs` + RPC dead code `create_ar_invoice`/
  `create_ap_bill`, drop kolom `counterparties.credit_limit`/`overdue_threshold_days`.
- `0066` — unifikasi vocabulary `origin` (`financial_only`/`order`/`goods_movement`
  dipakai kedua arah, gantiin `sales_order`/`goods_issue` vs `grn`/`langsung`).

## Referensi

- `memory/architecture/data/ar-schema.md` — submodule AR yang tersisa (Retur Barang,
  Penukaran Barang, Uang Muka/DP AR) — `invoice_id` sekarang FK ke `transactions(id)`.
- `memory/architecture/data/ap-schema.md` — submodule AP yang tersisa (Retur Barang ke
  Supplier, Uang Muka/DP AP) — `bill_id` sekarang FK ke `transactions(id)`.
- `memory/architecture/data/counterparty-schema.md` — preseden pola dokumen ini (gabung
  `customers`+`suppliers` jadi `counterparties`), `counterparty_role_guard()`.
- `memory/architecture/data/inventory-schema.md` submodule "Purchase Order & Sales Order
  (`orders`)" — preseden generalisasi PO+SO, pola `_repoint_fk`, deviasi "2 view tetap
  terpisah" yang jadi rujukan migration `0064` di atas.
