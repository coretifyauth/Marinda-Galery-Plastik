# Payments — Schema (Finalized)

Gantiin `ar_payments` (AR) + `ap_payments` (AP) — digabung jadi 1 tabel generic `payments`
(kolom `type` `'INBOUND'`/`'OUTBOUND'`), migration `0069` (2026-09-05). Fase 1 dari
unifikasi tabel anak AR/AP (`payments`, `credit_notes`, `deposits`, `return_credits`) —
mirror pola `transactions` (`0063`-`0065`, lihat `transactions-schema.md`). Ref konsep
bisnis gak berubah: `docs/domain/accounts-receivable.md` bagian "AR Payment", pasangan
AP di `docs/domain/accounts-payable.md`.

## Keputusan

- **Arah `type` DIBALIK migration `0074`** (2026-09-06) — ikut keluarga `transactions`
  (`transactions-schema.md`): AR sekarang `OUTBOUND`, AP sekarang `INBOUND`. `payments` gak
  pernah punya barang fisik sendiri (murni event uang), jadi cuma ikut label keluarga
  transaksi induknya — trigger role-guard & literal `type` di semua reducer ikut dibalik,
  tapi logic `payments_type_matches_transaction` (cek SAMA dengan `transactions.type`) TIDAK
  berubah (dua-duanya ikut dibalik bareng, jadi tetap harus sama).
- **Struktur DDL identik `ar_payments`/`ap_payments` lama** — cuma `customer_id`/`supplier_id`
  jadi `counterparty_id`, `invoice_id`/`bill_id` jadi `transaction_id`, ditambah kolom
  `type`. Guard overpay/cicil, immutability, RLS — semua perilaku bisnis IDENTIK, murni
  restrukturisasi tabel.
- **`type` didenormalisasi (redundan)** — `transaction_id` udah cukup nunjuk 1
  `transactions` row yang punya `type`-nya sendiri, tapi `payments.type` dipertahankan
  langsung di kolom (bukan selalu join) buat 2 alasan: (1) trigger
  `counterparty_role_guard` butuh tau role wajib (customer/supplier) dari row yang sama
  tanpa subquery, pola identik `transactions_counterparty_role_guard_inbound/outbound`;
  (2) reducer `ar_invoice_remaining`/`ap_bill_remaining`/`recompute_transaction_status`
  butuh filter cepat tanpa join balik ke `transactions`. Konsekuensi: butuh 1 trigger
  ekstra (`payments_type_matches_transaction`) buat jaga konsistensi kolom redundan ini
  — gak ada di `transactions` sendiri karena di situ `type` bukan salinan, dia sumbernya.
- **RPC `record_ar_payment`/`record_ap_payment` DIGABUNG jadi `record_payment(p_type, ...)`**
  — pola sama `create_transaction`, branch jurnal (debit/kredit ketuker) berdasar `p_type`
  di dalam 1 fungsi, bukan 2 fungsi terpisah.
- **Hard cutover, gak ada compatibility wrapper** — RPC lama di-drop di migration yang
  sama (`drop function if exists record_ar_payment(...)`/`record_ap_payment(...)`),
  konsisten pola `0065` (`create_ar_invoice`/`create_ap_bill` juga hard-drop, gak ada
  wrapper sementara) — frontend diupdate bareng di deploy window yang sama.
- Money pakai `numeric(14,2)`, bukan float (invariant `AGENT.md`).

## DDL

### `payments` — piutang berkurang (`type='OUTBOUND'`) & utang berkurang (`type='INBOUND'`)

```sql
create table payments (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INBOUND', 'OUTBOUND')),
  counterparty_id uuid not null references counterparties(id),
  transaction_id uuid not null references transactions(id),
  payment_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index payments_counterparty_id_idx on payments(counterparty_id);
create index payments_transaction_id_idx on payments(transaction_id);
```

`amount` gak boleh **melebihi** sisa outstanding (`ar_invoice_remaining`/`ap_bill_remaining`
tergantung `type`) pas `record_payment` dipanggil — boleh kurang (cicil, `0010`/AR selaras
`0011`/AP), gak boleh lebih (overpay), ditegakkan RPC, bukan constraint DB. **Gak ada
`updated_at`/`archived_at`** — immutable, pola sama `transactions`.

Backfill migration `0069` mempertahankan ID asli dari `ar_payments`/`ap_payments` — 0
dampak ke referensi historis manapun (tabel ini gak pernah jadi target FK dari tabel
lain, jadi gak ada repoint FK yang dibutuhkan, beda dari migrasi `transactions` yang
punya 11 tabel turunan nunjuk ke situ).

