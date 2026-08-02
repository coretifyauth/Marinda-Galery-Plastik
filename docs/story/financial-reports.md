# Story — Financial Reports: CV Roti Barokah

Fase 7. Konteks bisnis: `docs/story/company-profile.md` (poin 7 — tujuan akhir seluruh cerita: laporan keuangan yang bisa dibawa Bu Nur ke bank). Konsep: `docs/domain/financial-reports.md`. ERD & struktur data: `docs/architecture/financial-reports-schema.md`. 4 laporan (Trial Balance/Income Statement/Balance Sheet/Cash Flow) **gak ada migration baru** — murni agregasi read-only dari data yang sudah di-seed sepanjang cerita sejauh ini (COA `0003`, General Ledger `0005`, AR `0008`+`0009`, AP `0011`, Inventory `0013`, Fixed Assets `0015`). Period Closing beda — **ada migration baru**: `0016_period_closing.sql` (schema) + `0017_seed_demo_period_closing.sql` (nutup 2 periode beneran, lihat bagian 5 di bawah). Ini pertama kalinya story menggabungkan **seluruh fase sekaligus** jadi 1 set laporan utuh.

Rentang waktu laporan ini: **10 Januari 2025** (akuisisi oven pertama, `docs/story/fixed-assets.md`) sampai **25 Agustus 2026** (transaksi terakhir yang ke-seed, penjualan roti ke Warung Pak Budi, `docs/story/inventory.md`). Semua angka di bawah dihitung langsung dari jurnal riil yang sudah tercatat di migration-migration itu — bukan angka ilustrasi (angka ilustrasi generik ada di `docs/domain/financial-reports.md`).

## Kenapa Rentang Waktunya Sepanjang Ini (Sebelum Tutup Buku)

Bagian 1-4 di bawah ini adalah **snapshot SEBELUM `0017_seed_demo_period_closing.sql` dijalankan** — sengaja dipertahankan apa adanya (bukan dihapus/ditulis ulang) karena ini demonstrasi konkret kenapa Period Closing dibutuhkan. Tanpa Period Closing, akun Revenue/Expense di sistem ini gak pernah direset, jadi Income Statement & Cash Flow di bawah bukan "Laba Rugi Agustus 2026" yang bersih, tapi **kumulatif sejak transaksi pertama tercatat** (Januari 2025). Bagian 5 nunjukin gimana `close_period` (dibangun di migration `0016`) beneran menyelesaikan ini.

## Sumber Data

| Fase | Migration | Kontribusi ke laporan |
|---|---|---|
| 1. COA | `0003_seed_demo_coa.sql` | Daftar akun awal |
| 2. General Ledger | `0005_seed_demo_journal_entries.sql` | 6 transaksi generik Juli 2026 (modal, jual tunai, kirim grosir, beli bahan, gaji, cicilan KUR) |
| 3. AR | `0008_seed_demo_ar.sql` | 3 invoice + 3 payment customer |
| 4. AP | `0011_seed_demo_ap.sql` (+ akun kontra dari `0015`) | 6 bill + 4 payment supplier, 1 bill dibatalkan |
| 5. Inventory | `0013_seed_demo_inventory.sql` (+ akun `1420` dari migration ini sendiri) | 4 penerimaan barang, 1 produksi, 1 penjualan barang jadi |
| 6. Fixed Assets | `0015_seed_demo_fixed_assets.sql` | 2 akuisisi aset + 13 posting penyusutan (12x oven, 1x motor) |

## 1. Trial Balance per 25 Agustus 2026

