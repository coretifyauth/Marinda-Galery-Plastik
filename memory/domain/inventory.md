# Inventory & COGS — AI Context

Inventory melacak barang fisik (qty + harga per satuan) dari diterima → diproses jadi barang jadi → terjual, supaya HPP (Harga Pokok Penjualan / COGS) bisa dihitung akurat. **Prinsip inti: membeli bahan baku BUKAN biaya** — itu tukar aset (Kas/Utang → Persediaan). HPP baru diakui pas barang jadi **terjual** (matching principle), gak peduli kapan utang ke supplier dibayar.

Naratif lengkap + reasoning penuh: `docs/domain/inventory.md`. Struktur module → submodule di file ini SAMA urutannya dengan padanan naratif itu dan dengan `memory/architecture/data/inventory-schema.md` (lihat `AGENTS.md` > "Format Baku: Struktur Module → Submodule").

## Konsep Inti

**Entitas & Alur Nilai**
```
Beli bahan baku (aset naik) → Produksi (pindah aset: Bahan Baku → Barang Jadi) → Terjual (HPP muncul, dicocokkan ke Pendapatan)
```
Cuma tahap terakhir yang menyentuh Laporan Laba Rugi.

- **item** — master data barang (`RAW_MATERIAL`/`FINISHED_GOOD`). Costing-nya sama buat semua: Weighted Average. `uom` cuma 1 kolom teks, murni tampilan, gak ada konversi antar-satuan — ini tetap **1 satuan dasar** dipakai buat semua pelacakan stok/biaya (PO/GRN/BOM/production/goods issue). Satuan JUAL ke customer boleh beda (lihat submodule "Satuan Jual & Harga" di bawah).
- **inventory_balances** — satu-satunya state costing tersimpan (bukan derived) di seluruh modul, PK = `item_id` (maks 1 baris per item). Nyimpen `qty_on_hand` + `avg_cost`, di-update tiap ada penerimaan baru (avg berubah) atau konsumsi (qty berkurang, avg tetap). Bisa juga disesuaikan langsung ke hasil hitung fisik lewat Stock Opname (lihat submodule di bawah) — `avg_cost` gak berubah, cuma `qty_on_hand`.
- **Weighted Average** — 1 angka rata-rata berjalan per item, dihitung ulang **tiap ada penerimaan baru**: `new_avg = (qty_before × avg_before + qty_in × unit_cost_in) / (qty_before + qty_in)`. Konsumsi cuma kurangin qty, avg_cost gak berubah sampai penerimaan berikutnya.
- **FIFO sudah dihapus total dari sistem** (migration `0038_remove_fifo_costing.sql`). Dulu ada 2 metode, ditentukan per item (misal Tepung Terigu FIFO karena harganya sering naik-turun dan presisi per-batch penting, Gula Pasir Weighted Average). Sekarang Weighted Average dipakai semua item, termasuk yang harganya fluktuatif — rata-rata berjalan tetap merefleksikan perubahan harga (naik/turun langsung kebawa ke `avg_cost` pas penerimaan baru), cuma gak sepresisi FIFO di level per-batch. Trade-off yang diterima sengaja: struktur data lebih sederhana (1 baris per item, bukan berlapis-lapis lot), cukup buat skala bisnis ini. `inventory_lots`/`inventory_lot_consumptions`/`items.costing_method`/`consume_fifo()` semuanya di-drop total di migration ini.

**Constraints**
- Pembelian bahan baku selalu ke Persediaan (aset), gak pernah langsung Beban.
- Metode costing Weighted Average berlaku semua item tanpa kecuali — gak ada lagi kolom/pilihan metode per item sejak FIFO dihapus.
- Konsumsi/pengurangan qty gak boleh melebihi yang tersedia (anti over-consumption, pola sama anti-over-allocation AR/AP) — dijaga fungsi generik terpusat `consume_weighted_average`, dipakai dari 2 arah (input produksi & sales issue), satu-satunya tempat logika konsumsi stok ditulis biar gak duplikat.
- Semua pergerakan stok tertelusur ke dokumen sumber (PO+Bill buat masuk, Invoice buat keluar, BOM buat produksi).

## Purchase Order & Penerimaan Barang (3-Way Matching)

