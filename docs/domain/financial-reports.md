# Financial Reports — Merangkum Data Jadi Laporan yang Dibaca Bank

## Masalah yang Diselesaikan

Semua fase sebelumnya (COA → General Ledger → AR → AP → Inventory → Fixed Assets) itu **infrastruktur pengumpulan data** — tiap transaksi dicatat rapi sebagai baris jurnal berpasangan (debit/kredit). Tapi bank yang mau ngasih pinjaman modal ke Bu Nur (motivasi utama, `docs/story/company-profile.md`) gak mau baca ratusan baris jurnal mentah. Mereka minta **4 laporan standar**: Trial Balance, Income Statement (Laba Rugi), Balance Sheet (Neraca), Cash Flow Statement (Arus Kas).

Modul ini beda dari semua modul sebelumnya: **gak ada catatan baru, gak ada transaksi baru dicatat.** Financial Reports murni **merangkum ulang (read-only)** data yang udah ada sejak Fase 2 — jawab "jadi gimana kondisi bisnisnya sekarang", bukan "apa yang terjadi".

## Konsep Inti

- **Laporan ini murni lapisan baca** — gak ada kejadian bisnis baru yang tercatat di sini, gak ada dokumen sumber baru. Semua 4 laporan standar dihitung ulang dari data yang udah dicatat rapi sejak fase-fase sebelumnya.
- **Trial Balance adalah fondasi semua laporan lain** — 1 sumber angka (saldo tiap akun di satu titik waktu) yang dipakai bareng buat nyusun Income Statement DAN Balance Sheet, bukan dihitung ulang 2x terpisah dengan logic beda-beda.
- **Ada urutan wajib penyusunan** (dependency, gak bisa dibalik):
  ```
  1. Trial Balance    (agregat semua akun, titik waktu tertentu)
  2. Income Statement (dari akun Pendapatan+Beban di Trial Balance)
  3. Balance Sheet    (dari akun Aset+Liabilitas+Ekuitas, Ekuitas-nya
                        butuh Laba Bersih dari langkah 2 buat closing
                        ke Laba Ditahan)
  4. Cash Flow        (butuh Laba Bersih dari langkah 2 SEBAGAI starting
                        point, DAN butuh 2 Trial Balance — awal & akhir
                        periode — buat itung selisih Piutang/Persediaan/
                        Utang)
  ```
  Kenapa Income Statement harus duluan dari Balance Sheet: Ekuitas = Modal Pemilik + Laba Ditahan, dan Laba Ditahan adalah hasil closing dari Laba Bersih Income Statement. Tanpa itu, Neraca gak bakal balance (Ekuitas kurang komponen). Kenapa Cash Flow butuh 2 Trial Balance, bukan 1: baris "kenaikan Piutang" cuma bisa dihitung dari Piutang akhir periode dikurangi Piutang awal periode — ini satu-satunya laporan yang butuh data dari **2 titik waktu**, bukan cuma 1 titik kayak 3 laporan lainnya.
- **Kalau data-nya real, laporan-laporan ini PASTI konsisten satu sama lain** — karena semuanya berakar dari pencatatan berpasangan (debit=kredit) yang udah dijaga sejak awal. Kalau ketauan gak konsisten (Neraca gak balance, Kas hasil Cash Flow gak cocok saldo Kas beneran), itu ARTINYA ada bug di logic laporan turunan — bukan toleransi pembulatan, dan bukan berarti data mentahnya salah.
- Ada 1 skenario lengkap tervalidasi (beberapa transaksi 1 periode, keempat laporan dicocokkan satu sama lain sampai closing) yang dipakai buat ngebuktiin keempat laporan ini emang selalu konsisten — detail angka lengkapnya (angka riil, bukan ilustrasi) ada di `docs/story/financial-reports.md`.

### Trial Balance (Neraca Saldo)

**Cara Kerja**
- Daftar SEMUA akun + saldo masing-masing di 1 titik waktu, dengan total debit = total kredit (Core Invariant yang udah dijaga sejak transaksi pertama dicatat, sekarang dibuktikan ulang di level laporan).
- Cara hitung saldo 1 akun: total debit dikurangi total kredit kalau akun itu bersaldo normal debit, kebalikannya (total kredit dikurangi total debit) kalau bersaldo normal kredit — logic yang sama kayak yang dipakai buat liat riwayat 1 akun secara individual.
- Fungsinya jadi **1 sumber angka** yang dipakai buat nyusun Income Statement DAN Balance Sheet — bukan dihitung 2x terpisah.
- Catatan: pendekatan ambil-lalu-jumlahkan-apa-adanya ini cukup buat skala usaha kecil (puluhan-ratusan baris transaksi) — belum dioptimasi buat data dalam volume jauh lebih besar. Itu revisi performa ke depan kalau bisnisnya udah gede banget, bukan celah bisnis yang berlaku sekarang.

