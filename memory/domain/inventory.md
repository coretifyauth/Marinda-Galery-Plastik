# Inventory & COGS — AI Context

Inventory melacak barang fisik (qty + harga per satuan) dari diterima → diproses jadi barang jadi → terjual, supaya HPP (Harga Pokok Penjualan / COGS) bisa dihitung akurat. **Prinsip inti: membeli bahan baku BUKAN biaya** — itu tukar aset (Kas/Utang → Persediaan). HPP baru diakui pas barang jadi **terjual** (matching principle), gak peduli kapan utang ke supplier dibayar.

Naratif lengkap + reasoning penuh: `docs/domain/inventory.md`. Struktur module → submodule di file ini SAMA urutannya dengan padanan naratif itu dan dengan `memory/architecture/data/inventory-schema.md` (lihat `AGENTS.md` > "Format Baku: Struktur Module → Submodule").

## Konsep Inti

**Entitas & Alur Nilai**
```
Beli bahan baku (aset naik) → Produksi (pindah aset: Bahan Baku → Barang Jadi) → Terjual (HPP muncul, dicocokkan ke Pendapatan)
```
Cuma tahap terakhir yang menyentuh Laporan Laba Rugi.

- **item** — master data barang (`RAW_MATERIAL`/`FINISHED_GOOD`). Costing-nya sama buat semua: Weighted Average. `uom` cuma 1 kolom teks, murni tampilan, gak ada konversi antar-satuan — ini tetap **1 satuan dasar** dipakai buat semua pelacakan stok/biaya (PO/GRN/BOM/production/goods issue). Satuan JUAL ke customer boleh beda (lihat submodule "Satuan Jual & Harga" di bawah). **`item_type` cuma nentuin peran di BOM** (`FINISHED_GOOD` = boleh jadi output resep, `RAW_MATERIAL` = boleh jadi bahan resep) — **bukan** izin beli/jual. Sales Order & Goods Issue boleh jual item tipe APA PUN (revisi 2026-08-12 — sebelumnya salah dibatasi cuma `FINISHED_GOOD`, ketauan gak konsisten sama data cerita sendiri: Piring Plastik dijual langsung SEKALIGUS jadi bahan BOM "Paket Alat Makan", dua peran yang gak mungkin dipenuhi kalau `item_type` juga dipakai buat gerbang jual-beli). Purchase Order masih dibatesin `RAW_MATERIAL` doang — belum diubah, beda kasus, belum ada bukti kebutuhan konkret.
- **inventory_balances** — satu-satunya state costing tersimpan (bukan derived) di seluruh modul, PK = `item_id` (maks 1 baris per item). Nyimpen `qty_on_hand` + `avg_cost`, di-update tiap ada penerimaan baru (avg berubah) atau konsumsi (qty berkurang, avg tetap). Bisa juga disesuaikan langsung ke hasil hitung fisik lewat Stock Opname (lihat submodule di bawah) — `avg_cost` gak berubah, cuma `qty_on_hand`. Cuma nyimpen saldo AKHIR, bukan riwayat — kartu stok/riwayat mutasi per item (klik item di `/inventory` -> lihat histori kronologis) dibangun lewat `inventory_movements`, lihat submodule "Kartu Stok / Riwayat Mutasi per Item" di bawah.
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
- PO bisa dibatalkan (`cancel_purchase_order`, migration `0024`) SELAMA belum ada GRN sama sekali — beda dari `cancel_ar_invoice`/`cancel_ap_bill` yang bikin reversing journal entry, PO emang gak pernah punya jurnal buat dibalik, jadi cancel di sini murni stempel status final. PO yang udah punya GRN gak bisa dibatalkan lagi (udah "kepakai" sebagai dasar transaksi lain).

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
- **Sales Order (opsional)** — tahap komitmen sebelum Goods Issue, lihat submodule "Sales Order & Pemenuhan Bertahap" di bawah. Jalur langsung (tanpa Sales Order) yang dijelaskan di atas tetap jalan apa adanya buat penjualan spontan (kios walk-in).
- **Catatan lintas modul (retur):** kalau barang yang terjual lewat Goods Issue ini diretur (`ar_credit_notes` jalur full), barang balik masuk lagi nambah `inventory_balances` (pool tunggal, gak ada segregasi lot retur sejak FIFO dihapus — sebelum migration `0038`, item FIFO masih tersegregasi lewat lot `SALES_RETURN` biar barang rusak yang balik gak ketuker dipakai lagi buat penukaran garansi). Segregasi ini balik lagi secara logis sejak migration `0015`: tiap baris retur diklasifikasi `condition` (`RESALABLE`/`DAMAGED`), baris `DAMAGED` gak pernah nambah `inventory_balances` — cost-nya diakui `Beban Kerugian Barang Rusak` bukan ditambahkan balik jadi stok bernilai.

