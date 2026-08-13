# Chart of Accounts (COA) — Fondasi Pencatatan Keuangan

## Masalah yang Diselesaikan

Tanpa COA, transaksi dicatat asal tanpa kategori baku — gak bisa jawab "kas berapa?", "utang berapa?" secara terstruktur. COA adalah daftar master semua "kantong" keuangan (**akun**) yang dipakai buat mengelompokkan setiap transaksi. Semua modul lain (GL, AR, AP, dst) nempel ke akun-akun di COA ini, makanya COA jadi fase pembangunan pertama.

## Konsep Inti

**5 Kategori Akun**

Tiap akun wajib masuk salah satu dari 5 kategori, masing-masing punya **normal balance** (arah saldo wajar):

| Kategori | Contoh | Normal Balance |
|---|---|---|
| Asset (Harta) | Kas, Piutang, Persediaan, Aset Tetap | Debit |
| Liability (Utang) | Utang Usaha, Utang Bank | Kredit |
| Equity (Modal) | Modal Pemilik, Laba Ditahan | Kredit |
| Revenue (Pendapatan) | Pendapatan Jasa, Pendapatan Penjualan | Kredit |
| Expense (Beban) | Beban Gaji, Beban Sewa, HPP | Debit |

Kode akun (account code) konvensi umum: 1xxx Asset, 2xxx Liability, 3xxx Equity, 4xxx Revenue, 5xxx Expense — dipakai buat sorting laporan keuangan.

**Struktur Hierarkikal — Akun Bisa Dipecah (Parent-Child)**

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

Kode gak wajib pakai titik kayak contoh di atas (`1002.1`) — itu cuma salah satu cara render. Yang wajib secara struktur data: tiap akun menyimpan referensi ke akun induknya. Dari situ sistem bisa hitung level kedalaman dan rollup otomatis, gak peduli formatnya kode kayak apa.

**Rule penting: transaksi cuma boleh nempel di akun paling bawah (leaf/detail)**

Ini yang sering kelewat: **akun induk (header) — yang masih punya child — TIDAK boleh nerima posting transaksi langsung.** Yang boleh dicatat transaksi cuma akun yang gak punya child lagi (disebut *leaf account* atau *detail account*, lawannya *header account*).

Kenapa? Kalau `1000 Kas` (header) sekaligus dipakai buat posting langsung DAN juga jadi rollup dari `1001`+`1002`, saldonya bakal dobel-hitung atau gak jelas — transaksi cash yang mana yang masuk situ, cash kecil atau cash bank? Solusinya: begitu akun punya anak, dia otomatis jadi header-only, transaksi wajib turun ke level paling detail.

Contoh salah: bayar sewa dicatat langsung ke `1000 Kas` padahal seharusnya ke `1001 Kas Kecil` (kalau bayar cash fisik) atau `1002.1 Bank BCA` (kalau transfer). Contoh benar: selalu posting ke leaf-nya, saldo header otomatis ke-update lewat rollup.

Aturan ini gak cuma berlaku sekali pas transaksi pertama — begitu sebuah akun leaf sudah pernah dipakai mencatat transaksi, akun itu juga gak boleh "diam-diam" berubah jadi header cuma dengan menambah akun anak baru di bawahnya. Kalau dibiarkan, itu melanggar rule leaf-only-posting secara retroaktif buat histori transaksi yang sudah ada — jadi penambahan anak baru semacam itu ditolak.

**Kenapa Expense di Kiri (Debit) dan Revenue di Kanan (Kredit)**

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

**Debit & Kredit — Bukan "Uang Masuk/Keluar"**

Debit/Kredit di akuntansi cuma posisi pencatatan (kiri/kanan) di sistem **double-entry bookkeeping**. Tiap transaksi wajib dicatat di 2 sisi, dan total Debit harus sama dengan total Kredit (Core Invariant: SUM(debit) = SUM(credit)).

Efek Debit/Kredit tergantung kategori akun:

| Kategori | Debit = | Kredit = |
|---|---|---|
| Asset | nambah | berkurang |
| Expense | nambah | berkurang |
| Liability | berkurang | nambah |
| Equity | berkurang | nambah |
| Revenue | berkurang | nambah |

**Contoh Angka**

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

**Peran & Hak Akses**

