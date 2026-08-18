# Fixed Assets — Struktur Data

Fase 6. Konsep bisnisnya ada di `docs/domain/fixed-assets.md`. Konsep akun kontra: `docs/domain/chart-of-accounts.md` bagian "Akun Kontra". Detail teknis: `memory/architecture/data/fixed-assets-schema.md`.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `fixed_assets` | Master data tiap unit aset tetap (1 baris = 1 kendaraan, 1 mesin, dst — bukan kategori) | Menunjuk ke 3 akun di Chart of Accounts sekaligus |
| `depreciation_entries` | Histori posting penyusutan, satu baris per periode per aset | `fixed_assets`, dan ke transaksi jurnal yang otomatis dibuat |

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `fixed_assets` | Master data tiap unit aset tetap | Menunjuk ke 3 akun Chart of Accounts sekaligus |
| `depreciation_entries` | Histori posting penyusutan, satu baris per periode per aset | `fixed_assets`, dan ke transaksi jurnal yang otomatis dibuat |

**Setiap aset tetap dipetakan ke 3 akun sekaligus di Chart of Accounts** (bukan cuma 1) — ini yang membuat modul ini beda dari modul lain:

| Peran akun | Contoh | Kenapa terpisah |
|---|---|---|
| Akun Aset | "Aset Tetap - Kendaraan" | Menyimpan nilai perolehan asli, tidak pernah berubah sampai aset dijual/dibuang — supaya histori "beli berapa dulu" tetap bisa ditelusuri |
| Akun Akumulasi Penyusutan (kontra-asset) | "Akumulasi Penyusutan - Kendaraan" | Menampung total penyusutan yang sudah berjalan, ditampilkan sebagai pengurang di Neraca — bukan langsung mengurangi akun Aset |
| Akun Beban Penyusutan | "Beban Penyusutan - Kendaraan" | Muncul di Laporan Laba Rugi sebagai biaya operasional periode berjalan |

Sistem memvalidasi otomatis bahwa ketiga akun ini dipetakan sesuai perannya masing-masing (misalnya akun Akumulasi Penyusutan harus benar-benar berstatus akun kontra) — mencegah kesalahan pasang akun dari sisi tampilan.

**Struktur `fixed_assets` (kolom yang penting buat dipahami):**

| Kolom | Isinya | Catatan |
|---|---|---|
| nilai perolehan | Harga beli + biaya siap pakai | |
| nilai residu | Estimasi nilai jual di akhir umur manfaat | Sering Rp0 untuk aset UMKM kecil |
| umur manfaat | Berapa lama aset dipakai | Disimpan dalam bulan, supaya penyusutan bulanan presisi |
| metode penyusutan | Garis Lurus atau Saldo Menurun | Detail lengkap: submodule "Metode Penyusutan" |
| tarif penyusutan | Persentase per periode posting | Detail lengkap: submodule "Metode Penyusutan" |

**Struktur `depreciation_entries`:** satu baris = satu periode penyusutan untuk satu aset, menyimpan jumlah penyusutan periode itu secara eksplisit (bukan dihitung ulang dari rumus setiap kali dibaca) — ini yang membuat metode Saldo Menurun (nilainya beda tiap periode) tidak butuh struktur data tambahan dibanding Garis Lurus.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Daftarkan aset baru | `create_fixed_asset` | Hanya menyimpan data master (nilai, umur manfaat, metode, akun-akun terkait). Transaksi jurnal akuisisi (Debit Aset Tetap, Kredit Kas/Utang) dicatat terpisah lewat transaksi jurnal biasa, karena itu kejadian umum yang tidak butuh proses khusus | Trigger validasi 3 akun (peran harus sesuai) |
| Posting penyusutan satu periode | `post_depreciation` | Menghitung jumlah penyusutan otomatis sesuai metode aset (formula per metode: submodule "Metode Penyusutan"), lalu membuat transaksi jurnal (Debit Beban Penyusutan, Kredit Akumulasi Penyusutan) dan mencatat riwayatnya — semua sebagai satu langkah gabungan. Kalau perhitungan otomatis akan melewati batas maksimum, sistem otomatis memotong jumlahnya supaya pas berhenti di nilai residu | Trigger batas atas (tidak boleh lewat cap); constraint unik per aset+periode (tidak boleh dobel posting) |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Total penyusutan tidak boleh melebihi (nilai perolehan - nilai residu) | Trigger cap di `depreciation_entries` + auto-potong di `post_depreciation` |
| Tidak boleh dobel posting periode yang sama untuk aset yang sama | Constraint unik `(fixed_asset_id, period)` |
| Penyusutan yang sudah diposting tidak pernah bisa diedit atau dihapus | RLS default-deny + trigger `block_edit_delete` (reuse dari Journal Entry) |
| Aset yang sudah pernah disusutkan jadi "terkunci" sebagian (nilai, umur manfaat, metode, tarif, ketiga akun) | Trigger published-lock di `fixed_assets` |
| Ketiga akun yang dipetakan divalidasi perannya saat aset didaftarkan/diubah | Trigger validasi 3 akun di `fixed_assets` |
| Aset Tetap tercatat, gak berubah, sampai pelepasan | Tidak ada jalur yang mengubah nilai perolehan setelah tercatat (kecuali sebelum ada riwayat penyusutan). Pelepasan (disposal): submodule "Disposal Aset Tetap" |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `depreciation_entries` | banyak-ke-satu | `fixed_assets` |
| `depreciation_entries` | satu-ke-satu (`journal_entry_id`, `not null`) | `journal_entries` |
| `fixed_assets` (akun aset, akun akumulasi penyusutan, akun beban penyusutan) | masing-masing menunjuk | `accounts` |

