# Fixed Assets — AI Context

Fixed Assets menyebar biaya perolehan aset yang dipakai berulang bertahun-tahun (kendaraan, mesin — beda dari bahan baku Inventory yang habis sekali pakai) ke sepanjang masa manfaatnya, lewat penyusutan periodik. **Prinsip inti: matching by time** — beda dari Inventory yang matching-nya dipicu kejadian (barang terjual), Fixed Assets matching-nya berjalan tiap periode waktu (tiap bulan) tanpa perlu kejadian pemicu.

Naratif lengkap + reasoning penuh: `docs/domain/fixed-assets.md`. Struktur module → submodule di file ini SAMA urutannya dengan padanan naratif itu dan dengan `memory/architecture/data/fixed-assets-schema.md` (lihat `AGENTS.md` > "Format Baku: Struktur Module → Submodule").

## Konsep Inti

**Entitas & Jurnal**
- **fixed_asset** — satu unit aset fisik (bukan kategori). Kolom kunci: nilai perolehan, nilai residu, umur manfaat (bulan), metode penyusutan, tarif (kalau declining balance), 3 kolom akun (asset/akumulasi penyusutan/beban penyusutan).
- **Akuisisi** — Debit Aset Tetap, Kredit Kas/Utang. Dicatat lewat jurnal umum biasa (`create_journal_entry`), BUKAN RPC modul ini — modul ini cuma nyimpen master data buat dasar penyusutan berikutnya.
- **Penyusutan (per periode)** — Debit Beban Penyusutan, Kredit Akumulasi Penyusutan. Nominal dihitung otomatis sesuai metode aset (atau bisa di-override manual, dipakai buat penyesuaian periode terakhir declining balance), dijurnal + insert histori sekaligus dalam 1 langkah atomik.
- **Akumulasi Penyusutan** — akun kontra-asset pertama di project ini (`accounts.is_contra`, lihat "Dampak Schema" di bawah) — kategori `asset`, `normal_balance` kredit (kebalikan asset biasa).

**Dampak Schema (akun kontra)** — `accounts.normal_balance` (`coa-schema.md`) awalnya generated column, `asset → debit` tanpa exception, gak bisa nampung akun kontra-asset. Keputusan (Opsi A): tambah kolom `accounts.is_contra` boolean, rumus generated `normal_balance` ikut flag ini — kategori asset dengan `is_contra=true` jadi normal kredit. `is_contra` juga masuk daftar field yang dikunci setelah akun kepakai transaksi (`published` field-lock, reuse pola `accounts_published_lock`). DDL final: `memory/architecture/data/fixed-assets-schema.md`.

**Constraints**
- **Cap penyusutan**: akumulasi gak boleh melebihi (nilai perolehan - nilai residu) — ditegakkan trigger DB, bukan cuma dihitung benar di RPC (jaring kedua kalau ada insert bypass RPC).
- **No dobel posting**: 1 aset cuma boleh punya 1 baris penyusutan per periode (constraint unique).
- **Immutability**: histori penyusutan gak bisa di-`UPDATE`/`DELETE` — RLS default-deny + trigger `block_edit_delete` (reuse dari Journal Entry). Koreksi = reversing entry + posting ulang.
- **3 akun tervalidasi perannya** — trigger nolak kalau akun yang dipetakan ke aset ditunjuk ke kategori/status kontra yang salah (misal akumulasi penyusutan ditunjuk ke akun yang bukan kontra).
- **Published-lock**: begitu aset punya minimal 1 baris penyusutan, field penentu nilai (nilai perolehan, residu, umur manfaat, metode, tarif, 3 kolom akun) terkunci — nama & status arsip tetap bebas diubah kapan pun.
- **Disposal aset** — pelepasan (jual/buang/hilang) dibahas di submodule "Disposal Aset Tetap" di bawah.

**Skenario referensi**

| # | Kasus | Pola |
|---|---|---|
| 1 | Daftarkan aset baru | Insert master data doang, gak ada jurnal — akuisisi dicatat manual lewat jurnal umum |
| 2 | Posting penyusutan 1 periode | Hitung otomatis sesuai metode, 1 jurnal + 1 baris histori, atomik |
| 3 | Posting penyusutan periode terakhir (lewat cap) | Auto-terpotong ke sisa yang tersedia, biar nilai buku pas berhenti di residu |

