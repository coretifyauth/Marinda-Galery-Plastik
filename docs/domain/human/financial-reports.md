# Financial Reports — Merangkum Data Jadi Laporan yang Dibaca Bank

## Masalah yang Diselesaikan

Semua fase sebelumnya (COA → General Ledger → AR → AP → Inventory → Fixed Assets) itu **infrastruktur pengumpulan data** — tiap transaksi dicatat rapi di `journal_lines`. Tapi bank yang mau ngasih pinjaman modal ke Bu Nur (motivasi utama, `docs/story/company-profile.md`) gak mau baca ratusan baris jurnal mentah. Mereka minta **4 laporan standar**: Trial Balance, Income Statement (Laba Rugi), Balance Sheet (Neraca), Cash Flow Statement (Arus Kas).

Modul ini beda dari semua modul sebelumnya: **gak ada tabel baru, gak ada transaksi baru dicatat.** Financial Reports murni **query/agregasi read-only** dari data yang udah ada sejak Fase 2 — jawab "jadi gimana kondisi bisnisnya sekarang", bukan "apa yang terjadi".

## 1. Trial Balance (Neraca Saldo) — Fondasi Semua Laporan Lain

Daftar SEMUA akun + saldo masing-masing di 1 titik waktu, dengan total debit = total kredit (Core Invariant yang udah dijaga sejak Fase 2, sekarang dibuktikan di level laporan).

Cara hitung saldo 1 akun: `SUM(debit) - SUM(credit)` kalau akun normal debit, kebalikannya kalau normal kredit — persis logic yang dipakai di tab Ledger `/accounts/[id]`.

**Fungsi:** jadi **1 sumber angka** yang dipakai buat nyusun Income Statement DAN Balance Sheet — bukan dihitung 2x terpisah. Kalau Trial Balance gak balance, berarti ada bug di modul sebelumnya (harusnya gak mungkin, karena `journal_lines_balance_check` udah maksa balance dari Fase 2).

## 2. Income Statement (Laba Rugi) — Laporan Periode

Ambil akun **Revenue** dan **Expense** dari Trial Balance, buat **1 rentang waktu tertentu** (bukan snapshot 1 titik — beda dari Neraca).

```
Laba Bersih = Total Revenue - Total Expense
```

**Kenapa harus rentang waktu?** Revenue/Expense "reset" tiap periode (matching principle, `general-ledger.md`). Laba Rugi Juli beda dari Laba Rugi Agustus, meski Neraca akhir Juli dan akhir Agustus sama-sama snapshot.

Ini nutup semua HPP/Beban yang udah dibangun dari fase-fase sebelumnya: HPP dari Goods Issue (Inventory), Beban Penyusutan dari `post_depreciation` (Fixed Assets), Beban Gaji/Sewa/Bunga dari Journal Entry manual.

## 3. Balance Sheet (Neraca) — Snapshot 1 Titik Waktu

Ambil akun **Asset, Liability, Equity** dari Trial Balance, per **1 tanggal tertentu**. Harus tegakin persamaan akuntansi dari Fase 1:

```
Asset = Liability + Equity
```

**Bagian penting & gampang salah:** Equity bukan cuma `Modal Pemilik` — harus ditambah **Laba Ditahan** (akumulasi laba semua periode + laba periode berjalan). Laba Bersih dari Income Statement "masuk" ke Equity lewat **closing entry**.

**Akun kontra (Akumulasi Penyusutan) wajib masuk** — Aset Tetap ditampilin nilai perolehan penuh DIKURANGIN Akumulasi Penyusutan, bukan nilai perolehan mentah (`docs/domain/human/fixed-assets.md`, `docs/domain/human/chart-of-accounts.md` bagian "Akun Kontra").

Kalau data-nya real (dari `journal_lines` yang selalu balance karena double-entry), Asset **PASTI** sama dengan Liability+Equity. Kalau gak sama pas hitung Neraca beneran, berarti ada bug di query rollup (lupa 1 akun, atau lupa proses closing Laba Ditahan).

## 4. Cash Flow Statement — Beda Lensa (Cash vs Accrual)

Semua sistem ini pakai **accrual basis** (`general-ledger.md`: transaksi diakui pas kejadian, bukan pas kas gerak). Tapi bank juga mau tau **pergerakan kas beneran** — laba akrual bisa "besar" tapi kas abis (piutang macet, misalnya, kasus Warung Pak Budi di `accounts-receivable.md`).

