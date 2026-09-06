# Transactions — Schema (Finalized)

Gantiin `ar_invoices` (AR) + `ap_bills` (AP) — digabung jadi 1 tabel generic `transactions`
(kolom `type` `'INBOUND'`/`'OUTBOUND'`), migration `0063`-`0066` (2026-09-05). Histori
keputusan & proses eksekusi lengkap: `memory/scope-debt/ar-ap-unify-transactions.md`
(ditutup — lihat `git log` buat detail proses kalau perlu). Ref konsep bisnis gak berubah:
`docs/domain/accounts-receivable.md` (piutang) + `docs/domain/accounts-payable.md`
(utang) — cuma penyimpanannya yang digabung, substansi akuntansi tetap persis sama
(Debit Piutang vs Kredit Utang, dst).

Pola sama kayak `counterparty-schema.md` (gabung `customers`+`suppliers`): dokumen ini
gantiin bagian "Konsep Inti" `ar-schema.md`+`ap-schema.md` lama (file itu sendiri sudah
dihapus, digantikan struktur spine-per-tabel — lihat submodule "Referensi" di bawah buat
peta lengkap ke mana tiap bagian pindah). Tabel anak AR/AP (Retur Barang, Penukaran
Barang, Uang Muka/DP, dst) gak ikut digabung ke `transactions` — masing-masing punya
spine file sendiri, cuma kolom `invoice_id`/`bill_id`-nya sekarang FK ke `transactions(id)`
(bukan `ar_invoices(id)`/`ap_bills(id)` lagi).

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
`tax_settings` (singleton, `tax-settings-schema.md`) — sama pola `create_ar_invoice`/
`create_ap_bill` lama, gak pernah dipercaya dari input klien.

Full body: `supabase/migrations/0063_transactions_schema.sql`.

## Katalog kategori tambahan (`transaction_lines.account_id`) — `charge_categories`

Katalog master data (bukan tabel transaksional), TETAP ADA gak kesentuh unifikasi
`0063`-`0066` — murni buat UI (dropdown "pilih kategori" di form transaksi). **Gak ada
FK dari sini ke `transaction_lines`** — sama kayak `item_units` yang juga cuma resolve
pilihan di UI sebelum manggil RPC (trust boundary gak berubah: RPC tetap cuma terima
`account_id` mentah).

Awalnya 3 tabel identik terpisah per module (`ar_invoice_charge_types`/
`ap_bill_expense_categories`/`pos_charge_types`, lihat `pos-schema.md`) — digabung jadi 1
tabel generic `charge_categories` (migration `0073`, kolom discriminator `module` check
`pos`/`ar`/`ap`) karena strukturnya SAMA PERSIS, gak ada asimetri kolom kayak
`ar_invoices`/`ap_bills` dulu (bandingkan preseden `ar-ap-unify-transactions.md`). `module`
nentuin dropdown mana yang muncul di form mana (`ar` di form `INBOUND`, `ap` di
`OUTBOUND`, `pos` di checkout kasir) — `account_id` `module='ar'` biasanya nunjuk akun
kategori `revenue`, `module='ap'` nunjuk akun kategori `expense`, gak pernah campur.

