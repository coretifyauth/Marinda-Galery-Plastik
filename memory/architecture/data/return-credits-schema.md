# Return Credits — Schema (Finalized)

Gantiin `ar_return_credits`+`ap_return_credits` (dan `*_refunds` masing-masing) — digabung
jadi 2 tabel generic: `return_credits`, `return_credit_refunds`, migration `0072`
(2026-09-05). **Fase 4 (TERAKHIR)** dari unifikasi tabel anak AR/AP (`payments` [`0069`],
`credit_notes` [`0070`], `deposits` [`0071`], `return_credits`). Ref konsep bisnis gak
berubah: `docs/domain/accounts-receivable.md` bagian "Retur Barang (Credit Note)" >
"Saldo Kredit dari Retur", pasangan AP di `docs/domain/accounts-payable.md`.

**Migration `0075` (2026-09-06)**: `credit_notes` di-rename `returns`, kolom FK
`credit_note_id` di tabel ini di-rename `return_id` (retarget, bukan perubahan makna).
Nilai `return_credits.type` **TIDAK ikut dibalik** waktu `transactions.type` dibalik di
migration yang sama fase (`0074`) — lihat `returns-schema.md` > "Keputusan" buat penjelasan
lengkap kenapa retur beda perlakuan dari `transactions`/`payments`/`deposits`. Sisa dokumen
di bawah historis (nama `credit_notes`/`credit_note_id` merujuk ke masa migration `0072`
ditulis) — DDL final di paling bawah tiap section sudah pakai nama baru.

## Keputusan

- **`return_credits` gak pernah punya RPC "create" sendiri** — beda dari `payments`/
  `credit_notes`/`deposits` yang semua punya RPC top-level. Baris `return_credits`
  SELALU lahir inline dari dalam `create_ar_credit_note`/`create_ap_credit_note` (`0070`,
  TETAP 2 fungsi terpisah) begitu ada "excess" (retur bikin outstanding invoice/bill
  jadi minus). Migrasi ini cuma ganti target insert 2 RPC itu, **gak ada RPC baru buat
  "create"**.
- **RPC `refund` DIGABUNG jadi 1** (`refund_return_credit`) — `refund_ar_return_credit`/
  `refund_ap_return_credit` near-exact mirror (cuma akun & arah ketuker), pola sama
  `payments`/`deposits`. Lookup `type` dari `return_credits` internal, gak butuh param
  `p_type` dari caller.
- **`return_credits` dapat kolom `type` denormalisasi** (kayak `payments`/`credit_notes`/
  `deposits`) — dibutuhkan buat 2 hal: (1) `counterparty_role_guard` type-gated (INBOUND
  wajib customer, OUTBOUND wajib supplier), (2) `refund_return_credit` nentuin arah
  jurnal. Guard konsistensi baru: `return_credits_type_matches_credit_note` — cek
  `return_credits.type` == `credit_notes.type` (via `credit_note_id`), pola sama
  `payments_type_matches_transaction`/`credit_notes_type_matches_transaction`, cuma
  dibandingin ke `credit_notes` (bukan `transactions`) karena `return_credits` emang
  gak pernah FK langsung ke `transactions`.
- **GAK dapat kolom `remaining`/`status` ala `0053`** — beda dari `deposits` (`0071`).
  Dicek eksplisit: `ar_return_credits`/`ap_return_credits` (`0005`/`0006`) memang gak
  pernah didenormalisasi — migration `0053_denormalize_transactional_status.sql` cuma
  nyentuh `ar_deposits`/`ap_deposits`, gak pernah return-credit. `return_credit_remaining()`
  tetap dihitung on-the-fly, gak berubah dari pola sebelumnya.