**Aturan Bisnis**
- Total debit wajib sama persis dengan total kredit — gak ada toleransi pembulatan.

**Skenario**
- Laporan Trial Balance diminta buat tanggal tertentu — hasilnya daftar semua akun + saldo di titik waktu itu, langsung kebukti balance atau enggak.
- Trial Balance gak balance — berarti ada bug di modul pencatatan sebelumnya, harusnya secara struktural gak mungkin kejadian.

**Common Mistakes**
- Neraca Saldo dianggap "boleh gak balance dikit" — kalau gak balance berarti bug, bukan toleransi pembulatan.

### Income Statement (Laba Rugi)

**Cara Kerja**
- Ambil akun Pendapatan dan Beban dari Trial Balance, buat **1 rentang waktu tertentu** (bukan snapshot 1 titik — beda dari Neraca).
  ```
  Laba Bersih = Total Pendapatan - Total Beban
  ```
- **Kenapa harus rentang waktu?** Pendapatan/Beban "reset" tiap periode (matching principle, `general-ledger.md`). Laba Rugi bulan ini beda dari Laba Rugi bulan depan, meski Neraca akhir bulan ini dan bulan depan bisa aja mirip.
- Laporan ini nutup semua Harga Pokok Penjualan/Beban yang udah dibangun dari fase-fase sebelumnya: HPP dari penjualan barang (Inventory), Beban Penyusutan dari aset tetap (Fixed Assets), Beban Gaji/Sewa/Bunga dari pencatatan manual.
- **Interaksi sama Tutup Buku**: begitu suatu periode ditutup (lihat submodule "Tutup Buku"), transaksi jurnal penutup periode itu SENGAJA dikeluarkan dari perhitungan laporan ini — biar lihat ulang Laba Rugi periode yang udah ditutup tetap nunjukin angka historis aslinya, bukan balik ke nol.

**Aturan Bisnis**
- Income Statement wajib selalu rentang waktu, gak boleh "per 1 tanggal" doang — itu gak masuk akal secara akuntansi.

**Skenario**
- Diminta laporan performa 1 bulan tertentu — hasilnya Pendapatan dikurangi Beban periode itu doang, bukan kumulatif dari awal usaha berdiri.
- Diminta ulang laporan bulan yang udah ditutup buat lihat histori — hasilnya tetap sama kayak pas pertama kali dilaporkan, gak balik ke nol walau ada jurnal penutup yang menyertai penutupan bulan itu.

**Common Mistakes**
- Income Statement dianggap snapshot kayak Neraca — salah, ini selalu laporan rentang waktu.
- Lihat ulang Laba Rugi periode yang udah ditutup ikut menghitung jurnal penutupnya sendiri — hasilnya keliatan nol, padahal seharusnya tetap nunjukin angka historis asli periode itu.

### Balance Sheet (Neraca)

**Cara Kerja**
- Ambil akun Asset, Liability, Equity dari Trial Balance, per **1 tanggal tertentu**. Harus tegakin persamaan akuntansi dari Fase 1:
  ```
  Asset = Liability + Equity
  ```
- **Bagian penting & gampang salah:** Equity bukan cuma `Modal Pemilik` — harus ditambah **Laba Ditahan** (akumulasi laba semua periode + laba periode berjalan). Laba Bersih dari Income Statement "masuk" ke Equity lewat **closing entry** (lihat submodule "Tutup Buku").
- **Akun kontra (Akumulasi Penyusutan) wajib masuk** — Aset Tetap ditampilin nilai perolehan penuh DIKURANGIN Akumulasi Penyusutan, bukan nilai perolehan mentah (`docs/domain/fixed-assets.md`, `docs/domain/chart-of-accounts.md` bagian "Akun Kontra").
- Kalau data-nya real (dari pencatatan berpasangan yang selalu balance karena double-entry), Asset **PASTI** sama dengan Liability+Equity. Kalau gak sama pas hitung Neraca beneran, berarti ada bug di query rollup (lupa 1 akun, atau lupa proses closing Laba Ditahan).