**Common Mistakes**
- Beban penuh di bulan beli (harusnya disebar via penyusutan periodik).
- Kredit langsung ke akun Aset Tetap saat penyusutan — harusnya ke Akumulasi Penyusutan (kontra), biar histori nilai perolehan gak hilang.
- Lupa nilai residu — penyusutan dihitung kayak residu-nya nol.
- Penyusutan lewat batas nilai perolehan tanpa auto-adjust/guard.
- Nambah tabel/kolom baru yang butuh akun kontra tanpa cek `is_contra` — pola generated `normal_balance` sekarang bercabang, jangan asumsikan akun `asset` selalu normal debit.

## Metode Penyusutan (Garis Lurus & Saldo Menurun)

**Entitas & Jurnal**
- Ditentukan **per aset** (`fixed_assets.depreciation_method`), bukan global — tabel `depreciation_entries` menampung histori kedua metode tanpa struktur tambahan, karena `amount` tiap baris disimpan eksplisit (bukan re-derive dari formula tiap dibaca).
- **Garis Lurus (straight_line)**: `(nilai perolehan - nilai residu) / umur manfaat (bulan)`, sama tiap periode, dihitung ulang tiap posting dari formula yang sama (bukan snapshot rate).
- **Saldo Menurun (declining_balance)**: `nilai buku awal periode × tarif`. `depreciation_rate` merepresentasikan tarif PER PERIODE POSTING, bukan otomatis per-tahun — kalau posting bulanan, tarif yang diisi ya tarif bulanan, sengaja dibikin eksplisit (bukan disimpan sebagai tarif tahunan lalu dibagi 12 di RPC) biar gak ada ambiguitas konversi periode di 2 tempat beda (dokumentasi vs kode).
- **Auto-potong periode terakhir**: kalau hasil hitung (kedua metode) bikin akumulasi lewat cap, RPC posting otomatis motong ke sisa yang tersedia — kenyamanan doang (auto-adjust, gak perlu hitung manual pas periode terakhir), trigger cap tetap jalan sebagai jaring kedua kalau ada jalur insert lain yang gak lewat RPC ini.
- **Unit Produksi (metode ke-3) belum masuk scope** — butuh data pemakaian eksternal per periode (jam mesin/KM/batch produksi), bukan cuma waktu berjalan, berpotensi coupling ke `production_orders` (Inventory). Ditunda karena straight-line + declining balance udah cukup buat kebutuhan sekarang. Belum ada scope-debt file.
- **Ganti metode di tengah umur manfaat belum ada jalur resmi** — field-lock ("published lock", submodule "Konsep Inti") udah nutup dari sisi "gak bisa diam-diam berubah" (field metode terkunci begitu ada riwayat penyusutan), tapi belum ada proses revaluasi formal buat ganti dengan sengaja lewat jalur yang benar. Revaluasi aset (penyesuaian nilai wajar di luar penyusutan rutin) secara umum juga belum dibangun. Belum ada scope-debt file buat keduanya.

**Constraints**
- `depreciation_rate` wajib keisi kalau `depreciation_method='declining_balance'`, wajib `null` kalau `straight_line` — `check` constraint antar-kolom di tabel yang sama (bukan lintas tabel, jadi bisa `CHECK` biasa).
- `depreciation_method` + `depreciation_rate` ikut daftar field yang dikunci published-lock (lihat submodule "Konsep Inti").

**Skenario referensi**

| # | Kasus | Pola |
|---|---|---|
| 4 | Aset garis lurus | Penyusutan sama tiap periode |
| 5 | Aset saldo menurun, periode terakhir | Penyusutan dihitung dari nilai buku sisa, periode terakhir kena auto-potong ke cap |

**Common Mistakes**
- Simpan tarif Saldo Menurun sebagai tarif tahunan lalu dibagi 12 di kode — harus eksplisit tarif per periode posting, biar gak ada konversi ambigu di 2 tempat beda.
- Anggap `depreciation_entries` butuh kolom tambahan buat nampung Saldo Menurun — gak perlu, `amount` udah eksplisit per baris.

## Disposal Aset Tetap (Penjualan/Pembuangan/Kehilangan)