- **Reducer `warranty_replacements.return_credit_settled_amount` di `return_credit_remaining()`
  gak di-branch by type** — istilah ini HISTORIS-doang (AR pra-`0057`), tapi disertakan
  tanpa syarat di fungsi gabungan karena buat baris OUTBOUND (AP) subquery-nya otomatis 0
  (`warranty_replacements` gak pernah nulis `credit_note_id` OUTBOUND — RPC
  `create_warranty_replacement` sejak `0057` gak pernah ngisi kolom itu sama sekali buat
  baris baru). **Catatan gap dari `schema-reviewer`**: proteksi ini dulunya STRUKTURAL
  (FK `warranty_replacements.credit_note_id` cuma bisa nunjuk `ar_credit_notes`), tapi
  udah ilang sejak `0070` waktu FK-nya direpoint ke `credit_notes` gabungan (yang nampung
  INBOUND+OUTBOUND). Yang masih nahan sekarang murni "gak ada RPC yang nulis nilai itu
  lagi sejak `0057`", bukan constraint DB — kalau ada yang nulis ulang kolom itu di masa
  depan, butuh guard type eksplisit. Diterima sebagai gap dorman (bukan kesalahan
  migrasi ini), dicatat biar gak keulang lupa kalau kolom itu diaktifkan lagi.
- **Index yang ketinggalan dari fase 2 & 3 disapu bareng migrasi ini** — `credit_notes`
  (`0070`) dan `deposits` (`0071`) masing-masing kehilangan index yang dipunya tabel
  asalnya (`journal_entry_id`, dan buat `deposits` juga `counterparty_id`) — ketauan
  `schema-reviewer` pas review `0072`, karena `ar_invoice_remaining`/`ap_bill_remaining`/
  `recompute_transaction_status` manggil tabel-tabel ini di hampir tiap write AR/AP.
  Ditambahin balik: `credit_notes_journal_entry_id_idx`, `deposits_counterparty_id_idx`,
  `deposits_journal_entry_id_idx`, plus `return_credits_credit_note_id_idx`/
  `return_credits_counterparty_id_idx` buat tabel baru ini sendiri.
- Money pakai `numeric(14,2)`, bukan float (invariant `AGENT.md`).

## DDL

### `return_credits` — saldo kredit lahir dari excess retur

```sql
create table return_credits (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INBOUND', 'OUTBOUND')),
  counterparty_id uuid not null references counterparties(id),
  return_id uuid not null references returns(id), -- dulu credit_note_id -> credit_notes(id), rename 0075
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index return_credits_return_id_idx on return_credits(return_id);
create index return_credits_counterparty_id_idx on return_credits(counterparty_id);
```

**Gak ada kolom `source_ref`** — beda dari `payments`/`credit_notes`/`deposits` yang
semua punya. `return_credits` gak pernah punya dokumen sumbernya sendiri (dia derivatif
otomatis dari 1 `credit_notes` row, `source_ref`-nya dokumen itu sendiri yang dipakai).
Sama kayak `ar_return_credits`/`ap_return_credits` lama — bukan regresi migrasi ini.

### `return_credit_refunds` — 1 dari 1 disposisi (refund tunai)

```sql
create table return_credit_refunds (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references return_credits(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

**Punya `source_ref`** (beda dari `return_credits`) — refund adalah aksi user-initiated
sendiri, butuh nomor dokumen sendiri.

## Trigger

### `return_credits` — immutability, type-safety, konsistensi, sync status

```sql
create trigger return_credits_block_edit_delete
  before update or delete on return_credits
  for each row execute function block_edit_delete();

create trigger return_credits_counterparty_role_guard_inbound
  before insert on return_credits
  for each row when (new.type = 'INBOUND')
  execute function counterparty_role_guard('counterparty_id', 'customer');

create trigger return_credits_counterparty_role_guard_outbound
  before insert on return_credits
  for each row when (new.type = 'OUTBOUND')
  execute function counterparty_role_guard('counterparty_id', 'supplier');
