# Credit Notes — Schema (Finalized)

Gantiin `ar_credit_notes` (AR) + `ap_credit_notes` (AP) — digabung jadi 1 tabel generic
`credit_notes` (kolom `type` `'INBOUND'`/`'OUTBOUND'`), migration `0070` (2026-09-05).
Fase 2 dari unifikasi tabel anak AR/AP (`payments` [`0069`], `credit_notes`, `deposits`,
`return_credits`) — mirror pola `transactions`/`payments`. Ref konsep bisnis gak berubah:
`docs/domain/accounts-receivable.md` bagian "Retur Barang (Credit Note)", pasangan AP di
`docs/domain/accounts-payable.md` bagian "Retur Barang ke Supplier".

## Keputusan

- **Tabel digabung, RPC TETAP 2 fungsi terpisah** (`create_ar_credit_note`/
  `create_ap_credit_note`) — beda dari `payments` (`0069`) yang RPC-nya juga digabung.
  Alasan: `record_ar_payment`/`record_ap_payment` itu near-exact mirror (cuma
  debit/kredit ketuker), sedangkan 2 RPC ini beneran beda bentuk:
  - **AR** bisa bikin 1 ATAU 2 jurnal (kontra-revenue selalu, reversal HPP opsional
    kalau `p_lines` diisi, dengan klasifikasi `RESALABLE`/`DAMAGED` yang nentuin restock
    atau jadi beban) — 11 parameter.
  - **AP** cuma bikin 1 jurnal (langsung ke Persediaan/akun kredit, gak ada konsep akun
    kontra sama sekali), pakai `consume_weighted_average` yang MENGURANGI stok (barang
    keluar balik ke supplier), bukan restock kayak AR — 8 parameter.

  Maksa gabung jadi 1 RPC `p_type`-branch bakal butuh union parameter dari keduanya
  (sebagian besar `NULL` kalau gak dipakai) plus `if/else` yang isinya nyalin ulang
  hampir seluruh body — lebih banyak kode buat perilaku yang sama, bukan lebih sedikit.
  Pola yang dipilih: tabel penyimpanan digabung (biar FK/traceability satu tempat), logic
  bisnis TETAP di RPC masing-masing — sama pola `create_goods_issue`/`create_goods_receipt`
  yang tetap 2 fungsi walau sama-sama nulis ke `inventory_movements`.
- **Gak ada kolom `counterparty_id`** — beda dari `payments`, `credit_notes` gak pernah
  punya kolom pihak langsung di kedua tabel asalnya (customer/supplier selalu diturunkan
  lewat `transaction_id` -> `transactions.counterparty_id`).
- Money pakai `numeric(14,2)`, bukan float (invariant `AGENT.md`).

## DDL

### `credit_notes` — retur barang, sisi AR (`type='INBOUND'`) & AP (`type='OUTBOUND'`)

```sql
create table credit_notes (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INBOUND', 'OUTBOUND')),
  transaction_id uuid not null references transactions(id),
  credit_note_date date not null,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index credit_notes_transaction_id_idx on credit_notes(transaction_id);
```

Backfill migration `0070` mempertahankan ID asli dari `ar_credit_notes`/`ap_credit_notes`
— **5 tabel turunan** yang FK `credit_note_id`-nya nunjuk ke sini direpoint di migration
yang sama (kolom gak berubah nama, cuma target FK): `ar_return_credits`, `inventory_returns`,
`warranty_replacements` (dulu nunjuk `ar_credit_notes`), `ap_return_credits`,
`purchase_return_lines` (dulu nunjuk `ap_credit_notes`).

## Trigger

### Immutability, konsistensi type, no-over-return, sync status

Pola identik `payments-schema.md` (`0069`) — reuse konsep yang sama:

```sql
create trigger credit_notes_block_edit_delete
  before update or delete on credit_notes
  for each row execute function block_edit_delete();

create trigger credit_notes_type_matches_transaction_trigger
  before insert on credit_notes
  for each row execute function credit_notes_type_matches_transaction();
```

**No-over-return** — gantiin `ar_credit_notes_no_over_return`+`ap_credit_notes_no_over_return`
(sebelumnya 2 fungsi hampir identik, cuma beda nama kolom `invoice_id`/`bill_id`) jadi 1:

```sql
create function credit_notes_no_over_return() returns trigger as $$
declare
  v_transaction_amount numeric;
  v_already_returned numeric;
  v_transaction_ref text;
begin
  select amount into v_transaction_amount from transactions where id = new.transaction_id;
  select coalesce(sum(amount), 0) into v_already_returned
    from credit_notes where transaction_id = new.transaction_id;

  if v_already_returned + new.amount > v_transaction_amount then
    select source_ref into v_transaction_ref from transactions where id = new.transaction_id;
    raise exception 'Retur % melebihi nilai transaksi (nilai %, sudah diretur %, coba retur %)',
      v_transaction_ref, v_transaction_amount, v_already_returned, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;
```

Cap ke `transactions.amount` (bukan sisa outstanding) — gak peduli status bayar, sama
perilaku lama.