**Entitas & Jurnal**
- **Purchase Order (PO)** — komitmen pesan ke supplier (item, qty, harga disepakati). **Gak bikin jurnal** — belum kejadian akuntansi.
- **Goods Receipt Note (GRN)** — bukti terima fisik (qty & harga riil, bisa beda dari PO). Dicocokkan ke `purchase_order_lines` (qty diterima gak boleh melebihi qty dipesan). GRN inilah yang nambah Persediaan (update avg cost, formula weighted-average-receive).
- **Bill (AP)** — tagihan dari supplier. GRN & Bill dibuat **bersamaan** (asumsi proses pembelian informal, nota = bukti kirim + tagihan sekaligus) — menghindari kompleksitas akun perantara "Barang Diterima Belum Ditagih" (GR/IR clearing) yang dibutuhkan kalau GRN dan Bill terjadi di waktu berbeda. Belum ada tekanan nyata buat item ini — dibangun kalau nanti proses pembeliannya butuh jeda waktu.
- Jurnal (via `create_ap_bill`, reuse, 0 perubahan): Debit Persediaan, Kredit Utang Usaha.

**Constraints**
- Goods Receipt gak boleh melebihi qty yang dipesan di PO line-nya (anti over-receipt).
- Pembelian bahan baku selalu ke Persediaan (aset), gak pernah langsung ke Beban.

**Common Mistakes**
- Mencatat pembelian bahan baku sebagai Beban/HPP langsung.
- PO dianggap bikin jurnal (harusnya GRN+Bill yang bikin).

## Produksi (Bill of Materials & Production Order)

**Entitas & Jurnal**
- **BOM (Bill of Materials)** — resep: 1 finished item ← beberapa raw material item + qty per batch. Master data mutable (boleh direvisi kapan saja) — aman karena `production_orders`/`production_order_lines` **snapshot** qty & biaya aktual pas produksi terjadi, gak look-up ulang ke `bom_lines` di kemudian hari.
- **Production Order** = kejadian produksi beneran: konsumsi bahan baku (sesuai resep × jumlah batch, dihitung pakai Weighted Average via `consume_weighted_average`), hasilkan barang jadi senilai total biaya bahan yang dikonsumsi. **Masih tukar aset ke aset** (Persediaan Bahan Baku → Persediaan Barang Jadi) — bukan HPP.
- Jurnal: Debit Persediaan Barang Jadi, Kredit Persediaan Bahan Baku.
- Scope saat ini: biaya produksi cuma dari bahan baku, belum termasuk tenaga kerja/overhead pabrik — komponen HPP yang sebenarnya wajib masuk secara *full absorption costing*, tapi butuh mekanisme alokasi terpisah, belum dibangun.

**Constraints**
- Konsumsi bahan baku gak boleh melebihi stok tersedia (`consume_weighted_average` raise exception).
- Revisi resep gak retroaktif ke histori produksi yang sudah terjadi.

**Common Mistakes**
- Produksi dianggap HPP (masih tukar aset, HPP baru pas barang jadi terjual).

## Penjualan & Pengakuan HPP (Goods Issue)

**Entitas & Jurnal**
- **Goods Issue** — barang jadi keluar gudang karena terjual → dua jurnal bersamaan:
  ```
  Debit Piutang/Kas [harga jual]     | Kredit Pendapatan [harga jual]
  Debit HPP [biaya pokok]            | Kredit Persediaan Barang Jadi [biaya pokok]
  ```
  Biaya pokok dihitung dari Weighted Average (qty × avg_cost saat itu, via `consume_weighted_average`) — titik ini HPP benar-benar diakui.
- Dibuat **bersamaan** dengan invoice penjualan (`create_ar_invoice`, reuse, 0 perubahan) — sama pola GRN+Bill di sisi beli.
- **Sales Order belum ada** — 3-way matching cuma ada di sisi procurement (PO→GRN→Bill). Sisi jual cuma 2 dokumen: invoice + Goods Issue, langsung dibuat bersamaan tanpa tahap komitmen terpisah. Belum ada tekanan nyata buat ini sekarang.
- **Catatan lintas modul (retur):** kalau barang yang terjual lewat Goods Issue ini diretur (`ar_credit_notes` jalur full), barang balik masuk lagi nambah `inventory_balances` (pool tunggal, gak ada segregasi lot retur sejak FIFO dihapus — sebelum migration `0038`, item FIFO masih tersegregasi lewat lot `SALES_RETURN` biar barang rusak yang balik gak ketuker dipakai lagi buat penukaran garansi). Segregasi ini balik lagi secara logis sejak migration `0015`: tiap baris retur diklasifikasi `condition` (`RESALABLE`/`DAMAGED`), baris `DAMAGED` gak pernah nambah `inventory_balances` — cost-nya diakui `Beban Kerugian Barang Rusak` bukan ditambahkan balik jadi stok bernilai.