**Entitas & Jurnal**
- `fixed_asset_disposals` — 1 baris per aset yang dilepas (unique per `fixed_asset_id`, gak bisa disposal 2x). Kolom kunci: tanggal disposal, jenis (`SOLD`/`SCRAPPED`/`LOST`), nilai jual (nol kalau `SCRAPPED`/`LOST`), nilai buku saat disposal (snapshot, bukan re-derive), laba/rugi (signed, derived tapi disimpan eksplisit), `journal_entry_id`.
- `fixed_assets.disposed_at` — kolom denormalisasi (timestamp, null = masih aktif) buat filter cepat aset aktif vs sudah dilepas, pola sama `0053_denormalize_transactional_status.sql`.
- **Jurnal**: Debit Akumulasi Penyusutan (penuh) + Debit Kas/Bank (nilai jual, kalau >0) + Kredit Aset Tetap (nilai perolehan) + baris penyeimbang laba (kredit) atau rugi (debit). Dipost lewat `create_journal_entry` (RPC existing, direuse — bukan insert manual), atomik dalam 1 RPC baru `create_fixed_asset_disposal`.
- Akun laba pakai role `default_account_settings` baru `fixed_assets.disposal_gain` (default nunjuk ke 4300 Pendapatan Lain-lain, sama akun yang dipakai `ar.other_revenue` tapi role_key terpisah — boleh beda akun kalau admin mau nanti). Akun rugi pakai role baru `fixed_assets.disposal_loss` (akun baru, kode `6200 Rugi Pelepasan Aset Tetap` — `6000`/`6100` sudah dipakai akun lain, cek nomor final ke DB live sebelum migration diapply). Nilai jual (kalau ada) pakai role `cash.tunai`/`cash.bank` existing lewat `CashMethodField`.

**Constraints**
- **1 aset = 1 disposal** — unique constraint di `fixed_asset_disposals.fixed_asset_id`, gak ada disposal parsial/sebagian.
- **Immutability** — sama pola Journal Entry & `depreciation_entries`, gak bisa `UPDATE`/`DELETE` (RLS default-deny + `block_edit_delete`). Koreksi = reversing entry.
- **Blokir penyusutan pasca-disposal** — trigger di `depreciation_entries` cek `fixed_assets.disposed_at is null` sebelum izinin insert baris baru.
- **Tanggal disposal >= tanggal penyusutan terakhir** aset itu — dicek RPC, dijamin trigger.
- **Published-lock tetap berlaku** — field 3-akun/nilai/metode di `fixed_assets` udah terkunci dari penyusutan pertama, disposal gak buka kunci itu (gak relevan lagi begitu disposed).

**Skenario referensi**

| # | Kasus | Pola |
|---|---|---|
| 6 | Aset dijual untung | Nilai jual > nilai buku, kredit ke `fixed_assets.disposal_gain` |
| 7 | Aset dijual rugi | Nilai jual < nilai buku, debit ke `fixed_assets.disposal_loss` |
| 8 | Aset hilang/rusak total | Nilai jual nol, rugi penuh = seluruh nilai buku, gak ada baris Kas |

**Common Mistakes**
- Hapus baris `fixed_assets` begitu dijual/dibuang — harusnya insert `fixed_asset_disposals` + set `disposed_at`, histori tetap ada.
- Lupa debit Akumulasi Penyusutan saat disposal — saldo kontra-aset nyangkut selamanya.
- Hitung laba/rugi dari nilai perolehan, bukan nilai buku (nilai perolehan - akumulasi penyusutan berjalan).
- Insert manual ke `journal_entries`/`journal_lines` buat disposal, bukan lewat `create_journal_entry` — melanggar pola project (RPC modul baru manggil RPC modul lama).

## Glossary

- **Aset Tetap (Fixed Asset)**: barang dipakai berulang bertahun-tahun (bukan habis sekali pakai), disusutkan bertahap.
- **Penyusutan (Depreciation)**: proses menyebar nilai perolehan aset tetap jadi biaya sepanjang masa manfaatnya.
- **Akumulasi Penyusutan (Accumulated Depreciation)**: akun kontra-asset, saldo normal kredit, menampung total penyusutan yang sudah berjalan.
- **Nilai Buku (Net Book Value)**: Nilai Perolehan - Akumulasi Penyusutan, angka yang tampil di Neraca.
- **Nilai Residu (Salvage Value)**: estimasi nilai jual aset di akhir umur manfaat.
- **Garis Lurus (Straight-Line)**: metode penyusutan dengan nilai sama tiap periode.
- **Saldo Menurun (Declining Balance)**: metode penyusutan dengan tarif % dikali nilai buku sisa, nilainya ngecil tiap periode.

Naratif lengkap + reasoning penuh: `docs/domain/fixed-assets.md`.