```

`return_credits_type_matches_credit_note` (before insert, nama fungsi TETAP nama lama
pasca `0075`) — cek `new.type` sama dengan `returns.type` (via `new.return_id`, dulu
`new.credit_note_id`), raise exception kalau beda. Dicek aman dari race/urutan:
`create_ar_return`/`create_ap_return` (dulu `create_ar_credit_note`/`create_ap_credit_note`)
selalu insert `returns` (udah divalidasi `credit_notes_type_matches_transaction`) SEBELUM
insert `return_credits` — jadi `returns.type` yang dibaca di sini udah pasti valid.

`return_credits_sync_transaction_status` (after insert) — beda dari `payments`/`returns`/
`deposit_applications` yang lookup langsung ke `transaction_id` kolom sendiri,
`return_credits` HARUS lookup dulu lewat `returns` (gak ada FK langsung ke `transactions`):

```sql
create function return_credits_sync_transaction_status() returns trigger as $$
declare
  v_transaction_id uuid;
begin
  select transaction_id into v_transaction_id from returns where id = new.return_id;
  if v_transaction_id is not null then
    perform recompute_transaction_status(v_transaction_id);
  end if;
  return new;
end;
$$ language plpgsql;
```

Dibutuhkan karena `return_credits` baru mengubah reducer add-back di
`ar_invoice_remaining`/`ap_bill_remaining` — `outstanding`/`status` cache di `transactions`
(pola `0053`) jadi butuh direcompute.

### `return_credit_refunds` — immutability + guard, **TANPA** sync status

```sql
create trigger return_credit_refunds_block_edit_delete
  before update or delete on return_credit_refunds
  for each row execute function block_edit_delete();

create function return_credit_refunds_guard() returns trigger as $$
declare
  v_remaining numeric;
begin
  select return_credit_remaining(new.credit_id) into v_remaining;
  if new.amount > v_remaining then raise exception '...'; end if;
  return new;
end;
$$ language plpgsql;
```

**Sengaja gak ada trigger sync-status** — refund cuma disposisi lanjutan dari saldo yang
UDAH direklasifikasi keluar dari invoice/bill asalnya (transaksi asalnya gak kesentuh
lagi sama sekali). Diverifikasi: `ar_return_credit_refunds`/`ap_return_credit_refunds`
lama juga gak pernah punya trigger ini — bukan regresi.

## `return_credit_remaining(credit_id)` — gantiin `ar_return_credit_remaining`+`ap_return_credit_remaining`

```sql
create function return_credit_remaining(p_credit_id uuid) returns numeric as $$
  select c.amount
    - coalesce((
        select sum(wr.return_credit_settled_amount)
        from warranty_replacements wr
        where wr.return_id = c.return_id
      ), 0)
    - coalesce((select sum(amount) from return_credit_refunds where credit_id = p_credit_id), 0)
  from return_credits c
  where c.id = p_credit_id;
