# General Ledger & Journal Entry — Mencatat Transaksi

## Masalah yang diselesaikan

COA cuma nyiapin "kantong-kantong" akun — belum ada tempat buat nyatet kejadian bisnis harian. Dua konsep di fase ini:

- **Journal Entry** — unit pencatatan 1 kejadian bisnis, jadi ≥2 baris debit/kredit yang wajib balance.
- **General Ledger (buku besar)** — kumpulan semua journal entry yang udah diposting, dikelompokkan per akun. Ini yang jadi sumber saldo tiap akun di COA (termasuk rollup header/leaf yang udah didesain sebelumnya).

## Accrual vs Cash Basis — kenapa Piutang/Utang penting

Banyak transaksi bisnis gak dibayar tunai saat itu juga — jual dengan termin (belum dibayar pembeli), atau beli dengan utang (belum dibayar ke supplier). Ini bedain dua cara pencatatan:

- **Cash basis**: transaksi dicatat pas kas beneran berpindah tangan.
- **Accrual basis**: transaksi dicatat pas **kejadiannya terjadi** (barang/jasa udah berpindah), gak peduli kasnya udah pindah apa belum. Ini disebut **matching principle** — pendapatan/beban "dicocokkan" ke periode dia sebenarnya terjadi, bukan ke periode kasnya masuk/keluar.

Akun `Piutang Usaha` fungsinya nampung "udah berhak dapet uang, tinggal nunggu dibayar". Akun `Utang Usaha` nampung "udah wajib bayar, tinggal nunggu jatuh tempo". Dua akun ini isinya "jeda waktu" antara kejadian dan kas — makanya keduanya wajib ada di COA meski basis akuntansi accrual.

## Contoh Transaksi

| # | Kejadian | Debit | Kredit |
|---|---|---|---|
| 1 | Jual jasa/barang tunai Rp500.000 | Kas 500.000 | Pendapatan 500.000 |
| 2 | Jual jasa/barang Rp1.200.000, belum dibayar (termin) | Piutang Usaha 1.200.000 | Pendapatan 1.200.000 |
| 3 | Beli persediaan/bahan baku Rp800.000, belum dibayar | Persediaan 800.000 | Utang Usaha 800.000 |
| 4 | Bayar gaji karyawan tunai Rp2.000.000 | Beban Gaji 2.000.000 | Kas 2.000.000 |
| 5 | Bayar cicilan pinjaman bank: pokok 1.000.000 + bunga 150.000 | Utang Bank 1.000.000 + Beban Bunga 150.000 | Kas 1.150.000 |

Transaksi #5 sengaja 3 baris (**compound entry**) — nunjukin invariant `SUM(debit)=SUM(credit)` berlaku per entry, bukan cuma format 1-debit-1-kredit.

**Catatan soal #3:** beli persediaan nambah **asset** (Persediaan), bukan langsung jadi Beban/HPP — HPP baru diakui pas barangnya kejual (matching principle lagi, detail penuh di modul Inventory/COGS). Journal Entry sendiri tetap generik — gak perlu tau logic inventory, accountant yang pilih akun manual sesuai kejadian.

## Constraint Wajib (domain rules, bukan cuma teknis)

**1. Keseimbangan (`SUM(debit) = SUM(credit)` per entry)**
Konsekuensi langsung dari persamaan akuntansi (`Asset + Expense = Liability + Equity + Revenue`). Entry gak balance = persamaan itu rusak, Neraca gak akan pernah "tie" (Asset ≠ Liability+Equity).

**2. Minimal 2 baris, minimal 2 akun berbeda**
Prinsip double-entry — gak ada transaksi yang cuma "kena" 1 akun doang tanpa asal. Uang gak muncul/hilang dari kosong.

**3. Cuma leaf account yang boleh diposting**
Sama kayak aturan di `chart-of-accounts.md` — akun header (yang punya child) gak boleh nerima posting langsung, bikin rollup ambigu/dobel-hitung.

**4. Entry yang udah dibuat gak boleh diedit/dihapus — cuma boleh dibalik (reversing entry)**
Soal integritas histori: kalau history bisa diubah, laporan yang diambil hari ini bisa beda dari besok tanpa jejak kenapa. Salah catat → bikin entry BARU isinya kebalikan persis (debit↔kredit ditukar), rujuk ke entry asli. Dua-duanya (yang salah + koreksinya) tetep kelihatan di histori — itu bagian dari audit trail, bukan cacat.

