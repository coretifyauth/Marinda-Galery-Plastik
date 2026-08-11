# Story — Financial Reports: Toko Plastik Makmur Jaya

Konteks bisnis lengkap: `docs/story/company-profile.md` — baca itu dulu kalau belum (poin: kenapa Pak Herman butuh laporan keuangan yang bener, bukan cuma buku tulis, buat suatu saat ajukan pinjaman modal tambahan ke bank). Konsep: `docs/domain/financial-reports.md`. Struktur data/read-model: `memory/architecture/data/financial-reports-schema.md`.

**Beda dari file story lain**: tujuan file ini bukan cuma ngerti konsepnya, tapi bener-bener **jalan-jalan di UI beneran** — buka halaman, isi tanggal, baca tabel, klik tombol tutup buku. Tiap bagian pola-nya: narasi singkat → langkah UI konkret (menu/URL, field, tombol) → apa yang harus muncul di layar.

4 laporan pertama (Trial Balance/Income Statement/Balance Sheet/Cash Flow) murni **read-only** — dihitung on-demand dari `journal_lines` yang sudah kamu isi lewat modul-modul sebelumnya (COA, General Ledger, AR, AP, Inventory, Fixed Assets — semuanya berbasis persona Pak Herman/Toko Plastik Makmur Jaya, tapi seed sekarang cuma COA doang, jadi angka di bawah ini **ilustrasi buat latihan** — silakan input sendiri transaksi serupa lewat `/journal-entries`, `/ar-invoices`, `/ap-bills`, `/pos-sales`, `/fixed-assets` biar laporan di sini beneran keisi pas kamu coba). Tutup Buku (Period Closing) beda — itu satu-satunya bagian modul ini yang **menulis** data.

## Skenario Latihan — Angka yang Dipakai di File Ini

Bayangin Pak Herman sudah jalanin sistem dari **1 Januari 2026**. Sampai **31 Agustus 2026**, riwayat transaksinya (disederhanakan jadi 7 kejadian, cukup buat nunjukin 4 laporan nyambung satu sama lain):

Saldo awal (1 Jan 2026): **Kas Toko Rp10.000.000**, **Modal Pemilik Rp10.000.000** (setoran awal Pak Herman).

1. **10 Jan** — Beli **Mobil Pickup Antar Barang** Rp15.000.000, langsung via pinjaman bank (KUR), gak ada kas yang kesentuh sama sekali: `Debit Aset Tetap (Mobil Pickup) 15.000.000 / Kredit Utang Bank 15.000.000`.
2. **5 Feb** — Restock barang dari **PT Plastindo Jaya** (Ember Plastik 10L, Kursi Plastik Lipat) Rp3.000.000, setengah cash setengah utang: `Debit Persediaan Barang Jadi 3.000.000 / Kredit Kas Toko 1.500.000 / Kredit Utang Usaha 1.500.000`.
3. **Sepanjang Feb–Agu** — Total penjualan Rp8.000.000: **Rp4.000.000 retail lewat kios** (POS, tunai, `docs/story/pos.md`) dan **Rp4.000.000 grosir ke Warung Bu Siti** (AR Invoice, belum lunas — masih Piutang):
   ```
   Debit Kas Toko                    4.000.000
     Kredit Pendapatan Penjualan Toko        4.000.000
   Debit Piutang Usaha                4.000.000
     Kredit Pendapatan Penjualan Grosir      4.000.000
   ```
4. **Sama tanggal transaksi #3** — HPP atas penjualan itu: `Debit Harga Pokok Penjualan 2.000.000 / Kredit Persediaan Barang Jadi 2.000.000`.
5. **Tiap bulan** — Gaji Mbak Rina (kasir) total Rp1.500.000 sampai Agustus: `Debit Beban Gaji Karyawan 1.500.000 / Kredit Kas Toko 1.500.000`.
6. **Tiap bulan** — Penyusutan Mobil Pickup Rp250.000: `Debit Beban Penyusutan Mobil Pickup 250.000 / Kredit Akumulasi Penyusutan Mobil Pickup 250.000`.
7. **Agustus** — Bayar cicilan utang ke PT Plastindo Jaya Rp500.000 tunai: `Debit Utang Usaha 500.000 / Kredit Kas Toko 500.000`.

Angka-angka di 4 bagian laporan di bawah semuanya turunan langsung dari 7 kejadian ini — kalau kamu input ulang persis ini lewat UI, laporan yang kamu lihat harus persis sama.

## 1. Trial Balance