**Sync status** — gantiin `ar_credit_notes_sync_invoice_status`/`ap_credit_notes_sync_bill_status`,
1 fungsi manggil `recompute_transaction_status(new.transaction_id)`.

## RPC — TETAP 2 fungsi, cuma insert target yang berubah

`create_ar_credit_note`/`create_ap_credit_note` — signature & logic bisnis byte-identik
ke versi sebelumnya (lihat `ar-schema.md` submodule "Retur Barang" / `ap-schema.md`
submodule "Retur Barang ke Supplier" buat detail lengkap tiap RPC), **satu-satunya
perubahan**: `insert into ar_credit_notes (...)`/`insert into ap_credit_notes (...)` jadi
`insert into credit_notes (type, transaction_id, ...) values ('INBOUND'/'OUTBOUND', ...)`.
Full body: `supabase/migrations/0070_unify_credit_notes_schema.sql`.

## Fungsi lain yang ikut diretarget (`create or replace`, gak ada perubahan perilaku)

- `ar_invoice_remaining`/`ap_bill_remaining` — reducer #2 (retur) + reducer add-back
  (join `ar_return_credits`/`ap_return_credits`) target `credit_notes`.
- `cancel_ap_bill` — guard credit-note-count target `credit_notes` (`type='OUTBOUND'`).
- `ar_return_credit_refunds_guard`/`ap_return_credit_refunds_guard` — join buat ambil
  `source_ref` (pesan error) target `credit_notes`.
- `ap_return_credits_sync_bill_status`/`ar_return_credits_sync_invoice_status` — lookup
  `transaction_id` (dulu `bill_id`/`invoice_id`) dari `credit_notes`.
- `purchase_return_lines_no_over_return` — lookup `transaction_id` (dulu `bill_id`) dari
  `credit_notes`.
- `purchase_returned_qty`/`sales_returned_qty` — join `credit_notes` + filter
  `type='OUTBOUND'`/`'INBOUND'` (defensif — `purchase_return_lines`/`inventory_return_lines`
  secara struktural cuma pernah diisi lewat RPC AP/AR masing-masing, tapi gak ada
  constraint DB yang maksain itu).
- `warranty_replacements_no_over_reverse`/`warranty_replacements_no_over_settle_return_credit`
  — lookup `amount`/`source_ref` dari `credit_notes`.
- `recompute_transaction_status` — reducer `v_returned` (cabang INBOUND) target
  `credit_notes`. **Kritis dilakukan sebelum drop tabel lama** — pelajaran sama persis
  kayak `payments-schema.md` (fungsi ini `plpgsql`, gak bikin `pg_depend` ke tabel yang
  di-query di body-nya, jadi salah 1 reducer kelewat = drop table lolos diam-diam, meledak
  runtime belakangan).
- **`inventory_movements_with_source` (VIEW, `inventory-schema.md`)** — join
  `ap_credit_notes` (lewat `purchase_return_lines`) diretarget ke `credit_notes` (filter
  `type='OUTBOUND'`). **Beda dari fungsi plpgsql di atas**: VIEW punya `pg_depend` BENERAN
  ke tabel yang di-select — kalau ini kelewat, `drop table ap_credit_notes` bakal GAGAL
  KERAS (migration abort, bukan lolos diam-diam kayak kasus fungsi) — ketauan
  `schema-reviewer` sebagai blocker sebelum apply.

## RLS Policy & Grant

Pola identik `ar_credit_notes`/`ap_credit_notes` lama — `select` semua `authenticated`,
`insert` cuma `admin`/`accountant`, **gak ada** policy `UPDATE`/`DELETE`.

```sql
alter table credit_notes enable row level security;

create policy credit_notes_select on credit_notes
  for select using (auth.role() = 'authenticated');

create policy credit_notes_insert on credit_notes
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE -> RLS default deny

grant select, insert on credit_notes to authenticated;
```

## Dampak frontend

Nested-select alias `ar_credit_notes(...)`/`ap_credit_notes(...)` jadi
`ar_credit_notes:credit_notes(...)`/`ap_credit_notes:credit_notes(...)` (pola sama
`transactions`/`payments`) — JSON key gak berubah, TS type (`lib/ar-invoices/schema.ts`,
`lib/ap-bills/schema.ts`, `lib/ar-return-credits/schema.ts`, `lib/ap-return-credits/schema.ts`)
gak disentuh. Query langsung `.from("ar_credit_notes")`/`.from("ap_credit_notes")` diganti
`.from("credit_notes")` + `.eq("transaction_id", ...)` + `.eq("type", "INBOUND"/"OUTBOUND")`
di 2 file (`ar-invoices/[id]/view.tsx`, `ap-bills/[id]/view.tsx`). RPC call
`create_ar_credit_note`/`create_ap_credit_note` **TIDAK BERUBAH SAMA SEKALI** (nama, param,
signature identik) — keuntungan langsung dari keputusan "RPC tetap 2 fungsi": blast radius
frontend jauh lebih kecil dibanding kalau RPC-nya ikut digabung.
`generateDocumentNumber("ar_credit_notes"/"ap_credit_notes")` TETAP dipanggil apa adanya
(docType string persisten, konvensi project).