**5. Wajib ada rujukan ke dokumen sumber (`source_ref`)**
Tanpa ini, journal entry cuma angka tanpa bukti — gak bisa diverifikasi pas audit atau rekonsiliasi ke nota/kuitansi/kontrak fisik.

**6. Atomicity — header+lines harus kebentuk bareng, gak boleh nanggung**
Kalau gagal di tengah proses (misal baris ke-3 dari 3 gagal), SELURUH entry (header+lines) harus batal. Entry setengah jadi lebih bahaya daripada gak ada entry sama sekali — saldo salah tanpa ketahuan.

## Period Closing (Tutup Buku)

Proses akhir suatu periode waktu (biasanya bulanan/tahunan) di mana:

1. **Akun Revenue & Expense di-nol-kan** — saldonya (selisih laba/rugi periode itu) dipindah ke `Laba Ditahan`.
2. **Periode itu dikunci** — gak ada entry baru yang boleh bertanggal masuk ke periode tsb lagi.
3. Laporan keuangan periode itu (Neraca, Laba Rugi) jadi **final**, dipakai buat pelaporan ke pihak luar (bank, pajak, investor).

### Cara Kerja Sistem — Langkah demi Langkah

Begini urutan yang beneran terjadi begitu Bu Nur (atau akuntannya) minta 1 rentang tanggal ditutup:

1. **Pilih rentang + akun tujuan.** User kasih tanggal mulai, tanggal akhir, dan akun Ekuitas mana yang jadi tujuan pemindahan laba/rugi (biasanya `Laba Ditahan`).
2. **Sistem hitung ulang sendiri, gak percaya angka yang udah pernah dilihat user.** Meski user mungkin udah ngintip laporan Income Statement sebelumnya buat cek angkanya, pas tombol "Tutup" ditekan, sistem **hitung ulang dari nol** langsung dari catatan transaksi asli buat rentang itu. Ini penting — bisa aja ada transaksi baru nyelip masuk di antara waktu user lihat laporan dan waktu dia beneran menekan tombol tutup, dan sistem gak boleh nutup pakai angka yang udah basi.
3. **Susun 1 transaksi jurnal penutup.** Tiap akun Pendapatan yang punya saldo di rentang itu di-**debit** sebesar saldonya (nol-in), tiap akun Beban di-**kredit** sebesar saldonya (nol-in). Selisih totalnya — laba atau rugi bersih periode itu — dipindah ke akun Laba Ditahan (dikredit kalau laba, didebit kalau rugi, biar transaksinya tetap balance debit=kredit).
4. **Transaksi penutup itu DULU yang dicatat, baru rentangnya ditandai tertutup — urutannya sengaja begini.** Kalau kebalik (rentang ditandai tertutup dulu, baru bikin transaksi penutup), transaksi penutup itu sendiri — yang bertanggal di hari terakhir periode itu — bakal ketolak oleh kuncian yang baru aja dia bikin sendiri. Jadi transaksi penutup itu "keburu masuk" sebelum pintunya beneran dikunci.
5. **Kalau rentang itu ternyata gak ada aktivitas Pendapatan/Beban sama sekali** (misal bulan sepi transaksi), sistem tetap mencatat rentang itu sebagai tertutup, tapi TANPA bikin transaksi jurnal penutup — gak ada yang perlu dinolkan.
6. **Sejak itu, rentangnya terkunci** — bukan cuma nolak entry jurnal manual, tapi SEMUA transaksi dari modul mana pun (invoice pelanggan, tagihan supplier, posting penyusutan, dst — lihat "Cakupan Kuncian" di bawah) yang tanggalnya jatuh di rentang itu.
7. **Sebelum semua langkah di atas jalan, ada 1 pemeriksaan urutan**: rentang yang mau ditutup wajib mulai PERSIS sehari setelah rentang terakhir yang udah ditutup berakhir. Kalau enggak, sistem nolak duluan — mencegah ada bulan yang "kelewat" (gak pernah ditutup selamanya) atau 2 rentang yang tumpang tindih.

