# Warranty Replacements — Schema (Finalized)

Spine: `warranty_replacements` (+ `warranty_replacement_lines`). Penukaran barang
pasca-retur/garansi sisi AR — mirror `purchase_replacements` sisi AP
(`purchase-replacements-schema.md`), tapi 2 tabel fisik terpisah (gak digabung waktu
unifikasi AR/AP karena beda tabel, beda arah — lihat `returns-schema.md` >
"Keputusan" soal kapan RPC/tabel AR-AP digabung vs tetap terpisah). Ref konsep bisnis:
`docs/domain/accounts-receivable.md` bagian "Penukaran Barang Pasca-Retur (Garansi)".
Migration: `0026_ar_warranty_replacements.sql` (versi awal) → `0037_ar_warranty_replacement_discount_reversal.sql`
(pembalikan diskon) → `0041_ar_return_credit_resolution.sql` (penyelesaian saldo kredit
retur) → **`0057_ar_warranty_replacement_independent.sql`** (restrukturisasi jadi
independen, keputusan owner 2026-09-03, bentuk final saat ini).

## Keputusan

- Customer minta barang pengganti buat item yang udah terjual (lewat `goods_issue`) —
  BUKAN gratis/cuma-cuma (dijurnal HPP/Persediaan), TANPA invoice baru, dan (sejak `0057`)
  **gak nyentuh Piutang Usaha sama sekali**.
- **Restrukturisasi `0057`**: dulu warranty replacement WAJIB nunjuk `credit_note_id`
  (`return_id` sejak `0075`) yang sudah lebih dulu mencatat retur fisik+diskon
  (`ar_credit_notes.amount`/sekarang `returns.amount`, SELALU > 0). Kalau replacement dipanggil buat qty yang sama,
  sistem MENGIZINKAN lalu mewajibkan pembalikan proporsional diskon (`0037`) biar gak
  dobel kompensasi — strategi "izinkan lalu koreksi". Sekarang direstrukturisasi jadi
  INDEPENDEN — mirror `create_purchase_replacement` (AP) yang independen dari awal,
  nunjuk `invoice_id` langsung, gak pernah butuh credit note ada duluan. Fungsi baru
  `sales_returned_qty(invoice_id, item_id)` (mirror `purchase_returned_qty`) menjumlah
  qty yang udah diklaim LINTAS SEMUA jalur (retur kredit + ganti barang) buat 1 item di
  1 invoice, dipakai jaga qty fisik yang sama gak diklaim dobel — mencegah kompensasi
  ganda dari akarnya, gantiin mekanisme reversal yang cuma mengoreksi belakangan.

## DDL

Satu baris header = satu kejadian penggantian (bisa lebih dari 1 kali per invoice).
`journal_entry_id` nunjuk jurnal Debit HPP / Kredit Persediaan Barang Jadi
(`create_journal_entry`, reuse) — **satu-satunya jurnal** yang dibuat RPC ini sejak
`0057`. `invoice_id` (**baru, `0057`**) rujukan utama, independen dari credit note.
`return_id` (dulu `credit_note_id`, di-rename migration `0075`; **jadi nullable, `0057`**)
TETAP ada buat baris HISTORIS (data lama) yang masih nunjuk situ — baris BARU selalu NULL.
Kolom reversal (`discount_reversed_amount`, `discount_reversal_journal_entry_id`,
`return_credit_settled_amount`, `return_credit_settlement_journal_entry_id`) juga TETAP ada
buat histori — RPC baru gak pernah ngisi (selalu default `0`/`NULL`), gak ada backfill
mundur. Immutable, pola sama `returns`/`return_lines`.

```sql
create table warranty_replacements (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references transactions(id),          -- 0057, rujukan utama; dulu ar_invoices(id), repoint 0064
  return_id uuid references returns(id),             -- 0057: jadi nullable, cuma histori; repoint 0070, rename kolom 0075 (dulu credit_note_id)
  replacement_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  discount_reversed_amount numeric(14,2) not null default 0 check (discount_reversed_amount >= 0),  -- histori doang sejak 0057
  discount_reversal_journal_entry_id uuid references journal_entries(id),
  return_credit_settled_amount numeric(14,2) not null default 0 check (return_credit_settled_amount >= 0),  -- histori doang sejak 0057
  return_credit_settlement_journal_entry_id uuid references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table warranty_replacement_lines (
  id uuid primary key default gen_random_uuid(),
  warranty_replacement_id uuid not null references warranty_replacements(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_replaced numeric(14,3) not null check (qty_replaced > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);
```

## `sales_returned_qty(invoice_id, item_id)` — mirror `purchase_returned_qty`

```sql
create function sales_returned_qty(p_invoice_id uuid, p_item_id uuid) returns numeric as $$
  select
    coalesce((select sum(rl.qty_returned) from return_lines rl
      join returns r on r.id = rl.return_id
      where r.transaction_id = p_invoice_id and rl.type = 'INBOUND' and rl.item_id = p_item_id), 0)
    + coalesce((select sum(wrl.qty_replaced) from warranty_replacement_lines wrl
      join warranty_replacements wr on wr.id = wrl.warranty_replacement_id
      where wr.invoice_id = p_invoice_id and wrl.item_id = p_item_id), 0);
$$ language sql stable;
```