**Aturan Bisnis**
- Laba Bersih wajib di-closing ke Laba Ditahan sebelum Balance Sheet dihitung — tanpa ini, Asset ≠ Liability+Equity.
- Akumulasi Penyusutan (kontra-asset) wajib dikurangkan dari Aset Tetap di Balance Sheet — bukan ditampilin sebagai nilai perolehan mentah.

**Skenario**
- Diminta Neraca per tanggal tertentu — Asset harus sama persis dengan Liability+Equity, termasuk Laba Ditahan yang udah menyerap Laba Bersih periode berjalan.

**Common Mistakes**
- Neraca dianggap "boleh gak balance dikit" — kalau gak balance berarti bug, bukan toleransi pembulatan.
- Lupa masukin akun kontra (Akumulasi Penyusutan) di Neraca — Aset Tetap overstate (keliatan lebih besar dari nilai bukunya yang sebenarnya).
- Laba Bersih gak di-closing ke Equity — Neraca gak bakal balance.

### Cash Flow Statement (Arus Kas)

**Cara Kerja**
- Semua sistem ini pakai **accrual basis** (`general-ledger.md`: transaksi diakui pas kejadian, bukan pas kas gerak). Tapi bank juga mau tau **pergerakan kas beneran** — laba akrual bisa "besar" tapi kas abis (piutang macet, misalnya, kasus Warung Pak Budi di `accounts-receivable.md`).
- **Prinsip inti: Cash Flow cuma ngitung uang yang secara fisik masuk/keluar** — beda total dari Income Statement/Balance Sheet yang ngitung pengakuan akuntansi (accrual), bukan pergerakan kas.
- 3 kategori:
  - **Operating** — kas dari operasional harian (jual barang, bayar bahan baku, bayar gaji)
  - **Investing** — kas dari beli/jual aset tetap
  - **Financing** — kas dari pinjaman/modal (utang bank, setoran modal)
- Beda cuma di bagian **Operating** antara 2 metode — Investing dan Financing selalu sama persis di kedua metode (daftar langsung transaksi kas riil):
  - **Metode Tidak Langsung (Indirect, dipakai project ini)** — mulai dari Laba Bersih (accrual), dikoreksi balik:
    ```
    Laba Bersih
    + Beban Penyusutan (non-cash, add-back)
    - Kenaikan Piutang Usaha       (piutang naik = kas belum masuk sebesar itu)
    + Kenaikan Utang Usaha         (utang naik = kas belum keluar sebesar itu)
    - Kenaikan Persediaan          (kas keluar beli bahan, belum jadi Beban)
    = Kas Bersih dari Operating
    ```
  - **Metode Langsung (Direct)** — disusun dari nol pakai kategori kas asli (kas diterima dari pelanggan, kas dibayar ke supplier, dst), gak mulai dari Laba Bersih. Hasil akhir SAMA persis dengan Tidak Langsung, cuma jalannya beda.
  - **Kenapa project ini pakai Tidak Langsung:** datanya (Laba Bersih dari Income Statement, saldo Piutang/Persediaan/Utang dari Trial Balance) udah otomatis ada dari laporan lain — gak perlu pencatatan tambahan. Metode Langsung butuh tiap transaksi kas dikategorisasi asalnya (dari pelanggan? ke supplier? gaji?) — belum ada mekanismenya sekarang, jadi belum didukung.
  - **Kenapa Beban Penyusutan di-add-back (bukan "dibatalkan")**: Penyusutan **cuma sekali kepotong** — di Income Statement, sebagai Beban. Itu efek riil & valid, tetep ada. Masalahnya, Metode Tidak Langsung **mulai dari Laba Bersih** sebagai titik awal. Karena Laba Bersih udah kepotong penyusutan duluan, sedangkan penyusutan **gak pernah keluar kas beneran**, potongan yang "salah tempat kalau tujuannya ngitung kas" itu harus **ditambahin balik** — bukan membatalkan efeknya di Income Statement/Balance Sheet (yang tetep valid), cuma mengoreksi titik-berangkat perhitungan Cash Flow doang. Bukti tambahan: kalau pakai Metode Langsung (dari nol, bukan dari Laba Bersih), penyusutan **gak pernah muncul sama sekali** — karena penyusutan dari awal emang bukan transaksi kas. Gak ada yang perlu ditambah balik karena gak pernah kepotong duluan di jalur itu.
