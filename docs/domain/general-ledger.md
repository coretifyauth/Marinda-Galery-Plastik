# General Ledger & Journal Entry — Mencatat Transaksi

## Masalah yang Diselesaikan

COA cuma nyiapin "kantong-kantong" akun — belum ada tempat buat nyatet kejadian bisnis harian. Dua konsep di fase ini:

- **Journal Entry** — unit pencatatan 1 kejadian bisnis, jadi ≥2 baris debit/kredit yang wajib balance.
- **General Ledger (buku besar)** — kumpulan semua journal entry yang udah diposting, dikelompokkan per akun. Ini yang jadi sumber saldo tiap akun di COA (termasuk rollup header/leaf yang udah didesain sebelumnya).

## Konsep Inti

- **Journal Entry** — unit pencatatan 1 kejadian bisnis, minimal 2 baris debit/kredit yang saling melengkapi dan wajib balance. Ini unit dasar yang dipakai SEMUA modul lain (AR, AP, Inventory, Fixed Assets, dst) buat nyatet efek keuangannya — gak ada modul yang punya jalur pencatatan sendiri di luar ini.
- **General Ledger (Buku Besar)** — kumpulan seluruh journal entry yang udah tercatat, dikelompokkan per akun. Jadi sumber saldo tiap akun di Chart of Accounts, termasuk rollup akun induk dari saldo semua akun anaknya.

**Accrual vs Cash Basis — kenapa Piutang/Utang penting**

Banyak transaksi bisnis gak dibayar tunai saat itu juga — jual dengan termin (belum dibayar pembeli), atau beli dengan utang (belum dibayar ke supplier). Ini bedain dua cara pencatatan:

- **Cash basis**: transaksi dicatat pas kas beneran berpindah tangan.
- **Accrual basis**: transaksi dicatat pas **kejadiannya terjadi** (barang/jasa udah berpindah), gak peduli kasnya udah pindah apa belum. Ini disebut **matching principle** — pendapatan/beban "dicocokkan" ke periode dia sebenarnya terjadi, bukan ke periode kasnya masuk/keluar.

Akun `Piutang Usaha` fungsinya nampung "udah berhak dapet uang, tinggal nunggu dibayar". Akun `Utang Usaha` nampung "udah wajib bayar, tinggal nunggu jatuh tempo". Dua akun ini isinya "jeda waktu" antara kejadian dan kas — makanya keduanya wajib ada di COA meski basis akuntansi accrual.

**Contoh Transaksi** (pola generik, nominal konkret ada di `docs/story/general-ledger.md`)

| # | Kejadian | Debit | Kredit |
|---|---|---|---|
| 1 | Jual jasa/barang secara tunai | Kas | Pendapatan |
| 2 | Jual jasa/barang dengan termin, belum dibayar | Piutang Usaha | Pendapatan |
| 3 | Beli persediaan/bahan baku, belum dibayar | Persediaan | Utang Usaha |
| 4 | Bayar gaji karyawan tunai | Beban Gaji | Kas |
| 5 | Bayar cicilan pinjaman bank: pokok + bunga | Utang Bank + Beban Bunga | Kas |

Transaksi #5 sengaja 3 baris (**compound entry**) — nunjukin invariant `SUM(debit)=SUM(credit)` berlaku per entry, bukan cuma format 1-debit-1-kredit.

**Catatan soal #3:** beli persediaan nambah **asset** (Persediaan), bukan langsung jadi Beban/HPP — HPP baru diakui pas barangnya kejual (matching principle lagi, detail penuh di modul Inventory/COGS). Journal Entry sendiri tetap generik — gak perlu tau logic inventory, accountant yang pilih akun manual sesuai kejadian.

**Aturan wajib tiap journal entry** (domain rules, bukan cuma teknis)