**UI:** buka `apps/erp` → sidebar **Accounting**... sebenarnya laporan gak masuk grup itu, dari topbar/menu **Reports** langsung ke `/reports` (halaman landing "Financial Reports"), klik kartu **Trial Balance** (icon timbangan) → `/reports/trial-balance`.

1. Field **"Per Tanggal"** — isi `2026-08-31`, laporan otomatis reload tiap ganti tanggal (gak ada tombol submit terpisah).
2. Tabel muncul, kolom: Kode, Akun, Kategori, Debit, Kredit.

| Akun | Saldo | Sisi |
|---|---|---|
| 1000 Kas *(header rollup, 1100+1200)* | 10.500.000 | Debit |
| 1300 Piutang Usaha | 4.000.000 | Debit |
| 1420 Persediaan Barang Jadi | 1.000.000 | Debit |
| 1600 Aset Tetap *(header rollup, hanya 1620 Kendaraan Motor yang kepakai di skenario ini)* | 15.000.000 | Debit |
| 1640 Akumulasi Penyusutan Motor | 250.000 | Kredit (kontra) |
| 2100 Utang Usaha | 1.000.000 | Kredit |
| 2200 Utang Bank | 15.000.000 | Kredit |
| 3100 Modal Pemilik | 10.000.000 | Kredit |
| 4100 Pendapatan Penjualan Toko | 4.000.000 | Kredit |
| 4200 Pendapatan Penjualan Grosir | 4.000.000 | Kredit |
| 5100 Harga Pokok Penjualan | 2.000.000 | Debit |
| 5200 Beban Gaji Karyawan | 1.500.000 | Debit |
| 5610 Beban Penyusutan Motor | 250.000 | Debit |

Total Debit = `10.500.000+4.000.000+1.000.000+15.000.000+2.000.000+1.500.000+250.000 = 34.250.000`
Total Kredit = `250.000+1.000.000+15.000.000+10.000.000+4.000.000+4.000.000 = 34.250.000` ✓

3. Perhatiin baris **"1000 Kas"** dan **"1600 Aset Tetap"** — ini akun HEADER (`parent_id` null yang punya anak), ditampilin **tebal**, indentasinya lebih dangkal dari anak-anaknya (`1100 Kas Toko`/`1200 Kas di Bank` di bawahnya sedikit menjorok ke kanan). Ini fitur rollup (`rollupAccountBalances`/`accountDepth`, `apps/erp/src/lib/reports/balances.ts`) — header gak pernah diposting langsung (leaf-only posting rule), saldonya otomatis dijumlah dari leaf-nya buat tampilan. Total kolom Debit/Kredit di baris **Total** paling bawah tabel tetap dari leaf doang, biar gak dobel-hitung.
4. Di bawah tabel muncul teks **"✓ Balance — total debit sama total kredit."** warna hijau. Kalau suatu saat merah ("✗ Gak balance"), itu bug di laporan turunan, BUKAN toleransi pembulatan yang boleh diabaikan.

## 2. Income Statement (Laba Rugi)

**UI:** dari `/reports`, klik kartu **Income Statement** (icon panah naik) → `/reports/income-statement`.

1. Dua field tanggal: **"Dari Tanggal"** dan **"Sampai Tanggal"** — isi `2026-01-01` sampai `2026-08-31`.
2. Section **Pendapatan**: baris per akun revenue + Total Pendapatan.
3. Section **Beban**: baris per akun expense + Total Beban.
4. Baris besar paling bawah: **Laba Bersih** (hijau) atau **Rugi Bersih** (merah) tergantung tanda.

```
Pendapatan Penjualan Toko          4.000.000
Pendapatan Penjualan Grosir        4.000.000
Total Pendapatan                   8.000.000

Harga Pokok Penjualan              2.000.000
Beban Gaji Karyawan                1.500.000
Beban Penyusutan Motor               250.000
Total Beban                        3.750.000

Laba Bersih                        4.250.000
```

Beda dari Trial Balance: ini rentang tanggal, bukan 1 titik waktu — pindahin salah satu field tanggal, angkanya berubah total (misal persempit ke `2026-08-01`–`2026-08-31` doang, cuma transaksi Agustus yang kehitung).

## 3. Balance Sheet (Neraca)

**UI:** dari `/reports`, klik kartu **Balance Sheet** (icon bangunan) → `/reports/balance-sheet`.

1. Field **"Per Tanggal"** — isi `2026-08-31`.
2. Layout 2 kolom: kiri **Aset**, kanan **Liabilitas** + **Ekuitas** ditumpuk.

