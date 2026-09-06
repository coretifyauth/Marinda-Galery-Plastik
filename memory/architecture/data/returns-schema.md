# Returns — Schema (Finalized)

Gantiin `ar_credit_notes` (AR) + `ap_credit_notes` (AP) — digabung jadi 1 tabel generic
`credit_notes` (kolom `type` `'INBOUND'`/`'OUTBOUND'`), migration `0070` (2026-09-05). Fase 2
dari unifikasi tabel anak AR/AP (`payments` [`0069`], `credit_notes`, `deposits`,
`return_credits`) — mirror pola `transactions`/`payments`. **Migration `0075` (2026-09-06)
rename tabel `credit_notes` → `returns`** (nama lebih jelas, konteks pakainya memang cuma
buat retur) + merge `inventory_returns`+`inventory_return_lines`+`purchase_return_lines` jadi
1 tabel generic `return_lines` (flatten) + hapus klasifikasi kondisi (RESALABLE/DAMAGED) dari
alur retur AR. Ref konsep bisnis gak berubah: `docs/domain/accounts-receivable.md` bagian
"Retur Barang (Credit Note)", pasangan AP di `docs/domain/accounts-payable.md`.

## Keputusan

- **Tabel digabung, RPC TETAP 2 fungsi terpisah** (`create_ar_return`/`create_ap_return`,
  dulu `create_ar_credit_note`/`create_ap_credit_note`) — beda dari `payments` (`0069`) yang
  RPC-nya juga digabung. Alasan: AR bisa bikin 1 ATAU 2 jurnal (kontra-revenue selalu,
  reversal HPP opsional kalau `p_lines` diisi) — 10 parameter (dulu 11, `p_loss_expense_account_id`
  dicabut `0075`). AP cuma bikin 1 jurnal (langsung ke Persediaan/akun kredit, gak ada konsep
  akun kontra sama sekali), pakai `consume_weighted_average` yang MENGURANGI stok — 8
  parameter. Pola yang dipilih: tabel penyimpanan digabung (biar FK/traceability satu
  tempat), logic bisnis TETAP di RPC masing-masing — sama pola `create_goods_issue`/
  `create_goods_receipt`.
- **Gak ada kolom `counterparty_id`** — `returns` gak pernah punya kolom pihak langsung
  (customer/supplier selalu diturunkan lewat `transaction_id` -> `transactions.counterparty_id`).
- **Nama tabel `returns`, tapi trigger/fungsi internal LAIN sengaja TETAP pakai nama lama**
  (`credit_notes_type_matches_transaction`, `credit_notes_no_over_return`,
  `credit_notes_sync_transaction_status`, kolom `credit_note_date`) — pola sama
  `ar_invoice_remaining` yang juga gak ikut di-rename pas `ar_invoices`/`ap_bills` digabung
  jadi `transactions`. Cuma RPC user-facing (`create_ar_credit_note`/`create_ap_credit_note`)
  yang ikut di-rename jadi `create_ar_return`/`create_ap_return`.
- **Trigger konsistensi arah DIBALIK LOGIC-nya migration `0075`** — sebelumnya
  `credit_notes_type_matches_transaction` cek `returns.type` HARUS SAMA dengan
  `transactions.type`. Sejak `transactions.type` dibalik maknanya (`0074`,
  `transactions-schema.md`) sementara `returns.type` **TIDAK ikut dibalik** (nilainya udah
  benar dari awal — retur customer = barang masuk = tetap `INBOUND`, retur ke supplier =
  barang keluar = tetap `OUTBOUND`), trigger ini sekarang cek `returns.type` HARUS
  **KEBALIKAN** dari `transactions.type` — retur secara definisi adalah pembalikan arah dari
  transaksi induknya, bukan arah yang sama. `return_credits.type` vs `returns.type` (trigger
  `return_credits_type_matches_credit_note`) TETAP cek SAMA (dua-duanya gak ikut dibalik).