- **Keseimbangan** (`SUM(debit) = SUM(credit)` per entry) — konsekuensi langsung dari persamaan akuntansi (`Asset + Expense = Liability + Equity + Revenue`). Entry gak balance = persamaan itu rusak, Neraca gak akan pernah "tie" (Asset ≠ Liability+Equity).
- **Minimal 2 baris, minimal 2 akun berbeda** — prinsip double-entry, gak ada transaksi yang cuma "kena" 1 akun doang tanpa asal. Uang gak muncul/hilang dari kosong.
- **Cuma leaf account yang boleh diposting** — sama kayak aturan di `chart-of-accounts.md`: akun header (yang punya child) gak boleh nerima posting langsung, bikin rollup ambigu/dobel-hitung.
- **Entry yang udah dibuat gak boleh diedit/dihapus — cuma boleh dibalik (reversing entry)** — soal integritas histori: kalau history bisa diubah, laporan yang diambil hari ini bisa beda dari besok tanpa jejak kenapa. Salah catat → bikin entry BARU isinya kebalikan persis (debit↔kredit ditukar), rujuk ke entry asli. Dua-duanya (yang salah + koreksinya) tetep kelihatan di histori — itu bagian dari audit trail, bukan cacat.
- **Wajib ada rujukan ke dokumen sumber** — tanpa ini, journal entry cuma angka tanpa bukti — gak bisa diverifikasi pas audit atau rekonsiliasi ke nota/kuitansi/kontrak fisik.
- **Atomicity — header+lines harus kebentuk bareng, gak boleh nanggung** — kalau gagal di tengah proses (misal baris ke-3 dari 3 gagal), SELURUH entry (header+lines) harus batal. Entry setengah jadi lebih bahaya daripada gak ada entry sama sekali — saldo salah tanpa ketahuan.

**Common Mistakes**
- Posting cuma 1 baris (lupa sisi lawannya) — pasti gagal balance, tapi kalau sistem gak validasi bakal jadi data korup.
- Edit langsung journal entry yang salah (bukan bikin reversing entry) — ngerusak audit trail.
- Posting ke akun header karena "keliatannya paling pas" — padahal harusnya ke leaf paling detail (lihat `chart-of-accounts.md`).
- Nyatet transaksi cash-basis (nunggu kas beneran pindah) padahal seharusnya accrual — bikin Piutang/Utang gak pernah dicatat, laporan gak nyerminin posisi bisnis sebenarnya.
- Lupa rujukan ke dokumen sumber — entry jadi gak bisa ditelusuri balik ke bukti fisiknya.

### Period Closing (Tutup Buku)

**Cara Kerja**
- Proses akhir suatu periode waktu (biasanya bulanan/tahunan) di mana: (1) akun Revenue & Expense di-nol-kan — saldonya (selisih laba/rugi periode itu) dipindah ke `Laba Ditahan`; (2) periode itu dikunci — gak ada entry baru yang boleh bertanggal masuk ke periode tsb lagi; (3) laporan keuangan periode itu (Neraca, Laba Rugi) jadi **final**, dipakai buat pelaporan ke pihak luar (bank, pajak, investor).
- Urutan yang beneran terjadi begitu rentang tanggal mau ditutup:
  1. **Pilih rentang + akun tujuan.** Tanggal mulai, tanggal akhir, dan akun Ekuitas mana yang jadi tujuan pemindahan laba/rugi (biasanya `Laba Ditahan`).
  2. **Sistem hitung ulang sendiri, gak percaya angka yang udah pernah dilihat user.** Meski user mungkin udah ngintip laporan Income Statement sebelumnya buat cek angkanya, pas tombol "Tutup" ditekan, sistem **hitung ulang dari nol** langsung dari catatan transaksi asli buat rentang itu — bisa aja ada transaksi baru nyelip masuk di antara waktu user lihat laporan dan waktu dia beneran menekan tombol tutup, sistem gak boleh nutup pakai angka yang udah basi.
  3. **Susun 1 transaksi jurnal penutup.** Tiap akun Pendapatan yang punya saldo di rentang itu di-**debit** sebesar saldonya (nol-in), tiap akun Beban di-**kredit** sebesar saldonya (nol-in). Selisih totalnya — laba atau rugi bersih periode itu — dipindah ke akun Laba Ditahan (dikredit kalau laba, didebit kalau rugi, biar transaksinya tetap balance debit=kredit).
  4. **Transaksi penutup itu DULU yang dicatat, baru rentangnya ditandai tertutup — urutannya sengaja begini.** Kalau kebalik (rentang ditandai tertutup dulu, baru bikin transaksi penutup), transaksi penutup itu sendiri — yang bertanggal di hari terakhir periode itu — bakal ketolak oleh kuncian yang baru aja dia bikin sendiri.
  5. **Kalau rentang itu ternyata gak ada aktivitas Pendapatan/Beban sama sekali** (misal periode sepi transaksi), sistem tetap mencatat rentang itu sebagai tertutup, tapi TANPA bikin transaksi jurnal penutup — gak ada yang perlu dinolkan.
  6. **Sejak itu, rentangnya terkunci** — bukan cuma nolak entry jurnal manual, tapi SEMUA transaksi dari modul mana pun (invoice pelanggan, tagihan supplier, posting penyusutan, dst) yang tanggalnya jatuh di rentang itu.
  7. **Sebelum semua langkah di atas jalan, ada 1 pemeriksaan urutan**: rentang yang mau ditutup wajib mulai PERSIS sehari setelah rentang terakhir yang udah ditutup berakhir. Kalau enggak, sistem nolak duluan — mencegah ada periode yang "kelewat" (gak pernah ditutup selamanya) atau 2 rentang yang tumpang tindih.