**Kenapa Revenue/Expense harus di-nol-kan tiap periode:** dua akun ini **sementara** (temporary) — cuma rincian dari Equity yang belum ditutup (lihat derivasi persamaan akuntansi di `chart-of-accounts.md`). Kalau gak di-nol-kan, saldo Pendapatan bulan ini numpuk terus sama bulan depan — Laporan Laba Rugi bulan depan jadi keliatan gabungan 2 bulan. Asset/Liability/Equity itu **permanen** — saldonya emang harus jalan terus antar bulan (saldo kas gak di-nol-in tiap bulan).

**Contoh angka — tutup buku 1 periode:** Total Pendapatan Rp23.000.000, Total Beban (termasuk HPP & bunga) Rp10.150.000 → **Laba bersih Rp12.850.000**. Closing entry-nya:
- Debit tiap akun Pendapatan sebesar saldo masing-masing (total 23jt)
- Kredit tiap akun Beban/HPP sebesar saldo masing-masing (total 10,15jt)
- Kredit `Laba Ditahan` sebesar selisihnya (12,85jt)

Habis ini, semua akun Revenue/Expense balik ke 0, siap buat periode berikutnya. `Laba Ditahan` (akun permanen, Equity) nyimpen akumulasi laba itu terus.

**Kenapa periode yang ditutup gak boleh diutak-atik lagi:** kalau laporan periode itu udah dikasih ke pihak luar, terus ketemu ada transaksi yang kelewat catet — kalau boleh nyelundup masuk balik ke periode yang udah ditutup, laporan yang udah dipegang pihak luar diam-diam jadi salah tanpa mereka tahu. Solusinya: transaksi itu tetap dicatat, tapi tanggalnya masuk periode yang **lagi berjalan**, bukan dipaksa balik ke periode lama.

**Relasi ke constraint #4 (entry immutability):** dua-duanya soal "gak boleh diubah", tapi levelnya beda — constraint #4 berlaku **per entry individual**, berlaku dari transaksi pertama. Period closing berlaku **per rentang waktu**, baru relevan begitu ada proses tutup buku formal (butuh laporan keuangan siap dulu buat tau angka definitif yang mau ditutup). Keduanya independen: sebuah entry bisa immutable (constraint #4) di periode yang masih terbuka (belum kena constraint period closing).

### Soft Close vs Hard Close — Bukan 2 Mekanisme, Cuma 1

Istilah "tutup buku" di dunia nyata sering dipakai longgar buat 2 hal yang beda:

- **Hard close** — proses yang dijelasin di atas: closing entry BENERAN diposting (Revenue/Expense di-nol-kan), rentang tanggalnya BENERAN dikunci (gak bisa nerima entry baru lagi). Ini satu-satunya proses yang secara teknis akuntansi layak disebut "closing".
- **Soft close** (kadang disebut "interim review" atau "laporan sementara") — sekadar **melihat** angka Laba Rugi buat 1 rentang tanggal (misal buat keputusan internal bulanan), TANPA memposting closing entry apa pun dan TANPA mengunci apa pun. Revenue/Expense tetap menumpuk seperti biasa, entry baru masih bebas ditambah/dikoreksi.

Karena soft close gak mengubah data atau mengunci apa pun, dia sebenarnya bukan proses "closing" terpisah — dia cuma **menjalankan laporan Income Statement buat rentang tanggal tertentu**, sesuatu yang udah bisa dilakukan kapan pun tanpa mekanisme tambahan (`financial-reports.md`). Sistem ini cuma punya 1 mekanisme closing (yang hard), dan itu keputusan sadar — bukan gap yang kelewat.

### Cadence-nya Bebas, Bukan Dihardcode Bulanan/Tahunan

Hard close bisa dipanggil buat rentang tanggal APA PUN — 1 bulan, 1 kuartal, 1 tahun, bahkan 1 minggu. Gak ada konsep "tipe periode" yang disimpan di data; cuma tanggal mulai dan tanggal akhir. Satu-satunya aturan keras: **rentang berikutnya wajib mulai persis 1 hari setelah rentang sebelumnya berakhir** — gak boleh ada celah (periode yang kelewat gak pernah ditutup) atau lompatan urutan waktu.

### Best Practice buat Skala UMKM