Migration `0075` sederhanain join ini dari 2-hop (`inventory_return_lines` → `inventory_returns`
→ `credit_notes`) jadi 1-hop langsung (`return_lines` → `returns`), efek merge `return_lines`
(`returns-schema.md`) — logic gak berubah. Gabungan qty yang udah "diklaim" dari 1 item di 1
invoice, lintas retur kredit + ganti barang (`warranty_replacement_lines` via `invoice_id`
langsung). **Ini yang beneran menegakkan mutual exclusivity** — begitu qty suatu item abis
diklaim lewat retur kredit, sisa yang bisa diganti otomatis 0 tanpa butuh cek "diskon > 0"
eksplisit (yang gak akan pernah kerja karena `returns.amount` emang selalu > 0).

## Trigger `warranty_replacement_lines_no_over_replace` (ditulis ulang `0057`)

Dulu: cap ke `SUM(qty_returned)` di `inventory_return_lines` 1 credit note doang.
Sekarang: cap ke `goods_issue_lines.qty_issued` (invoice asli, via `goods_issues.invoice_id`)
**dikurangi** `sales_returned_qty()` — mirror persis `purchase_replacement_lines_no_over_return`
(AP, `purchase-replacements-schema.md`). Item yang gak ketemu di `goods_issue_lines`
invoice itu `raise exception` duluan (invoice financial-only gak punya barang fisik buat
diganti).

## Trigger `warranty_replacements_no_over_reverse` (fix `0037`) dan `warranty_replacements_no_over_settle_return_credit` (`0041`) — TETAP ADA, gak diubah `0057`

Dua-duanya baca `new.return_id` (dulu `new.credit_note_id`, kolom di-rename migration `0075`)/
`new.discount_reversed_amount`/`new.return_credit_settled_amount` — aman dijalankan buat
baris baru (`return_id` NULL, kedua kolom amount selalu `0`): `no_over_settle_return_credit`
short-circuit di awal kalau `return_credit_settled_amount = 0` (lookup `return_credits`,
retarget migration `0072`+`0075` — lihat `return-credits-schema.md`); `no_over_reverse` gak
short-circuit eksplisit tapi `select amount from returns where id = NULL` balikin NULL, bikin
perbandingan `... > NULL` evaluasi NULL (bukan TRUE) di PL/pgSQL — `raise exception` gak
pernah kepicu. Dipertahankan aktif buat baris HISTORIS yang `return_id`-nya masih terisi,
walau RPC baru gak akan pernah nyentuh kolom-kolom yang dijaga trigger ini lagi.

## RPC `create_warranty_replacement` (signature baru, jauh lebih sederhana — `0057`)

```sql
create_warranty_replacement(
  p_invoice_id uuid, p_replacement_date date, p_source_ref text,
  p_lines jsonb, -- {"item_id":uuid,"qty":numeric}
  p_hpp_account_id uuid, p_finished_good_account_id uuid
) returns uuid
```

Turun dari 9 parameter ke 6 — `p_credit_note_id`/`p_contra_revenue_account_id`/
`p_receivable_account_id`/`p_return_credit_liability_account_id` semua dicabut, karena
RPC baru gak pernah bikin jurnal reversal/settlement sama sekali. **Wajib
`drop function if exists create_warranty_replacement(uuid, date, text, jsonb, uuid, uuid, uuid, uuid, uuid)`
sebelum `create function`** — signature-nya berubah total (bukan cuma nambah param
opsional di akhir), kalau enggak Postgres bikin overload ambigu (konvensi wajib project
ini, pelajaran dari bug `0011`/`0012` `create_ap_bill`).

- `security invoker`, reuse `create_journal_entry` + `consume_weighted_average`
  (`inventory-ledger-schema.md`) — 0 fungsi baru buat logic konsumsi stok.
- Guard `p_lines` kosong/null tetap dicek eksplisit (pola lama dipertahankan).
- **Gak ada lagi guard "credit note jalur full"** — RPC ini sekarang gak butuh credit
  note apa pun, langsung konsumsi stok + bikin 1 jurnal HPP/Persediaan, insert
  header+lines+`inventory_movements`. Mutual exclusivity ditegakkan trigger
  `warranty_replacement_lines_no_over_replace` di atas, bukan guard eksplisit di RPC.
- **Konsumsi stok**: tetap pool `inventory_balances` (Weighted Average) via
  `consume_weighted_average`. Klasifikasi kondisi (RESALABLE/DAMAGED) di retur AR sendiri
  DICABUT total migration `0075` (`returns-schema.md`) — sekarang SEMUA baris retur restock,
  gak ada lagi baris yang dikecualikan dari `inventory_balances`.

Migration/riwayat: `0026` (versi awal) → `0037` (pembalikan diskon) → `0038` (costing
disederhanakan) → `0041` (penyelesaian saldo kredit retur) → **`0057`** (restrukturisasi
independen, bentuk final saat ini).

## RLS & Grant

Pola identik AR/Inventory lain — `select` semua `authenticated`, `insert` cuma
`admin`/`accountant`, **gak ada** policy `update`/`delete` (default deny + `block_edit_delete`).