## Metode Penyusutan (Garis Lurus & Saldo Menurun)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `fixed_assets` (kolom metode & tarif penyusutan) | Metode & tarif penyusutan, ditentukan per aset | — |

Tidak ada tabel baru — metode & tarif cuma 2 kolom tambahan di `fixed_assets` (DDL lengkap: submodule "Konsep Inti").

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Hitung penyusutan sesuai metode | `post_depreciation` (badan fungsi sama dengan submodule "Konsep Inti") | Garis Lurus: `(nilai perolehan - nilai residu) / umur manfaat`, sama tiap periode. Saldo Menurun: `nilai buku awal periode × tarif`, mengecil tiap periode. Kalau hasil lewat batas, otomatis dipotong ke sisa yang tersedia (biasanya periode terakhir) | Constraint di `fixed_assets` — tarif wajib terisi kalau Saldo Menurun, wajib kosong kalau Garis Lurus |

**Aturan Bisnis → RPC**

| Aturan | Dijaga oleh |
|---|---|
| Metode ditentukan per aset, bukan setting global | Kolom metode di `fixed_assets`, tidak ada setting modul-wide |
| Tarif wajib kalau Saldo Menurun, wajib kosong kalau Garis Lurus | Constraint antar-kolom di `fixed_assets` |
| Metode & tarif terkunci begitu aset pernah disusutkan | Trigger published-lock di `fixed_assets` (submodule "Konsep Inti") |
| Metode Unit Produksi belum didukung | Tipe pilihan metode penyusutan cuma menampung 2 nilai |
| Ganti metode di tengah umur manfaat, atau revaluasi aset secara umum, butuh proses resmi yang belum ada | Tidak ada RPC "ganti metode"/"revaluasi" — perubahan cuma lewat update biasa, yang sudah ditutup published-lock sebelum ada riwayat penyusutan |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `fixed_assets` (tarif penyusutan) | dipakai formula di dalam | `post_depreciation` |

## Disposal Aset Tetap (Penjualan/Pembuangan/Kehilangan)

Konsep bisnisnya: `docs/domain/fixed-assets.md` submodule "Disposal Aset Tetap".

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `fixed_asset_disposals` | Satu baris = satu aset yang dilepas (dijual/dibuang/hilang), menyimpan nilai buku saat itu & laba-rugi pelepasan | `fixed_assets` (1-ke-1, unik per aset), `journal_entries`, `accounts` (akun penerimaan kas & akun laba/rugi) |
| `fixed_assets` (kolom tanggal dilepas) | Kolom penanda, terisi otomatis begitu aset di-disposal — dipakai buat filter cepat aset aktif vs sudah dilepas | — |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Lepas aset (jual/buang/hilang) | `create_fixed_asset_disposal` | Hitung ulang nilai buku (nilai perolehan - akumulasi penyusutan berjalan), bandingkan ke nilai jual yang diterima → laba atau rugi. Bikin satu transaksi jurnal (nolin Akumulasi Penyusutan, nolin akun Aset, catat kas masuk kalau ada, catat laba/rugi ke akun yang sesuai) dan catat riwayat disposal — semua sebagai satu langkah gabungan | Tolak kalau aset sudah pernah di-disposal; tolak kalau tanggal disposal lebih awal dari penyusutan terakhir yang sudah diposting |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Satu aset cuma bisa di-disposal sekali, gak ada disposal sebagian | Kolom penunjuk aset di `fixed_asset_disposals` unik |
| Laba/rugi pelepasan dihitung dari Nilai Buku (bukan nilai perolehan mentah) | Dihitung otomatis di `create_fixed_asset_disposal`, bukan dientri manual |
| Riwayat disposal gak bisa diedit/dihapus | RLS default-deny + trigger `block_edit_delete` (reuse dari Journal Entry) |
| Aset yang sudah di-disposal gak bisa diposting penyusutan lagi | Trigger cap penyusutan (submodule "Konsep Inti") diperluas ikut cek status pelepasan aset |
| Tanggal disposal gak boleh lebih awal dari penyusutan terakhir yang sudah diposting | Dicek di `create_fixed_asset_disposal` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `fixed_asset_disposals` | satu-ke-satu (unik per aset) | `fixed_assets` |
| `fixed_asset_disposals` | satu-ke-satu (`journal_entry_id`, `not null`) | `journal_entries` |
| `fixed_asset_disposals` (akun penerimaan kas, akun laba/rugi) | masing-masing menunjuk (opsional, tergantung kasus) | `accounts` |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar aset & riwayat penyusutan/disposal | Semua user yang sudah login |
| Mendaftarkan aset baru, mengubah data aset (sebelum ada penyusutan) | Role `admin` atau `accountant` |
| Memposting penyusutan | Role `admin` atau `accountant` |
| Melepas aset (disposal) | Role `admin` atau `accountant` |
| Mengedit/menghapus riwayat penyusutan atau disposal | **Tidak ada seorang pun** |
| Menghapus aset secara permanen | **Tidak ada seorang pun** — hanya bisa diarsipkan (atau dilepas lewat disposal) |