Closing formal **gak perlu sering-sering**. Makin sering ditutup (misal tiap bulan), makin tinggi risiko ada transaksi telat yang "kejebak" di periode yang udah terlanjur dikunci. Buat bisnis skala CV Roti Barokah:

- **Review bulanan/mingguan** cukup pakai laporan Income Statement biasa (soft, gak dikunci) — buat mutusin hal internal (naikin harga, ganti supplier).
- **Hard close** idealnya **tahunan**, diselaraskan sama kewajiban pajak tahunan (SPT Tahunan) dan momen laporan ke pihak luar (bank). Jangan buru-buru nutup persis di 31 Desember — kasih jeda beberapa minggu di awal tahun berikutnya biar nota-nota yang telat nyampe sempat kekumpul, baru ditutup.

### Cakupan Kuncian — Berlaku ke Semua Modul, Bukan Cuma Jurnal Manual

Karena semua RPC financial write di modul lain (AR, AP, Inventory, Fixed Assets) ujung-ujungnya manggil mekanisme jurnal yang sama, kuncian hard close otomatis berlaku ke **semua jenis transaksi** begitu rentangnya ditutup — bukan cuma entry yang diinput manual: invoice AR baru, bill AP baru, posting penyusutan, goods issue, bahkan reversing entry buat koreksi, semuanya ditolak kalau tanggalnya masuk rentang yang udah ditutup. Satu-satunya jalan: catat transaksinya dengan tanggal periode yang **sedang berjalan**.

### Contoh — Kenapa Pemecahan Periode Penting (bukan cuma angka gabungan)

Ambil data CV Roti Barokah (`docs/story/financial-reports.md`): kalau dibiarkan gak pernah ditutup, Laba Rugi kumulatif (Jan 2025–Agu 2026) nunjukin **rugi Rp11.627.500** — angka yang bikin panik tapi gak jelas asalnya dari mana. Begitu dipecah jadi 2 periode kontigu:

| Periode | Pendapatan | Beban | Laba (Rugi) |
|---|---|---|---|
| 2025 (tahun akuisisi oven+motor, baru penyusutan) | 0 | 12.600.000 (penyusutan) | **(12.600.000)** — wajar, tahun investasi |
| Jan–Agu 2026 (operasional jualan) | 3.160.000 | 2.187.500 | **972.500** — untung |

`(12.600.000) + 972.500 = (11.627.500)` — **totalnya sama persis** dengan angka kumulatif. Period closing gak mengubah kebenaran angka, cuma memecahnya jadi potongan yang bisa dibaca dan dibandingkan — dari sini baru kelihatan bahwa operasional 2026 sebenarnya sehat, rugi besarnya murni dari investasi aset di 2025.

**Status:** dibangun di Fase 7 (Financial Reports), begitu Income Statement siap dipakai buat ngasih angka definitif per periode. Detail struktur data: `docs/architecture/financial-reports-schema.md` bagian "Tutup Buku".

## Common Mistakes

- Posting cuma 1 baris (lupa sisi lawannya) — pasti gagal balance, tapi kalau sistem gak validasi bakal jadi data korup.
- Edit langsung journal entry yang salah (bukan bikin reversing entry) — ngerusak audit trail.
- Posting ke akun header karena "keliatannya paling pas" — padahal harusnya ke leaf paling detail (lihat `chart-of-accounts.md`).
- Nyatet transaksi cash-basis (nunggu kas beneran pindah) padahal seharusnya accrual — bikin Piutang/Utang gak pernah dicatat, laporan gak nyerminin posisi bisnis sebenarnya.
- Lupa `source_ref` — entry jadi gak bisa ditelusuri balik ke bukti fisiknya.
- Nutup buku (hard close) kebanyakan/kesering (misal tiap minggu) buat sekadar "liat angka" — soft review pakai laporan Income Statement biasa udah cukup, gak perlu dikunci; hard close yang kesering justru naikin risiko transaksi telat kejebak di periode yang udah terkunci.
- Nganggap Laba Rugi kumulatif (belum pernah ditutup) sebagai performa "sekarang" — kalau ada aktivitas yang timing-nya beda jauh (misal beban penyusutan 1 tahun penuh numpuk sama pendapatan operasional yang baru jalan beberapa bulan), angka gabungan itu menyesatkan sampai dipecah per periode.
