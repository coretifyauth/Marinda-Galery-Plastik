# Pengaturan PPN (Tax Settings) — Struktur Data

Konsep bisnisnya adalah PPN (Pajak Pertambahan Nilai) — dipungut sistem otomatis dari tarif yang diset admin, bukan diketik manual oleh staf, biar gak ada resiko salah hitung atau lupa dicatat. Dipakai di 2 tempat: sisi AP (PPN Masukan, saat bisnis beli dari supplier) dibahas di `docs/domain/accounts-payable.md` bagian "Kategori Campur & PPN"; sisi AR (PPN Keluaran, saat bisnis jual ke customer) di `docs/domain/accounts-receivable.md` bagian yang sama; sisi kasir (POS) di `docs/domain/pos.md` bagian "Kategori Biaya Tambahan & PPN". Detail teknis (SQL, nama fungsi persis) ada di `supabase/migrations/0006_tax_settings_schema.sql`.

Tabel ini **bukan child dari modul manapun** — dia konfigurasi lintas-modul (dipakai `transactions` dan `pos_sales` sekaligus), makanya berdiri sendiri sebagai 1 file spine, bukan ditumpangkan ke `transactions-schema.md` atau `pos-schema.md`.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `tax_settings` | Konfigurasi tunggal (singleton) tarif PPN & akun-akun pajaknya, dipakai lintas modul | `accounts` (akun PPN Keluaran & PPN Masukan) |

> **Migration final (2026-09-07):** `supabase/migrations/0006_tax_settings_schema.sql` -- konsolidasi dari migration incremental lama (0001-0084, sudah dihapus). Nomor migration `00XX` yang disebut di seluruh dokumen ini HISTORIS (isinya tetap akurat sebagai catatan evolusi keputusan, lihat `git log` kalau perlu baca file aslinya) -- SQL final yang AKTIF di database sekarang ada di file yang disebut di atas.

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `tax_settings` | Cuma 1 baris selamanya — status aktif PPN + tarif + akun PPN Keluaran/Masukan | `accounts.id` (2 kolom FK) |

**Struktur `tax_settings` (kolom yang penting buat dipahami)**

| Kolom | Isinya | Catatan |
|---|---|---|
| `id` | Selalu `true` | Bukan identifier beneran — ini trik supaya tabel **cuma bisa punya 1 baris selamanya** (constraint struktural di level database, bukan dijaga aplikasi) |
| `is_active` | Apakah bisnis ini sekarang wajib pungut PPN | Beda dari flag arsip di tabel master data lain — ini flag konfigurasi bisnis, bukan status lifecycle per-baris |
| `ppn_rate` | Tarif PPN (default 11%) | Tarif aturan pemerintah, disimpan di database (bukan di-hardcode di kode) biar ganti tarif cukup 1 kali update, gak perlu deploy ulang aplikasi |
| `ppn_keluaran_account_id` | Akun buat PPN yang dipungut dari customer (AR/POS) | FK ke `accounts` |
| `ppn_masukan_account_id` | Akun buat PPN yang dibayar ke supplier (AP) | FK ke `accounts` |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Aktifkan/nonaktifkan PPN, ubah tarif atau akun pajak | — (update langsung ke `tax_settings`, bukan financial write jadi gak lewat RPC) | Update kolom pada baris tunggal | RLS update admin doang; constraint singleton (`id boolean primary key check (id)`) memastikan gak pernah ada baris kedua |
| Catat bill dari supplier yang kena PPN Masukan | `create_transaction` (lihat `transactions-schema.md`) | Baca `ppn_masukan_account_id`/`ppn_rate` dari `tax_settings`, hitung nominal PPN otomatis, tambahkan ke akun Utang Usaha (`p_control_account_id`) sebagai bagian dari total utang | Menolak (raise exception) kalau `is_active=false` atau akun PPN belum diset di `tax_settings` |
| Catat penjualan kasir yang kena PPN Keluaran | `create_pos_sale` (lihat `pos-schema.md`) | Mekanisme sama seperti di atas, arah kebalik — PPN ditambahkan ke total yang ditagih ke customer | Menolak (raise exception) kalau `is_active=false` atau akun PPN belum diset |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| PPN Masukan/Keluaran dihitung otomatis oleh sistem dari tarif yang diset admin, gak boleh diketik manual | `create_transaction`/`create_pos_sale` baca `ppn_rate` dari `tax_settings` dan hitung sendiri nominalnya — kolom `is_tax` pada baris pajak gak pernah diisi dari input klien |
| Kategori campur/PPN tidak mengubah cara total tagihan dihitung — tetap 1 angka total (subtotal kategori + PPN kalau ada) | Nominal PPN ditambahkan langsung ke akun kontrol (`p_control_account_id`) di RPC yang sama, bukan alur terpisah |
| PPN cuma boleh dipungut kalau bisnis memang berstatus wajib pungut PPN | Guard `is_active=false` di `create_transaction`/`create_pos_sale` — RPC menolak transaksi kalau diminta hitung PPN tapi status belum aktif |
| Tarif PPN adalah aturan pemerintah, harus bisa diubah tanpa deploy ulang aplikasi | Tarif disimpan sebagai kolom `ppn_rate` di database, bukan konstanta di kode |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `tax_settings.ppn_keluaran_account_id` | banyak-ke-satu | `accounts` |
| `tax_settings.ppn_masukan_account_id` | banyak-ke-satu | `accounts` |
| `transactions` (lewat `create_transaction`, lihat `transactions-schema.md`) | baca konfigurasi, gak ada FK | `tax_settings` |
| `pos_sales` (lewat `create_pos_sale`, lihat `pos-schema.md`) | baca konfigurasi, gak ada FK | `tax_settings` |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat pengaturan PPN saat ini | Semua user yang sudah login |
| Mengaktifkan/menonaktifkan PPN, mengubah tarif atau akun pajak | Role `admin` doang |
| Menambah baris baru / menghapus baris | **Tidak ada seorang pun** — baris tunggalnya cuma pernah diseed lewat migration, dan constraint singleton menolak baris kedua apa pun yang dicoba |
