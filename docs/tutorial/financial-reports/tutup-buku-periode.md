# Tutup Buku Periode (Period Closing)

## Kapan Melakukan Ini

Di akhir suatu rentang periode akuntansi (biasanya tahunan untuk skala UMKM, bisa juga bulanan/kuartalan) — untuk menol-kan saldo akun Pendapatan/Beban, memindahkan selisihnya ke Laba Ditahan, dan mengunci rentang tanggal itu supaya tidak bisa ditambahi transaksi baru lagi. **Ini satu-satunya aksi yang menulis data** di antara semua yang ada di menu Financial Reports — beda dari 4 laporan lain yang murni dilihat saja.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Semua transaksi periode yang mau ditutup sudah selesai dicatat — begitu ditutup, rentang itu tidak bisa dibuka lagi.
- Kalau ini bukan penutupan pertama kali, rentang baru **wajib dimulai persis 1 hari setelah** rentang terakhir yang sudah ditutup — sistem menyarankan tanggal mulai ini otomatis.
- Yakin dengan pilihan **Akun Laba Ditahan** (harus akun kategori Equity) yang akan menampung hasil closing.

## Langkah-Langkah

1. Buka menu **Financial Reports** (`/reports`), klik kartu **Tutup Buku**.
2. Cek tabel **Riwayat Penutupan** untuk lihat periode-periode yang sudah pernah ditutup sebelumnya.
3. Klik **+ Tutup Periode Baru**.
4. Kalau ada penutupan sebelumnya, modal menampilkan hint tanggal mulai yang wajib dipakai — field **Dari Tanggal** sudah otomatis terisi sesuai saran ini.
5. Isi **Sampai Tanggal** — akhir rentang yang mau ditutup.
6. Pilih **Akun Laba Ditahan** dari dropdown (hanya akun kategori Equity yang muncul).
7. Klik **Tutup Periode**.

## Hasil Akhir

- Sistem menghitung ulang saldo Pendapatan/Beban langsung dari data jurnal terkini untuk rentang itu (bukan dari laporan Income Statement yang mungkin sudah kamu lihat sebelumnya) — kalau ada transaksi baru masuk sejak terakhir kali kamu cek laporan, angka closing tetap akurat sesuai kondisi terbaru.
- Sebuah jurnal closing otomatis terbentuk (menol-kan Pendapatan/Beban, memindahkan selisihnya ke Akun Laba Ditahan yang dipilih) — kecuali kalau memang tidak ada aktivitas Pendapatan/Beban di rentang itu, baris **Closing Entry** akan menunjukkan "Gak ada aktivitas".
- Rentang tanggal ini masuk ke tabel **Riwayat Penutupan** dan **tidak bisa dibuka lagi** — transaksi baru dengan tanggal di dalam rentang ini akan ditolak sistem. Koreksi kesalahan yang ketahuan belakangan harus dicatat sebagai entry baru di periode yang sedang berjalan, bukan menyelundup masuk ke periode yang sudah ditutup.

## Kesalahan Umum

- **Menutup periode padahal masih ada transaksi yang belum sempat dicatat** — begitu ditutup, tidak bisa dibuka lagi; pastikan semua pencatatan periode itu sudah lengkap dulu sebelum menutup.
- **Salah isi Dari Tanggal, tidak mengikuti saran sistem** — kalau rentang baru tidak persis mulai 1 hari setelah rentang terakhir, sistem akan menolak (mencegah periode yang "kelewat" tidak pernah ditutup, atau rentang yang tumpang tindih).
- **Terlalu sering menutup buku (mis. tiap minggu)** — makin sering ditutup, makin tinggi risiko ada transaksi telat yang "kejebak" di periode yang sudah terlanjur dikunci. Untuk review rutin internal, cukup lihat Income Statement biasa (tanpa menutup apa pun) — lihat [lihat-laporan-keuangan.md](lihat-laporan-keuangan.md). Closing formal sebaiknya jarang, idealnya tahunan.
- **Salah pilih Akun Laba Ditahan** — pastikan akun yang dipilih memang dimaksudkan untuk menampung laba ditahan kumulatif, karena ini akan terus dipakai berulang tiap penutupan periode berikutnya.