- **Kasus Non-Cash Investing & Financing**: kalau aset dibeli **langsung ditukar jadi utang** (bukan: dana cair dulu ke rekening, baru dibayar terpisah ke toko) — gak ada akun Kas yang kesentuh sama sekali di jurnal itu. Konsekuensinya: Investing DAN Financing sama-sama **nol** buat transaksi ini — bukan bug, ini **non-cash investing & financing activity**, kategori khusus yang wajib didokumentasiin di catatan kaki terpisah ("Aktivitas Investasi dan Pendanaan Non-Kas"), bukan disembunyiin.

**Aturan Bisnis**
- Saldo Kas Akhir hasil hitungan Cash Flow wajib dicocokkan ke saldo akun Kas di Trial Balance periode sekarang — ini cara validasi utama, bukan opsional:
  ```
  Saldo Kas Awal (dari Trial Balance periode lalu)
  + Kas Bersih Operating + Investing + Financing
  = Saldo Kas Akhir (HASIL HITUNGAN Cash Flow)
                      HARUS SAMA DENGAN
  Saldo akun Kas di Trial Balance sekarang (FAKTA)
  ```
  Saldo Kas di Trial Balance **selalu otomatis bener** (langsung dari data mentah, gak ada estimasi). Cash Flow yang harus nyocokin diri ke fakta itu. Kalau gak match, yang salah pasti logic Cash Flow-nya (adjustment kelewat/salah arah plus-minus), bukan datanya.
- Aktivitas investasi/pendanaan non-kas wajib didokumentasikan di catatan kaki, gak boleh disembunyikan cuma karena nilainya nol di laporan utama.
- **Bandingin 2 Trial Balance (lama vs sekarang) itu bahan buat NYUSUN Cash Flow, bukan cara VALIDASI-nya** — 2 hal beda: nyusun = bandingin Trial Balance periode lalu vs sekarang buat dapet delta Piutang/Persediaan/Utang; validasi = cocokin Saldo Kas Akhir hasil hitungan ke saldo akun Kas Trial Balance sekarang.

**Skenario**
- Laba akrual besar tapi kas menipis — sebagian penjualan masih piutang, belum jadi kas beneran.
- Beli aset tetap yang dibiayai langsung lewat utang bank (dana gak pernah masuk-keluar rekening kas perusahaan) — Investing dan Financing sama-sama nol buat transaksi ini, dicatat di catatan kaki.

**Common Mistakes**
- Cash Flow disamain sama Income Statement — laba besar bukan berarti kas banyak (piutang belum tertagih).
- Nganggap "beli aset = otomatis keluar di Investing" — kalau dibiayai non-kas (kredit langsung tanpa lewat akun Kas), itu nol di Investing, dicatat di catatan kaki.
- Lupa add-back Beban Penyusutan di Metode Tidak Langsung — Kas dari Operating ke-understate.
- Salah arah kenaikan Piutang/Persediaan (harusnya MINUS ke kas) vs kenaikan Utang (harusnya PLUS ke kas) — kebalik gampang banget kejadian.
- Validasi Cash Flow dikira "bandingin 2 Trial Balance" — itu bahan penyusunan, validasinya adalah cocokin Saldo Kas Akhir ke Trial Balance sekarang.

### Tutup Buku (Period Closing)