- **Kenapa Revenue/Expense harus di-nol-kan tiap periode:** dua akun ini **sementara** (temporary) — cuma rincian dari Equity yang belum ditutup (lihat derivasi persamaan akuntansi di `chart-of-accounts.md`). Kalau gak di-nol-kan, saldo Pendapatan periode ini numpuk terus sama periode depan — Laporan Laba Rugi periode depan jadi keliatan gabungan. Asset/Liability/Equity itu **permanen** — saldonya emang harus jalan terus antar periode (saldo kas gak di-nol-in tiap bulan).
- **Kenapa periode yang ditutup gak boleh diutak-atik lagi:** kalau laporan periode itu udah dikasih ke pihak luar, terus ketemu ada transaksi yang kelewat catet — kalau boleh nyelundup masuk balik ke periode yang udah ditutup, laporan yang udah dipegang pihak luar diam-diam jadi salah tanpa mereka tahu. Solusinya: transaksi itu tetap dicatat, tapi tanggalnya masuk periode yang **lagi berjalan**, bukan dipaksa balik ke periode lama.
- **Relasi ke aturan immutability entry individual** (lihat Konsep Inti): dua-duanya soal "gak boleh diubah", tapi levelnya beda — immutability per entry berlaku dari transaksi pertama. Period closing berlaku **per rentang waktu**, baru relevan begitu ada proses tutup buku formal (butuh laporan keuangan siap dulu buat tau angka definitif yang mau ditutup). Keduanya independen: sebuah entry bisa immutable (aturan Konsep Inti) di periode yang masih terbuka (belum kena kuncian period closing).
- **Soft close vs hard close — bukan 2 mekanisme, cuma 1.** Istilah "tutup buku" di dunia nyata sering dipakai longgar buat 2 hal yang beda: **hard close** — proses yang dijelasin di atas, closing entry BENERAN diposting (Revenue/Expense di-nol-kan), rentang tanggalnya BENERAN dikunci. Ini satu-satunya proses yang secara teknis akuntansi layak disebut "closing". **Soft close** (kadang disebut "interim review" atau "laporan sementara") — sekadar **melihat** angka Laba Rugi buat 1 rentang tanggal (misal buat keputusan internal bulanan), TANPA memposting closing entry apa pun dan TANPA mengunci apa pun. Revenue/Expense tetap menumpuk seperti biasa, entry baru masih bebas ditambah/dikoreksi. Karena soft close gak mengubah data atau mengunci apa pun, dia sebenarnya bukan proses "closing" terpisah — dia cuma **menjalankan laporan Income Statement buat rentang tanggal tertentu**, sesuatu yang udah bisa dilakukan kapan pun tanpa mekanisme tambahan (`financial-reports.md`). Sistem ini cuma punya 1 mekanisme closing (yang hard), dan itu keputusan sadar — bukan gap yang kelewat.
- **Cadence-nya bebas, bukan dihardcode bulanan/tahunan.** Hard close bisa dipanggil buat rentang tanggal APA PUN — 1 bulan, 1 kuartal, 1 tahun, bahkan 1 minggu. Gak ada konsep "tipe periode" yang disimpan; cuma tanggal mulai dan tanggal akhir. Satu-satunya aturan keras: rentang berikutnya wajib mulai persis 1 hari setelah rentang sebelumnya berakhir.
- **Best practice buat skala UMKM.** Closing formal **gak perlu sering-sering**. Makin sering ditutup (misal tiap bulan), makin tinggi risiko ada transaksi telat yang "kejebak" di periode yang udah terlanjur dikunci. Review bulanan/mingguan cukup pakai laporan Income Statement biasa (soft, gak dikunci) — buat mutusin hal internal (naikin harga, ganti supplier). Hard close idealnya **tahunan**, diselaraskan sama kewajiban pajak tahunan (SPT Tahunan) dan momen laporan ke pihak luar (bank). Jangan buru-buru nutup persis di akhir tahun kalender — kasih jeda beberapa minggu di awal periode berikutnya biar nota-nota yang telat nyampe sempat kekumpul, baru ditutup.
- **Cakupan kuncian — berlaku ke semua modul, bukan cuma jurnal manual.** Karena semua RPC financial write di modul lain (AR, AP, Inventory, Fixed Assets) ujung-ujungnya manggil mekanisme jurnal yang sama, kuncian hard close otomatis berlaku ke **semua jenis transaksi** begitu rentangnya ditutup — bukan cuma entry yang diinput manual: invoice AR baru, bill AP baru, posting penyusutan, goods issue, bahkan reversing entry buat koreksi, semuanya ditolak kalau tanggalnya masuk rentang yang udah ditutup. Satu-satunya jalan: catat transaksinya dengan tanggal periode yang **sedang berjalan**.
- **Kenapa pemecahan periode penting (bukan cuma angka gabungan).** Kalau dibiarkan gak pernah ditutup, Laba Rugi kumulatif bisa nyampur momen yang sifatnya beda jauh — misal periode akuisisi aset besar (beban penyusutan numpuk, belum ada pendapatan operasional) dengan periode operasional biasa (jualan jalan normal) — jadi 1 angka gabungan yang bikin panik tapi gak jelas asalnya dari mana. Begitu dipecah jadi periode-periode kontigu, baru kelihatan bagian mana yang wajar rugi karena investasi dan bagian mana yang operasionalnya sebenarnya sehat. Period closing gak mengubah kebenaran angka, cuma memecahnya jadi potongan yang bisa dibaca dan dibandingkan. Contoh angka nyata: `docs/story/financial-reports.md`.
- **Status:** dibangun di Fase 7 (Financial Reports), begitu Income Statement siap dipakai buat ngasih angka definitif per periode. Detail struktur data: `docs/architecture/financial-reports-schema.md` bagian "Tutup Buku".

