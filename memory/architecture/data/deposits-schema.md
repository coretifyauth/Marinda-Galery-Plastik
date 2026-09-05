# Deposits — Schema (Finalized)

Gantiin `ar_deposits`+`ap_deposits` (dan `*_applications`/`*_refunds`/`*_forfeitures`
masing-masing) — digabung jadi 4 tabel generic: `deposits`, `deposit_applications`,
`deposit_refunds`, `deposit_forfeitures`, migration `0071` (2026-09-05). Fase 3 dari
unifikasi tabel anak AR/AP (`payments` [`0069`], `credit_notes` [`0070`], `deposits`,
`return_credits` [belum]). Ref konsep bisnis gak berubah: `docs/domain/accounts-receivable.md`
bagian "Uang Muka / DP (Deposit)", pasangan AP di `docs/domain/accounts-payable.md`
bagian "Uang Muka / DP ke Supplier".

## Keputusan

- **RPC DIGABUNG jadi 1 per operasi** (`create_deposit`, `apply_deposit`, `refund_deposit`,
  `forfeit_deposit`) — beda dari `credit_notes` (`0070`, RPC tetap 2 fungsi karena logic
  beda bentuk). Di sini ke-8 RPC lama (`create_ar_deposit`/`create_ap_deposit`, dst) itu
  near-exact mirror — cuma akun & arah debit/kredit ketuker, sama persis kelas kasus
  `payments` (`0069`). Maksa pisah 2 fungsi di sini cuma nambah duplikasi tanpa nilai.
- **`apply_deposit`/`refund_deposit`/`forfeit_deposit` GAK BUTUH parameter `p_type`** —
  beda dari `record_payment` (`0069`) yang bujuk caller kirim `p_type` eksplisit. Di sini
  `deposit_id` udah cukup nunjuk 1 baris `deposits` yang punya `type`-nya sendiri, jadi
  RPC lookup `type` internal (`select type from deposits where id = p_deposit_id`) —
  gak ada kolom redundan yang perlu dijaga konsisten kayak `payments.type`. Cuma
  `create_deposit` yang butuh `p_type` eksplisit (belum ada row `deposits` buat di-lookup
  saat create).
- **`deposit_applications` GAK PUNYA kolom `type` sendiri** (beda dari `payments`/
  `credit_notes` yang keduanya punya) — konsistensi arah (`deposits.type` vs
  `transactions.type`) dicek langsung di `deposit_applications_guard()` lewat 2 lookup
  (bukan via kolom denormalisasi + trigger konsistensi terpisah), karena guard ini
  udah lookup kedua row itu buat validasi lain (sisa deposit, counterparty match,
  cancelled check) — nambah 1 pengecekan lagi di fungsi yang sama lebih murah daripada
  bikin kolom + trigger baru.
- **`deposits.remaining` sekaligus jadi `numeric(14,2)`** — kolom lama (`ar_deposits`/
  `ap_deposits.remaining`, ditambah `0053`) sempat `numeric` polos tanpa presisi/skala,
  melanggar invariant "money = numeric(14,2)" secara teknis (walau nilainya selalu
  hasil operasi dari kolom `amount numeric(14,2)` jadi gak pernah beneran salah presisi).
  Diperbaiki bareng migrasi ini — ketauan `schema-reviewer` sebagai catatan positif.
  **Konsekuensi teknis**: view `ar_deposits_with_status`/`ap_deposits_with_status`
  butuh cast eksplisit `remaining::numeric` (bukan `numeric(14,2)`) biar `CREATE OR
  REPLACE VIEW` gak nolak ganti tipe kolom — Postgres larang ganti tipe kolom view
  lewat `CREATE OR REPLACE`, cuma bisa ganti kalau tipe hasil akhirnya (`numeric` bare)
  sama kayak semula. Pola sama persis kasus `outstanding`/`returned` di migration `0064`.
- Money pakai `numeric(14,2)`, bukan float (invariant `AGENT.md`).

## DDL

### `deposits` — uang muka diterima (`type='INBOUND'`) / dibayar (`type='OUTBOUND'`)