**Constraints**
- Pengurangan qty (Weighted Average) gak boleh melebihi yang tersedia (anti over-consumption, sama mekanisme submodule Produksi).
- Goods Issue tertelusur ke invoice yang dibuat bersamaan.

**Common Mistakes**
- HPP dihitung dari kapan utang dibayar (harusnya dari kapan barang terjual) — dua hal yang gak berhubungan sama sekali.

## Sales Order & Pemenuhan Bertahap (migration `0024_sales_orders_schema.sql`)

**Entitas & Jurnal**
- **Sales Order (SO)** — cerminan Purchase Order di sisi jual: komitmen pesan dari customer (item, qty, harga disepakati). **Gak bikin jurnal** — belum kejadian akuntansi, sama alasannya kayak PO (belum ada barang pindah tangan, piutang belum boleh diakui — prinsip revenue recognition: kewajiban baru "terpenuhi" pas barang beneran dikirim).
- **Beda dari PO: SO bersifat OPSIONAL, bukan wajib.** `goods_issue_lines.so_line_id` nullable — jalur jual langsung tanpa SO (submodule "Penjualan & Pengakuan HPP" di atas) tetap jalan gak berubah. Alasan asimetri: pembelian selalu keputusan terencana (wajar dipaksa PO), tapi penjualan ada 2 pola sekaligus — spontan (kios walk-in, gak natural dipaksa bikin SO dulu) dan terencana (pesanan customer buat acara, qty gede, stok belum tentu cukup pas dipesan).
- **Pemenuhan (fulfillment) bisa dicicil, tiap cicilan = 1 Goods Issue + 1 invoice terpisah** — bukan nunggu SO lunas/`FULLY_FULFILLED` baru invoice terbit sekali. Piutang & Pendapatan diakui persis di titik barang dikirim, gak lebih cepat (itu yang mau dihindari — invoice full di depan sebelum barang jadi/dikirim = overstate piutang+pendapatan untuk bagian yang belum kepenuhi).
- `create_goods_issue` **signature TETAP SAMA** (0 breaking change) — `p_lines` sekarang boleh punya key opsional `so_line_id` per baris. Caller lama yang gak nyertain key ini tetap jalan (`so_line_id` NULL, gak kena trigger anti-over-issue).

**Constraints**
- Pengiriman (Goods Issue) yang nunjuk `so_line_id` gak boleh melebihi `qty_ordered` SO line-nya (trigger `goods_issue_lines_no_over_issue`, mirror `goods_receipt_lines_no_over_receipt` — skip kalau `so_line_id` null).
- SO immutable secara data (header/lines gak pernah bisa diedit) — koreksi isi pesanan tetap harus bikin SO baru. Tapi bisa **dibatalkan** (`cancel_sales_order`, migration `0024`) SELAMA belum ada Goods Issue sama sekali — mirror persis mekanisme cancel PO (submodule "Purchase Order & Penerimaan Barang"), murni stempel status, gak ada jurnal (SO emang gak pernah punya jurnal).

**Skenario referensi**
- Customer pesan qty gede buat acara, stok belum cukup saat dipesan → SO dibuat duluan (belum ada jurnal apa pun). Produksi nambah stok belakangan. Barang dikirim bertahap (2x pengiriman) → 2 invoice terpisah lahir, masing-masing dari `create_goods_issue` yang nunjuk `so_line_id` yang sama, sampai `SUM(qty_issued)` = `qty_ordered` (status SO jadi `FULLY_FULFILLED`, derived — bukan kolom).

