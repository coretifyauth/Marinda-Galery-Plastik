# Inventory Ledger — Schema (Finalized)

Spine: `inventory_balances` (saldo berjalan per item) + `inventory_movements` (kartu
stok/riwayat mutasi). Cross-cutting — dibaca/ditulis dari hampir semua RPC transaksi
Inventory (GRN, goods issue, produksi, retur, opname, POS). Ref konsep bisnis:
`docs/domain/inventory.md` + `memory/domain/inventory.md` bagian "Kartu Stok / Riwayat
Mutasi per Item". Migration: `0012_inventory_schema.sql` (`inventory_balances`),
`0038_remove_fifo_costing.sql` (FIFO dihapus), `0042_inventory_movements_schema.sql`
(`inventory_movements`, status: schema+RPC+backfill+UI selesai, migration `0042`-`0052`,
halaman `/items/[id]`).

## Keputusan

- **Metode costing: Weighted Average, satu-satunya, berlaku semua item.** Sebelum
  migration `0038` sempat ada dua metode (FIFO per-lot + Weighted Average) yang
  ditentukan per `items.costing_method`; FIFO sudah dihapus total dari sistem
  (`0038_remove_fifo_costing.sql`) — kolom `costing_method` juga sudah di-drop karena
  jadi redundant (cuma ada 1 nilai yang mungkin).
- **`inventory_balances` adalah satu-satunya state costing tersimpan lewat INCREMENTAL
  update tiap transaksi** (bukan dihitung ulang dari nol) di seluruh modul Inventory.
  Alasannya: rata-rata berjalan (`new_avg = (qty_before×avg_before + qty_in×unit_cost_in)
  / (qty_before+qty_in)`) itu rekursif — gak bisa diringkas jadi 1 agregat SQL sederhana
  kayak `SUM(debit)-SUM(credit)` atau `SUM(allocations)`, harus dihitung incremental
  tiap transaksi. Beda dari pola cache status AR/AP/PO/SO/POS/Deposit
  (`0053_denormalize_transactional_status.sql`, `transactions-schema.md`) — itu kolom
  **cache** dari agregat yang MASIH BISA dihitung ulang dari nol kapan aja (trigger
  cuma nyimpen ulang hasil `SUM`/`CASE` yang sama persis), sementara
  `inventory_balances.avg_cost` gak bisa dihitung ulang dari nol tanpa incremental
  (riwayat urutan transaksinya harus diproses berurutan).
- **Tabel ledger terpusat baru (`inventory_movements`), BUKAN view gabungan** —
  keputusan arsitektur eksplisit (dibahas 2026-08-16 & 2026-08-17): baca riwayat lebih
  cepat & konsisten jangka panjang (1 tabel rapi, gak perlu buka ±10 tabel tiap query),
  ditukar biaya awal lebih besar (harus ubah ±9-10 RPC + backfill).
- **Saldo berjalan derived, BUKAN kolom tersimpan** — gak ada kolom `running_balance`.
  Dibaca lewat pola opening-balance (agregat `SUM(qty)` sampai cutoff) + halaman (baris
  di halaman itu doang), mirror persis `report_account_ledger_opening_balance`
  (General Ledger, migration `0041`). Dipilih ketimbang kolom tersimpan demi akurasi
  (gak ada risiko nilai tersimpan diam-diam menyimpang dari data mutasi asli, terutama
  karena logic insert disebar ke ±9-10 RPC berbeda).
- **`qty` bertanda** (positif=masuk, negatif=keluar), bukan kolom `direction` terpisah
  — supaya `SUM(qty)` langsung jadi saldo, gak perlu `CASE WHEN` di tiap query.
- **11 kolom penunjuk sumber nullable, tepat 1 terisi per baris** (`check
  num_nonnulls(...) = 1`) — kolom mana yang terisi = jenis mutasinya, gak perlu kolom
  `source_type` teks terpisah yang rawan salah ketik pas disalin ke ±9-10 RPC.
  **Awalnya 10 kolom (migration `0042`)**, nambah jadi 11 di migration `0046` — lihat
  gap `purchase_replacement_lines` di bawah.
- **Composite FK `(source_id, item_id) REFERENCES tabel_sumber(id, item_id)`, bukan FK
  1 kolom** — FK 1 kolom cuma jamin "ID ada di tabel yang benar", gak jamin `item_id`
  di movement cocok sama `item_id` di baris sumber yang ditunjuk (kelas bug yang rawan
  muncul karena logic insert disebar ke banyak RPC). Composite FK bikin Postgres sendiri
  yang jamin pasangan itu match, gak perlu trigger custom.