- **Klasifikasi kondisi (RESALABLE/DAMAGED) DICABUT dari alur retur AR migration `0075`** —
  barang rusak dari retur sekarang dialihkan ke `stock_opname` generic (mirror pola AP,
  migration `0068` yang lebih dulu mencabut Opsi C `purchase_writeoffs` demi simetri). Semua
  baris retur sekarang SELALU restock (dulu cuma baris `RESALABLE`). Kolom `condition` di
  `return_lines` TETAP ada (historical-only, default `RESALABLE`, RPC baru gak pernah isi
  `DAMAGED`) — data historis DAMAGED gak boleh diubah/dihapus (invariant "no editing posted
  period"), pola sama kolom historical di `warranty_replacements` (`0057`).
- **`inventory_returns`+`inventory_return_lines`+`purchase_return_lines` DIGABUNG jadi
  `return_lines`, opsi FLATTEN (migration `0075`)** — tanpa header terpisah. `goods_issue_id`
  (rujukan snapshot cost) + `hpp_reversal_journal_entry_id` (jurnal ke-2, cuma ada di AR)
  jadi kolom nullable LANGSUNG di tiap baris `return_lines`, bukan di header — cuma keisi
  `type='INBOUND'`. Konsekuensi: `sales_returned_qty` (dulu 2-hop lewat `inventory_returns`)
  sekarang 1-hop langsung ke `return_lines`. Dipilih dibanding opsi "header optional"/"header
  simetris penuh" karena tabel paling sedikit — trade-off diterima: 2 kolom itu keulang per
  baris kalau 1 retur ada >1 item (bounded, aman karena tabel immutable, gak pernah di-`UPDATE`
  setelah insert).
- Money pakai `numeric(14,2)`, bukan float (invariant `AGENT.md`).

## DDL

### `returns` — retur barang, sisi AR (`type='INBOUND'`) & AP (`type='OUTBOUND'`)

```sql
create table returns (
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

create index returns_transaction_id_idx on returns(transaction_id);
```

Nama kolom `credit_note_date` TETAP (gak di-rename ke `return_date`) — sengaja minim
perubahan kolom di luar yang benar-benar perlu (`credit_note_id` di tabel anak). Backfill
migration `0075` pertahankan ID asli dari `credit_notes` — 4 tabel turunan yang FK
`credit_note_id`-nya nunjuk ke sini di-rename kolomnya jadi `return_id` sekaligus repoint:
`return_credits`, `warranty_replacements` (nullable, historis), `return_lines` (baru).

### `return_lines` — item retur, sisi AR (`type='INBOUND'`) & AP (`type='OUTBOUND'`), flatten

```sql
create table return_lines (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INBOUND', 'OUTBOUND')),
  return_id uuid not null references returns(id),
  item_id uuid not null references items(id),
  qty_returned numeric(14,3) not null check (qty_returned > 0),
  total_cost numeric(14,2) not null check (total_cost > 0),
  condition text not null default 'RESALABLE' check (condition in ('RESALABLE', 'DAMAGED')), -- historical-only sejak 0075
  goods_issue_id uuid references goods_issues(id),               -- nullable, cuma type='INBOUND'
  hpp_reversal_journal_entry_id uuid references journal_entries(id) -- nullable, cuma type='INBOUND'
);

create unique index return_lines_id_item_id_key on return_lines(id, item_id); -- composite FK inventory_movements
create index return_lines_return_id_idx on return_lines(return_id);
```

`goods_issue_id`/`hpp_reversal_journal_entry_id` — cuma diisi baris `type='INBOUND'` (AR):
`goods_issue_id` nunjuk balik ke `goods_issues` asal (buat snapshot cost reversal HPP),
`hpp_reversal_journal_entry_id` nunjuk jurnal reversal HPP (Debit Persediaan Barang Jadi /
Kredit HPP) yang **terpisah** dari jurnal kontra-revenue di `returns` (2 jurnal independen,
sama pola `create_goods_issue`). Baris `type='OUTBOUND'` (AP) 2 kolom ini selalu `NULL` — AP
cuma 1 jurnal total (udah nempel di `returns.journal_entry_id`), gak butuh snapshot (pakai
`consume_weighted_average` di harga rata-rata **saat ini**).

Barang yang balik masuk blend ke `inventory_balances.avg_cost` (`inventory-ledger-schema.md`,
formula sama persis weighted-average-receive) — **SEMUA baris `type='INBOUND'`** sejak
`0075` (dulu cuma `condition='RESALABLE'`). `inventory_movements` insert SEMUA baris tanpa
terkecuali (dulu skip baris `DAMAGED`).

### Trigger `return_lines_no_over_return_inbound`/`_outbound`

`before insert`, dipecah 2 (`when new.type='INBOUND'`/`'OUTBOUND'`) — gantiin
`inventory_return_lines_guard`(AR)/`purchase_return_lines_no_over_return`(AP) lama. AR
sekarang baca `new.goods_issue_id` LANGSUNG dari baris itu sendiri (dulu 2-hop lewat header
`inventory_returns`). AP lookup `bill_id` lewat `returns.transaction_id` (`return_lines` gak
punya `transaction_id` sendiri, beda dari sisi AR yang punya `goods_issue_id` langsung).
Keduanya baca `sales_returned_qty`/`purchase_returned_qty` (di bawah) buat cek gak over-claim.

## Trigger (`returns` sendiri)

### Immutability, konsistensi type, no-over-return, sync status

Fungsi TETAP nama lama (`credit_notes_*`), cuma badan/target tabel yang diretarget:

```sql
create trigger credit_notes_block_edit_delete
  before update or delete on returns
  for each row execute function block_edit_delete();

create trigger credit_notes_type_matches_transaction_trigger
  before insert on returns
  for each row execute function credit_notes_type_matches_transaction();
```

**Konsistensi arah — logic DIBALIK migration `0075`** (lihat "Keputusan" di atas):

```sql
create function credit_notes_type_matches_transaction() returns trigger as $$
declare
  v_transaction_type text;
begin
  select type into v_transaction_type from transactions where id = new.transaction_id;
  if v_transaction_type = new.type then
    raise exception 'returns.type (%) harus KEBALIKAN dari transactions.type (%) buat transaction_id % -- retur adalah pembalikan arah, bukan arah yang sama', new.type, v_transaction_type, new.transaction_id;
  end if;
  return new;
end;
$$ language plpgsql;
```

**No-over-return** (fungsi `credit_notes_no_over_return`, TETAP nama lama) — cap ke
`transactions.amount` (bukan sisa outstanding), retarget `from credit_notes` → `from returns`,
logic gak berubah:

```sql
create function credit_notes_no_over_return() returns trigger as $$
declare
  v_transaction_amount numeric;
  v_already_returned numeric;
  v_transaction_ref text;
begin
  select amount into v_transaction_amount from transactions where id = new.transaction_id;
  select coalesce(sum(amount), 0) into v_already_returned
    from returns where transaction_id = new.transaction_id;

  if v_already_returned + new.amount > v_transaction_amount then
    select source_ref into v_transaction_ref from transactions where id = new.transaction_id;
    raise exception 'Retur % melebihi nilai transaksi (nilai %, sudah diretur %, coba retur %)',
      v_transaction_ref, v_transaction_amount, v_already_returned, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;
```

**Sync status** (`credit_notes_sync_transaction_status`, TETAP nama lama) — body cuma pakai
`new.transaction_id`, gak pernah nyebut nama tabel, jadi TIDAK diubah sama sekali oleh
migration `0075`.

## `sales_returned_qty`/`purchase_returned_qty` — gantiin lookup 2-hop jadi 1-hop

```sql
create function sales_returned_qty(p_invoice_id uuid, p_item_id uuid) returns numeric as $$
  select
    coalesce((
      select sum(rl.qty_returned) from return_lines rl
      join returns r on r.id = rl.return_id
      where r.transaction_id = p_invoice_id and rl.type = 'INBOUND' and rl.item_id = p_item_id
    ), 0)
    +
    coalesce((
      select sum(wrl.qty_replaced) from warranty_replacement_lines wrl
      join warranty_replacements wr on wr.id = wrl.warranty_replacement_id
      where wr.invoice_id = p_invoice_id and wrl.item_id = p_item_id
    ), 0);
$$ language sql stable;

create function purchase_returned_qty(p_bill_id uuid, p_item_id uuid) returns numeric as $$
  select
    coalesce((
      select sum(rl.qty_returned) from return_lines rl
      join returns r on r.id = rl.return_id
      where r.transaction_id = p_bill_id and rl.type = 'OUTBOUND' and rl.item_id = p_item_id
    ), 0)
    +
    coalesce((
      select sum(prpl.qty_replaced) from purchase_replacement_lines prpl
      join purchase_replacements prp on prp.id = prpl.purchase_replacement_id
      where prp.bill_id = p_bill_id and prpl.item_id = p_item_id
    ), 0);
$$ language sql stable;
```

## RPC — TETAP 2 fungsi, `create_ar_return`/`create_ap_return` (dulu `create_ar_credit_note`/`create_ap_credit_note`)

### RPC `create_ar_return`

`security invoker`, reuse `create_journal_entry` (2x kalau jalur full, 1x kalau
financial-only). Param `condition`/`p_loss_expense_account_id` DICABUT `0075` — semua baris
retur selalu restock.

- `p_lines` (nullable/kosong) menentukan jalur: kosong = financial-only. Terisi = full (2
  jurnal + stok balik) — `raise exception` kalau invoice gak punya `goods_issues`.
- Nominal jurnal kontra-revenue (`p_amount`) tetap input eksplisit dari caller.
- Nominal reversal HPP dihitung RPC dari snapshot (`goods_issue_lines.total_cost /
  qty_issued × qty_returned`), server-side, gak dipercaya dari caller.
- Deteksi & cairkan excess retur jadi Saldo Kredit Retur Customer (`return-credits-schema.md`)
  — sama persis logic sebelumnya, gak berubah.

```sql
create function create_ar_return(
  p_invoice_id uuid,
  p_credit_note_date date,
  p_source_ref text,
  p_amount numeric,
  p_contra_revenue_account_id uuid,
  p_receivable_account_id uuid,
  p_lines jsonb default null,
  p_hpp_account_id uuid default null,
  p_finished_good_account_id uuid default null,
  p_return_credit_liability_account_id uuid default null
) returns uuid
```

Insert `returns (type='INBOUND', ...)`, kalau excess insert `return_credits (type='INBOUND',
return_id=..., ...)`, kalau `p_lines` terisi insert `return_lines` per item (`type='INBOUND'`,
`goods_issue_id`, `hpp_reversal_journal_entry_id` diisi) + `inventory_movements` (qty
POSITIF) buat SEMUA baris tanpa terkecuali.

### RPC `create_ap_return`

`p_lines` null/kosong → financial-only. Terisi → full, bill wajib punya
`goods_receipt_notes`, **`p_amount` DIABAIKAN dan DIGANTI** hasil penjumlahan cost fisik
tiap baris (`consume_weighted_average`). **Gak ada akun kontra**. Insert `returns
(type='OUTBOUND', ...)`, `return_lines` per item (`type='OUTBOUND'`, 2 kolom ekstra `NULL`)
+ `inventory_movements` (qty NEGATIF).

```sql
create function create_ap_return(
  p_bill_id uuid,
  p_credit_note_date date,
  p_source_ref text,
  p_amount numeric,
  p_payable_account_id uuid,
  p_credit_account_id uuid,
  p_lines jsonb default null,
  p_return_credit_asset_account_id uuid default null
) returns uuid
```

Full body kedua RPC: `supabase/migrations/0075_rename_returns_and_merge_return_lines.sql`.
RPC lama (`create_ar_credit_note`/`create_ap_credit_note`) di-drop total, hard cutover.
Riwayat sebelumnya (pra-rename): `0072_unify_return_credits_schema.sql` (retarget
`return_credits`), `0021_ar_credit_notes_schema.sql`/`0015_ar_credit_note_damaged_condition.sql`
(AR), `0035_ap_credit_notes_schema.sql` (AP).

## Fungsi lain yang ikut diretarget (`create or replace`, gak ada perubahan perilaku)

- `ar_invoice_remaining`/`ap_bill_remaining` — reducer #2 (retur, filter `type='INBOUND'`/
  `'OUTBOUND'` TIDAK berubah — lihat `transactions-schema.md`) + reducer add-back (join
  `return_credits` lewat `return_id`) target `returns`.