**Common Mistakes**
- Mikir invoice harus nunggu SO terpenuhi penuh baru terbit — harusnya per pengiriman, bisa banyak invoice dari 1 SO.
- Nganggep SO wajib buat semua penjualan (niru pola PO di AP) — SO cuma dipakai kalau emang ada tahap komitmen-duluan; penjualan spontan tetap boleh lewat Goods Issue langsung tanpa SO.

## Kategori & Brand Barang (migration `0023_item_categories_brands.sql`)

**Entitas & Kolom**
- `item_categories`/`item_brands` — 2 tabel katalog independen, `{id, name, archived_at, created_at, updated_at}`. Pola SAMA PERSIS kayak `ar_invoice_charge_types`/`ap_bill_expense_categories`/`pos_charge_types` (katalog terkontrol, admin kelola sendiri) — bedanya cuma gak ada `account_id` (kategori/brand bukan konsep akuntansi, gak pernah dipetakan ke akun).
- `items.category_id`/`items.brand_id` — FK nullable ke masing-masing katalog. Independen satu sama lain, dan independen dari kolom `items` lain (gak ada validasi silang ke `item_type`, dst).
- Murni metadata deskriptif buat filter/pengelompokan pas katalog barang udah banyak — 0 RPC baru, 0 perubahan ke RPC transaksi manapun (PO/GRN/BOM/Production/Goods Issue/SO/Opname semua gak nyentuh kolom ini sama sekali).

**Constraints**
- `items.category_id`/`items.brand_id` nullable — barang boleh gak punya salah satu/keduanya.
- 1 barang → maksimal 1 kategori, 1 brand (FK tunggal, bukan tabel jembatan many-to-many).
- Menonaktifkan (`archived_at`) baris katalog gak mengubah/menghapus FK barang yang udah nunjuk ke situ — cuma gak muncul lagi di pilihan buat barang baru.

**Common Mistakes**
- Simpan kategori/brand sebagai kolom teks bebas di `items` — variasi penulisan ("Lion Star" vs "lion star") bikin filter/grouping meleset, harus lewat katalog terkontrol.
- Bikin tabel jembatan many-to-many buat "barang bisa multi-kategori" — scope sekarang cuma 1:1 per barang, cukup FK langsung.

## Satuan Jual & Harga (Multi Unit of Measure)

