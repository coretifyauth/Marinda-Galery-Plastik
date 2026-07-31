# Story — Fixed Assets: CV Roti Barokah

Fase 6. Konteks bisnis: `docs/story/company-profile.md` (poin 6: "oven + motor disusutkan, bukan langsung jadi beban semua di tahun beli"). Konsep: `docs/domain/human/fixed-assets.md`. ERD & DDL: `docs/architecture/data/fixed-assets-schema.md`. Lanjutan dari `docs/story/inventory.md` — 2 aset ini (oven, motor) udah disebut sejak `company-profile.md` (dibeli 2025 pakai pinjaman KUR), baru sekarang penyusutannya beneran dihitung & dicatat.

Timeline cerita ini: **akuisisi Januari 2025**, penyusutan diposting sampai **31 Desember 2025** (posisi akhir tahun pertama).

## Master Data Aset

| Aset | Nilai Perolehan | Nilai Residu | Umur Manfaat | Metode | Akun Aset | Akun Kontra | Akun Beban |
|---|---|---|---|---|---|---|---|
| Oven Tambahan | Rp15.000.000 | Rp0 | 5 tahun (60 bulan) | **Straight-Line** | `1610 Peralatan Oven` | `1630 Akumulasi Penyusutan Oven` | `5600 Beban Penyusutan Oven` |
| Motor Antar | Rp24.000.000 | Rp2.400.000 | 4 tahun (48 bulan) | **Declining Balance** (40%/tahun) | `1620 Kendaraan Motor` | `1640 Akumulasi Penyusutan Motor` | `5610 Beban Penyusutan Motor` |

`1610`/`1620` udah ada sejak seed COA (`0003_seed_demo_coa.sql`, sebagai child dari `1600 Aset Tetap`). 4 akun baru (`1630`, `1640`, `5600`, `5610`) ditambah di seed ini — 2 akun kontra (`is_contra=true`, kategori asset tapi normal kredit) + 2 akun beban.

Dua metode beda disengaja dipilih buat 2 aset yang beda karakter (`docs/domain/human/fixed-assets.md` bagian "Metode Penyusutan"): oven manfaatnya rata tiap tahun (straight-line cocok), motor cepat kehilangan nilai di tahun-tahun awal (declining balance cocok).

## Tahap 1 — Akuisisi Oven (10 Januari 2025)

Beli oven tambahan Rp15.000.000, dibayar pakai pinjaman KUR (Utang Bank).

`fixed_assets` (via `create_fixed_asset`): Oven Tambahan, `1610`/`1630`/`5600`, cost 15.000.000, residu 0, 60 bulan, straight_line.

Jurnal akuisisi (manual, `create_journal_entry` — bukan lewat RPC khusus, sama pola akuisisi generik):
```
Debit  Peralatan Oven (1610)     15.000.000
Kredit Utang Bank (2200)                     15.000.000
```

## Tahap 2 — Akuisisi Motor (15 Januari 2025)

Beli motor antar Rp24.000.000, juga dari KUR.

`fixed_assets`: Motor Antar, `1620`/`1640`/`5610`, cost 24.000.000, residu 2.400.000, 48 bulan, declining_balance, rate 40%.

```
Debit  Kendaraan Motor (1620)    24.000.000
Kredit Utang Bank (2200)                     24.000.000
```

## Tahap 3 — Penyusutan Oven (Straight-Line, 12x posting bulanan sepanjang 2025)

Formula: `(15.000.000 - 0) / 60 bulan = Rp250.000/bulan`, sama tiap bulan.

Diposting via `post_depreciation` tiap akhir bulan, Januari s.d. Desember 2025 (12 kali panggilan, `p_amount_override` gak dipakai — dihitung otomatis dari `depreciation_method`). Tiap posting:
```
Debit  Beban Penyusutan Oven (5600)          250.000
Kredit Akumulasi Penyusutan Oven (1630)               250.000
```

Setelah 12x posting: **Akumulasi Penyusutan Oven = Rp3.000.000**, **Nilai Buku Oven = Rp12.000.000** — persis contoh angka di `docs/domain/human/fixed-assets.md`.

## Tahap 4 — Penyusutan Motor (Declining Balance, 1x posting tahunan)

Beda cadence dari oven — motor diposting **tahunan** (bukan bulanan), buat nunjukin `period` fleksibel (satuan waktu apa aja, gak dihardcode bulan) selama `depreciation_rate` konsisten sama periode postingnya (`docs/architecture/data/fixed-assets-schema.md`: "`depreciation_rate` mewakili tarif PER PERIODE POSTING").

Formula tahun 1: `Nilai Buku Awal (24.000.000) × 40% = Rp9.600.000`.

```
Debit  Beban Penyusutan Motor (5610)        9.600.000
Kredit Akumulasi Penyusutan Motor (1640)              9.600.000
```

Setelah posting tahun 1: **Akumulasi Penyusutan Motor = Rp9.600.000**, **Nilai Buku Motor = Rp14.400.000**.

## Posisi Akhir per 31 Desember 2025

| Aset | Nilai Perolehan | Akumulasi Penyusutan | Nilai Buku |
|---|---|---|---|
| Oven Tambahan | 15.000.000 | 3.000.000 | **12.000.000** |
| Motor Antar | 24.000.000 | 9.600.000 | **14.400.000** |

Ini yang muncul di Neraca: `Aset Tetap` (gross, 2 baris nilai perolehan) dikurangi `Akumulasi Penyusutan` (2 baris kontra), Nilai Buku total = Rp26.400.000. `Beban Penyusutan Oven` + `Beban Penyusutan Motor` (total Rp12.600.000 buat tahun 2025) muncul di Laporan Laba Rugi sebagai biaya operasional — komponen biaya di luar HPP bahan baku yang udah dihitung di `docs/story/inventory.md`.

## Simulasi Interface (rencana)

Sama pola modul lain: setelah migration `0014_fixed_assets_schema.sql`+seed ini diterapkan, web app bakal punya halaman `/fixed-assets` (master data aset + nilai buku berjalan) dan aksi "posting penyusutan" per periode. Detail flow menyusul pas fase UI dikerjakan.

## Lanjutan Story

Fase berikutnya (Financial Reports) bakal narik semua saldo — termasuk Nilai Buku Aset Tetap & Beban Penyusutan dari sini — jadi Neraca dan Laporan Laba Rugi CV Roti Barokah yang utuh, tujuan akhir motivasi bisnis di `company-profile.md`.