- **Index `item_id` di 10 tabel sumber TIDAK diperlukan** — beda dari draf awal yang
  mengasumsikan desain "view gabungan" (query langsung ke 10 tabel tiap kartu stok
  dibuka). Karena desain akhirnya tabel ledger terpisah, halaman kartu stok cuma pernah
  query `inventory_movements` sendiri — 10 tabel sumber cuma disentuh sekali pas
  backfill (full table scan, gak butuh index) dan lewat composite FK (yang butuh
  `unique(id, item_id)`, bukan index performa baca).
- **Gap ditemukan & ditutup: `purchase_replacement_lines` (migration `0046`)** — tabel
  dari RPC `create_purchase_replacement` (`purchase-replacements-schema.md`, "Opsi B —
  tukar barang" di retur ke supplier) gak pernah masuk daftar ±10 tabel sumber asli,
  ketauan pas nulis migration RPC #4. RPC ini secara fisik ngeluarin barang rusak DAN
  masukin barang pengganti (net ke `qty_on_hand` nol karena item sama, tapi 2 kejadian
  fisik nyata) — kalau gak dicatat, kartu stok item itu gak akan pernah nunjukin
  kejadian tukar-barang ini sama sekali. Ditutup: kolom ke-11
  `purchase_replacement_line_id` ditambah + composite FK + CHECK diperluas (dicari
  lewat `pg_constraint`/`pg_get_constraintdef` yang match `%num_nonnulls%`, BUKAN nama
  yang ditebak — constraint aslinya gak dikasih nama eksplisit pas `0042`).
  **Satu-satunya sumber yang 1 baris = 2 baris ledger** (bukan 1:1 kayak 10 sumber lain)
  — `purchase_replacement_line_id` yang sama dipakai di kedua baris (1 qty negatif buat
  barang rusak keluar, 1 qty positif buat barang pengganti masuk), sah karena CHECK
  `num_nonnulls=1` dicek PER BARIS LEDGER, bukan per baris sumber.
- **Migration `0068` ngurangin jadi 10 kolom** (drop `purchase_writeoff_line_id`, fitur
  `purchase_writeoffs` dicabut demi simetri AR/AP) — **CHECK constraint ikut hilang diam-diam**
  bareng drop kolom itu (constraint gabungan, Postgres drop constraint utuh kalau salah 1
  kolom yang direferensikannya di-drop) dan **gak pernah dipulihkan** — gap dorman, gak
  ketauan sampai migration `0075` di bawah.
- **Migration `0075` gabung `inventory_return_line_id`+`purchase_return_line_id` jadi 1
  kolom `return_line_id`** (efek merge `return_lines`, `returns-schema.md`) — total jadi
  **9 kolom sumber**. Dibedakan arahnya lewat `return_lines.type` (`INBOUND`=dari customer,
  `OUTBOUND`=ke supplier), bukan 2 kolom polymorphic terpisah lagi. Nyoba pulihkan CHECK
  constraint (9 kolom final) di migration yang sama, **GAGAL & DIBATALKAN** — ketauan ada 2
  baris live yang `num_nonnulls=0` (data historis nyimpang dari luar aplikasi, bukan bug
  RPC manapun). **CHECK constraint saat ini TIDAK ADA SAMA SEKALI** — status: scope-debt
  aktif, `memory/scope-debt/inventory-movements-exactly-one-source-constraint.md`.

## `inventory_balances`

**Dipakai semua item** (sejak migration `0038` — sebelumnya cuma item
`WEIGHTED_AVERAGE`, item `FIFO` punya baris di `inventory_lots`). Nyimpen
`qty_on_hand` dan `avg_cost` yang di-update tiap ada penerimaan (avg_cost berubah)
atau konsumsi/penjualan (qty_on_hand berkurang, avg_cost tetap). Ini pengecualian
sengaja dari pola "derived, bukan stored" yang dipegang di modul lain. PK-nya
`item_id` sendiri (bukan `id` terpisah) — struktural mastiin maksimal 1 baris per item,
gak butuh `unique` constraint tambahan.

```sql
create table inventory_balances (
  item_id uuid primary key references items(id),
  qty_on_hand numeric(14,3) not null default 0 check (qty_on_hand >= 0),
  avg_cost numeric(14,2) not null default 0,
  updated_at timestamptz not null default now()
);
```

**`inventory_lots` dan `inventory_lot_consumptions` sudah dihapus total (migration
`0038_remove_fifo_costing.sql`)** — dulu ada 2 tabel buat nangenin costing FIFO
per-lot (`inventory_lots` buat stok "lahir", `inventory_lot_consumptions` buat stok
"dipakai/keluar"), lengkap sama trigger anti-over-consumption per lot. Sekarang cuma
Weighted Average yang tersisa — satu-satunya state costing yang hidup adalah
`inventory_balances` di atas, gak ada lagi konsep lot/batch per item.

**Penyesuaian ke hasil hitung fisik**: RPC `record_stock_opname`
(`stock-opname-schema.md`) langsung nyesuaiin `qty_on_hand` ke hasil hitung —
satu-satunya jalur yang nulis ke `qty_on_hand` tanpa lewat transaksi lain (semua RPC
lain sebelumnya selalu lewat kejadian eksplisit: GRN, goods issue, produksi, retur,
write-off). `avg_cost` gak disentuh.

## Fungsi Bersama: `consume_weighted_average`

Fungsi generik (bukan RPC yang dipanggil langsung dari client, tapi dipanggil dari
dalam `create_production_order` (`production-orders-schema.md`) /`create_goods_issue`
(`goods-issue-schema.md`)) — satu-satunya tempat logika konsumsi stok ditulis, biar
production-input dan sales-issue gak duplikat logika. Cukup kurangin `qty_on_hand`
langsung, `avg_cost` gak berubah pas konsumsi (cuma berubah pas penerimaan baru).
Sebelum migration `0038`, ada juga `consume_fifo` (jalan lot demi lot, urut
`lot_date`) buat item FIFO — sudah di-drop total, `consume_weighted_average` sekarang
satu-satunya jalur konsumsi buat semua item.

Full body: `supabase/migrations/0012_inventory_schema.sql`.

## RLS & Grant (`inventory_balances`)

Pola identik AR/AP: `select` terbuka semua `authenticated`, `insert` cuma
`admin`/`accountant`. Beda dari tabel transaksional lain — `inventory_balances` dapat
policy `update` juga (state yang di-update RPC, bukan cuma insert-only).

```sql
grant select, insert, update on inventory_balances to authenticated;
```

Detail lengkap: `supabase/migrations/0012_inventory_schema.sql`.

## `inventory_movements`

1 baris = 1 kejadian mutasi qty 1 item, ditulis sebagai efek samping dari RPC
transaksi yang sudah ada (bukan RPC baru berdiri sendiri).

DDL di bawah bentuk FINAL pasca migration `0075` (9 kolom sumber: 10 dari `0042`+`0046`,
`purchase_writeoff_line_id` di-drop `0068`, `inventory_return_line_id`+
`purchase_return_line_id` digabung `return_line_id` `0075`). **CHECK `num_nonnulls`
SENGAJA GAK DITULIS DI BAWAH** — constraint ini gak ada di database live saat ini (hilang
sejak `0068`, gagal dipulihkan `0075`, lihat "Keputusan" di atas dan
`memory/scope-debt/inventory-movements-exactly-one-source-constraint.md`). Kolom di bawah
tetap "tepat 1 terisi per baris" SECARA KONVENSI (semua RPC masih nulis sesuai itu), cuma
gak ada lagi penjagaan DB-level.

```sql
create table inventory_movements (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items(id),
  movement_date date not null,
  qty numeric(14,3) not null check (qty <> 0),
  created_at timestamptz not null default now(),

  goods_receipt_line_id uuid,
  production_order_id uuid,
  return_line_id uuid, -- migration 0075, gantiin inventory_return_line_id+purchase_return_line_id
  stock_opname_line_id uuid,
  goods_issue_line_id uuid,
  pos_sale_line_id uuid,
  production_order_line_id uuid,
  warranty_replacement_line_id uuid,
  purchase_replacement_line_id uuid, -- migration 0046, lihat "Keputusan" di atas

  foreign key (goods_receipt_line_id, item_id) references goods_receipt_lines(id, item_id),
  foreign key (production_order_id, item_id) references production_orders(id, item_id),
  foreign key (return_line_id, item_id) references return_lines(id, item_id),
  foreign key (stock_opname_line_id, item_id) references stock_opname_lines(id, item_id),
  foreign key (goods_issue_line_id, item_id) references goods_issue_lines(id, item_id),
  foreign key (pos_sale_line_id, item_id) references pos_sale_lines(id, item_id),
  foreign key (production_order_line_id, item_id) references production_order_lines(id, item_id),
  foreign key (warranty_replacement_line_id, item_id) references warranty_replacement_lines(id, item_id),
  foreign key (purchase_replacement_line_id, item_id) references purchase_replacement_lines(id, item_id)

  -- TIDAK ADA check(num_nonnulls(...)=1) -- lihat catatan di atas.
);

create index inventory_movements_item_id_movement_date_id_idx
  on inventory_movements(item_id, movement_date, id);

create trigger inventory_movements_block_edit_delete
  before update or delete on inventory_movements
  for each row execute function block_edit_delete();
```

Baris `return_line_id` dibedakan arahnya lewat `return_lines.type` (join, bukan kolom
sendiri) — `INBOUND` = retur dari customer (barang masuk), `OUTBOUND` = retur ke supplier
(barang keluar).

- `movement_date` — tanggal transaksi ASLI dari tabel sumbernya (misal `receipt_date`
  GRN, `production_date`, dst), bukan `created_at` insert — bisa beda kalau ada input
  mundur. Ini kolom yang dipakai opening-balance query, bukan `created_at`.
- Composite FK otomatis "lolos" (skip validasi) kalau salah satu kolom pasangannya
  `NULL` (perilaku default `MATCH SIMPLE` Postgres) — jadi 9 dari 10 FK selalu
  trivially satisfied per baris, cuma 1 FK yang kolom penunjuknya terisi yang benar-benar
  divalidasi. Dikombinasikan sama `check(num_nonnulls(...)=1)`, ini yang jamin tepat 1
  FK "aktif" per baris — dikonfirmasi `schema-reviewer` valid secara semantik Postgres.
- Index `(item_id, movement_date, id)` — dipakai opening-balance (`WHERE item_id=...
  AND movement_date < cutoff`) dan pagination halaman (`ORDER BY movement_date, id
  WHERE item_id=...`), kolom `id` ikut buat tie-break deterministik kalau ada >1
  mutasi item yang sama di tanggal yang sama.

## Unique `(id, item_id)` di 10 tabel sumber — prasyarat composite FK

`id` di tiap tabel sumber sudah unique (PK) — menambah `item_id` sebagai kolom kedua
gak mungkin memunculkan duplikat baru, cuma menyediakan target yang bisa ditunjuk
composite FK di atas. (`production_orders_id_item_id_key` didefinisikan di
`production-orders-schema.md` bareng kolom `item_id`-nya sendiri.)

```sql
alter table goods_receipt_lines add constraint goods_receipt_lines_id_item_id_key unique (id, item_id);
alter table return_lines add constraint return_lines_id_item_id_key unique (id, item_id); -- migration 0075, gantiin inventory_return_lines+purchase_return_lines
alter table stock_opname_lines add constraint stock_opname_lines_id_item_id_key unique (id, item_id);
alter table goods_issue_lines add constraint goods_issue_lines_id_item_id_key unique (id, item_id);
alter table pos_sale_lines add constraint pos_sale_lines_id_item_id_key unique (id, item_id);
alter table production_order_lines add constraint production_order_lines_id_item_id_key unique (id, item_id);
alter table warranty_replacement_lines add constraint warranty_replacement_lines_id_item_id_key unique (id, item_id);
```

## `inventory_movements_with_source` — VIEW join semua tabel sumber

Dipakai halaman kartu stok (`/items/[id]`) buat resolve nama/referensi dokumen sumber
tanpa client harus tahu tabel sumbernya. `create or replace` di migration `0070` (retarget
join `ap_credit_notes` -> `credit_notes` dengan filter `acn.type = 'OUTBOUND'`) → migration
`0075` (retarget lagi ke `return_lines`/`returns`, 2 kolom polymorphic lama
`inventory_return_line_id`/`purchase_return_line_id` digabung 1 `return_line_id`, dibedakan
arahnya lewat `rl.type` — lihat `returns-schema.md`) — casting `::numeric as remaining`/tipe
kolom lain dijaga tetap sama, Postgres nolak `CREATE OR REPLACE VIEW` yang mengubah typmod
kolom.

## RLS & Grant (`inventory_movements`)

Pola identik tabel transaksional lain (`goods_issues`, `stock_opname_lines`, dst) —
`select` semua `authenticated`, `insert` cuma `admin`/`accountant` (baris ledger cuma
lahir dari RPC transaksi yang sudah role-gated; RPC `create_pos_sale` yang `security
definer` tetap bisa insert lewat privilege pemilik fungsi, gak butuh role `cashier`
eksplisit di sini). **Gak ada** policy `update`/`delete` — immutable total, 2 lapis
proteksi (RLS default-deny + trigger `block_edit_delete`).

```sql
grant select, insert on inventory_movements to authenticated;
```

## Rencana Bertahap — RPC & Backfill (Selesai)

Migration `0042` cuma schema dasar. RPC yang ditambah 1 blok `INSERT INTO
inventory_movements` (additive, `create or replace`, gak ubah signature) menyusul
bertahap, migration terpisah per RPC (atau kelompok kecil yang berkaitan), direview
`schema-reviewer` satu-satu, urutan dari risiko paling rendah ke paling tinggi:

1. `create_purchase_writeoff` (barang rusak, insidental) — migration
   `0043_inventory_movements_purchase_writeoff.sql`. **Catatan: RPC dan tabelnya
   sendiri sudah dicabut total migration `0068`** (lihat `purchase-replacements-schema.md`)
   — baris historis di `inventory_movements` yang nunjuk lewat kolom ini tetap ada
   sebagai data lama.
2. `create_warranty_replacement` (klaim garansi, jarang) — migration
   `0044_inventory_movements_warranty_replacement.sql`, sudah diapply.
3. `record_stock_opname` (periodik, tapi kompleks — 1 RPC bisa hasilkan movement IN
   maupun OUT tergantung tanda `variance` per baris) — migration
   `0045_inventory_movements_stock_opname.sql`, sudah diapply.
4. `create_ap_return` (dulu `create_ap_credit_note`) + `create_purchase_replacement`
   (retur ke supplier, 2 opsi saling eksklusif) — migration
   `0046_inventory_movements_purchase_return_replacement.sql`, sudah diapply.
   Sekalian nutup gap `purchase_replacement_lines` (kolom ke-11, lihat "Keputusan" di
   atas).
5. `create_ar_return` (dulu `create_ar_credit_note`, retur dari customer) — migration
   `0047_inventory_movements_ar_credit_note.sql`, sudah diapply. **Historis**: dulu cuma
   kondisi `RESALABLE` yang masuk ledger, baris `DAMAGED` di-skip — klasifikasi ini
   dicabut total migration `0075` (`returns-schema.md`), sekarang SEMUA baris insert ke
   `inventory_movements` tanpa kecuali.
6. `create_goods_receipt` (pembelian, cukup rutin) — migration
   `0048_inventory_movements_goods_receipt.sql`, sudah diapply.
7. `create_production_order` (paling kompleks — 1 pemanggilan hasilkan 1 baris IN
   [barang jadi] + N baris OUT [tiap bahan baku dikonsumsi] sekaligus) — migration
   `0049_inventory_movements_production_order.sql`, sudah diapply.
8. `create_goods_issue` + `create_pos_sale` (transaksi paling sering/harian —
   disentuh PALING TERAKHIR, setelah pola insert-nya terbukti aman di RPC lain) —
   migration `0050_inventory_movements_goods_issue_pos_sale.sql`, sudah diapply.
   `create_pos_sale` `security definer` — insert ke `inventory_movements` tetap jalan
   lewat privilege pemilik fungsi walau role `cashier` gak punya akses insert langsung.

**Seluruh 8 RPC (10 fungsi total) sudah selesai.** Backfill data historis (11 skrip
`INSERT INTO inventory_movements SELECT ... FROM <tabel_sumber>`, independen satu sama
lain, dijaga `NOT EXISTS` per kolom sumber) + query rekonsiliasi (`SUM(inventory_movements.qty)`
per item vs `inventory_balances.qty_on_hand`) sudah diapply migration
`0051_inventory_movements_backfill.sql` — lolos tanpa mismatch.

**RPC ke-9, ditutup belakangan: `void_pos_sale`** — gap ditemukan lewat review `0051`
(bukan bagian dari 8 RPC yang disepakati di awal, sengaja jadi item terpisah,
`memory/scope-debt/void-pos-sale-inventory-movement-gap.md`). Ditutup migration
`0056_void_pos_sale_inventory_movement_compensation.sql`. Beda dari 8 RPC di atas: ini
bukan RPC yang *menciptakan* mutasi baru, tapi yang *membatalkan* mutasi lama — loop
per `pos_sale_lines` milik sale yang di-void, insert 1 baris `inventory_movements` per
baris (qty **positif** = kompensasi/pemulihan) nunjuk ke `pos_sale_line_id` yang SAMA
dengan baris OUT asli dari `create_pos_sale` (pola "1 baris sumber = banyak baris
ledger" sama persis `purchase_replacement_lines`, `check num_nonnulls=1` dicek per
baris ledger bukan per baris sumber). Gak butuh backfill — dicek ke DB live sebelum
migration ini ditulis, belum pernah ada riwayat void POS sale sama sekali.

Full body: `supabase/migrations/0042_inventory_movements_schema.sql`.