**Entitas & Jurnal**
- **item_units** (migration `0019_item_units_schema.sql`) — gantiin `items.default_price` (migration `0018`, di-drop di migration ini, data dimigrasi). 1 baris = 1 satuan (pcs/pack/box/lusin/dst) per item: `unit_label` (teks), `conversion_factor` (numeric, berapa satuan dasar = 1 satuan ini), `price` (nullable), `is_base` (boolean, persis 1 baris TRUE per item, wajib `conversion_factor=1`, labelnya harus sama dengan `items.uom` — dijaga sebagai konvensi input, bukan trigger, pola sama pemilihan akun debit manual di AP). Item boleh 0 baris (belum didefinisikan satuan tambahan) sampai berapa pun baris (1 base + N satuan tambahan).
- **Murni data referensi** — gak ada jurnal, gak ada RPC finansial baru. **0 perubahan ke RPC transaksi manapun** (`create_purchase_order`, `create_goods_receipt`, `create_sales_order`, `create_goods_issue`, `create_production_order`, `record_stock_opname`) — semua RPC ini TETAP nerima qty di satuan dasar persis kayak sebelum fitur ini ada. Konversi terjadi **di UI**, sebelum manggil RPC — bukan di server, biar kontrak RPC/tabel transaksional gak berubah sama sekali (invariant traceability tetap tabel transaksional sumber kebenaran tunggal).
- CRUD `item_units` langsung lewat tabel (RLS-protected), bukan RPC — pola sama `items`/`bom_lines` (master data mutable, insert/update/delete bebas, beda dari tabel transaksional immutable).
- **Input qty simultan multi-satuan (`MultiUomQtyInput`, komponen UI, bukan tabel baru)** — dipakai di form INTERNAL yang input qty per item di `/erp` (Production Order qty produksi, Stock Opname qty hasil hitung). User isi qty di beberapa satuan sekaligus dalam 1 baris (mis. 2 pcs + 2 pack + 0 box), komponen jumlahkan `Σ(qty_input × conversion_factor)` jadi 1 angka satuan dasar sebelum dikirim ke RPC. Item yang belum punya baris `is_base` di `item_units` tetap dapat 1 kolom input (satuan dasar sintetis di sisi UI, bukan insert ke tabel) — gak ada cabang UI terpisah buat item yang belum lengkap datanya.
- **Pilih 1 UOM berharga + qty (`UomPriceQtyInput`, komponen UI, revisi 2026-08-14)** — dipakai di form SISI JUAL (Sales Order, Goods Issue), gantiin `MultiUomQtyInput` yang tadinya juga dipasang di 2 form ini. Ketauan konflik dari feedback pemakaian nyata: sisi jual butuh pilih SATU satuan (yang punya `price`) lalu harga otomatis muncul dari `item_units.price` — bukan isi qty campur beberapa satuan sekaligus. Pola ini niru pemilih satuan yang dari awal sudah dipakai `apps/pos` (dropdown 1 satuan, harga auto). Konsekuensi: dropdown item di Sales Order/Goods Issue sekarang DIFILTER cuma nampilin item yang punya minimal 1 baris `item_units` berharga (`price != null`) — item tanpa harga jual gak bisa dipesan/diinvoice lewat form ini sama sekali (harus ditambahin harganya dulu di `/items/[id]`). Total pendapatan Goods Issue (`p_credit_lines[0].amount`) sekarang otomatis = `Σ(qty × item_units.price)` semua baris, ditampilkan read-only (bukan input manual + tombol "Saran" lagi). Sales Order `unit_price` per baris sekarang otomatis = `item_units.price / conversion_factor` (harga per satuan dasar), gak diketik manual lagi. **0 perubahan RPC/schema** — `create_goods_issue`/`create_sales_order` tetap terima qty & harga di satuan dasar persis seperti sebelumnya, konversi tetap terjadi di UI.
- **Pilih 1 UOM + qty + harga beli manual (`UnitCostQtyInput`, komponen UI, revisi 2026-08-14)** — dipakai di form SISI BELI (Purchase Order, Goods Receipt), gantiin `MultiUomQtyInput` yang tadinya dipasang di 2 form ini juga. Beda dari `UomPriceQtyInput`: harga TETAP diketik manual per baris (bukan auto), karena `item_units.price` itu harga JUAL ke customer — gak relevan sebagai harga beli dari supplier, dan gak ada "katalog harga beli" tersendiri di skema ini. Dropdown item **gak difilter** ke yang punya `item_units.price` (beda dari sisi jual) — bahan baku yang gak pernah dijual (gak pernah punya baris `item_units` berharga) tetap harus bisa dibeli. Dropdown satuan nampilin SEMUA satuan item itu (termasuk yang `price`-nya null), user pilih 1 satuan + isi qty + isi harga beli buat satuan itu. Konsekuensi: kalau 1 penerimaan barang fisik campuran kemasan (mis. 2 dus + 3 pcs) punya harga per-satuan yang beda (bukan cuma proporsional), sekarang butuh 2 baris terpisah (dulu bisa 1 baris lewat `MultiUomQtyInput`, tapi cuma nerima 1 harga rata buat seluruh campuran — gak presisi kalau memang ada harga grosir vs eceran dari supplier). Goods Receipt tetap prefill qty & harga dari sisa PO (`initialBaseQty`/`initialBaseCost`, default ke satuan dasar). **0 perubahan RPC/schema** — `create_purchase_order`/`create_goods_receipt` tetap terima qty & harga di satuan dasar seperti sebelumnya. `item_units` sendiri gak butuh kebijakan larangan hapus — gak ada tabel manapun yang FK ke `item_units.id` (dicek langsung ke seluruh `supabase/migrations/`), semua RPC transaksi cuma nerima angka satuan dasar hasil konversi UI, gak pernah nyimpen baris `item_units` mana yang dipakai — jadi hapus 1 baris `item_units` gak pernah bisa bikin data transaksi lama nyantol ke referensi mati.
- **Cakupan sekarang lintas beli & jual, bukan cuma "satuan jual"** — nama tabel & kolom tetap `item_units` (gak di-rename, breaking change ke skema gak sepadan buat perubahan UI murni), tapi secara pemakaian sekarang berfungsi sebagai satuan umum per item, dipakai baik di form pembelian (PO/GRN) maupun penjualan (SO/Goods Issue) maupun internal (Production/Opname). Implikasinya: bahan baku yang cuma pernah dibeli/diproduksi (gak pernah dijual) sekarang juga bisa punya manfaat dari `item_units` (mis. tepung dibeli per "sak" 25kg) — sebelumnya cuma gunanya buat barang jadi yang dijual customer.

