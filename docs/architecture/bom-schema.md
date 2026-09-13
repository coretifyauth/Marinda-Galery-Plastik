# Bill of Materials — Struktur Data

Resep produksi: barang jadi apa yang dihasilkan, dari bahan baku apa saja, dan berapa takarannya per 1 batch. Konsep bisnisnya ada di `docs/domain/inventory.md` bagian "Produksi (Bill of Materials & Production Order)" — file ini fokus ke bagaimana datanya disimpan. Kejadian produksi nyata yang menjalankan resep ini ada di `docs/architecture/production-orders-schema.md`. Detail teknis (SQL, nama fungsi persis): `supabase/migrations/0010_bom_schema.sql`.

> **Migration final (2026-09-07):** `supabase/migrations/0010_bom_schema.sql` -- konsolidasi dari migration incremental lama (0001-0084, sudah dihapus). Nomor migration `00XX` yang disebut di seluruh dokumen ini HISTORIS (isinya tetap akurat sebagai catatan evolusi keputusan, lihat `git log` kalau perlu baca file aslinya) -- SQL final yang AKTIF di database sekarang ada di file yang disebut di atas.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `bom_headers` | Header resep — barang jadi yang dihasilkan, qty output per 1 batch, aktif/tidak | `items` (barang jadi), dipakai `production_orders` |
| `bom_lines` | Baris resep — tiap bahan baku yang dibutuhkan & takarannya per batch | `bom_headers`, `items` (bahan baku) |

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `bom_headers` | Header resep — barang jadi yang dihasilkan, qty output per 1 batch, aktif/tidak | `items` (barang jadi) |
| `bom_lines` | Baris resep — tiap bahan baku yang dibutuhkan & takarannya per batch | `bom_headers`, `items` (bahan baku) |

**Struktur (kolom yang penting buat dipahami)**

| Kolom | Isinya | Catatan |
|---|---|---|
| `bom_headers.finished_item_id` | Barang jadi yang dihasilkan resep ini | |
| `bom_headers.output_qty` | Qty barang jadi yang dihasilkan per 1 batch resep | Dipakai `production_orders` buat hitung `batch_multiplier = qty_produced / output_qty` |
| `bom_headers.is_active` | Resep masih dipakai atau sudah pensiun | Nonaktifin resep lama cukup update kolom ini, gak perlu hapus baris — resep lama tetap bisa dilihat buat riwayat |
| `bom_lines.raw_material_item_id` | Bahan baku yang dikonsumsi | |
| `bom_lines.qty_per_batch` | Takaran bahan baku itu per 1 batch resep | |
| `bom_headers.created_by`, `bom_lines.created_at`/`created_by` | Email pembuat baris (snapshot, bukan FK) + kapan | `created_by` nullable, `NULL` = data lama/insert di luar jalur aplikasi. Konvensi sama dipakai `items`/`counterparties`/`accounts`, lihat `items-schema.md` |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Tambah/ubah resep (header) | — (insert/update langsung ke `bom_headers`, bukan financial write jadi gak lewat RPC) | Insert baris baru atau update kolom yang ada | RLS `insert`/`update` cuma role `admin` |
| Ubah komposisi resep (ganti/tambah bahan) | — (delete + insert langsung ke `bom_lines`) | Baris lama dihapus, baris baru ditambah — bebas diubah kapan saja | RLS `delete` cuma ada di `bom_lines` (beda dari hampir semua tabel transaksional lain di modul Inventory yang immutable) |
| Nonaktifkan resep lama | — (update `is_active`) | Resep gak dipakai buat produksi baru lagi; histori produksi yang sudah pakai resep ini gak berubah sama sekali | — |

**Aturan Bisnis → RPC**

| Aturan (dari `docs/domain`) | Dijaga oleh |
|---|---|
| Resep boleh direvisi kapan saja tanpa mengubah histori produksi yang sudah terjadi | `production_order_lines` (`production-orders-schema.md`) menyimpan salinan (snapshot) qty & biaya aktual sendiri — gak lookup ulang ke `bom_lines` tiap kali dibaca |
| BOM adalah master data mutable, bukan transaksional immutable | `bom_headers`/`bom_lines` gak dipasangi trigger `block_edit_delete` — beda dari hampir semua tabel lain di modul Inventory yang sekali tercatat gak bisa diubah |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `bom_lines` | banyak-ke-satu | `bom_headers` |
| `bom_headers.finished_item_id` | banyak-ke-satu | `items` |
| `bom_lines.raw_material_item_id` | banyak-ke-satu | `items` |
| `production_orders.bom_header_id` (`production-orders-schema.md`) | banyak-ke-satu | `bom_headers` |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat resep (termasuk yang sudah nonaktif) | Semua user yang sudah login |
| Menambah/mengubah header resep (`bom_headers`) | Role `admin` |
| Menambah/mengubah/menghapus baris resep (`bom_lines`) | Role `admin` |