## Trigger

### Immutability — reuse `block_edit_delete()`

```sql
create trigger payments_block_edit_delete
  before update or delete on payments
  for each row execute function block_edit_delete();
```

### Type-safety counterparty — reuse `counterparty_role_guard()`, pola `transactions_counterparty_role_guard_*`

```sql
create trigger payments_counterparty_role_guard_inbound
  before insert on payments
  for each row when (new.type = 'INBOUND')
  execute function counterparty_role_guard('counterparty_id', 'supplier');

create trigger payments_counterparty_role_guard_outbound
  before insert on payments
  for each row when (new.type = 'OUTBOUND')
  execute function counterparty_role_guard('counterparty_id', 'customer');
```

Role dibalik migration `0074` (INBOUND sekarang AP→supplier, OUTBOUND sekarang AR→customer).

### Konsistensi `type` vs `transactions.type` (baru, `payments` gak punya padanan di `transactions`)

`payments.type` kolom denormalisasi (lihat "Keputusan" di atas) — trigger ini nolak insert
kalau `p_type` gak sama dengan `type` milik `transaction_id`-nya, mencegah data
inconsistent yang bisa lolos dari 2 guard role di atas (misal `type='INBOUND'` dipasang ke
`transaction_id` yang sebenarnya `OUTBOUND`, tapi `counterparty_id`-nya kebetulan valid
customer — 2 guard role gak akan nangkep ini sendirian).

```sql
create function payments_type_matches_transaction() returns trigger as $$
declare
  v_transaction_type text;
begin
  select type into v_transaction_type from transactions where id = new.transaction_id;
  if v_transaction_type is distinct from new.type then
    raise exception 'payments.type (%) gak cocok sama transactions.type (%) buat transaction_id %', new.type, v_transaction_type, new.transaction_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger payments_type_matches_transaction_trigger
  before insert on payments
  for each row execute function payments_type_matches_transaction();
```

### Sync status transaksi — gantiin `ar_payments_sync_invoice_status`/`ap_payments_sync_bill_status`

```sql
create function payments_sync_transaction_status() returns trigger as $$
begin
  perform recompute_transaction_status(new.transaction_id);
  return new;
end;
$$ language plpgsql;

create trigger payments_sync_transaction_status_trigger
  after insert on payments
  for each row execute function payments_sync_transaction_status();
```

`recompute_transaction_status()` sendiri (`transactions-schema.md`) diupdate bareng
migration ini — reducer `v_allocated` (dulu `sum(amount) from ar_payments`/`ap_payments`)
sekarang `sum(amount) from payments where transaction_id = ... and type = 'INBOUND'/'OUTBOUND'`.
**Kritis dilakukan sebelum drop tabel lama** — fungsi ini `plpgsql`, Postgres gak bikin
`pg_depend` ke tabel yang di-query di dalam body-nya, jadi `drop table ar_payments`/
`ap_payments` bakal LOLOS diam-diam kalau reducer ini kelewat diupdate, baru meledak
runtime di SEMUA trigger `AFTER INSERT` lain yang manggil fungsi ini (`ar_credit_notes`,
`ar_deposit_applications`, `goods_issues`, dst — bukan cuma `payments`). Ketauan
`schema-reviewer` sebagai blocker sebelum apply — kelas bug yang sama persis kayak
`0066` (`transactions_block_edit_delete`).

## RPC `record_payment` — gantiin `record_ar_payment` + `record_ap_payment`

```sql
create function record_payment(
  p_type text,                  -- 'INBOUND' (AP) | 'OUTBOUND' (AR) -- dibalik 0074
  p_counterparty_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_source_ref text,
  p_cash_account_id uuid,
  p_control_account_id uuid,    -- OUTBOUND: Piutang Usaha, INBOUND: Utang Usaha
  p_transaction_id uuid
) returns uuid
```

`security invoker`, reuse `create_journal_entry` — gak pernah insert manual ke
`journal_entries`/`journal_lines`. Guard overpay: `p_amount` gak boleh melebihi
`ar_invoice_remaining(p_transaction_id)` (OUTBOUND) atau `ap_bill_remaining(p_transaction_id)`
(INBOUND) — `raise exception` sebelum jurnal apa pun dibuat. Jurnal dibangun 2 arah:

```
OUTBOUND: Debit Kas/Bank            / Kredit p_control_account_id (Piutang Usaha)
INBOUND:  Debit p_control_account_id (Utang Usaha) / Kredit Kas/Bank
```

Body asli: `supabase/migrations/0069_unify_payments_schema.sql`. Final (branch literal
`p_type` dibalik 0074): `0074_flip_transactions_type_direction.sql`.

## `ar_invoice_remaining`/`ap_bill_remaining` — reducer #1 target `payments`

Signature & fungsi gak berubah, cuma `from ar_payments`/`ap_payments where invoice_id/
bill_id = ...` diganti `from payments where transaction_id = ... and type = 'OUTBOUND'/
'INBOUND'` (arah dibalik 0074, AR=OUTBOUND/AP=INBOUND). Detail reducer lengkap tetap di
`transactions-schema.md` submodule `ar_invoice_remaining`/`ap_bill_remaining`.

## `cancel_ar_invoice`/`cancel_ap_bill` — guard payment-count target `payments`

Signature & fungsi gak berubah, cuma `count(*) from ar_payments/ap_payments where
invoice_id/bill_id = ...` diganti `count(*) from payments where transaction_id = ... and
type = 'OUTBOUND'/'INBOUND'` (arah dibalik 0074).

## Histori: `ap_payment_allocations` many-to-many dicabut (migration `0011_ap_payment_single_bill.sql`)

AP awalnya (desain Fase 4 pra-unifikasi) lebih longgar dari AR — tabel jembatan
`ap_payment_allocations` ngizinin 1 payment dipecah ke banyak bill sekaligus ("bayar
gabungan"). Migration `0011` (2026-08-08, menyusul `0010` AR allow-partial-payment)
nyamain filosofi kedua sisi: **payment boleh cicil, tapi wajib fokus nunjuk 1 transaksi
tertentu** — `ap_payments.bill_id` (sekarang `payments.transaction_id`) FK langsung,
bukan lewat tabel jembatan. Tabel `ap_payment_allocations` di-drop total (0 baris di DB
live saat itu, verifikasi sebelum drop) — 1 payment = 1 transaksi tetap berlaku sampai
sekarang, gak pernah di-restore.

## RLS Policy & Grant

Pola identik `ar_payments`/`ap_payments` lama — `select` semua `authenticated`, `insert`
cuma `admin`/`accountant`, **gak ada** policy `UPDATE`/`DELETE` (RLS default deny +
trigger `block_edit_delete` = 2 lapis immutability).

```sql
alter table payments enable row level security;

create policy payments_select on payments
  for select using (auth.role() = 'authenticated');

create policy payments_insert on payments
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE -> RLS default deny

grant select, insert on payments to authenticated;
```

## Dampak frontend

Nested-select alias `ar_payments(...)`/`ap_payments(...)` jadi `ar_payments:payments(...)`/
`ap_payments:payments(...)` (pola sama `transactions`) di 4 file: `ar-invoices/[id]/view.tsx`,
`ap-bills/[id]/view.tsx`, `customers/[id]/view.tsx`, `suppliers/[id]/view.tsx` — JSON key
yang dibaca frontend gak berubah nama, TS type (`ArPayment`/`ApPayment` di
`lib/ar-payments/schema.ts`/`lib/ap-payments/schema.ts`) gak disentuh sama sekali.
Query langsung `.from("ar_payments")`/`.from("ap_payments")` diganti `.from("payments")`
+ `.eq("transaction_id", ...)` (ganti `.eq("invoice_id"/"bill_id", ...)`), ditambah
`.eq("type", "INBOUND"/"OUTBOUND")` di 2 tempat (`customers/[id]/view.tsx`,
`suppliers/[id]/view.tsx`) yang filter by `counterparty_id` — perlu filter arah karena 1
counterparty bisa berperan customer DAN supplier sekaligus. RPC call `record_ar_payment`/
`record_ap_payment` diganti `record_payment` dengan param di-remap (`p_customer_id`/
`p_supplier_id` → `p_counterparty_id`, `p_receivable_account_id`/`p_payable_account_id` →
`p_control_account_id`, `p_invoice_id`/`p_bill_id` → `p_transaction_id`, ditambah
`p_type`). `generateDocumentNumber("ar_payments"/"ap_payments")` TETAP dipanggil apa
adanya — docType string persisten independen dari nama tabel fisik (konvensi project,
lihat `document-numbering-schema.md`).