**Constraints**
- Persis 1 baris `is_base=true` per item, `conversion_factor` wajib 1 buat baris itu (`check ((is_base and conversion_factor = 1) or not is_base)`).
- `unique(item_id, unit_label)` — gak boleh 2 satuan sama nama dalam 1 item.
- Partial unique index `item_id where is_base` — jaga maksimal 1 baris base per item.
- **`conversion_factor` antar satuan 1 item harus nested rapi** (tiap angka kelipatan bulat dari angka di bawahnya, mis. pcs=1/pack=12/box=144 — bukan box=100) — trigger `item_units_nested_conversion_guard` (migration `0025_item_units_nested_conversion_guard.sql`), dijaga di level DB (bukan cuma UI). Syarat ini yang bikin breakdown tampilan stok box/pack/pcs (`formatStockBreakdown()` di `apps/erp/src/lib/stock-display.ts` + `apps/pos/src/lib/stock-display.ts`, murni fitur tampilan — 0 tabel/RPC baru) presisi — tanpa nested, greedy breakdown bisa nyisain pecahan gak presisi.

**Skenario referensi**
- Item dijual pakai satuan bukan-dasar (misal lusin, faktor 12) di Sales Order/Goods Issue — user pilih satuan "lusin" di `UomPriceQtyInput`, harga otomatis muncul dari `item_units.price` baris itu (independen, boleh beda dari price satuan dasar × faktor — biasanya ada diskon grosir), UI konversi qty & harga ke satuan dasar SEBELUM manggil RPC.
- Item dengan 3 satuan (pcs, pack faktor 12, box faktor 144) diproduksi/di-opname — user isi 2 pcs + 2 pack + 0 box di 1 baris Production/Opname, `MultiUomQtyInput` jumlahkan jadi 26 (satuan dasar) sebelum dikirim ke RPC — pola ini KHUSUS internal, bukan jual/beli (lihat submodule di atas kenapa dipisah).
- Item dibeli dalam satuan "dus" (faktor 144) di Purchase Order — user pilih satuan "dus" di `UnitCostQtyInput`, isi qty & harga beli per dus MANUAL (item_units.price gak dipakai sama sekali di sini), UI konversi qty & harga ke satuan dasar SEBELUM manggil RPC. Kalau qty datang sebagian dus sebagian pcs lepas dengan harga beda, dipecah jadi 2 baris (1 baris per satuan yang dipakai).

**Common Mistakes**
- Ngirim qty satuan JUAL/BELI (bukan satuan dasar) langsung ke RPC transaksi manapun tanpa konversi — stok/HPP/qty pesan keitung salah total (kurang dari yang seharusnya, sebesar faktor konversi).
- Nganggep harga satuan jual = harga satuan dasar × faktor konversi secara otomatis — harusnya independen, diskon grosir itu keputusan bisnis manual per satuan (didefinisikan pas admin isi `item_units.price`, bukan lagi dihitung/diketik manual pas transaksi).
- Pasang `MultiUomQtyInput` (isi qty campur beberapa satuan sekaligus) di form sisi jual/beli — itu yang bikin konflik sama kebutuhan "pilih 1 satuan, harga jelas per baris" (ketauan dari feedback pemakaian nyata 2026-08-14), makanya Sales Order/Goods Issue pakai `UomPriceQtyInput` (harga auto) dan Purchase Order/Goods Receipt pakai `UnitCostQtyInput` (harga manual) sendiri-sendiri, beda dari form internal (Production/Opname) yang tetap `MultiUomQtyInput`.
- Nyoba auto-fill harga beli PO dari `item_units.price` — itu harga JUAL ke customer, sering jauh beda dari harga beli ke supplier (bahkan arahnya kebalik: markup vs cost). Gak ada referensi harga beli tersimpan di skema ini, jadi harga beli PO/GRN SELALU input manual.