**Prinsip inti: Cash Flow cuma ngitung uang yang secara fisik masuk/keluar** — beda total dari Income Statement/Balance Sheet yang ngitung pengakuan akuntansi (accrual), bukan pergerakan kas.

3 kategori:
- **Operating** — kas dari operasional harian (jual roti, bayar bahan baku, bayar gaji)
- **Investing** — kas dari beli/jual aset tetap (nyambung ke Fixed Assets)
- **Financing** — kas dari pinjaman/modal (utang bank, setoran modal)

### Indirect Method vs Direct Method

Beda cuma di bagian **Operating** — Investing dan Financing selalu sama persis di kedua metode (daftar langsung transaksi kas riil).

**Indirect Method** (dipakai project ini) — mulai dari Laba Bersih (accrual), dikoreksi balik:
```
Laba Bersih
+ Beban Penyusutan (non-cash, add-back)
- Kenaikan Piutang Usaha       (piutang naik = kas belum masuk sebesar itu)
+ Kenaikan Utang Usaha         (utang naik = kas belum keluar sebesar itu)
- Kenaikan Persediaan          (kas keluar beli bahan, belum jadi Beban)
= Kas Bersih dari Operating
```

**Direct Method** — susun dari nol pakai kategori kas asli (kas diterima dari pelanggan, kas dibayar ke supplier, dst), gak mulai dari Laba Bersih. Hasil akhir SAMA persis dengan Indirect, cuma jalannya beda.

**Kenapa project ini pakai Indirect:** datanya (Laba Bersih dari Income Statement, saldo Piutang/Persediaan/Utang dari Trial Balance) udah otomatis ada dari laporan lain — gak perlu query/tagging tambahan ke `journal_lines`. Direct method butuh tiap baris `journal_lines` yang nyentuh akun Kas dikategorisasi manual (dari pelanggan? ke supplier? gaji?) — gak ada kolom buat itu di schema sekarang.

### Kenapa Beban Penyusutan Di-Add-Back (Bukan "Dibatalkan")

Penyusutan **cuma sekali kepotong** — di Income Statement, sebagai Beban. Itu efek riil & valid, tetep ada.

Masalahnya, Indirect Method **mulai dari Laba Bersih** sebagai titik awal. Karena Laba Bersih udah kepotong penyusutan duluan, sedangkan penyusutan **gak pernah keluar kas beneran**, potongan yang "salah tempat kalau tujuannya ngitung kas" itu harus **ditambahin balik** — bukan membatalkan efeknya di Income Statement/Balance Sheet (yang tetep valid), cuma mengoreksi titik-berangkat perhitungan Cash Flow doang.

Bukti tambahan: kalau pakai Direct Method (dari nol, bukan dari Laba Bersih), penyusutan **gak pernah muncul sama sekali** — karena penyusutan dari awal emang bukan transaksi kas. Gak ada yang perlu ditambah balik karena gak pernah kepotong duluan di jalur itu.

### Kasus Non-Cash Investing & Financing

Kalau aset dibeli **langsung ditukar jadi utang** (bukan: bank cairin kas dulu ke rekening, baru dibayar terpisah ke toko) — cek jurnal akuisisi Fixed Assets (`0015_seed_demo_fixed_assets.sql`):
```
Debit  Peralatan Oven (1610)     15.000.000
Kredit Utang Bank (2200)                     15.000.000
```
Gak ada akun Kas di jurnal ini. Konsekuensinya: Investing DAN Financing sama-sama **nol** buat transaksi ini — bukan bug, ini **non-cash investing & financing activity**, kategori khusus yang wajib didokumentasiin di catatan kaki terpisah ("Aktivitas Investasi dan Pendanaan Non-Kas"), bukan disembunyiin.

## 5. Period Closing — Kenapa Ini Bagian dari Fase 7

Ditandai dari Fase 2 (`docs/scope-debt/period-closing.md`) sebagai "ditunda ke Fase 7" — karena butuh Income Statement jalan dulu buat tau angka Laba Bersih definitif yang mau ditutup. Mekanisme teknis (closing entry, contoh angka) udah ditulis di `docs/domain/human/general-ledger.md` bagian "Period Closing". Bagian ini nambahin **konteks bisnis** yang belum dijelasin di sana.

