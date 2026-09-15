# Penomoran Dokumen Otomatis — Struktur Data

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi |
|---|---|
| Daftar Jenis Dokumen | Master 29 jenis dokumen transaksional di seluruh sistem, masing-masing dengan kode singkat (prefix) sendiri — contoh AP Bill = `APB`, AR Invoice = `ARI`. Plus 1 jenis ke-30 yang bukan dokumen transaksional (Kode Scan Barang, `SKU`) — nebeng mekanisme yang sama biar formatnya konsisten, lihat submodule "Kode Scan Barang" di `docs/architecture/items-schema.md`. |
| Penghitung Nomor | Menyimpan angka urutan terakhir yang sudah dipakai, per jenis dokumen per tahun. Sumber dari nomor berikutnya yang akan diberikan. |

> **Migration final (2026-09-07):** `supabase/migrations/0007_document_numbering_schema.sql` -- konsolidasi dari migration incremental lama (0001-0084, sudah dihapus). Nomor migration `00XX` yang disebut di seluruh dokumen ini HISTORIS (isinya tetap akurat sebagai catatan evolusi keputusan, lihat `git log` kalau perlu baca file aslinya) -- SQL final yang AKTIF di database sekarang ada di file yang disebut di atas.

## Generate Nomor Otomatis

**Peta Data (ERD)**
- Daftar Jenis Dokumen: 1 baris per jenis dokumen (mis. AP Bill, AR Invoice, Purchase Order) — nama singkat, kode prefix, label.
- Penghitung Nomor: 1 baris per kombinasi jenis dokumen + tahun — angka urutan terakhir yang sudah dipakai.

**Alur Teknis**
- Simpan dokumen → sistem cari kode prefix jenis dokumen itu → naikkan angka urutan tahun berjalan sebanyak 1 → format jadi `PREFIX-TAHUN-00001` → nomor itu dipakai sebagai Nomor Dokumen final.

**Aturan Bisnis → Data**
- "Nomor gak boleh dobel" dijaga karena tiap kombinasi jenis dokumen + tahun cuma boleh punya 1 baris penghitung, dan kenaikannya dilakukan sebagai 1 operasi atomik (aman walau 2 transaksi tersimpan bersamaan).
- "Reset tiap tahun" dijaga karena tahun adalah bagian dari kunci baris penghitung — tahun baru otomatis mulai dari angka urutan 0 lagi.

**Interaksi Antar Tabel**
- Penghitung Nomor merujuk ke Daftar Jenis Dokumen (tiap baris penghitung harus jenis dokumen yang memang terdaftar).

**Bootstrap ulang kalau kosong** — 29 baris Daftar Jenis Dokumen (key + prefix bawaan, TIDAK termasuk `depreciation_entries` yang sudah dicabut permanen menyusul pencabutan modul Fixed Assets) sekarang juga bisa dibuat lewat RPC `complete_onboarding` (lihat `coa-schema.md` submodule "Onboarding — Bootstrap Konfigurasi Awal") kalau tabel ini kosong (mis. pasca seluruh data dihapus) — idempotent per `doc_type` (`on conflict do nothing`), jaring pengaman di atas seed migration `0007` yang normalnya sudah mengisinya. Key-nya (`ap_bills`, `ar_invoices`, dst) TETAP hardcoded karena dipanggil literal oleh RPC lain (`generate_document_number(p_doc_type)`) — bukan sesuatu yang bisa diketik bebas admin, cuma teks `prefix`/`label` yang boleh disesuaikan belakangan.

## AP Bill — Nomor Nota Supplier

**Peta Data (ERD)**
- Tabel AP Bill dapat 1 kolom baru: Nomor Nota Supplier (teks bebas, boleh kosong).

**Alur Teknis**
- Saat input AP Bill, user isi Nomor Nota Supplier secara manual (opsional) — beda dari Nomor Dokumen yang otomatis dari sistem.

**Aturan Bisnis → Data**
- Nomor asli dari nota supplier gak boleh tertimpa nomor otomatis sistem — makanya disimpan di kolom terpisah, bukan menggantikan Nomor Dokumen.

**Interaksi Antar Tabel**
- Tetap di tabel AP Bill yang sudah ada — gak ada tabel baru untuk bagian ini.

## Dokumen dengan Rujukan Manual — Gak Dibackfill

**Peta Data (ERD)**
- Gak ada tabel baru. Rujukan Dokumen lama di semua tabel transaksional tetap berisi teks manual asli, gak pernah diubah ke format otomatis.

**Alur Teknis**
- Rujukan manual lama gak dibackfill ke format otomatis — setiap tabel transaksional punya aturan "gak bisa diedit sekali tersimpan" yang berlaku ke SEMUA kolom (termasuk Rujukan Dokumen), ditegakkan di level database, bukan cuma level aplikasi. Gak ada jalur buat buka kunci itu sementara demi kebutuhan backfill.

**Aturan Bisnis → Data**
- Prinsip "dokumen yang sudah tersimpan gak boleh diedit diam-diam" berlaku ke seluruh isi baris, bukan cuma nominal uang — konsisten sama alasan aturan itu ditegakkan tanpa pengecualian.

**Interaksi Antar Tabel**
- Gak ada perubahan skema. Tampilan (list & detail) menunjukkan Rujukan Dokumen apa adanya — teks manual lama untuk dokumen yang belum pernah dapat nomor otomatis, format `PREFIX-TAHUN-URUTAN` untuk dokumen yang dibuat lewat mekanisme penomoran ini.