Ada 3 peran: **admin** (full access + kelola user/peran), **accountant** (bikin/ubah transaksi & COA), **viewer** (read-only). Semua user yang sudah login boleh melihat daftar akun (termasuk yang diarsipkan) — data COA itu referensi bersama, semua peran butuh lihat buat kerja (viewer pun perlu tau daftar akun buat baca laporan). Menambah atau mengubah akun cuma boleh dilakukan admin atau accountant. Menghapus akun secara permanen **tidak bisa dilakukan siapapun** — ini sengaja ditutup total, sesuai aturan "arsip, bukan hapus" di bawah.

Menetapkan peran ke user lain lewat aplikasi (misal layar "User Management") sekarang masih ditunda — assign peran masih dilakukan manual di luar aplikasi, karena butuh mekanisme keamanan tambahan (mencegah user biasa menaikkan perannya sendiri jadi admin) yang belum digarap.

**Akun yang Sudah Dipakai Transaksi Jadi "Terkunci" Sebagian**

Begitu sebuah akun pernah dipakai mencatat transaksi, kode, kategori, sisi normal, posisi induk, dan status kontra akun itu gak bisa diubah lagi — mencegah histori laporan lama berubah makna secara diam-diam (misal akun yang tadinya dicatat sebagai "Kas" tau-tau diubah kategorinya jadi "Piutang" padahal udah dipakai bertransaksi bertahun-tahun, bikin laporan lama jadi salah baca). Nama akun tetap boleh diganti kapan saja (misal typo) — itu gak mengubah makna histori.

Akun yang sudah pernah dipakai mencatat transaksi tidak pernah benar-benar dihapus — cuma bisa "diarsipkan", supaya akun itu tetap ada di histori dan laporan masa lalu tetap bisa dibaca dengan benar. Akun yang belum pernah dipakai sama sekali (baru dibuat, salah bikin, dsb) boleh dihapus permanen — gak ada histori yang perlu dijaga.

Beberapa kesalahan pemahaman yang sering kejadian di seputar konsep inti ini:
- Bikin akun terlalu granular di awal (misal akun kas per meja kasir per cabang) — bikin COA bengkak, susah maintain. Solusi: pakai dimensi lain (cost center/department), bukan bikin akun baru.
- Salah kategori — misal Utang Usaha dimasukin ke Expense padahal Liability. Bikin Balance Sheet vs Income Statement salah total.
- Lupa normal balance saat validasi — sistem gak bisa deteksi user salah debit/kredit dari sisi logika bisnis kalau field ini gak dipakai (walau SUM tetap balance).
- Posting transaksi langsung ke akun header (akun yang masih punya child) — bikin saldo rollup gak jelas/dobel-hitung. Transaksi wajib ke leaf account paling detail.

### Akun Kontra (Contra Account)

**Cara Kerja**
- Aturan normal balance di atas (tabel 5 kategori) punya 1 pengecualian yang disengaja: **akun kontra**. Kategorinya tetep ikut akun induknya, tapi arah normal balance-nya kebalik dari default kategori itu.
- **Definisi presisi:** akun kontra adalah akun yang normal balance-nya **tetap konsisten** (gak goyang-goyang, sama kayak akun biasa), tapi arahnya **berlawanan dari aturan default kategorinya sendiri**. Bukan "kadang debit kadang kredit" — begitu ditentukan arahnya, dia selalu konsisten ke arah itu, cuma arahnya beda dari saudara-saudara sekategorinya.
- Fungsinya: nampung **pengurang** dari akun pasangannya, tanpa menyentuh saldo akun pasangan itu — biar histori nilai kotor (gross) tetap utuh dan bisa ditelusur balik, sementara nilai bersih (net) tetap bisa dihitung dengan menjumlahkan keduanya.
- **Simulasi — kalau akun kontra gak ada, apa yang rusak:** Motor Rp24.000.000, disusutkan Rp500.000/bulan, 3 bulan jalan, **tanpa** akun kontra (kredit langsung ke akun Motor):

  | Tanggal | Keterangan | Debit | Kredit | Saldo Motor |
  |---|---|---|---|---|
  | 1 Jan | Beli motor | 24.000.000 | | 24.000.000 |
  | 31 Jan | Penyusutan bulan 1 | | 500.000 | 23.500.000 |
  | 28 Feb | Penyusutan bulan 2 | | 500.000 | 23.000.000 |
  | 31 Mar | Penyusutan bulan 3 | | 500.000 | 22.500.000 |

  Saldo akun Motor sekarang `22.500.000` — angka campuran. Tanya "motor ini beli berapa dulu?" gak bisa dijawab dari saldo, harus gali ulang baris paling atas (makin susah kalau udah jalan bertahun-tahun, puluhan baris penyusutan).

  **Dengan** akun kontra (Akumulasi Penyusutan Motor, akun terpisah):

  Akun **Motor** (gak pernah disentuh lagi setelah akuisisi):

  | Tanggal | Keterangan | Debit | Kredit | Saldo |
  |---|---|---|---|---|
  | 1 Jan | Beli motor | 24.000.000 | | 24.000.000 |

  Akun **Akumulasi Penyusutan Motor** (baru, kategori asset, normal kredit — kebalik dari asset biasa):

  | Tanggal | Keterangan | Debit | Kredit | Saldo |
  |---|---|---|---|---|
  | 31 Jan-31 Mar | 3x penyusutan | | 500.000/bulan | 1.500.000 |

  Tanya "beli berapa dulu?" → langsung liat akun Motor: `24.000.000`. Tanya "udah disusutkan berapa?" → langsung liat Akumulasi Penyusutan: `1.500.000`. Nilai buku (`24.000.000 - 1.500.000 = 22.500.000`) sama persis kayak skenario tanpa kontra — **bukan soal angka akhir beda, soal informasi apa yang ketinggalan di jalan**.