### Masalah Dunia Nyata

Bank gak cuma minta "laporan keuangan" sekali doang — mereka minta laporan **per periode spesifik** ("Laba Rugi bulan Juli 2026", "Neraca per 31 Desember 2026"). Begitu Bu Nur nyerahin laporan itu, **laporan itu jadi dasar keputusan bank** (approve pinjaman, berapa plafon).

**Skenario tanpa period closing:** Bu Nur udah ngasih Laporan Laba Rugi Juli 2026 ke bank (Laba Bersih Rp2.100.000, misalnya). Bank udah proses keputusan berdasarkan angka itu. Minggu depan, karyawan nemu nota belanja tepung tanggal 28 Juli yang kelupaan dicatat. Kalau sistem **boleh** nyelipin entry baru bertanggal 28 Juli (periode yang udah dilaporkan), Laba Bersih Juli **diam-diam berubah** — padahal bank udah pegang & ambil keputusan berdasarkan angka lama, dan gak pernah tau laporannya berubah tanpa sepengetahuan mereka.

Ini beda dari kasus "salah catat, dikoreksi lewat reversing entry" yang udah di-handle dari Fase 2 (`general-ledger.md` constraint #4) — itu emang dimaksudkan buat **KETAHUAN** ada koreksi (reversing entry kelihatan di histori). Masalah di sini soal periode yang **udah "disegel" dan dipakai pihak luar** — begitu udah dilaporkan, gak boleh diam-diam berubah, titik.

**Masalah kedua (internal, buat Bu Nur sendiri):** dia mau tau **performa per bulan** — bulan mana untung, bulan mana rugi — buat mutusin naikin harga roti atau ganti supplier. Kalau Revenue/Expense gak pernah direset tiap bulan, angka yang keliatan itu **kumulatif dari awal usaha berdiri 2023** (`docs/story/company-profile.md`) — Laba Rugi Agustus 2026 bakal keliatan gabungan hampir 3 tahun, bukan performa Agustus doang. Gak bisa dibandingin "Juli untung berapa vs Agustus untung berapa".

### Solusi (Ringkas — Detail Teknis di `general-ledger.md`)

1. **Tutup buku**: pindahin saldo Revenue/Expense periode itu ke `Laba Ditahan` (Equity, permanen), Revenue/Expense balik ke 0 — bulan depan mulai dari nol, bisa dibandingin performa antar bulan.
2. **Kunci periode**: transaksi susulan yang ketauan telat gak boleh nyelonong masuk ke tanggal periode yang udah ditutup — tetep dicatat, tapi bertanggal periode **sekarang** (yang lagi berjalan), bukan dipaksa balik. Laporan yang udah dipegang bank tetep utuh, gak berubah diam-diam.

## Urutan Penyusunan (Wajib, Ada Dependency)

```
1. Trial Balance    (agregat semua akun, titik waktu tertentu)
2. Income Statement (dari akun Revenue+Expense di Trial Balance)
3. Balance Sheet    (dari akun Asset+Liability+Equity, Equity-nya
                      butuh Laba Bersih dari langkah 2 buat closing
                      ke Laba Ditahan)
4. Cash Flow        (butuh Laba Bersih dari langkah 2 SEBAGAI starting
                      point, DAN butuh 2 Trial Balance — awal & akhir
                      periode — buat itung selisih Piutang/Persediaan/
                      Utang)
```

**Kenapa Income Statement harus duluan dari Balance Sheet:** Equity = `Modal Pemilik + Laba Ditahan`, dan Laba Ditahan adalah hasil closing dari Laba Bersih Income Statement. Tanpa itu, Neraca gak bakal balance (Equity kurang komponen).

**Kenapa Cash Flow butuh 2 Trial Balance, bukan 1:** baris "kenaikan Piutang" cuma bisa dihitung dari `Piutang akhir periode (Trial Balance akhir) - Piutang awal periode (Trial Balance awal)`. Ini satu-satunya laporan yang butuh data dari **2 titik waktu**, bukan cuma 1 titik kayak 3 laporan lainnya.

## Cara Validasi

**Bandingin 2 Trial Balance (lama vs sekarang) itu bahan buat NYUSUN Cash Flow, bukan cara VALIDASI-nya.** Dua hal beda:

1. **Nyusun**: bandingin Trial Balance periode lalu vs sekarang → dapet delta Piutang/Persediaan/Utang → jadi baris-baris Cash Flow.
2. **Validasi**: Saldo Kas Akhir **hasil hitungan** Cash Flow harus **sama persis** dengan saldo akun Kas di Trial Balance periode **sekarang** (fakta langsung dari `journal_lines`, gak perlu dihitung manual — tinggal `SUM(debit)-SUM(credit)` akun Kas).

```
Saldo Kas Awal (dari Trial Balance periode lalu)
+ Kas Bersih Operating + Investing + Financing
= Saldo Kas Akhir (HASIL HITUNGAN Cash Flow)
                    HARUS SAMA DENGAN
Saldo akun Kas di Trial Balance sekarang (FAKTA)
```

Saldo Kas di Trial Balance **selalu otomatis bener** (langsung dari data mentah, gak ada estimasi). Cash Flow yang harus nyocokin diri ke fakta itu. Kalau gak match, yang salah pasti logic Cash Flow-nya (adjustment kelewat/salah arah plus-minus), bukan datanya.

## Contoh Angka Lengkap (1 Periode, Tervalidasi End-to-End)

Skenario 1 bulan CV Roti Barokah (angka ilustrasi bulat, bukan reconciliation seed asli — tapi **beneran konsisten & balance**, beda dari contoh di percakapan sebelumnya yang sengaja gak balance buat nunjukin pentingnya validasi).

**Neraca Awal Periode** (sebelum ada transaksi bulan ini):
```
Kas                10.000.000
Modal Pemilik      10.000.000
```

**7 transaksi selama periode:**

| # | Transaksi | Jurnal |
|---|---|---|
| 1 | Beli Oven Rp15.000.000, dibiayai langsung Utang Bank (non-kas) | Debit Aset Tetap 15.000.000 / Kredit Utang Bank 15.000.000 |
| 2 | Beli bahan baku Rp3.000.000, separuh cash separuh utang | Debit Persediaan 3.000.000 / Kredit Kas 1.500.000 / Kredit Utang Usaha 1.500.000 |
| 3 | Jual roti Rp8.000.000, separuh cash separuh piutang | Debit Kas 4.000.000 / Debit Piutang 4.000.000 / Kredit Pendapatan 8.000.000 |
| 4 | HPP atas penjualan itu, bahan baku senilai Rp2.000.000 | Debit HPP 2.000.000 / Kredit Persediaan 2.000.000 |
| 5 | Bayar gaji cash Rp1.500.000 | Debit Beban Gaji 1.500.000 / Kredit Kas 1.500.000 |
| 6 | Penyusutan oven bulan ini Rp250.000 | Debit Beban Penyusutan 250.000 / Kredit Akumulasi Penyusutan 250.000 |
| 7 | Bayar sebagian Utang Usaha cash Rp500.000 | Debit Utang Usaha 500.000 / Kredit Kas 500.000 |

### 1. Trial Balance (akhir periode)

| Akun | Saldo | Sisi |
|---|---|---|
| Kas | 10.500.000 | Debit |
| Piutang Usaha | 4.000.000 | Debit |
| Persediaan | 1.000.000 | Debit |
| Aset Tetap | 15.000.000 | Debit |
| HPP | 2.000.000 | Debit |
| Beban Gaji | 1.500.000 | Debit |
| Beban Penyusutan | 250.000 | Debit |
| Akumulasi Penyusutan | 250.000 | Kredit (kontra) |
| Utang Usaha | 1.000.000 | Kredit |
| Utang Bank | 15.000.000 | Kredit |
| Modal Pemilik | 10.000.000 | Kredit |
| Pendapatan | 8.000.000 | Kredit |

Total Debit = `10.500.000+4.000.000+1.000.000+15.000.000+2.000.000+1.500.000+250.000 = 34.250.000`
Total Kredit = `250.000+1.000.000+15.000.000+10.000.000+8.000.000 = 34.250.000` ✓ **Balance.**

### 2. Income Statement (periode ini)

```
Pendapatan                    8.000.000
- HPP                         2.000.000
- Beban Gaji                  1.500.000
- Beban Penyusutan              250.000
= Laba Bersih                 4.250.000
```

### 3. Balance Sheet (akhir periode)

```
Asset:
  Kas                                10.500.000
  Piutang Usaha                       4.000.000
  Persediaan                          1.000.000
  Aset Tetap                         15.000.000
  Akumulasi Penyusutan                (250.000)
  Total Asset                        30.250.000

Liability:
  Utang Usaha                         1.000.000
  Utang Bank                         15.000.000
  Total Liability                    16.000.000

Equity:
  Modal Pemilik                      10.000.000
  Laba Ditahan (closing dari #2)      4.250.000
  Total Equity                       14.250.000

Liability + Equity = 16.000.000 + 14.250.000 = 30.250.000 = Total Asset ✓ Balance.
```

### 4. Cash Flow (Indirect Method)

```
Operating:
  Laba Bersih                                4.250.000
  + Beban Penyusutan (add-back)                250.000
  - Kenaikan Piutang (0 -> 4.000.000)       (4.000.000)
  + Kenaikan Utang Usaha (0 -> 1.000.000)     1.000.000
  - Kenaikan Persediaan (0 -> 1.000.000)     (1.000.000)
  = Kas Bersih Operating                       500.000

Investing:
  Beli Oven — non-cash (langsung Utang Bank)          0

Financing:
  Terima Utang Bank — non-cash (langsung ke aset)     0

Kenaikan Kas Bersih Periode Ini                       500.000
```

### Validasi

```
Kas Awal Periode                 10.000.000
+ Kenaikan Kas Bersih                500.000
= Kas Akhir (hasil hitungan CF)  10.500.000
                HARUS SAMA DENGAN
Saldo akun Kas di Trial Balance  10.500.000   <- cocok! (poin 1 di atas)
```

**Match** — 4 laporan ini konsisten satu sama lain, gak ada angka yang "bocor" di tengah jalan.

## Constraint Wajib

**1. Trial Balance total debit harus sama total kredit**
Kalau enggak, ada bug di modul lain — laporan ini gak boleh "toleransi pembulatan dikit", harus exact.

**2. Income Statement selalu rentang waktu, Balance Sheet selalu snapshot**
Gak boleh ketuker — Income Statement "per 31 Desember" doang gak masuk akal, harus "Januari-Desember".

**3. Laba Bersih wajib di-closing ke Laba Ditahan sebelum Balance Sheet dihitung**
Tanpa ini, Asset ≠ Liability+Equity.

**4. Akumulasi Penyusutan (kontra-asset) wajib dikurangkan dari Aset Tetap di Balance Sheet**
Bukan ditampilin sebagai nilai perolehan mentah.

**5. Saldo Kas Akhir Cash Flow wajib dicocokkan ke saldo akun Kas Trial Balance sekarang**
Cara validasi utama, bukan opsional.

## Common Mistakes

- Neraca dianggap "boleh gak balance dikit" — kalau gak balance berarti bug, bukan toleransi pembulatan.
- Lupa masukin akun kontra (Akumulasi Penyusutan) di Neraca — Aset Tetap overstate.
- Income Statement dianggap snapshot kayak Neraca — salah, selalu rentang waktu.
- Laba Bersih gak di-closing ke Equity — Neraca gak bakal balance.
- Cash Flow disamain sama Income Statement — laba besar bukan berarti kas banyak (piutang belum tertagih).
- Nganggap "beli aset = otomatis keluar di Investing" — kalau dibiayai non-kas (KUR langsung tanpa lewat akun Kas), itu nol di Investing, dicatat di catatan kaki.
- Lupa add-back Beban Penyusutan di Indirect Method — Kas dari Operating ke-understate.
- Salah arah kenaikan Piutang/Persediaan (harusnya MINUS ke kas) vs kenaikan Utang (harusnya PLUS ke kas) — kebalik gampang banget kejadian.
- Validasi Cash Flow dikira "bandingin 2 Trial Balance" — itu bahan penyusunan, validasinya adalah cocokin Saldo Kas Akhir ke Trial Balance sekarang.

## Belum Termasuk (di luar scope fase ini)

- Direct Method Cash Flow — butuh tagging kategori tiap baris `journal_lines` yang nyentuh akun Kas, belum ada mekanismenya.
- Period closing formal (lock periode, larangan posting retroaktif) — `docs/scope-debt/period-closing.md`.
- Trial Balance rollup performance buat data besar — `docs/scope-debt/trial-balance-rollup.md`.