## Kode Scan Barang (Barcode/QR per Satuan Jual, migration `0021_item_unit_barcode.sql` + `0022_item_unit_barcode_reuse_document_numbering.sql`)

**Entitas & Kolom**
- `item_units.barcode` (text, nullable, unique global lintas tabel) — kode scan per **satuan jual**, BUKAN per item. Alasan level satuan (bukan `items`): kemasan fisik beda (dus/pcs/pack) biasanya punya barcode/label fisik beda-beda di dunia nyata — kalau ditaruh di `items`, cuma bisa nyimpen 1 kode padahal item boleh >1 satuan jual (`item_units`, submodule sebelumnya).
- 2 sumber kode, diperlakukan **sama persis** dari sisi kolom (cuma string yang dicocokkan pas scan): **barcode pabrik** (scan langsung, disimpan apa adanya) atau **kode internal** (digenerate via `generate_document_number('item_unit_barcodes')` — REUSE fungsi document numbering yang sudah ada, format `SKU-2026-00001`, `doc_type` ini PENGECUALIAN gak punya tabel transaksional beneran, lihat `document-numbering-schema.md`). Format tahun-nya cuma soal gimana STRING kodenya dibentuk — kode yang udah jadi tetap permanen selamanya begitu ter-assign ke 1 baris `item_units`, gak pernah reassign/berubah, walau counter internal-nya reset tiap tahun buat kode BARU.
- **CRUD langsung lewat tabel** (update `item_units.barcode`), bukan RPC yang langsung nulis — `generate_document_number()` cuma ngembaliin teks kodenya, UI yang nyimpen ke baris lewat update biasa (pola sama edit `price`/`conversion_factor`, RLS `item_units_update` yang udah ada otomatis berlaku, gak perlu policy baru).
- Render QR + cetak label murni fitur UI client-side, lewat **window print terpisah** (`window.open()` + `window.print()`) — BUKAN `@media print` di halaman yang sama (native `<dialog>`/Modal gak konsisten diprint lintas browser, apalagi Firefox sering skip isi dialog pas print sama sekali). Gak ada penyimpanan gambar/asset di server, QR digenerate on-the-fly (data URI) dari teks `barcode` yang tersimpan.

**Constraints**
- `unique(barcode)` global (bukan per-item) — nullable, Postgres izinin banyak NULL (barang tanpa kode gak saling bentrok).
- Gak ada validasi format kode di level database maupun aplikasi — terima teks apa pun, termasuk hasil encode QR bebas format.
- Optional per baris `item_units`, independen — gak ada aturan "1 satuan punya kode maka semua satuan barang itu harus punya".

**Common Mistakes**
- Taruh kolom ini di `items` bukan `item_units` — item dengan >1 satuan jual cuma bisa nyimpen 1 kode, gak bisa bedain scan dus vs scan pcs.
- Mewajibkan format EAN-13/UPC ketat — nolak kode internal/QR yang emang dirancang bebas format.

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

## Kartu Stok / Riwayat Mutasi per Item (Inventory Movement Ledger)

Schema->API->UI selesai (migration `0042`-`0052` + halaman `/items/[id]` kartu stok) — bekas scope-debt `inventory-movement-ledger.md`, sudah ditutup.

**Cara Kerja**
- `/inventory` sekarang cuma nunjukin `inventory_balances.qty_on_hand`+`avg_cost` (saldo akhir) — gak ada riwayat gimana angka itu terbentuk. Ditutup lewat **tabel ledger terpusat baru `inventory_movements`** (keputusan arsitektur eksplisit, BUKAN view gabungan read-only — trade-off yang diterima sadar: baca riwayat lebih cepat & konsisten jangka panjang, ditukar biaya awal lebih besar karena harus ubah ±9-10 RPC + backfill data lama, lihat submodule "RPC & Backfill" di `memory/architecture/data/inventory-schema.md`).
- **`inventory_balances` TETAP satu-satunya sumber kebenaran qty/avg_cost real-time** — `inventory_movements` murni lapisan riwayat/audit trail di atasnya, gak pernah dipakai buat hitung ulang stok/HPP. Kalau `SUM(inventory_movements.qty)` per item gak cocok sama `inventory_balances.qty_on_hand`, `inventory_balances` yang dianggap benar (dicek lewat query rekonsiliasi pas backfill).
- 1 baris `inventory_movements` = 1 kejadian mutasi qty 1 item, `qty` bertanda (positif=masuk/negatif=keluar). **Saldo berjalan derived, bukan kolom tersimpan** — dibaca pakai pola opening-balance (agregat `SUM` sampai cutoff) + halaman (baris di halaman itu doang), mirror persis `report_account_ledger_opening_balance` (General Ledger, migration `0041`) — dipilih ketimbang window function polos atas seluruh riwayat karena tetap cepat walau riwayat 1 item udah panjang, dan ketimbang kolom tersimpan karena akurasi (gak ada risiko drift nilai tersimpan) jadi prioritas, bukan performa tulis.
- Tiap baris nunjuk balik ke SATU dari ±10 tabel sumber transaksi lain (lihat detail kolom di `memory/architecture/data/inventory-schema.md`) — traceability ke dokumen sumber asli.