```sql
create table deposits (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INBOUND', 'OUTBOUND')),
  counterparty_id uuid not null references counterparties(id),
  deposit_date date not null,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  remaining numeric(14,2) not null,
  status text not null default 'belum_dipakai'
);
```

`remaining`/`status` kolom asli (pola `0053`, bukan derived tiap query) — `remaining`
di-set `= amount` pas insert (trigger `deposits_set_defaults`), lalu di-update
`recompute_deposit_status()` tiap ada baris baru di `deposit_applications`/`refunds`/
`forfeitures`. Backfill migration `0071` salin `remaining`/`status` APA ADANYA dari
`ar_deposits`/`ap_deposits` (snapshot, bukan direcompute ulang) — dijalankan sebelum
tabel anak (`deposit_applications` dst) bahkan ada, jadi gak ada resiko recompute
prematur baca data yang belum lengkap.

### `deposit_applications` — DP diterapkan ke transaksi

```sql
create table deposit_applications (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references deposits(id),
  transaction_id uuid not null references transactions(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

### `deposit_refunds` / `deposit_forfeitures` — 2 disposisi lain

```sql
create table deposit_refunds (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references deposits(id),
  amount numeric(14,2) not null check (amount > 0),
  refund_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table deposit_forfeitures (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references deposits(id),
  amount numeric(14,2) not null check (amount > 0),
  forfeiture_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

Struktur identik kedua sisi AR/AP dari awal (gak ada kolom yang cuma relevan 1 arah)
— makanya 2 tabel ini gak butuh kolom `type` sama sekali, murni join lewat `deposit_id`.

## Trigger

### `deposits` — type-safety, default, immutability selektif

```sql
create trigger deposits_counterparty_role_guard_inbound
  before insert on deposits
  for each row when (new.type = 'INBOUND')
  execute function counterparty_role_guard('counterparty_id', 'customer');

create trigger deposits_counterparty_role_guard_outbound
  before insert on deposits
  for each row when (new.type = 'OUTBOUND')
  execute function counterparty_role_guard('counterparty_id', 'supplier');
```

`deposits_set_defaults` (`new.remaining := new.amount`) + `deposits_block_edit_delete_or_sync`
(pola `_or_sync` sejak `0053` — kolom bisnis asli immutable, `remaining`/`status` boleh
diubah trigger recompute).

### `deposit_applications_guard()` — gabungan `ar_deposit_applications_guard`+`ap_deposit_applications_guard`

Urutan cek (masing-masing baca state yang udah pasti tersedia dari cek sebelumnya, gak
ada dependensi maju): (1) sisa deposit (`deposit_remaining`), (2) **type match** —
`deposits.type` (via `deposit_id`) harus sama `transactions.type` (via `transaction_id`,
BARU di migrasi ini, dulu strukturally mustahil mismatch karena FK terpisah ke
`ar_invoices`/`ap_bills`), (3) counterparty match (deposit vs transaksi harus pihak yang
sama), (4) transaksi belum dibatalkan, (5) sisa outstanding transaksi
(`ar_invoice_remaining`/`ap_bill_remaining` tergantung `v_deposit_type`).

```sql
create function deposit_applications_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_deposit_type text;
  v_deposit_counterparty_id uuid;
  v_transaction_type text;
  v_transaction_counterparty_id uuid;
  v_transaction_journal_entry_id uuid;
  v_transaction_cancelled boolean;
  v_transaction_remaining numeric;
begin
  select deposit_remaining(new.deposit_id) into v_remaining;
  if new.amount > v_remaining then raise exception '...'; end if;

  select type, counterparty_id into v_deposit_type, v_deposit_counterparty_id from deposits where id = new.deposit_id;
  select type, counterparty_id, journal_entry_id into v_transaction_type, v_transaction_counterparty_id, v_transaction_journal_entry_id
    from transactions where id = new.transaction_id;

  if v_transaction_type is distinct from v_deposit_type then raise exception '... arah beda'; end if;
  if v_transaction_counterparty_id is distinct from v_deposit_counterparty_id then raise exception '... pihak lain'; end if;
  -- cek cancelled + sisa outstanding transaksi, branch by v_deposit_type
  return new;
end;
$$ language plpgsql;
```

### Sync status & guard refund/forfeiture

`deposit_applications_sync_deposit_status` (after insert: `recompute_deposit_status(new.deposit_id)`
+ `recompute_transaction_status(new.transaction_id)`), `deposit_refunds_guard`/
`deposit_forfeitures_guard` (before insert: `new.amount > deposit_remaining(new.deposit_id)`),
`deposit_refunds_sync_deposit_status`/`deposit_forfeitures_sync_deposit_status` (after
insert: `recompute_deposit_status` doang, gak nyentuh status transaksi). Semua immutable
via `block_edit_delete` generic (reuse, bukan `_or_sync` — beda dari `deposits` yang
punya kolom mutable).

## `deposit_remaining(deposit_id)` — gantiin `ar_deposit_remaining`+`ap_deposit_remaining`

```sql
create function deposit_remaining(p_deposit_id uuid) returns numeric as $$
  select d.amount
    - coalesce((select sum(da.amount) from deposit_applications da
        where da.deposit_id = p_deposit_id
          and not exists (select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id)
      ), 0)
    - coalesce((select sum(amount) from deposit_refunds where deposit_id = p_deposit_id), 0)
    - coalesce((select sum(amount) from deposit_forfeitures where deposit_id = p_deposit_id), 0)
  from deposits d
  where d.id = p_deposit_id;
$$ language sql stable;
```

## `recompute_deposit_status(deposit_id)` — gantiin `recompute_ar_deposit_status`+`recompute_ap_deposit_status`

Logic literally identik kedua versi lama (cuma nama tabel beda) — `selesai` (remaining
≤ 0.005) / `sebagian` (remaining < amount) / `belum_dipakai`, `security definer` (pola
sama `recompute_transaction_status`).

## RPC — 4 fungsi generic

```sql
create_deposit(p_type, p_counterparty_id, p_deposit_date, p_source_ref, p_amount, p_cash_account_id, p_deposit_account_id) returns uuid
apply_deposit(p_deposit_id, p_transaction_id, p_amount, p_entry_date, p_source_ref, p_deposit_account_id, p_control_account_id) returns uuid
refund_deposit(p_deposit_id, p_amount, p_refund_date, p_source_ref, p_deposit_account_id, p_cash_account_id) returns uuid
forfeit_deposit(p_deposit_id, p_amount, p_forfeiture_date, p_source_ref, p_deposit_account_id, p_offset_account_id) returns uuid
```

`security invoker`, reuse `create_journal_entry`. `p_deposit_account_id` generic —
INBOUND: Uang Muka Penjualan (liability), OUTBOUND: Uang Muka Pembelian (asset).
`p_control_account_id` (apply doang) — INBOUND: Piutang Usaha, OUTBOUND: Utang Usaha.
`p_offset_account_id` (forfeit doang) — INBOUND: Pendapatan Lain-lain (kredit),
OUTBOUND: Beban Kerugian Uang Muka (debit). Arah jurnal per operasi:

```
create_deposit  INBOUND:  Debit Kas            / Kredit deposit_account
create_deposit  OUTBOUND: Debit deposit_account / Kredit Kas
apply_deposit   INBOUND:  Debit deposit_account / Kredit control_account
apply_deposit   OUTBOUND: Debit control_account / Kredit deposit_account
refund_deposit  INBOUND:  Debit deposit_account / Kredit Kas
refund_deposit  OUTBOUND: Debit Kas            / Kredit deposit_account
forfeit_deposit INBOUND:  Debit deposit_account / Kredit offset_account
forfeit_deposit OUTBOUND: Debit offset_account  / Kredit deposit_account
```

Full body: `supabase/migrations/0071_unify_deposits_schema.sql`. RPC lama (8 fungsi)
di-drop total, hard cutover (gak ada compatibility wrapper), konsisten pola `0065`/`0069`.

## Fungsi lain yang ikut diretarget (`create or replace`, gak ada perubahan perilaku)

- `ar_invoice_remaining`/`ap_bill_remaining` — reducer #3 (deposit application aktif)
  target `deposit_applications.transaction_id`.
- `cancel_ar_invoice`/`cancel_ap_bill` — auto-unwind loop target `deposit_applications`.
- `recompute_transaction_status` — reducer `v_deposit_applied` (KEDUA cabang) target
  `deposit_applications`. **Asimetri lama dipertahankan apa adanya**: cabang INBOUND
  gak exclude application yang reversed dari `v_deposit_applied`, cabang OUTBOUND
  exclude — beda ini udah ada SEBELUM migrasi ini (disalin dari `recompute_ap_bill_status`
  lama), bukan hasil bug baru, `schema-reviewer` diminta khusus cross-check ini gak
  ke-"perbaiki"/dihomogenkan gak sengaja.
- `journal_entries_sync_reversal_status` (trigger gabungan di `journal_entries`, dipakai
  bareng `transactions`/`pos_sales`) — 4 loop terpisah (2 arah x cek-transaksi +
  cek-deposit) disederhanain jadi 2 loop atas `deposit_applications` yang udah gabungan,
  manggil `recompute_deposit_status` (bukan `recompute_ar_deposit_status`/
  `recompute_ap_deposit_status` lagi).
- `ar_deposits_with_status`/`ap_deposits_with_status` (VIEW) — target `deposits` filter
  `type`, alias `counterparty_id as customer_id`/`as supplier_id` biar kolom publiknya
  gak berubah nama sama sekali (`queries.ts` list page gak disentuh sama sekali).

## RLS Policy & Grant

Pola identik ke-8 tabel lama — `select` semua `authenticated`, `insert` cuma
`admin`/`accountant`, **gak ada** policy `UPDATE`/`DELETE` di ke-4 tabel baru.

## Dampak frontend

**List page** (`/ar-deposits`, `/ap-deposits`) — **0 perubahan**, query langsung ke view
`ar_deposits_with_status`/`ap_deposits_with_status` yang kolom publiknya gak berubah.
**Detail page** (`[id]/view.tsx`) — `.from("ar_deposits")`/`.from("ap_deposits")` jadi
`.from("deposits")` + `.eq("type", "INBOUND"/"OUTBOUND")`, `customer_id`/`supplier_id`
jadi alias `customer_id:counterparty_id`/`supplier_id:counterparty_id`, nested embed
`ar_deposit_applications(...)`/dst jadi alias `ar_deposit_applications:deposit_applications(...)`
(JSON key gak berubah, TS type gak disentuh). RPC call `create_ar_deposit`/`create_ap_deposit`
→ `create_deposit` (+`p_type`), `apply_ar_deposit`/`apply_ap_deposit` → `apply_deposit`,
`refund_ar_deposit`/`refund_ap_deposit` → `refund_deposit`, `forfeit_ar_deposit`/
`forfeit_ap_deposit` → `forfeit_deposit` — param akun di-rename generic
(`p_deposit_liability_account_id`/`p_deposit_asset_account_id` → `p_deposit_account_id`,
`p_receivable_account_id`/`p_payable_account_id` → `p_control_account_id`,
`p_other_revenue_account_id`/`p_loss_expense_account_id` → `p_offset_account_id`) — semua
lewat named-parameter object di `.rpc()`, gak ada resiko ketuker posisional. Ada juga
embed `ar_deposit_applications(amount)`/`ap_deposit_applications(amount)` di bawah
`transactions` (`ar-invoices/[id]/view.tsx`, `ap-bills/[id]/view.tsx`,
`customers/[id]/view.tsx`, `suppliers/[id]/view.tsx`) yang ikut di-alias ke
`:deposit_applications(amount)`. `generateDocumentNumber(...)` TETAP dipanggil dengan
string lama (`"ar_deposits"`, `"ar_deposit_applications"`, dst) — docType string
persisten independen dari nama tabel fisik.