| Akun | Saldo | Sisi |
|---|---|---|
| 1100 Kas Toko | 500.000 | Debit |
| 1200 Kas di Bank | 6.680.000 | Debit |
| 1300 Piutang Usaha | 1.260.000 | Debit |
| 1400 Persediaan Bahan Baku | 3.857.500 | Debit |
| 1420 Persediaan Barang Jadi | 25.000 | Debit |
| 1610 Peralatan Oven | 15.000.000 | Debit |
| 1620 Kendaraan Motor | 24.000.000 | Debit |
| 5100 Harga Pokok Penjualan | 37.500 | Debit |
| 5200 Beban Gaji Karyawan | 2.000.000 | Debit |
| 5500 Beban Bunga Bank | 150.000 | Debit |
| 5600 Beban Penyusutan Oven | 3.000.000 | Debit |
| 5610 Beban Penyusutan Motor | 9.600.000 | Debit |
| 1630 Akumulasi Penyusutan Oven | 3.000.000 | Kredit (kontra) |
| 1640 Akumulasi Penyusutan Motor | 9.600.000 | Kredit (kontra) |
| 2100 Utang Usaha | 2.350.000 | Kredit |
| 2200 Utang Bank | 38.000.000 | Kredit |
| 3100 Modal Pemilik | 10.000.000 | Kredit |
| 4100 Pendapatan Penjualan Toko | 500.000 | Kredit |
| 4200 Pendapatan Penjualan Grosir | 2.660.000 | Kredit |

Total Debit = `500.000+6.680.000+1.260.000+3.857.500+25.000+15.000.000+24.000.000+37.500+2.000.000+150.000+3.000.000+9.600.000 = 66.110.000`
Total Kredit = `3.000.000+9.600.000+2.350.000+38.000.000+10.000.000+500.000+2.660.000 = 66.110.000` ✓ **Balance.**

(`1000 Kas` dan `1600 Aset Tetap` adalah akun header, gak pernah diposting langsung — leaf-only posting rule sejak Fase 1 — makanya gak muncul baris sendiri di sini, saldonya sudah terwakili anak-anaknya: `1100`+`1200` dan `1610`+`1620`.)

## 2. Income Statement (kumulatif, 10 Jan 2025 – 25 Agustus 2026)

```
Pendapatan Penjualan Toko          500.000
Pendapatan Penjualan Grosir      2.660.000
Total Pendapatan                 3.160.000

Harga Pokok Penjualan               37.500
Beban Gaji Karyawan               2.000.000
Beban Bunga Bank                    150.000
Beban Penyusutan Oven             3.000.000
Beban Penyusutan Motor            9.600.000
Total Beban                      14.787.500

Laba (Rugi) Bersih              (11.627.500)
```

## 3. Balance Sheet per 25 Agustus 2026

```
Aset:
  Kas (1100+1200)                              7.180.000
  Piutang Usaha                                 1.260.000
  Persediaan (1400+1420)                        3.882.500
  Aset Tetap (nilai perolehan, 1610+1620)      39.000.000
  Akumulasi Penyusutan (1630+1640)            (12.600.000)
  Total Aset                                   38.722.500

Liabilitas:
  Utang Usaha                                   2.350.000
  Utang Bank                                   38.000.000
  Total Liabilitas                             40.350.000

Ekuitas:
  Modal Pemilik                                10.000.000
  Laba Ditahan (closing dari Income Statement)(11.627.500)
  Total Ekuitas                                (1.627.500)

Liabilitas + Ekuitas = 40.350.000 + (1.627.500) = 38.722.500 = Total Aset ✓ Balance.
```

`Laba Ditahan` di sini **bukan baris yang pernah diposting via journal entry** — dihitung langsung oleh laporan ini dari Laba Bersih Income Statement (persis seperti dijelaskan di `docs/domain/financial-reports.md`: "Laba Bersih 'masuk' ke Equity lewat closing entry", yang levelnya laporan/kalkulasi, bukan transaksi baru di `journal_lines`).

## 4. Cash Flow — Indirect Method (10 Jan 2025 – 25 Agustus 2026)

```
Operating:
  Laba (Rugi) Bersih                         (11.627.500)
  + Beban Penyusutan (add-back, 3.000.000+9.600.000)   12.600.000
  - Kenaikan Piutang Usaha (0 -> 1.260.000)              (1.260.000)
  - Kenaikan Persediaan (0 -> 3.882.500)                 (3.882.500)
  + Kenaikan Utang Usaha (0 -> 2.350.000)                 2.350.000
  = Kas Bersih Operating                                 (1.820.000)

Investing:
  Akuisisi Oven & Motor — non-kas (langsung Utang Bank via KUR)         0

Financing:
  Setoran Modal Pemilik                                  10.000.000
  Bayar cicilan pokok Utang Bank (KUR)                    (1.000.000)
  = Kas Bersih Financing                                   9.000.000

Kenaikan Kas Bersih                                        7.180.000
```

