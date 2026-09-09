# Stock Opname — Struktur Data

Penyesuaian stok berdasarkan hasil hitung fisik gudang — beda mendasar dari submodule Inventory lain: gak menempel ke 1 transaksi tertentu (retur/write-off selalu nunjuk balik ke dokumen sumbernya), dokumen sumbernya di sini justru sesi hitung fisik itu sendiri. Konsep bisnisnya ada di `docs/domain/inventory.md` bagian "Stock Opname (Penyesuaian Stok Fisik)". Detail teknis: `supabase/migrations/0012_stock_opname_schema.sql`.

> **Migration final (2026-09-07):** `supabase/migrations/0012_stock_opname_schema.sql` -- konsolidasi dari migration incremental lama (0001-0084, sudah dihapus). Nomor migration `00XX` yang disebut di seluruh dokumen ini HISTORIS (isinya tetap akurat sebagai catatan evolusi keputusan, lihat `git log` kalau perlu baca file aslinya) -- SQL final yang AKTIF di database sekarang ada di file yang disebut di atas.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `stock_opnames` | Header 1 sesi hitung fisik — tanggal opname, sumber dokumennya adalah sesi itu sendiri | `stock_opname_lines` |
| `stock_opname_lines` | 1 baris = 1 barang yang ADA selisihnya (barang yang hasil hitungnya pas gak menghasilkan baris apa pun) | `stock_opnames`, `items`, `inventory_balances`, transaksi jurnal (1 per baris) |

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `stock_opnames` | Header 1 sesi hitung fisik | `stock_opname_lines` |
| `stock_opname_lines` | 1 baris per barang yang ada selisihnya | `stock_opnames`, `items`, `inventory_balances`, transaksi jurnal |

**Struktur (kolom yang penting buat dipahami)**

| Kolom | Isinya | Catatan |
|---|---|---|
| `stock_opnames` | Gak punya `journal_entry_id` | Beda dari pola header lain di seluruh project ini (biasanya 1 header = 1 jurnal) — di sini jurnalnya per BARIS (`stock_opname_lines.journal_entry_id`), karena tiap item dalam 1 sesi bisa beda arah (debit/kredit tertukar tergantung kurang/lebih) DAN beda akun Persediaan (Bahan Baku vs Barang Jadi), gak bisa digabung jadi 1 jurnal |
| `qty_system` / `qty_actual` | Qty tercatat di sistem vs hasil hitung fisik | Wajib beda satu sama lain (check constraint) — barang yang hasil hitungnya pas gak pernah punya baris di sini sama sekali |
| `unit_cost` | Harga rata-rata berjalan barang itu SAAT opname (snapshot) | Dipakai buat menghitung nilai selisih — `avg_cost` di `inventory_balances` sendiri gak pernah disentuh, opname murni soal qty |
| `journal_entry_id` | Jurnal per baris | Debit Beban Selisih Persediaan / Kredit Persediaan (kalau kurang), atau kebalikannya lewat Pendapatan Selisih Persediaan (kalau lebih) |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Catat hasil hitung fisik | `record_stock_opname` | Insert header dulu, lalu loop tiap baris input: hitung selisih (`qty_actual` dikurangi `qty_system` dari `inventory_balances`), kalau nol dilewati (gak insert apa pun). Kalau ada selisih: catat jurnal (arah tergantung kurang/lebih, akun Persediaan dipilih per baris sesuai kategori barangnya), insert baris opname, lalu langsung set `qty_on_hand` ke hasil hitung fisik (`avg_cost` gak disentuh) | Barang tanpa selisih dilewati; kalau SEMUA baris ternyata gak ada selisih sama sekali, seluruh percobaan (termasuk insert header) dibatalkan total — konsisten pola "no partial write" |

**Aturan Bisnis → RPC**

| Aturan (dari `docs/domain`) | Dijaga oleh |
|---|---|
| Selisih kurang dan lebih diakui ke akun terpisah, gak digabung/netting jadi 1 angka bersih | 2 akun berbeda (Beban Selisih Persediaan / Pendapatan Selisih Persediaan), dipilih `record_stock_opname` otomatis sesuai arah tiap baris |
| Nilai selisih dihitung dari harga rata-rata berjalan SAAT opname, bukan harga historis | `unit_cost` diambil dari `inventory_balances.avg_cost` persis saat RPC dipanggil, lalu disimpan sebagai snapshot |
| Barang tanpa selisih gak menghasilkan pencatatan apa pun | Baris itu dilewati (`continue`) dalam loop, gak pernah di-insert |
| Akun Persediaan bisa beda per barang dalam 1 sesi (Bahan Baku dan Barang Jadi sekaligus) | `inventory_account_id` diterima per baris input, bukan 1 parameter tunggal buat seluruh pemanggilan RPC |
| Opname tidak boleh dicatat ke periode akuntansi yang sudah ditutup | Reuse aturan umum block-retroactive-period dari General Ledger |
| Transaksi opname tidak boleh diedit/dihapus setelah tercatat | Trigger `block_edit_delete` di kedua tabel |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `stock_opname_lines` | banyak-ke-satu | `stock_opnames` |
| `stock_opname_lines` | tiap baris menyesuaikan | `inventory_balances` (cuma `qty_on_hand`, `avg_cost` tetap) |
| `stock_opname_lines` | tiap baris memicu | 1 transaksi jurnal + 1 baris `inventory_movements` (Kartu Stok, lihat `inventory-ledger-schema.md`) |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat data opname | Semua user yang sudah login |
| Mencatat hasil hitung fisik | Role `admin` atau `accountant` |
| Mengedit/menghapus opname yang sudah tercatat | **Tidak ada seorang pun** |