**Cara Kerja**
- Ditandai dari Fase 2 sebagai "ditunda ke Fase 7" — karena butuh Income Statement jalan dulu buat tau angka Laba Bersih definitif yang mau ditutup. Mekanisme teknis (closing entry, contoh angka) udah ditulis di `docs/domain/general-ledger.md` bagian "Period Closing" — bagian ini nambahin **konteks bisnis** yang belum dijelasin di sana.
- **Masalah dunia nyata**: Bank gak cuma minta "laporan keuangan" sekali doang — mereka minta laporan **per periode spesifik** ("Laba Rugi bulan Juli 2026", "Neraca per 31 Desember 2026"). Begitu Bu Nur nyerahin laporan itu, **laporan itu jadi dasar keputusan bank** (approve pinjaman, berapa plafon).
  - **Skenario tanpa period closing:** Bu Nur udah ngasih Laporan Laba Rugi Juli ke bank. Bank udah proses keputusan berdasarkan angka itu. Minggu depan, karyawan nemu nota belanja tepung tanggal 28 Juli yang kelupaan dicatat. Kalau sistem **boleh** nyelipin entry baru bertanggal 28 Juli (periode yang udah dilaporkan), Laba Bersih Juli **diam-diam berubah** — padahal bank udah pegang & ambil keputusan berdasarkan angka lama, dan gak pernah tau laporannya berubah tanpa sepengetahuan mereka.
  - Ini beda dari kasus "salah catat, dikoreksi lewat reversing entry" yang udah di-handle dari Fase 2 (`general-ledger.md` constraint #4) — itu emang dimaksudkan buat **KETAHUAN** ada koreksi (reversing entry kelihatan di histori). Masalah di sini soal periode yang **udah "disegel" dan dipakai pihak luar** — begitu udah dilaporkan, gak boleh diam-diam berubah, titik.
- **Masalah kedua (internal, buat Bu Nur sendiri):** dia mau tau **performa per bulan** — bulan mana untung, bulan mana rugi — buat mutusin naikin harga roti atau ganti supplier. Kalau Pendapatan/Beban gak pernah direset tiap bulan, angka yang keliatan itu **kumulatif dari awal usaha berdiri** — Laba Rugi bulan tertentu bakal keliatan gabungan hampir 3 tahun, bukan performa bulan itu doang. Gak bisa dibandingin "bulan A untung berapa vs bulan B untung berapa".
- **Solusi** (ringkas — detail teknis di `general-ledger.md`):
  1. **Tutup buku**: pindahin saldo Pendapatan/Beban periode itu ke `Laba Ditahan` (Equity, permanen), Pendapatan/Beban balik ke 0 — bulan depan mulai dari nol, bisa dibandingin performa antar bulan.
  2. **Kunci periode**: transaksi susulan yang ketauan telat gak boleh nyelonong masuk ke tanggal periode yang udah ditutup — tetep dicatat, tapi bertanggal periode **sekarang** (yang lagi berjalan), bukan dipaksa balik. Laporan yang udah dipegang bank tetep utuh, gak berubah diam-diam.
  3. Kalau suatu rentang tanggal ternyata gak punya transaksi Pendapatan/Beban sama sekali, rentang itu tetap bisa "ditutup" (buat menjaga urutan tetap bersambung) tanpa perlu bikin transaksi jurnal penutup apa pun.
- **Seberapa sering harus nutup buku?** Gak perlu tiap bulan. Cadence tutup buku (`docs/domain/general-ledger.md` bagian "Fleksibilitas Cadence") itu bebas dipilih, tapi buat skala UMKM kayak CV Roti Barokah, **tahunan** lebih pas daripada bulanan: makin sering dikunci, makin gede risiko transaksi telat "kejebak" di periode yang udah gak bisa diubah. Review performa bulanan (naikin harga roti, ganti supplier) cukup pakai laporan Income Statement biasa — itu gak mengunci apa pun, bisa dijalanin kapan aja. Tutup buku beneran (yang mengunci) paling pas diselaraskan sama momen yang emang butuh angka final: laporan tahunan ke bank, atau SPT Tahunan pajak.

**Aturan Bisnis**
- Periode harus ditutup berurutan dan tanpa jeda — gak bisa loncat (tutup periode berikutnya duluan sebelum yang sebelumnya) atau bolong (lupa nutup 1 periode).
- Periode yang sudah ditutup **gak bisa dibuka lagi** — kalau ada kesalahan, koreksinya lewat transaksi baru di periode yang sedang berjalan, bukan membongkar kunci periode lama. Ini konsisten dengan prinsip "laporan yang sudah dipegang pihak luar gak boleh diam-diam berubah". Konsekuensinya: kesalahan penutupan (misal salah pilih akun tujuan closing) gak bisa "dibatalkan" langsung, cuma bisa dikoreksi lewat transaksi baru di periode berjalan.

**Skenario**
- Laporan Laba Rugi bulan tertentu udah diserahkan ke bank, lalu ketauan ada nota belanja yang kelupaan dicatat di tanggal periode itu — kalau periode itu udah ditutup, nota itu tetap dicatat tapi bertanggal periode sekarang, bukan menyelinap masuk ke tanggal lama.
- Review performa bulanan buat mutusin naikin harga produk atau ganti supplier — cukup pakai laporan Income Statement rentang bulan itu, gak perlu nutup buku.

**Common Mistakes**
- Ngebolehin transaksi baru bertanggal masuk ke periode yang udah dilaporkan ke pihak luar — angka yang udah jadi dasar keputusan orang lain jadi diam-diam berubah tanpa mereka tau.
- Nutup buku sesering mungkin (misal tiap minggu) cuma buat "biar rapi" — makin sering dikunci, makin gede risiko transaksi telat kejebak gak bisa dikoreksi ke tanggal aslinya.
- Berharap ada jalan buat "buka lagi" periode yang salah ditutup — sengaja gak ada jalurnya, filosofinya periode yang udah dipegang pihak luar gak boleh diam-diam berubah.