Investing bernilai 0 bukan kelalaian — akuisisi oven (`KUR-OVEN-001`) dan motor (`KUR-MOTOR-001`) di `0015_seed_demo_fixed_assets.sql` sama-sama `Debit Aset / Kredit Utang Bank`, gak ada baris Kas tersentuh sama sekali. Persis kasus "non-cash investing & financing" yang dijelaskan di `docs/domain/financial-reports.md` — cuma di sini bukan lagi contoh ilustrasi, ini transaksi asli yang ke-seed.

Bunga cicilan KUR (Rp150.000, `5500 Beban Bunga Bank`) sudah otomatis lewat lewat Laba Bersih di Operating (Indirect method gak butuh baris terpisah buat itu); yang muncul terpisah di Financing cuma pokok pinjamannya (Rp1.000.000), karena itu murni transaksi neraca (mengurangi Utang Bank), bukan beban.

### Validasi

```
Kas Awal (sebelum transaksi pertama sistem, 10 Jan 2025)                   0
+ Kenaikan Kas Bersih (hasil hitungan Cash Flow di atas)          7.180.000
= Kas Akhir (hasil hitungan Cash Flow)                            7.180.000
                          HARUS SAMA DENGAN
Saldo Kas di Trial Balance sekarang (1100+1200)                  7.180.000
```

**Match** — 4 laporan konsisten dari ujung ke ujung, ditarik dari data riil lintas 6 fase, gak ada angka yang "bocor" di tengah jalan.

## Catatan: Kenapa Laba Bersih-nya Minus (Rugi)

Angka Rp11.627.500 rugi ini keliatan mengkhawatirkan, tapi ini **artefak bentuk data demo**, bukan cerminan bisnis Bu Nur beneran gagal — dan justru ini pelajaran pentingnya:

- **Beban Penyusutan (Rp12.600.000) mewakili SATU TAHUN PENUH 2025** (12x posting bulanan oven + 1x posting tahunan motor) untuk 2 aset besar (Rp15jt & Rp24jt) yang dibeli sekaligus di awal.
- **Pendapatan (Rp3.160.000) cuma mewakili segelintir transaksi ilustratif** dari cerita Juli-Agustus 2026 (6 baris General Ledger + beberapa invoice AR + 1 penjualan roti) — jauh dari skala transaksi harian CV Roti Barokah yang sebenarnya (kios + 3 warung langganan, tiap hari).
- Karena bagian 1-4 di atas itu snapshot **sebelum** Period Closing dijalankan, kedua angka yang beda skala waktu ini (beban 1 tahun penuh vs pendapatan sepotong 2 bulan) numpuk jadi 1 angka kumulatif yang timpang — persis skenario yang diperingatkan di `docs/domain/financial-reports.md` bagian Period Closing: tanpa reset per periode, laporan yang keliatan **bukan performa periode tertentu**, gampang menyesatkan kalau dibawa ke bank apa adanya.

Bagian 5 di bawah nunjukin gimana `close_period` menyelesaikan ini beneran — bukan cuma teori.

## 5. Tutup Buku Sungguhan — `0017_seed_demo_period_closing.sql`

Data di atas ditutup jadi **2 periode kontigu**, dipilih di titik yang masuk akal secara bisnis (batas tahun buku 2025/2026):

```sql
select close_period('2025-01-01', '2025-12-31', (select id from accounts where code = '3200'), 'TUTUP-BUKU-2025');
select close_period('2026-01-01', '2026-08-25', (select id from accounts where code = '3200'), 'TUTUP-BUKU-2026-S1');
```

**Periode A (2025 penuh)** — cuma ada akuisisi & penyusutan aset, belum ada penjualan sama sekali:
```
Total Pendapatan                        0
Total Beban (penyusutan oven+motor)    12.600.000
Laba (Rugi) Bersih Periode A          (12.600.000)
```
Closing entry: `Debit Laba Ditahan 12.600.000 / Kredit Beban Penyusutan Oven 3.000.000 / Kredit Beban Penyusutan Motor 9.600.000`.