```
Aset:
  Kas (1100+1200)                              10.500.000
  Piutang Usaha                                  4.000.000
  Persediaan Barang Jadi                         1.000.000
  Aset Tetap (nilai perolehan)                  15.000.000
  Akumulasi Penyusutan                            (250.000)
  Total Aset                                    30.250.000

Liabilitas:
  Utang Usaha                                    1.000.000
  Utang Bank                                    15.000.000
  Total Liabilitas                              16.000.000

Ekuitas:
  Modal Pemilik                                 10.000.000
  Laba Ditahan (dihitung ulang dari Income Statement)  4.250.000
  Total Ekuitas                                 14.250.000

Total Liabilitas + Ekuitas = 16.000.000 + 14.250.000 = 30.250.000 = Total Aset ✓
```

3. Perhatiin baris **Akumulasi Penyusutan** ditampilin dalam kurung `(250.000)` dengan badge kuning **"Kontra"** di sebelah namanya — ini kontra-aset, dikurangkan dari total Aset, bukan ditambah.
4. Baris **"Laba Ditahan (dihitung ulang dari Income Statement)"** — ini BUKAN saldo dari akun `3200 Laba Ditahan` yang pernah diposting via jurnal, ini dihitung ulang tiap kali halaman ini dibuka dari Laba Bersih (bagian 2). Detail kenapa gitu: `memory/architecture/data/financial-reports-schema.md` bagian Balance Sheet.
5. Di bawah, teks **"✓ Balance — Total Aset sama dengan Total Liabilitas + Ekuitas."**

## 4. Cash Flow (Arus Kas) — Indirect Method

**UI:** dari `/reports`, klik kartu **Cash Flow** (icon ombak) → `/reports/cash-flow`.

1. Field **"Dari Tanggal"** `2026-01-01`, **"Sampai Tanggal"** `2026-08-31`.
2. 3 section: **Operating**, **Investing**, **Financing**, lalu kotak abu-abu di bawah buat rekonsiliasi.

```
Operating:
  Laba Bersih                                4.250.000
  + Beban Penyusutan (add-back)                250.000
  − Kenaikan Piutang Usaha (0 → 4.000.000)  (4.000.000)
  − Kenaikan Persediaan (0 → 1.000.000)     (1.000.000)
  + Kenaikan Utang Usaha (0 → 1.000.000)     1.000.000
  Kas Bersih Operating                         500.000

Investing:
  Kas Bersih Investing                               0

Financing:
  Kas Bersih Financing                               0

Kenaikan (Penurunan) Kas Bersih                  500.000

Kas Awal                                    10.000.000
+ Kenaikan Kas Bersih                          500.000
= Kas Akhir (hasil hitungan)                10.500.000
Saldo Kas di Trial Balance (fakta)          10.500.000
```