**Aturan Bisnis**
- Kartu Stok gak pernah jadi sumber kebenaran baru buat qty/HPP — cuma cerminan transaksi yang udah tercatat di modul lain (`inventory_balances` tetap yang utama).
- Mencakup SEMUA jalur yang nyentuh `inventory_balances`, bukan cuma jalur inti — termasuk retur (AR & AP), write-off barang rusak, penggantian garansi, dan penyesuaian stock opname.

**Skenario**
- Saldo Tepung Terigu turun drastis tanpa penjelasan jelas — buka Kartu Stok barang itu, baris demi baris kelihatan: pembelian masuk, konsumsi produksi keluar, penyesuaian opname — penyebabnya ketahuan tanpa buka manual ke ±10 halaman transaksi berbeda.

**Common Mistakes**
- Menganggap `inventory_movements` jadi sumber kebenaran baru — `inventory_balances` tetap yang utama, ledger yang harus diperbaiki kalau ada selisih, bukan sebaliknya.

## Glossary

- **Item**: master data barang (raw material atau finished good), costing-nya Weighted Average.
- **BOM (Bill of Materials)**: resep — daftar bahan baku & qty yang dibutuhkan buat 1 batch produksi.
- **Purchase Order (PO)**: pesanan ke supplier, belum kejadian akuntansi.
- **Goods Receipt Note (GRN)**: bukti penerimaan fisik barang, dasar penambahan Persediaan.
- **Goods Issue**: bukti pengeluaran fisik barang jadi karena terjual, dasar pengakuan HPP.
- **HPP / COGS**: Harga Pokok Penjualan — biaya pokok barang yang terjual, diakui bersamaan dengan pendapatannya.
- **`consume_weighted_average()`**: fungsi generik terpusat, satu-satunya jalur konsumsi stok — dipakai baik input produksi maupun sales issue.
- **item_categories** / **item_brands**: katalog terkontrol opsional buat pengelompokan barang (`items.category_id`/`items.brand_id`, FK tunggal masing-masing) — murni metadata deskriptif, bukan konsep akuntansi.
- **item_units**: satuan jual per item (bisa lebih dari 1, misal buah & lusin), tiap baris punya faktor konversi ke satuan dasar + harga sendiri. Konversi qty ke satuan dasar terjadi di UI, bukan di RPC.
- **Kode Scan (barcode/QR)**: identitas unik opsional per satuan jual (`item_units.barcode`), dipakai kasir POS buat lookup cepat pas checkout — bisa barcode asli pabrik atau kode internal yang digenerate sistem (`generate_document_number('item_unit_barcodes')`, format `SKU-2026-00001`).
- **Stock Opname**: penyesuaian `inventory_balances.qty_on_hand` ke hasil hitung fisik gudang — gak menempel ke 1 transaksi tertentu (beda dari retur/write-off), dokumen sumbernya sesi hitung fisik itu sendiri. Selisih kurang → Beban Selisih Persediaan, selisih lebih → Pendapatan Selisih Persediaan (2 akun terpisah, gak di-netting).
- **Kartu Stok (Inventory Movement Ledger)**: riwayat mutasi kronologis per item (`inventory_movements`) — lapisan audit trail di atas `inventory_balances`, bukan sumber kebenaran baru. Saldo berjalan derived (opening-balance + halaman), bukan kolom tersimpan.
