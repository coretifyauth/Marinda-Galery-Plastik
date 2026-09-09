# Cetak Dokumen Fisik — Struktur Data & Teknis

Konsep bisnisnya ada di `docs/domain/print-templates.md`. Detail teknis penuh (DDL/RLS): `supabase/migrations/0009_print_templates_schema.sql`. Cross-cutting, murni config presentasi — tidak ada relasi (FK) dari tabel transaksional manapun ke tabel-tabel di sini, dan sebaliknya. Bagian cetak dokumen itu sendiri (AR Invoice, Purchase Order, dst) tidak punya tabel sendiri sama sekali — dirender langsung dari data yang sudah dimuat halaman detailnya masing-masing, ditambah 2 tabel konfigurasi di bawah ini.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| Identitas Perusahaan | Nama, alamat, NPWP, dan link logo untuk kop surat — 1 baris tunggal untuk seluruh sistem | — |
| Daftar Penandatangan | Katalog jabatan yang perlu tanda tangan manual di kolom bawah cetakan, beserta urutan tampilnya | — |

> **Migration final (2026-09-07):** `supabase/migrations/0009_print_templates_schema.sql` -- konsolidasi dari migration incremental lama (0001-0084, sudah dihapus). Nomor migration `00XX` yang disebut di seluruh dokumen ini HISTORIS (isinya tetap akurat sebagai catatan evolusi keputusan, lihat `git log` kalau perlu baca file aslinya) -- SQL final yang AKTIF di database sekarang ada di file yang disebut di atas.

## Kop Surat & Blok Tanda Tangan

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| Identitas Perusahaan | Nama, alamat, NPWP, link logo — cuma 1 baris, gak bisa nambah baris kedua | — |
| Daftar Penandatangan | 1 baris per jabatan (mis. "Kepala Toko"), urutan tampil, status aktif/nonaktif | — |

Identitas Perusahaan sengaja cuma boleh punya 1 baris (dijaga di level database, bukan cuma disiplin form) — pola yang sama dipakai Pengaturan PPN (`docs/architecture/tax-settings-schema.md`). Daftar Penandatangan sengaja **tidak** menyimpan nama pegawai — cuma label jabatan, karena tanda tangannya dibubuhkan manual di kertas, bukan e-signature.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Admin ubah identitas perusahaan | — (update langsung lewat halaman Pengaturan, bukan RPC) | Perubahan langsung kepakai di cetakan berikutnya — tidak ada langkah publish/deploy terpisah | Cuma role `admin` yang boleh mengubah |
| Admin tambah/urutkan/nonaktifkan jabatan penandatangan | — (insert/update langsung lewat halaman Pengaturan) | Kolom tanda tangan baru otomatis muncul di cetakan berikutnya sesuai urutan yang diset | Cuma role `admin` yang boleh menambah/mengubah |
| Admin hapus permanen 1 jabatan penandatangan | — (delete langsung) | Baris jabatan hilang total dari sistem | Cuma role `admin` — aman dihapus permanen karena tidak ada dokumen transaksi manapun yang merujuk baris ini |
| Cetak dokumen (AR Invoice/Purchase Order, dst) | — (bukan RPC — dibaca langsung pas halaman dibuka) | Kop surat & blok tanda tangan dirender dari data TERKINI kedua tabel ini, bukan salinan yang dibekukan | Blok tanda tangan cuma menampilkan jabatan yang berstatus aktif, urut sesuai pengaturan |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Kop surat & blok tanda tangan ikut aturan "Live Data" — perubahan pengaturan langsung kepakai tanpa perlu ubah kode apa pun | Kedua tabel dibaca ulang setiap kali halaman detail dokumen dibuka, bukan disalin/dibekukan sekali di awal |
| Cuma jabatan yang aktif yang muncul di blok tanda tangan | Baris yang dinonaktifkan (bukan dihapus) otomatis dilewati saat merender cetakan |
| Jabatan penandatangan boleh dihapus permanen, beda dari katalog master data lain yang cuma bisa diarsipkan | Aman karena tidak ada satu pun tabel dokumen transaksi yang merujuk baris ini lewat relasi (FK) apa pun |
| Logo perusahaan cuma berupa link ke gambar yang sudah di-host di tempat lain, bukan upload file ke sistem | Kolomnya murni teks (link), tidak ada penyimpanan file di sisi sistem untuk fase ini |

**Interaksi Antar Tabel**

- Kedua tabel di submodule ini berdiri sendiri, tidak terhubung ke tabel manapun (termasuk satu sama lain) — murni dibaca by-value saat tombol "Cetak" ditekan di halaman detail dokumen manapun yang sudah mendukungnya.