- **Contoh lain lintas kategori:**

  | Kategori Induk | Akun Biasa (normal) | Akun Kontra (normal kebalik) | Dipakai di Modul |
  |---|---|---|---|
  | Asset (normal debit) | Aset Tetap | **Akumulasi Penyusutan** (kredit) | Fixed Assets |
  | Asset (normal debit) | Piutang Usaha | **Cadangan Kerugian Piutang** (kredit) — estimasi piutang gak ketagih, piutang riil tetap utuh buat dasar nagih | AR |
  | Revenue (normal kredit) | Pendapatan Penjualan | **Retur & Potongan Penjualan** (debit) — retur dicatat terpisah, gak langsung ngurangin Pendapatan | AR/AP |

  Pola yang selalu berulang: kategori ikut induk, arah kebalik, fungsi selalu mengurangi nilai gross tanpa menghapus histori aslinya.
- **Analogi:** Akun biasa kayak "berat badan sekarang" — berdiri sendiri, punya makna tanpa perlu akun lain. Akun kontra kayak "total berat yang udah turun dari awal diet" — gak ada artinya sendirian (butuh tau berat awal buat masuk akal), tapi dua-duanya dibutuhin bareng buat tau "berat awal berapa" DAN "progress penurunan berapa".

**Aturan Bisnis**
- Kategori akun kontra tetap ikut kategori akun pasangannya — cuma arah normal balance yang dibalik dari default kategori itu, bukan kategorinya sendiri yang berubah.
- Begitu arah normal balance akun kontra ditentukan, dia selalu konsisten ke arah itu — bukan "kadang debit kadang kredit" tergantung transaksi.
- Akun kontra cuma boleh menampung pengurang dari akun pasangannya — gak boleh menyentuh/mengubah saldo akun pasangan itu langsung.

**Skenario**
- Status saat ini di project ini: sampai fase Inventory (fase 5), COA project ini **belum punya** satupun akun kontra — semua akun asset yang lahir (Kas, Piutang, Persediaan, Aset Tetap) normal debit polos. Aturan normal balance yang dipakai sekarang masih rigid tanpa pengecualian — ini justru secara struktural **mencegah** siapapun keceplosan bikin akun kontra sebelum desainnya siap.
- Gap ini baru diselesaikan nanti di fase Fixed Assets, begitu kebutuhan pertama muncul (Akumulasi Penyusutan buat aset tetap yang disusutkan) — desain akun kontra dan penguncian yang ikut menjaganya dibahas detail di situ.

**Common Mistakes**
- Kredit langsung ke akun pasangannya (misal Aset Tetap dikredit langsung tiap kali ada penyusutan) alih-alih ke akun kontra terpisah — nilai gross (harga perolehan asli) jadi ketutup histori campuran, gak bisa dijawab lagi dari saldo akun itu doang.
- Menganggap akun kontra "berdiri sendiri" tanpa akun pasangannya — gak ada artinya sendirian, karena fungsinya emang buat dibaca bareng akun pasangan (analogi berat badan vs progress penurunan berat di atas).
