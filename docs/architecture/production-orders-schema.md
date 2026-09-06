# Production Order — Struktur Data

Kejadian produksi beneran — menjalankan resep dari `docs/architecture/bom-schema.md`: mengonsumsi bahan baku sesuai takaran, menghasilkan barang jadi, dan mencatat jurnal transfer aset sekaligus. Konsep bisnisnya ada di `docs/domain/inventory.md` bagian "Produksi (Bill of Materials & Production Order)". Detail teknis: `memory/architecture/data/production-orders-schema.md`.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `production_orders` | Header 1 kejadian produksi — resep yang dipakai, qty yang diproduksi, tanggal, jurnal yang otomatis dibuat | `bom_headers`, `items` (barang jadi), transaksi jurnal |
| `production_order_lines` | Baris konsumsi — tiap bahan baku yang dipakai, qty & biaya aktual (salinan/snapshot, bukan lookup ulang ke resep) | `production_orders`, `items` (bahan baku), `inventory_balances` |

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `production_orders` | Header 1 kejadian produksi | `bom_headers`, `items` (barang jadi), transaksi jurnal |
| `production_order_lines` | Baris konsumsi bahan baku, snapshot qty & biaya aktual | `production_orders`, `items` (bahan baku), `inventory_balances` |

**Struktur (kolom yang penting buat dipahami)**

| Kolom | Isinya | Catatan |
|---|---|---|
| `bom_header_id` | Resep yang dijalankan | |
| `item_id` | Barang jadi hasil produksi | Ditambah belakangan (di-backfill dari `bom_headers.finished_item_id`) supaya kaitan ke `inventory_movements` (`inventory-ledger-schema.md`) bisa dijamin langsung oleh database, seragam kayak sumber mutasi lain, gak butuh trigger validasi terpisah |
| `qty_produced` | Qty barang jadi yang mau diproduksi | Dipakai hitung `batch_multiplier = qty_produced / output_qty` — menentukan berapa kali lipat takaran resep yang dikonsumsi |
| `journal_entry_id` | Jurnal transfer aset (wajib ada) | Debit Persediaan Barang Jadi, Kredit Persediaan Bahan Baku, di level akun kontrol — bukan per-item |
| `production_order_lines.qty_consumed` / `total_cost` | Snapshot bahan baku yang benar-benar dikonsumsi & biayanya | Dihitung dari harga rata-rata berjalan (Weighted Average) SAAT produksi terjadi — gak lookup ulang ke `bom_lines` di kemudian hari |

Kedua tabel immutable — sekali tercatat gak bisa diedit/dihapus, koreksi lewat pencatatan produksi baru.

**Catatan scope biaya**: `production_order_lines` saat ini cuma menghitung dari bahan baku yang dikonsumsi — belum ada alokasi biaya tenaga kerja langsung atau overhead pabrik, walau secara prinsip *full absorption costing* keduanya wajib ikut masuk HPP. Butuh mekanisme alokasi terpisah yang belum dibangun.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Jalankan produksi | `create_production_order` | Ambil `bom_lines` dari resep, hitung `batch_multiplier`, konsumsi tiap bahan baku dari saldo rata-rata (lihat `inventory-ledger-schema.md`), catat jurnal Debit Persediaan Barang Jadi / Kredit Persediaan Bahan Baku sebesar total biaya bahan yang dikonsumsi, tambah stok barang jadi hasil produksi ke saldo, dan catat baris histori Kartu Stok (1 baris masuk barang jadi + N baris keluar tiap bahan baku yang dikonsumsi) | Menolak konsumsi bahan baku yang melebihi stok tersedia |

**Aturan Bisnis → RPC**

| Aturan (dari `docs/domain`) | Dijaga oleh |
|---|---|
| Konsumsi bahan baku tidak boleh melebihi stok yang tersedia | Fungsi konsumsi rata-rata bersama (`inventory-ledger-schema.md`) — dipakai juga oleh Goods Issue biar logika gak duplikat |
| Tiap produksi tertelusur ke resep yang dipakai, dan menyimpan salinan angka bahan baku & biaya yang benar-benar dipakai saat itu | `production_order_lines` snapshot `qty_consumed`/`total_cost` sendiri, bukan mengacu ulang ke `bom_lines` |
| Biaya produksi saat ini cuma mencakup biaya bahan baku (belum tenaga kerja/overhead pabrik) | `create_production_order` cuma menjumlahkan hasil konsumsi bahan baku — belum ada input biaya lain |
| Transaksi produksi tidak boleh diedit/dihapus setelah tercatat | Trigger `block_edit_delete` di kedua tabel |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `production_orders` | banyak-ke-satu | `bom_headers` |
| `production_order_lines` | banyak-ke-satu | `production_orders` |
| `production_order_lines` | tiap baris mengonsumsi dari | `inventory_balances` (bahan baku) — lihat `inventory-ledger-schema.md` |
| `production_orders` | menambah ke | `inventory_balances` (barang jadi) |
| `production_orders` / `production_order_lines` | tiap baris memicu baris baru di | `inventory_movements` (Kartu Stok) — lihat `inventory-ledger-schema.md` |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat data produksi | Semua user yang sudah login |
| Menjalankan produksi | Role `admin` atau `accountant` |
| Mengedit/menghapus produksi yang sudah tercatat | **Tidak ada seorang pun** |