$$ language sql stable;
```

## RPC `refund_return_credit` — gantiin `refund_ar_return_credit`+`refund_ap_return_credit`

```sql
create function refund_return_credit(
  p_credit_id uuid,
  p_amount numeric,
  p_entry_date date,
  p_source_ref text,
  p_return_credit_account_id uuid, -- INBOUND: Saldo Kredit Retur Customer (liability), OUTBOUND: Piutang Retur Supplier (asset)
  p_cash_account_id uuid
) returns uuid
```

`security invoker`, reuse `create_journal_entry`. Lookup `type` dari `return_credits`
internal:

```
INBOUND:  Debit return_credit_account (liability) / Kredit Kas
OUTBOUND: Debit Kas / Kredit return_credit_account (asset)
```

Body asli: `supabase/migrations/0072_unify_return_credits_schema.sql`.

## Fungsi lain yang ikut diretarget (`create or replace`, gak ada perubahan perilaku)

- `create_ar_return`/`create_ap_return` (dulu `create_ar_credit_note`/`create_ap_credit_note`,
  rename `0075`, TETAP 2 fungsi) — insert `return_credits (type, counterparty_id, return_id, ...)`
  (kolom `return_id`, dulu `credit_note_id`).
- `ar_invoice_remaining`/`ap_bill_remaining` — reducer add-back target `return_credits`.
- `warranty_replacements_no_over_settle_return_credit` — lookup `id`/`source_ref` dari
  `return_credits` (dulu `ar_return_credits`).

## RLS Policy & Grant

Pola identik ke-4 tabel lama — `select` semua `authenticated`, `insert` cuma
`admin`/`accountant`, **gak ada** policy `UPDATE`/`DELETE`.

## Dampak frontend

**Gak ada halaman dedicated** (`/ar-return-credits`, `/ap-return-credits` gak pernah
ada) — semua akses lewat halaman detail invoice/bill (`ar-invoices/[id]/view.tsx`,
`ap-bills/[id]/view.tsx`) dan customer/supplier (`customers/[id]/view.tsx`,
`suppliers/[id]/view.tsx`). Nested-select alias `ar_return_credits(...)`/
`ap_return_credits(...)` jadi `ar_return_credits:return_credits(...)`/
`ap_return_credits:return_credits(...)` (JSON key gak berubah). Query langsung
`.from("ar_return_credits")` (cuma ada di `ar-invoices/[id]/view.tsx`, sisi AP gak
pernah punya top-level query serupa) diganti `.from("return_credits")` +
`.eq("counterparty_id", ...)` + `.eq("type", "INBOUND")`. RPC call
`refund_ar_return_credit`/`refund_ap_return_credit` diganti `refund_return_credit`
(param `p_return_credit_liability_account_id`/`p_return_credit_asset_account_id` →
`p_return_credit_account_id`). `create_ar_credit_note`/`create_ap_credit_note` call
site **TIDAK BERUBAH SAMA SEKALI** (nama/param/signature identik, konsisten sama fase 2).

## Status inisiatif

**Fase 4 ini menutup seluruh unifikasi tabel anak AR/AP.** Ringkasan akhir:

| Fase | Migration | Tabel digabung | RPC |
|---|---|---|---|
| 1 | `0069` | `payments` | Digabung — `record_payment` |
| 2 | `0070` | `credit_notes` (→ `returns`, rename `0075`) | TETAP 2 — `create_ar_credit_note`/`create_ap_credit_note` (→ `create_ar_return`/`create_ap_return`, rename `0075`) |
| 3 | `0071` | `deposits`+`deposit_applications`+`deposit_refunds`+`deposit_forfeitures` | Digabung — `create_deposit`/`apply_deposit`/`refund_deposit`/`forfeit_deposit` |
| 4 | `0072` | `return_credits`+`return_credit_refunds` | Digabung — `refund_return_credit` (create inline di `create_*_credit_note`) |

Prinsip yang konsisten dipegang sepanjang 4 fase: **tabel digabung kalau strukturnya
identik, RPC digabung KALAU DAN CUMA KALAU logic bisnisnya juga near-exact mirror**
(payments, deposits, return_credits refund — semua cuma debit/kredit ketuker) — RPC
TETAP terpisah kalau logic-nya beneran beda bentuk (retur create — AR bisa 2 jurnal, AP
cuma 1 jurnal yang consume/reduce stok). Maksa gabung RPC yang beda bentuk cuma nambah
percabangan tanpa ngurangin kompleksitas riil — dipegang konsisten dari fase 2 sampai
akhir.

**Update `0075`** (di luar 4 fase awal, dianggap "Fase 5" gak resmi): rename
`credit_notes`→`returns`, merge `inventory_returns`+`inventory_return_lines`+
`purchase_return_lines` jadi `return_lines`, cabut klasifikasi RESALABLE/DAMAGED dari alur
retur AR (dialihkan ke `stock_opname`, mirror keputusan `0068` di AP). Detail lengkap:
`returns-schema.md`.
