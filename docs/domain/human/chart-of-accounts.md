# Chart of Accounts (COA) — Fondasi Pencatatan Keuangan

## Masalah yang diselesaikan

Tanpa COA, transaksi dicatat asal tanpa kategori baku — gak bisa jawab "kas berapa?", "utang berapa?" secara terstruktur. COA adalah daftar master semua "kantong" keuangan (**akun**) yang dipakai buat mengelompokkan setiap transaksi. Semua modul lain (GL, AR, AP, dst) nempel ke akun-akun di COA ini, makanya COA jadi fase pembangunan pertama.

## 5 Kategori Akun

Tiap akun wajib masuk salah satu dari 5 kategori, masing-masing punya **normal balance** (arah saldo wajar):

| Kategori | Contoh | Normal Balance |
|---|---|---|
| Asset (Harta) | Kas, Piutang, Persediaan, Aset Tetap | Debit |
| Liability (Utang) | Utang Usaha, Utang Bank | Kredit |
| Equity (Modal) | Modal Pemilik, Laba Ditahan | Kredit |
| Revenue (Pendapatan) | Pendapatan Jasa, Pendapatan Penjualan | Kredit |
| Expense (Beban) | Beban Gaji, Beban Sewa, HPP | Debit |

Kode akun (account code) konvensi umum: 1xxx Asset, 2xxx Liability, 3xxx Equity, 4xxx Revenue, 5xxx Expense — dipakai buat sorting laporan keuangan.

## Struktur Hierarkikal — Akun Bisa Dipecah (Parent-Child)

Satu akun bisa **dipecah** jadi beberapa sub-akun (child) buat nambah detail, tanpa bikin kategori baru. Ini yang bikin COA disebut *hierarchical* — bentuknya pohon (tree), bukan daftar datar.

**Contoh nyata, 3 level:**

```
1000 Kas                          <- akun induk (header)
├── 1001 Kas Kecil                <- child level 1
└── 1002 Kas di Bank
    ├── 1002.1 Bank BCA           <- child level 2 (cucu dari 1000)
    └── 1002.2 Bank Mandiri
```

**Kenapa dipecah begini?** Dua kebutuhan yang beda tapi harus dipenuhi bareng:
- **Direksi/owner** mau lihat ringkas: "Kas total berapa?" — cukup lihat saldo akun induk `1000 Kas`, gak perlu tau detail per bank.
- **Bagian finance/audit** butuh detail: "Saldo di BCA vs Mandiri masing-masing berapa?" — butuh akun sedetail `1002.1 Bank BCA`.

Hierarki nyelesain dua kebutuhan ini sekaligus: saldo akun induk = **penjumlahan (rollup)** semua saldo child di bawahnya, sampai level paling dalam.

### Rule penting: transaksi cuma boleh nempel di akun paling bawah (leaf/detail)

Ini yang sering kelewat: **akun induk (header) — yang masih punya child — TIDAK boleh nerima posting transaksi langsung.** Yang boleh dicatat transaksi cuma akun yang gak punya child lagi (disebut *leaf account* atau *detail account*, lawannya *header account*).

Kenapa? Kalau `1000 Kas` (header) sekaligus dipakai buat posting langsung DAN juga jadi rollup dari `1001`+`1002`, saldonya bakal dobel-hitung atau gak jelas — transaksi cash yang mana yang masuk situ, cash kecil atau cash bank? Solusinya: begitu akun punya anak, dia otomatis jadi header-only, transaksi wajib turun ke level paling detail.

Contoh salah: bayar sewa dicatat langsung ke `1000 Kas` padahal seharusnya ke `1001 Kas Kecil` (kalau bayar cash fisik) atau `1002.1 Bank BCA` (kalau transfer). Contoh benar: selalu posting ke leaf-nya, saldo header otomatis ke-update lewat rollup.

## Kaitan ke Kode Akun

Kode gak wajib pakai titik kayak contoh di atas (`1002.1`) — itu cuma salah satu cara render. Yang wajib secara struktur data: tiap akun nyimpen referensi ke `parent_id`-nya (lihat `docs/architecture/data/coa-schema.md`). Dari situ sistem bisa hitung level kedalaman dan rollup otomatis, gak peduli formatnya kode kayak apa.

## Kenapa Expense di kiri (Debit) dan Revenue di kanan (Kredit)

Akar jawabannya: persamaan akuntansi.

```
Asset = Liability + Equity
Equity = Modal Disetor + Laba Ditahan
Laba Ditahan = Revenue - Expense
```

Gabung dan pindahin Expense ke kiri:

```
Asset + Expense = Liability + Modal + Revenue
```

Expense "nempel" di sisi kiri (Debit) bareng Asset karena dia MENGURANGI Equity — kebalikan arah dari Equity. Revenue "nempel" di sisi kanan (Kredit) bareng Liability+Modal karena dia MENAMBAH Equity — searah dengan Equity.

Expense dan Revenue sebenarnya cuma rincian sementara dari Equity (laba/rugi periode berjalan), sebelum ditutup ke Laba Ditahan di akhir periode.

## Debit & Kredit — bukan "uang masuk/keluar"

Debit/Kredit di akuntansi cuma posisi pencatatan (kiri/kanan) di sistem **double-entry bookkeeping**. Tiap transaksi wajib dicatat di 2 sisi, dan total Debit harus sama dengan total Kredit (Core Invariant: `SUM(debit) = SUM(credit)`).

Efek Debit/Kredit tergantung kategori akun:

| Kategori | Debit = | Kredit = |
|---|---|---|
| Asset | nambah | berkurang |
| Expense | nambah | berkurang |
| Liability | berkurang | nambah |
| Equity | berkurang | nambah |
| Revenue | berkurang | nambah |

## Contoh angka

**Owner setor modal cash Rp 50.000.000**
- Debit Kas Rp 50jt (Asset nambah)
- Kredit Modal Pemilik Rp 50jt (Equity nambah)

**Bayar sewa toko cash Rp 5.000.000**
- Debit Beban Sewa Rp 5jt (Expense nambah)
- Kredit Kas Rp 5jt (Asset berkurang)

**Jual jasa Rp 3.000.000, belum dibayar (piutang)**
- Debit Piutang Usaha Rp 3jt (Asset nambah)
- Kredit Pendapatan Jasa Rp 3jt (Revenue nambah)

**Kasus gabungan — cek keseimbangan Asset = Equity:**
Modal awal Rp 10jt (Kas=10jt, Equity=10jt).
- Jual jasa cash Rp 2jt: Debit Kas 2jt, Kredit Pendapatan 2jt → Equity ikut naik jadi 12jt
- Bayar gaji cash Rp 500rb: Debit Beban Gaji 500rb, Kredit Kas 500rb → Equity ikut turun jadi 11,5jt
- Asset akhir = 10jt+2jt-500rb = 11,5jt. Equity akhir = 10jt+2jt-500rb = 11,5jt. Balance.

## Common Mistake

- Bikin akun terlalu granular di awal (misal akun kas per meja kasir per cabang) — bikin COA bengkak, susah maintain. Solusi: pakai dimensi lain (cost center/department), bukan bikin akun baru.
- Salah kategori — misal Utang Usaha dimasukin ke Expense padahal Liability. Bikin Balance Sheet vs Income Statement salah total.
- Lupa normal balance saat validasi — sistem gak bisa deteksi user salah debit/kredit dari sisi logika bisnis kalau field ini gak dipakai (walau SUM tetap balance).
- Posting transaksi langsung ke akun header (akun yang masih punya child) — bikin saldo rollup gak jelas/dobel-hitung. Transaksi wajib ke leaf account paling detail.