```sql
create table charge_categories (
  id uuid primary key default gen_random_uuid(),
  module text not null check (module in ('pos', 'ar', 'ap')),
  name text not null,
  account_id uuid not null references accounts(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

`archived_at` — soft-delete (`state-naming-convention.md`). RLS/Grant: `select` semua
`authenticated`, `insert`/`update` cuma `admin` (`charge_categories_insert`/`_update`) —
pola identik `item_categories` (`items-schema.md`). **Gak ada policy `delete`** —
nonaktifkan pakai `archived_at`.

Migration awal: `0005_ar_schema.sql` (`ar_invoice_charge_types`)/`0006_ap_schema.sql`
(`ap_bill_expense_categories`)/`0009_pos_schema.sql` (`pos_charge_types`), digabung
`0073_unify_charge_categories.sql`.

## `ar_invoice_remaining`/`ap_bill_remaining` — reducer "sisa outstanding riil", target `transactions`

Signature & fungsi gak berubah dari sebelumnya, cuma `from ar_invoices`/`from ap_bills`
diganti `from transactions` (migration `0064`+`0065` — reducer `ar_bad_debt_writeoffs`
di `ar_invoice_remaining` sempat dipertahankan sementara di `0064` selagi tabelnya masih
ada, dicabut beneran di `0065` bareng drop tabelnya). `ar_invoice_remaining` disentralisasi
migration `0031` (dulu 5 fungsi ngitung ulang sendiri-sendiri, digabung jadi 1 sumber
kebenaran — riwayat lengkap: `memory/scope-debt/ar-ap-unify-transactions.md`);
`ap_bill_remaining` disentralisasi dari AWAL desain AP (gak pernah retrofit).

```sql
create function ar_invoice_remaining(p_invoice_id uuid) returns numeric as $$
  select ai.amount
    - coalesce((select sum(amount) from payments where transaction_id = p_invoice_id and type = 'INBOUND'), 0)
    - coalesce((select sum(amount) from credit_notes where transaction_id = p_invoice_id and type = 'INBOUND'), 0)
    - coalesce((
        select sum(da.amount) from deposit_applications da
        where da.transaction_id = p_invoice_id
          and not exists (select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id)
      ), 0)
    + coalesce((
        select sum(rc.amount) from return_credits rc
        join credit_notes acn on acn.id = rc.credit_note_id
        where acn.transaction_id = p_invoice_id
      ), 0)
  from transactions ai
  where ai.id = p_invoice_id;
$$ language sql stable;

create function ap_bill_remaining(p_bill_id uuid) returns numeric as $$
  select ab.amount
    - coalesce((select sum(amount) from payments where transaction_id = p_bill_id and type = 'OUTBOUND'), 0)
    - coalesce((select sum(amount) from credit_notes where transaction_id = p_bill_id and type = 'OUTBOUND'), 0)
    - coalesce((
        select sum(da.amount) from deposit_applications da
        where da.transaction_id = p_bill_id
          and not exists (select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id)
      ), 0)
    + coalesce((
        select sum(rc.amount) from return_credits rc
        join credit_notes acn on acn.id = rc.credit_note_id
        where acn.transaction_id = p_bill_id
      ), 0)
  from transactions ab
  where ab.id = p_bill_id;
$$ language sql stable;
```

4 reducer masing-masing (payment/credit note langsung, deposit application aktif exclude
reversed, return credit add-back) — bentuk final pasca `0031` (AR) dan pasca `0013`+`0072`
(AP). `record_payment` (`payments-schema.md`) pakai fungsi ini buat guard overpay.
Detail histori evolusi reducer (kenapa disentralisasi, bug yang pernah kejadian):
`memory/scope-debt/ar-ap-unify-transactions.md`.

## `cancel_ar_invoice`/`cancel_ap_bill` — batalkan transaksi salah input (reversing entry, dengan guard)

Manggil `reverse_journal_entry` yang udah ada (Fase 2 Journal Entry) — pakai **akun yang
sama persis** dengan transaksi asli, debit/kredit ketuker, gak butuh akun baru (ini
koreksi "salah input", bukan kejadian bisnis baru kayak retur barang). `cancel_ar_invoice`
auto-unwind jurnal `deposit_applications` aktif (reklasifikasi sederhana, aman dibalik —
detail lengkap `deposits-schema.md`). `cancel_ap_bill` hard-block tambahan kalau bill
udah punya `credit_notes` (`type='OUTBOUND'`) — AR gak punya guard setara karena retur AR
(`credit_notes` INBOUND) gak exclusive sama pembatalan invoice (beda perilaku bisnis,
dipertahankan apa adanya dari desain awal masing-masing).

```sql
create or replace function cancel_ar_invoice(
  p_invoice_id uuid, p_entry_date date, p_source_ref text
) returns uuid language plpgsql security invoker as $$
declare
  v_paid_count int; v_original_entry_id uuid; v_new_entry_id uuid;
  v_application record; v_invoice_ref text;