**Constraints**
- Pengurangan qty (Weighted Average) gak boleh melebihi yang tersedia (anti over-consumption, sama mekanisme submodule Produksi).
- Goods Issue tertelusur ke invoice yang dibuat bersamaan.

**Common Mistakes**
- HPP dihitung dari kapan utang dibayar (harusnya dari kapan barang terjual) — dua hal yang gak berhubungan sama sekali.

## Satuan Jual & Harga (Multi Unit of Measure)

**Entitas & Jurnal**
- **item_units** (migration `0019_item_units_schema.sql`) — gantiin `items.default_price` (migration `0018`, di-drop di migration ini, data dimigrasi). 1 baris = 1 satuan jual per item: `unit_label` (teks, mis. "buah"/"lusin"), `conversion_factor` (numeric, berapa satuan dasar = 1 satuan jual ini), `price` (nullable), `is_base` (boolean, persis 1 baris TRUE per item, wajib `conversion_factor=1`, labelnya harus sama dengan `items.uom` — dijaga sebagai konvensi input, bukan trigger, pola sama pemilihan akun debit manual di AP). Item boleh 0 baris (gak dijual langsung) sampai berapa pun baris (1 base + N satuan tambahan).
- **Murni data referensi** — gak ada jurnal, gak ada RPC finansial baru. **0 perubahan ke `create_goods_issue`/`goods_issue_lines`** — RPC ini TETAP nerima qty di satuan dasar persis kayak sebelumnya. Konversi "N satuan jual → qty satuan dasar" dan hitung "N × price satuan jual" terjadi **di UI**, sebelum manggil RPC — bukan di server, biar kontrak RPC/tabel transaksional gak berubah sama sekali (invariant traceability tetap `goods_issue_lines` sumber kebenaran tunggal).
- CRUD `item_units` langsung lewat tabel (RLS-protected), bukan RPC — pola sama `items`/`bom_lines` (master data mutable, insert/update/delete bebas, beda dari tabel transaksional immutable).
- Cuma relevan buat jalur full (ada `goods_issue_lines`) — invoice financial-only gak pernah nyentuh `item_units` sama sekali, karena gak ada referensi item di situ.

**Constraints**
- Persis 1 baris `is_base=true` per item, `conversion_factor` wajib 1 buat baris itu (`check ((is_base and conversion_factor = 1) or not is_base)`).
- `unique(item_id, unit_label)` — gak boleh 2 satuan jual sama nama dalam 1 item.
- Partial unique index `item_id where is_base` — jaga maksimal 1 baris base per item.

**Skenario referensi**
- Item dijual pakai satuan bukan-dasar (misal lusin, faktor 12) — UI konversi qty ke satuan dasar SEBELUM manggil `create_goods_issue`, harga pakai `item_units.price` satuan itu (independen, boleh beda dari price satuan dasar × faktor — biasanya ada diskon grosir).

**Common Mistakes**
- Ngirim qty satuan JUAL (bukan satuan dasar) langsung ke `create_goods_issue` tanpa konversi — stok/HPP keitung salah total (kurang dari yang seharusnya, sebesar faktor konversi).
- Nganggep harga satuan jual = harga satuan dasar × faktor konversi secara otomatis — harusnya independen, diskon grosir itu keputusan bisnis manual per satuan.

## Stock Opname (Penyesuaian Stok Fisik)

