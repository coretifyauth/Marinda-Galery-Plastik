# Pengaturan Aplikasi (App Settings) — Struktur Data

Tabel konfigurasi global lintas-modul, isinya 3 domain independen yang persis sama pola: 1
baris selamanya, RLS select semua user login/update admin doang, gak punya relasi ke satu
sama lain. Digabung 1 tabel biar gak perlu 3x pasang RLS policy + 3x fetch buat config
global.

Isinya 3 domain bisnis independen dalam 1 baris:
- **Pajak (PPN)** — dibahas `docs/domain/accounts-payable.md` bagian "Kategori Campur & PPN"
  (sisi AP), `docs/domain/accounts-receivable.md` bagian sama (sisi AR), `docs/domain/pos.md`
  bagian "Kategori Biaya Tambahan & PPN" (sisi kasir).
- **Identitas Perusahaan** — dibahas `docs/domain/print-templates.md`, dipakai kop surat
  cetakan (AR Invoice, Purchase Order).
- **Pelanggan Walk-in (POS)** — dibahas `docs/domain/pos.md`, id `counterparties` default
  buat penjualan kios tanpa customer dipilih manual.

Detail teknis (SQL, nama fungsi persis) ada di `supabase/migrations/0006_app_settings_schema.sql`.

Tabel ini **bukan child dari modul manapun** — konfigurasi lintas-modul (dipakai `transactions`, `goods_notes`, dan alur POS sekaligus), berdiri sendiri sebagai 1 file spine.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `app_settings` | Konfigurasi tunggal (singleton) — PPN, identitas perusahaan, customer walk-in POS | `accounts` (akun PPN Keluaran & Masukan), `counterparties` (walk-in customer) |

> **Migration:** `supabase/migrations/0006_app_settings_schema.sql`.

## Konsep Inti

**Struktur `app_settings` (kolom yang penting buat dipahami)**

| Kolom | Isinya | Domain asal | Catatan |
|---|---|---|---|
| `id` | Selalu `true` | — | Bukan identifier beneran — trik supaya tabel **cuma bisa punya 1 baris selamanya** (constraint struktural di level database) |
| `name`, `address`, `npwp`, `logo_url` | Identitas perusahaan buat kop surat | company_settings | Logo cuma link ke gambar yang sudah di-host di tempat lain, bukan upload file |
| `is_active` | Apakah bisnis ini sekarang wajib pungut PPN | tax_settings | Flag konfigurasi bisnis, bukan status lifecycle per-baris |
| `ppn_rate` | Tarif PPN (default 11%) | tax_settings | Aturan pemerintah, disimpan di database biar ganti tarif cukup 1 kali update |
| `ppn_keluaran_account_id` | Akun buat PPN yang dipungut dari customer (AR/POS) | tax_settings | FK ke `accounts` |
| `ppn_masukan_account_id` | Akun buat PPN yang dibayar ke supplier (AP) | tax_settings | FK ke `accounts` |
| `walk_in_customer_id` | Id customer default "Pelanggan Umum" buat penjualan kios | pos_settings | FK ke `counterparties`, wajib diisi (`not null`) |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Ubah identitas perusahaan / aktifkan-nonaktifkan PPN / ubah tarif & akun pajak | — (update langsung ke `app_settings`, bukan financial write jadi gak lewat RPC) | Update kolom pada baris tunggal, langsung kepakai (tidak ada langkah publish/deploy terpisah) | RLS update admin doang; constraint singleton (`id boolean primary key check (id)`) memastikan gak pernah ada baris kedua |
| Catat bill dari supplier yang kena PPN Masukan | `create_transaction` (lihat `transactions-schema.md`) | Baca `ppn_masukan_account_id`/`ppn_rate` dari `app_settings`, hitung nominal PPN otomatis, tambahkan ke akun kontrol sebagai bagian dari total utang | Menolak (raise exception) kalau `is_active=false` atau akun PPN belum diset |
| Catat penjualan kasir yang kena PPN Keluaran / customer gak dipilih | `create_pos_sale` (lihat `pos-schema.md`) | Baca `ppn_keluaran_account_id`/`ppn_rate` buat hitung PPN; baca `walk_in_customer_id` kalau kasir gak pilih customer | Menolak kalau `is_active=false`/akun PPN belum diset (khusus PPN); `walk_in_customer_id` selalu ada (kolom `not null`) |
| Cetak dokumen (AR Invoice/PO) | — (bukan RPC, dibaca langsung pas halaman dibuka) | Kop surat dirender dari `name`/`address`/`npwp`/`logo_url` TERKINI | — |
| Isi baris pertama `app_settings` (setup awal aplikasi) | `complete_onboarding(...)` (lihat `coa-schema.md` submodule "Onboarding — Bootstrap Konfigurasi Awal") | Insert 1 baris singleton: identitas usaha + PPN (akun PPN di-resolve dari template COA yang dibuat RPC yang sama) + `walk_in_customer_id` (counterparty "Pelanggan Umum" dibuat/reuse RPC yang sama) | Menolak kalau `app_settings` sudah punya baris — cuma bisa dipanggil sekali selama tabel ini masih kosong |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| PPN Masukan/Keluaran dihitung otomatis oleh sistem dari tarif yang diset admin, gak boleh diketik manual | `create_transaction`/`create_pos_sale` baca `ppn_rate` dari `app_settings` dan hitung sendiri nominalnya |
| PPN cuma boleh dipungut kalau bisnis memang berstatus wajib pungut PPN | Guard `is_active=false` di `create_transaction`/`create_pos_sale` |
| Kop surat & identitas perusahaan ikut aturan "Live Data" — perubahan langsung kepakai tanpa perlu ubah kode | Dibaca ulang setiap kali halaman detail dokumen dibuka, bukan disalin/dibekukan sekali di awal |
| Kasir gak wajib pilih customer — sistem otomatis pakai walk-in default | `walk_in_customer_id` dibaca RPC `create_pos_sale` kalau parameter customer kosong |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `app_settings.ppn_keluaran_account_id` | banyak-ke-satu | `accounts` |
| `app_settings.ppn_masukan_account_id` | banyak-ke-satu | `accounts` |
| `app_settings.walk_in_customer_id` | banyak-ke-satu | `counterparties` |
| `transactions` (lewat `create_transaction`) | baca konfigurasi, gak ada FK | `app_settings` |
| alur POS (lewat `create_pos_sale`, lihat `pos-schema.md`) | baca konfigurasi, gak ada FK | `app_settings` |
| Halaman detail AR Invoice/PO (kop surat) | baca konfigurasi, gak ada FK | `app_settings` |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat pengaturan saat ini (PPN, identitas perusahaan, walk-in customer) | Semua user yang sudah login |
| Mengubah pengaturan apa pun di baris ini | Role `admin` doang |
| Mengisi baris pertama | Admin, sekali lewat RPC `complete_onboarding` (lihat `coa-schema.md` submodule "Onboarding") |
| Menambah baris baru / menghapus baris | **Tidak ada seorang pun** — constraint singleton menolak baris kedua apa pun yang dicoba |
