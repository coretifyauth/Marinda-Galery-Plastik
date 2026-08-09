# Inventory & COGS — AI Context

Inventory melacak barang fisik (qty + harga per satuan) dari diterima → diproses jadi barang jadi → terjual, supaya HPP (Harga Pokok Penjualan / COGS) bisa dihitung akurat. **Prinsip inti: membeli bahan baku BUKAN biaya** — itu tukar aset (Kas/Utang → Persediaan). HPP baru diakui pas barang jadi **terjual** (matching principle), gak peduli kapan utang ke supplier dibayar.

Naratif lengkap + reasoning penuh: `docs/domain/inventory.md`. Struktur module → submodule di file ini SAMA urutannya dengan padanan naratif itu dan dengan `memory/architecture/data/inventory-schema.md` (lihat `AGENTS.md` > "Format Baku: Struktur Module → Submodule").

## Konsep Inti

**Entitas & Alur Nilai**
```
Beli bahan baku (aset naik) → Produksi (pindah aset: Bahan Baku → Barang Jadi) → Terjual (HPP muncul, dicocokkan ke Pendapatan)
```
Cuma tahap terakhir yang menyentuh Laporan Laba Rugi.

- **item** — master data barang (`RAW_MATERIAL`/`FINISHED_GOOD`). Costing-nya sama buat semua: Weighted Average.
- **inventory_balances** — satu-satunya state costing tersimpan (bukan derived) di seluruh modul, PK = `item_id` (maks 1 baris per item). Nyimpen `qty_on_hand` + `avg_cost`, di-update tiap ada penerimaan baru (avg berubah) atau konsumsi (qty berkurang, avg tetap).
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
- **Catatan lintas modul (retur, `kerugian-barang-rusak`):** kalau barang yang terjual lewat Goods Issue ini diretur (`ar_credit_notes` jalur full), barang balik masuk lagi nambah `inventory_balances` (pool tunggal, gak ada segregasi lot retur sejak FIFO dihapus — sebelum migration `0038`, item FIFO masih tersegregasi lewat lot `SALES_RETURN` biar barang rusak yang balik gak ketuker dipakai lagi buat penukaran garansi). Barang yang balik ini masuk lagi sebagai stok bernilai seolah layak jual, padahal kalau alasannya rusak harusnya diakui Beban Kerugian Barang Rusak (write-off), bukan ditambahkan balik jadi stok bernilai — **catatan terbuka, ref `memory/scope-debt/kerugian-barang-rusak.md`** (lintas modul AR/AP, ditunda karena belum ada kejadian ini di cerita bisnis manapun).

**Constraints**
- Pengurangan qty (Weighted Average) gak boleh melebihi yang tersedia (anti over-consumption, sama mekanisme submodule Produksi).
- Goods Issue tertelusur ke invoice yang dibuat bersamaan.

**Common Mistakes**
- HPP dihitung dari kapan utang dibayar (harusnya dari kapan barang terjual) — dua hal yang gak berhubungan sama sekali.

## Glossary

- **Item**: master data barang (raw material atau finished good), costing-nya Weighted Average.
- **BOM (Bill of Materials)**: resep — daftar bahan baku & qty yang dibutuhkan buat 1 batch produksi.
- **Purchase Order (PO)**: pesanan ke supplier, belum kejadian akuntansi.
- **Goods Receipt Note (GRN)**: bukti penerimaan fisik barang, dasar penambahan Persediaan.
- **Goods Issue**: bukti pengeluaran fisik barang jadi karena terjual, dasar pengakuan HPP.
- **HPP / COGS**: Harga Pokok Penjualan — biaya pokok barang yang terjual, diakui bersamaan dengan pendapatannya.
- **`consume_weighted_average()`**: fungsi generik terpusat, satu-satunya jalur konsumsi stok — dipakai baik input produksi maupun sales issue.
