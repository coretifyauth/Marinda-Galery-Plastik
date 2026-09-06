# Purchase Replacements — Schema (Finalized)

Spine: `purchase_replacements` (+ `purchase_replacement_lines`). Penukaran barang ke
supplier sisi AP, "Opsi B" dari 2 jalur resolusi retur (mirror `warranty_replacements`
sisi AR, `warranty-replacements-schema.md` — 2 tabel fisik terpisah, gak digabung
waktu unifikasi AR/AP). Ref konsep bisnis: `docs/domain/accounts-payable.md` bagian
"Retur Barang ke Supplier". Migration: `0035_ap_credit_notes_schema.sql`.

## Keputusan

- **Gak pernah nunjuk ke `returns`** (dulu `credit_notes`) — berbeda dari
  `warranty_replacements` (AR) yang wajib punya `return_id` (dulu `credit_note_id`,
  nullable-historis). Jurnalnya Debit Persediaan (barang baru) / Kredit Persediaan (barang
  rusak) — **akun yang sama di 2 baris**, net nol, dokumentasi/audit trail doang.
- **2 resolusi retur (Opsi A "kurangi utang" via `returns`, Opsi B "tukar barang"
  di sini) saling EKSKLUSIF**, dipilih manual, bukan additive kayak AR sebelum `0057`.
  Ketauan lewat proses ngajarin fitur ini bahwa `warranty_replacement` di AR justru
  punya cacat desain (kompensasi ganda) — sudah diperbaiki lewat migration
  `0037_ar_warranty_replacement_discount_reversal.sql`, lalu direstrukturisasi total
  jadi independen di `0057` (lihat `warranty-replacements-schema.md`).
- **Opsi C (`purchase_writeoffs`, "barang rusak yang pemasok tolak ganti sama sekali")
  DICABUT TOTAL migration `0068`** (2026-09-05, keputusan owner) — demi simetri AR/AP
  (AR cuma punya 2 jalur resolusi retur). Barang rusak yang supplier tolak kompensasi
  sekarang dialihkan ke `stock_opname` generic (`record_stock_opname`,
  `stock-opname-schema.md`) — trade-off yang disadari: kehilangan traceability ke
  bill/GRN spesifik + guard qty gabungan lintas opsi, demi kesederhanaan struktur.

## DDL

```sql
create table purchase_replacements (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references transactions(id), -- dulu references ap_bills(id), repoint migration 0064
  replacement_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table purchase_replacement_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_replacement_id uuid not null references purchase_replacements(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_replaced numeric(14,3) not null check (qty_replaced > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);
```

## `purchase_returned_qty(bill_id, item_id)` — guard qty gabungan Opsi A + B (disederhanakan `0068`, sebelumnya A+B+C)

Item Weighted Average gak punya proteksi otomatis per-lot (FIFO sudah dihapus total,
migration `0038_remove_fifo_costing.sql`) — stoknya udah nyampur begitu diterima. Guard
ini jumlahin klaim dari **2 tabel** (`return_lines` — dulu `purchase_return_lines`, digabung
migration `0075`, lihat `returns-schema.md` — via `returns.transaction_id`,
`purchase_replacement_lines` via `purchase_replacements.bill_id` — reducer ke-3,
`purchase_writeoff_lines`, dicabut `0068` bareng tabelnya) dan dibandingin ke
`goods_receipt_lines.qty_received` (`goods-receipt-schema.md`) — fisiknya cuma ada 1 pool
qty yang bisa diklaim, mau lewat jalur mana pun. `create or replace` — signature gak
berubah, jadi 2 trigger existing (`return_lines_no_over_return_outbound_trigger` — dulu
`purchase_return_lines_no_over_return_trigger`, di-rename+retarget migration `0075`;
`purchase_replacement_lines_no_over_return_trigger`) otomatis kepake definisi baru tanpa
perlu di-drop/recreate. Ini yang bikin Opsi A/B partial-capable "gratis" (batasnya di
level fisik qty diterima, bukan per-mekanisme) — gak butuh fungsi `*_remaining()`
terpisah kayak `deposit_remaining()`.

```sql
create or replace function purchase_returned_qty(p_bill_id uuid, p_item_id uuid) returns numeric as $$
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

Join `returns` (dulu `ap_credit_notes` → `credit_notes` sejak `0070` → `returns` sejak `0075`)
lewat `return_lines` (1-hop, dulu `purchase_return_lines` langsung join `credit_notes`).
Dipakai 2 trigger insert (`return_lines_no_over_return_outbound_trigger`,
`purchase_replacement_lines_no_over_return_trigger`) yang semuanya juga nge-lookup
`goods_receipt_lines.qty_received` lewat `goods_receipt_notes.bill_id`
(`goods-receipt-schema.md`).

## RPC `create_purchase_replacement` (Opsi B)

Konsumsi barang rusak pakai `consume_weighted_average` (fungsi yang sama dipakai jalur
full Opsi A, `inventory-ledger-schema.md`), lalu "terima" barang baru pakai `avg_cost`
yang identik (`v_line_cost / v_qty`) — karena unit cost-nya sama persis, hitung ulang
rata-rata otomatis balik ke `avg_cost` semula (murni aljabar:
`((qty_before - qty)*avg + qty*avg) / qty_before = avg`), konsisten sama klaim "net nol"
di dokumentasi bisnis.

Body asli: `supabase/migrations/0035_ap_credit_notes_schema.sql`. Final (retarget
`return_lines`/`returns`): `0075_rename_returns_and_merge_return_lines.sql`.

## RLS & Grant

Pola identik semua tabel transaksional AP/AR lain: `select` terbuka semua
`authenticated`, `insert` cuma `admin`/`accountant`, gak ada `update`/`delete` (RLS
default-deny + `block_edit_delete` jaring kedua).