3. **Investing bernilai 0** bukan kelalaian — Mobil Pickup (transaksi #1) dibeli `Debit Aset Tetap / Kredit Utang Bank` langsung, gak ada baris Kas yang kesentuh. Ini "non-cash investing & financing", tetap dilaporkan sebagai footnote (nilai 0 di section-nya), bukan disembunyikan.
4. Di bawah, teks **"✓ Match — Kas Akhir hasil hitungan sama dengan saldo Kas di Trial Balance."** — ini validasi wajib: kalau gak match, bug-nya di logic Cash Flow, bukan di Trial Balance (yang selalu benar langsung dari `journal_lines`).

## 5. Tutup Buku (Period Closing) — Satu-satunya Laporan yang Menulis

Akhir Agustus 2026, Pak Herman mau nutup buku periode Januari–Agustus 2026 biar Laba Bersih periode ini "resmi" — gak keubah diam-diam kalau ada transaksi telat masuk nanti, dan biar Revenue/Expense ke-reset buat mulai periode baru.

**UI:** dari `/reports`, klik kartu **Tutup Buku** (icon gembok) → `/reports/period-closing`. **Cuma role `admin`/`accountant` yang bisa lihat form ini** — role lain cuma lihat riwayat penutupan di bawahnya.

1. Kartu **"Tutup Periode Baru"** — kalau ini penutupan pertama, gak ada hint periode sebelumnya. Isi:
   - **Dari Tanggal**: `2026-01-01`
   - **Sampai Tanggal**: `2026-08-31`
   - **Akun Laba Ditahan**: pilih dari dropdown (cuma nampilin akun kategori `equity`) — pilih `3200 Laba Ditahan`.
   - **Rujukan Dokumen**: isi bebas, misal `TUTUP-BUKU-2026-S1`.
2. Baca dulu hint di bawah form: *"Saldo Pendapatan/Beban dihitung ulang langsung dari data jurnal saat ini... Setelah ditutup, rentang ini gak bisa dibuka lagi — koreksi cuma bisa lewat entry baru di periode berjalan."* — **ini beneran gak ada tombol undo**, jangan klik kalau masih ragu tanggalnya.
3. Klik tombol **Tutup Periode**. RPC `close_period` jalan: hitung ulang saldo semua akun Revenue/Expense yang aktif di rentang itu LANGSUNG dari `journal_lines` (gak percaya angka dari laporan yang mungkin sudah kamu lihat sebelumnya), bikin 1 closing entry buat nol-in semuanya + pindahin selisihnya ke `3200 Laba Ditahan`, lalu kunci rentang `2026-01-01`–`2026-08-31` dari transaksi baru.
4. Setelah sukses, tabel **"Riwayat Penutupan"** di bawah nambah 1 baris: Dari `2026-01-01`, Sampai `2026-08-31`, Rujukan `TUTUP-BUKU-2026-S1`, Closing Entry **"Ada (nol-in Pendapatan/Beban)"**.
5. Coba isi form lagi buat nutup periode yang OVERLAP (misal `2026-06-01`–`2026-07-31`, yang udah masuk rentang tertutup) — submit bakal ditolak, `FormError` merah muncul dengan pesan dari database (constraint `exclude using gist` + validasi kontiguitas di RPC).

### Efek Setelah Tutup Buku — Coba Balik Lagi ke Trial Balance & Income Statement

6. Buka lagi `/reports/trial-balance`, tanggal `2026-08-31` — **totalnya TETAP 34.250.000**, gak berubah. Tapi sekarang akun `4100`/`4200`/`5100`/`5200`/`5610` semuanya **0** (udah dinolkan closing entry), dan `3200 Laba Ditahan` sekarang punya saldo **nyata, keposting**, Rp4.250.000 — bukan lagi cuma dihitung ulang kayak sebelum ditutup.
7. Buka lagi `/reports/income-statement`, isi tanggal PERSIS rentang yang barusan ditutup (`2026-01-01`–`2026-08-31`) — **HARUS tetap muncul Pendapatan 8.000.000 / Beban 3.750.000 / Laba Bersih 4.250.000**, angka historis yang sama, BUKAN 0. Ini titik penting: closing entry Periode ini sendiri bertanggal `2026-08-31`, persis di ujung rentang yang di-query ulang — kalau baris closing entry ikut kehitung, dia bakal MEMBATALKAN BALIK saldo yang baru aja dinolkan, hasilnya 0 padahal seharusnya nampilin angka historis. `getIncomeStatement` secara eksplisit **mengabaikan baris dari closing entry** (`fetchClosingJournalEntryIds()`, cek `period_closings.journal_entry_id`) sebelum menjumlahkan, jadi angka historis tetap kebaca kapan pun laporan ini dibuka lagi.
8. Trial Balance & Balance Sheet **SENGAJA gak exclude** baris closing entry (beda dari Income Statement) — keduanya justru butuh efek closing entry ikut kehitung, biar saldo kumulatif Revenue/Expense beneran keliatan udah dinol-in.
9. Coba catat transaksi baru lewat modul mana pun (misal `/journal-entries` bikin entry manual) dengan tanggal `2026-07-15` (masuk rentang tertutup) — bakal ditolak trigger database dengan pesan *"Tanggal 2026-07-15 sudah masuk periode yang ditutup..."*. Ganti tanggalnya ke `2026-09-01` (periode berjalan, belum ditutup) — berhasil normal.

## Ringkasan Alur

```
Trial Balance (1 titik waktu, semua akun)
      ↓ Revenue/Expense
Income Statement (1 rentang tanggal) ──→ Laba Bersih
      ↓
Balance Sheet (1 titik waktu) ──→ Laba Ditahan = Laba Bersih
      ↓ + 2× Trial Balance (awal & akhir rentang)
Cash Flow (1 rentang tanggal) ──→ rekonsiliasi ke Kas Trial Balance

Tutup Buku (nulis) ──→ nol-in Revenue/Expense periode itu, kunci dari transaksi retroaktif,
                        Income Statement tetap bisa di-query ulang buat periode itu (angka historis
                        gak berubah), gak ada jalur buka lagi.
```

## Lanjutan Story

Laporan ini yang jadi tujuan akhir motivasi bisnis Pak Herman (`company-profile.md`) — bisa dibawa ke bank per periode yang jelas (bukan cuma kumulatif sejak awal) berkat Tutup Buku di bagian 5. Fase berikutnya di roadmap (`AGENTS.md`): perluasan skenario tax handling (PPN Masukan dari sisi AP — sudah ada field-nya di `/settings/charges`, tinggal skenario transaksinya digarap).