- `cancel_ap_bill` — guard return-count target `returns` (`type='OUTBOUND'`, TIDAK berubah).
- `return_credit_refunds_guard`, `return_credits_sync_transaction_status`,
  `warranty_replacements_no_over_reverse`, `warranty_replacements_no_over_settle_return_credit`
  — retarget `credit_notes`/`credit_note_id` → `returns`/`return_id` (`return-credits-schema.md`,
  `warranty-replacements-schema.md`).
- `recompute_transaction_status` — reducer `v_returned` (cabang AR, sekarang dipilih lewat
  `type='OUTBOUND'` bukan `'INBOUND'` lagi — lihat `transactions-schema.md`) target
  `returns`, filter `type='INBOUND'` TIDAK berubah (return-side).
- **`inventory_movements_with_source` (VIEW, `inventory-ledger-schema.md`)** — retarget
  `purchase_return_lines`/`inventory_return_lines` (2 kolom polymorphic terpisah) jadi
  `return_lines` (1 kolom `return_line_id`, dibedakan lewat `rl.type`). **VIEW punya
  `pg_depend` BENERAN ke kolom yang di-select** — migration `0075` WAJIB retarget view ini
  SEBELUM drop kolom lama, kebalik urutannya bakal gagal keras "view depends on column"
  (ketauan pas apply live).