**Periode B (1 Jan – 25 Agu 2026)** — seluruh transaksi General Ledger, AR, AP, Inventory yang udah di-seed, semuanya jatuh persis di rentang ini:
```
Total Pendapatan                3.160.000
Total Beban (HPP+gaji+bunga)    2.187.500
Laba Bersih Periode B             972.500
```
Closing entry: `Debit Pendapatan Penjualan Toko 500.000 / Debit Pendapatan Penjualan Grosir 2.660.000 / Kredit HPP 37.500 / Kredit Beban Gaji 2.000.000 / Kredit Beban Bunga Bank 150.000 / Kredit Laba Ditahan 972.500`.

### Posisi Setelah Tutup Buku (masih per 25 Agustus 2026)

Total Trial Balance/Balance Sheet **gak berubah** dari bagian 1-3 di atas (masih 66.110.000 / 38.722.500) — closing gak mengubah kebenaran angka, cuma memindah lokasinya:
- Semua akun `4100`/`4200`/`5100`/`5200`/`5500`/`5600`/`5610` sekarang **0** (udah dinolkan 2x closing entry).
- `3200 Laba Ditahan` sekarang punya saldo **nyata, keposting** `(12.600.000) + 972.500 = (11.627.500)` — bukan lagi dihitung ulang tiap kali laporan dibuka kayak di bagian 3.
- Periode yang masih **terbuka** mulai **26 Agustus 2026** — transaksi baru apa pun (dari modul mana pun) bertanggal ≤ 25 Agustus 2026 bakal ditolak sistem.

### Gotcha yang Ketemu (dan Sudah Diperbaiki): Income Statement Sempat Gak Bisa Di-Re-Query buat Periode yang Udah Ditutup

Waktu bagian 5 ini pertama ditulis, ketauan: kalau `getIncomeStatement('2026-01-01','2026-08-25')` dijalankan LAGI setelah closing di atas, hasilnya **0 Pendapatan, 0 Beban, 0 Laba** — bukan angka 972.500 yang barusan dihitung. Sebabnya: closing entry Periode B bertanggal `2026-08-25`, PERSIS di dalam rentang yang di-query ulang, jadi baris-baris penolan tadi (debit Pendapatan, kredit Beban) ikut kehitung dan membatalkan balik saldo yang baru aja dinolkan.

Ini gap nyata (sempat dicatat sebagai scope-debt, sekarang ditutup) — perbaikannya: `getIncomeStatement` sekarang secara eksplisit **mengabaikan baris dari closing entry** (dicek lewat `period_closings.journal_entry_id`) sebelum menjumlahkan saldo. Jadi `getIncomeStatement('2026-01-01','2026-08-25')` sekarang tetap balikin **Pendapatan 3.160.000, Beban 2.187.500, Laba 972.500** — persis angka historis Periode B — meski dijalankan berkali-kali kapan pun, sebelum atau sesudah periode itu ditutup. Trial Balance & Balance Sheet SENGAJA gak ikut diubah (`docs/architecture/financial-reports-schema.md` bagian "Tutup Buku") — keduanya justru butuh closing entry ikut kehitung, biar saldo kumulatif beneran nunjukin Pendapatan/Beban yang udah dinolkan.

## Simulasi Interface

Web app punya halaman `/reports` — 4 laporan read-only (`/reports/trial-balance`, `/reports/income-statement`, `/reports/balance-sheet`, `/reports/cash-flow`) dengan filter tanggal/rentang tanggal, plus `/reports/period-closing` (role `admin`/`accountant`) buat eksekusi `close_period` beneran + riwayat periode yang udah ditutup.

## Lanjutan Story

Ini laporan yang jadi tujuan akhir motivasi bisnis di `company-profile.md` — dan sekarang beneran bisa dibawa Bu Nur ke bank per periode yang jelas (bukan cuma kumulatif sejak awal), berkat Period Closing di bagian 5. Fase berikutnya di roadmap (`AGENTS.md`): **Tax handling** — pajak yang bakal dipotong dari Laba Bersih (atau omzet, tergantung skema) yang baru pertama kali punya angka konkret per periode buat dihitung di fase ini.