**Aturan Bisnis**
- Rentang yang mau ditutup wajib mulai PERSIS sehari setelah rentang terakhir yang udah ditutup berakhir — gak boleh ada gap (periode yang kelewat gak pernah ditutup) atau tumpang tindih.
- Sistem wajib hitung ulang saldo Revenue/Expense dari catatan transaksi asli tiap kali tombol tutup ditekan — gak boleh percaya angka laporan yang mungkin udah basi.
- Transaksi jurnal penutup wajib dicatat DULU, baru rentangnya ditandai tertutup — bukan sebaliknya.
- Rentang tanpa aktivitas Pendapatan/Beban tetap dicatat tertutup, tanpa transaksi jurnal penutup.
- Begitu rentang tertutup, SEMUA transaksi dari modul mana pun yang tanggalnya jatuh di rentang itu ditolak — bukan cuma entry jurnal manual.
- Gak ada mekanisme buka kembali (reopen) periode yang udah ditutup — konsisten sama Core Invariant "no edit posted/closed period".

**Skenario**
- Tutup buku periode yang punya aktivitas Pendapatan/Beban — closing entry dibuat, akun-akun itu di-nol-kan, laba/rugi periode dipindah ke Laba Ditahan.
- Tutup buku periode yang gak ada aktivitas Pendapatan/Beban sama sekali — tetap tercatat tertutup, tanpa closing entry.
- Coba tutup rentang yang gak bersambung sama rentang terakhir yang udah ditutup (ada gap atau tumpang tindih) — ditolak sebelum proses jalan.
- Transaksi apa pun dari modul lain (invoice, tagihan, penyusutan, dst) yang tanggalnya jatuh ke rentang yang udah ditutup — ditolak, harus dicatat ulang ke periode yang sedang berjalan.

**Common Mistakes**
- Nutup buku (hard close) kebanyakan/kesering (misal tiap minggu) buat sekadar "liat angka" — soft review pakai laporan Income Statement biasa udah cukup, gak perlu dikunci; hard close yang kesering justru naikin risiko transaksi telat kejebak di periode yang udah terkunci.
- Nganggap Laba Rugi kumulatif (belum pernah ditutup) sebagai performa "sekarang" — kalau ada aktivitas yang timing-nya beda jauh (misal beban penyusutan numpuk sama pendapatan operasional yang baru jalan beberapa bulan), angka gabungan itu menyesatkan sampai dipecah per periode.