begin
  select count(*) into v_paid_count
  from payments where transaction_id = p_invoice_id and type = 'INBOUND';

  if v_paid_count > 0 then
    select source_ref into v_invoice_ref from transactions where id = p_invoice_id;
    raise exception 'Invoice % udah punya payment -- gak bisa dibatalkan lewat jalur ini', v_invoice_ref;
  end if;

  select journal_entry_id into v_original_entry_id from transactions where id = p_invoice_id;
  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  for v_application in
    select da.journal_entry_id from deposit_applications da
    where da.transaction_id = p_invoice_id
      and not exists (select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id)
  loop
    perform reverse_journal_entry(v_application.journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  return v_new_entry_id;
end;
$$;

create or replace function cancel_ap_bill(
  p_bill_id uuid, p_entry_date date, p_source_ref text
) returns uuid language plpgsql security invoker as $$
declare
  v_allocated_count int; v_credit_note_count int; v_original_entry_id uuid;
  v_new_entry_id uuid; v_bill_ref text;
begin
  select count(*) into v_allocated_count
  from payments where transaction_id = p_bill_id and type = 'OUTBOUND';

  if v_allocated_count > 0 then
    select source_ref into v_bill_ref from transactions where id = p_bill_id;
    raise exception 'Bill % udah punya % payment -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_allocated_count;
  end if;

  select count(*) into v_credit_note_count
  from credit_notes where transaction_id = p_bill_id and type = 'OUTBOUND';

  if v_credit_note_count > 0 then
    select source_ref into v_bill_ref from transactions where id = p_bill_id;
    raise exception 'Bill % udah punya % retur (credit note) -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_credit_note_count;
  end if;

  select journal_entry_id into v_original_entry_id from transactions where id = p_bill_id;
  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  return v_new_entry_id;
end;
$$;
```

Gak insert/update apa pun ke `transactions` — baris asli tetap ada persis kayak semula
(immutability tetap utuh). Status "dibatalkan" murni kebaca dari keberadaan reversal di
`journal_entries`, sama pola derived kayak status lunas/belum. Guard write-off (dulu
ngecek `ar_bad_debt_writeoffs`) **DIHAPUS `0065`** bareng tabelnya — fitur Piutang Tak
Tertagih dicabut total.

**Gap lama (pre-existing, bukan diperkenalkan migration manapun)**: kedua fungsi ini gak
ngecek apakah `journal_entry_id`-nya udah pernah di-reverse sebelumnya — kalau dipanggil
2x buat transaksi yang sama, bisa double-reversal. Di luar scope migration manapun
sejauh ini, dicatat sebagai potensi scope-debt.

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
sama sekali gak kesentuh — detail lengkap tetap di `goods-issue-schema.md`/`goods-receipt-schema.md`.

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

## Referensi — peta tabel anak AR/AP lama (`ar-schema.md`/`ap-schema.md`, sudah dihapus) ke spine baru

- `memory/architecture/data/credit-notes-schema.md` — Retur Barang (AR & AP), termasuk
  `inventory_returns`/`purchase_return_lines` — `invoice_id`/`bill_id` sekarang FK ke
  `transactions(id)`.
- `memory/architecture/data/return-credits-schema.md` — Saldo Kredit dari Retur (AR & AP).
- `memory/architecture/data/warranty-replacements-schema.md` — Penukaran Barang
  Pasca-Retur (Garansi), sisi AR.
- `memory/architecture/data/purchase-replacements-schema.md` — Retur Barang ke Supplier
  Opsi B (tukar barang), sisi AP.
- `memory/architecture/data/deposits-schema.md` — Uang Muka/DP, AR & AP.
- `memory/architecture/data/counterparty-schema.md` — preseden pola dokumen ini (gabung
  `customers`+`suppliers` jadi `counterparties`), `counterparty_role_guard()`.
- `memory/architecture/data/orders-schema.md` — preseden generalisasi PO+SO, pola
  `_repoint_fk`, deviasi "2 view tetap terpisah" yang jadi rujukan migration `0064` di
  atas.