## RLS Policy & Grant

### `returns` — pola identik `ar_credit_notes`/`ap_credit_notes` lama, policy TETAP nama lama

```sql
alter table returns enable row level security; -- (tabel di-rename, RLS/grant ikut otomatis)

-- policy di-rename migration 0075: credit_notes_select/_insert -> returns_select/_insert
create policy returns_select on returns
  for select using (auth.role() = 'authenticated');

create policy returns_insert on returns
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE -> RLS default deny

grant select, insert on returns to authenticated;
```

### `return_lines` — pola sama, policy baru

```sql
alter table return_lines enable row level security;

create policy return_lines_select on return_lines
  for select using (auth.role() = 'authenticated');

create policy return_lines_insert on return_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

grant select, insert on return_lines to authenticated;
```

## Dampak frontend

**Gak ada halaman dedicated** (`/returns`, `/ar-returns`, `/ap-returns` gak pernah ada) —
semua akses lewat halaman detail invoice/bill (`ar-invoices/[id]/view.tsx`,
`ap-bills/[id]/view.tsx`) dan customer/supplier (`customers/[id]/view.tsx`,
`suppliers/[id]/view.tsx`). Nested-select alias `ar_credit_notes:credit_notes(...)`/
`ap_credit_notes:credit_notes(...)` jadi `ar_returns:returns(...)`/`ap_returns:returns(...)`,
field JS ikutan berubah nama (`invoice.ar_credit_notes` → `invoice.ar_returns`,
`bill.ap_credit_notes` → `bill.ap_returns`) — beda dari unifikasi-unifikasi sebelumnya yang
JSON key-nya sengaja dipertahankan sama; di sini memang diganti biar konsisten sama nama
tabel baru (`lib/ar-invoices/schema.ts`, `lib/ap-bills/schema.ts`, `lib/ar-return-credits/schema.ts`,
`lib/ap-return-credits/schema.ts` ikut diupdate). Query langsung `.from("credit_notes")`
diganti `.from("returns")`. Select string retur AR (`ar-invoices/[id]/view.tsx`) yang dulu
`inventory_returns(id, return_date, inventory_return_lines(...))` (2-hop) jadi
`return_lines(item_id, qty_returned, total_cost, items(name, uom))` (1-hop langsung, TANPA
`condition` — UI pemilihan kondisi per baris dihapus total dari form retur). RPC call
`create_ar_credit_note`/`create_ap_credit_note` diganti `create_ar_return`/`create_ap_return`,
param `condition`/`loss_expense_account_id` gak dikirim lagi.
`generateDocumentNumber("ar_credit_notes"/"ap_credit_notes")` TETAP dipanggil apa adanya
(docType string persisten, konvensi project, independen dari nama tabel fisik).