**Entitas & Jurnal**
- **stock_opnames** (migration `0020_stock_opname_schema.sql`) — header 1 sesi hitung fisik: `opname_date`, `source_ref` (nomor berita acara opname — dokumen sumbernya sendiri, beda dari fitur lain yang selalu nunjuk ke transaksi lain). **Gak ada `journal_entry_id` di header** — jurnalnya per-baris, karena tiap item bisa beda arah (debit/kredit) dan beda akun Persediaan (Bahan Baku vs Barang Jadi).
- **stock_opname_lines** — 1 baris = 1 item yang ADA selisihnya (item yang hasil hitungnya pas gak menghasilkan baris sama sekali, `check (qty_actual <> qty_system)`). Kolom: `qty_system` (snapshot `qty_on_hand` sebelum disesuaikan), `qty_actual` (hasil hitung fisik), `unit_cost` (snapshot `avg_cost` saat opname), `journal_entry_id` (jurnal sendiri per baris).
- RPC `record_stock_opname(p_opname_date, p_source_ref, p_lines, p_shortage_expense_account_id, p_surplus_revenue_account_id)` — `p_lines`: array of `{item_id, qty_actual, inventory_account_id}`. Per baris: `variance = qty_actual - qty_system` (dibaca dari `inventory_balances` saat itu). `variance = 0` → skip (gak insert apa pun). `variance < 0` (kurang) → `Debit p_shortage_expense_account_id / Kredit inventory_account_id` (per baris, item itu sendiri). `variance > 0` (lebih) → `Debit inventory_account_id / Kredit p_surplus_revenue_account_id`. Abis jurnal, `update inventory_balances set qty_on_hand = qty_actual` (avg_cost gak disentuh). Kalau SEMUA baris di `p_lines` ternyata `variance = 0`, `raise exception` (gak ada yang perlu dicatat) — transaksi di-rollback total termasuk insert header, konsisten pola "no partial write".
- **`inventory_account_id` per baris (bukan 1 param buat seluruh sesi)** — beda dari pola `create_purchase_writeoff` (1 `p_inventory_account_id` buat seluruh panggilan) karena 1 sesi opname bisa mencakup item lintas kategori (Bahan Baku DAN Barang Jadi) sekaligus dalam 1 hari hitung.
- **2 akun baru** (seed migration `0021_seed_stock_opname_accounts.sql`): `Beban Selisih Persediaan` (expense) dan `Pendapatan Selisih Persediaan` (revenue) — sengaja **2 akun terpisah**, bukan 1 akun netting, biar laporan tetap nunjukin rincian per item (keputusan bisnis, dibahas eksplisit — alternatif 1-akun-netting ditolak karena kehilangan rincian per barang).

**Constraints**
- `qty_actual >= 0`, `qty_system >= 0`, `unit_cost >= 0`.
- `check (qty_actual <> qty_system)` — gak ada baris buat item yang gak ada selisihnya.
- Reuse trigger block-retroactive-period (`create_journal_entry`) — opname ke periode tertutup ditolak otomatis, gak ada constraint baru.
- Immutable (`stock_opnames`/`stock_opname_lines` reuse `block_edit_delete`) — beda dari `items`/`item_units` yang mutable, karena ini tabel transaksional (ada `journal_entry_id`).

**Skenario referensi**
- 1 sesi opname, banyak item — sebagian selisih kurang (Debit Beban Selisih Persediaan), sebagian selisih lebih (Kredit Pendapatan Selisih Persediaan), sebagian pas (gak ada baris/jurnal) — masing-masing independen, gak di-netting.

**Common Mistakes**
- Netting semua selisih 1 sesi jadi 1 angka sebelum dijurnal — harusnya per item, per baris, ke akun yang sesuai arahnya.
- Pakai harga historis (harga pas item itu pertama masuk) buat nilai selisih — harusnya `avg_cost` yang berlaku SAAT opname (`unit_cost` di-snapshot dari situ).
- Coba catat opname lewat RPC transaksi lain (retur/write-off/goods issue) — opname gak punya lawan transaksi (customer/supplier) sama sekali, butuh RPC sendiri.

## Glossary

- **Item**: master data barang (raw material atau finished good), costing-nya Weighted Average.
- **BOM (Bill of Materials)**: resep — daftar bahan baku & qty yang dibutuhkan buat 1 batch produksi.
- **Purchase Order (PO)**: pesanan ke supplier, belum kejadian akuntansi.
- **Goods Receipt Note (GRN)**: bukti penerimaan fisik barang, dasar penambahan Persediaan.
- **Goods Issue**: bukti pengeluaran fisik barang jadi karena terjual, dasar pengakuan HPP.
- **HPP / COGS**: Harga Pokok Penjualan — biaya pokok barang yang terjual, diakui bersamaan dengan pendapatannya.
- **`consume_weighted_average()`**: fungsi generik terpusat, satu-satunya jalur konsumsi stok — dipakai baik input produksi maupun sales issue.
- **item_units**: satuan jual per item (bisa lebih dari 1, misal buah & lusin), tiap baris punya faktor konversi ke satuan dasar + harga sendiri. Konversi qty ke satuan dasar terjadi di UI, bukan di RPC.
- **Stock Opname**: penyesuaian `inventory_balances.qty_on_hand` ke hasil hitung fisik gudang — gak menempel ke 1 transaksi tertentu (beda dari retur/write-off), dokumen sumbernya sesi hitung fisik itu sendiri. Selisih kurang → Beban Selisih Persediaan, selisih lebih → Pendapatan Selisih Persediaan (2 akun terpisah, gak di-netting).
