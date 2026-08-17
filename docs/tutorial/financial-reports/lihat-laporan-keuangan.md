# Lihat Laporan Keuangan (Trial Balance, Income Statement, Balance Sheet, Cash Flow)

## Kapan Melakukan Ini

Kapan pun butuh melihat kondisi keuangan bisnis — saldo akun saat ini, laba/rugi periode tertentu, posisi aset-liabilitas-ekuitas, atau pergerakan kas. Keempat laporan ini murni **baca data** (read-only), tidak mencatat transaksi baru apa pun.

## Prasyarat

- Login (semua role bisa akses, tidak perlu admin/accountant khusus untuk melihat laporan).
- Sudah ada transaksi tercatat di sistem (journal entries) — laporan kosong kalau belum ada data.

## Langkah-Langkah

1. Buka menu **Financial Reports** (`/reports`) — akan tampil 4 kartu laporan read-only plus 1 kartu **Tutup Buku** (lihat [tutup-buku-periode.md](tutup-buku-periode.md) untuk itu, beda alur karena itu aksi menulis).
2. Klik salah satu laporan yang mau dilihat:
   - **Trial Balance** — isi **Per Tanggal** (default hari ini), laporan menampilkan saldo semua akun sampai tanggal itu, plus indikator balance (total debit harus sama dengan total kredit).
   - **Income Statement** — isi **Dari Tanggal** dan **Sampai Tanggal**, menampilkan total Pendapatan dikurangi Beban untuk rentang itu (Laba/Rugi periode).
   - **Balance Sheet** — isi 1 tanggal (per tanggal tertentu), menampilkan Aset, Liabilitas, dan Ekuitas (Laba Ditahan dihitung otomatis kumulatif sejak transaksi pertama).
   - **Cash Flow** — isi rentang tanggal, menampilkan pergerakan kas (Operating/Investing/Financing) memakai metode Indirect.
3. Laporan otomatis dimuat begitu halaman dibuka (dengan tanggal default) — ubah tanggal dan laporan akan refresh sesuai rentang baru.

## Hasil Akhir

- Laporan menampilkan angka yang dihitung ulang langsung dari data jurnal saat itu juga — bukan snapshot yang tersimpan, jadi selalu real-time sesuai transaksi terbaru.
- Kalau data-nya benar (semua jurnal balance), keempat laporan ini **selalu konsisten satu sama lain** — Neraca harus balance (Aset = Liabilitas + Ekuitas), dan saldo Kas di Cash Flow harus cocok dengan saldo akun Kas yang sebenarnya. Kalau ketauan tidak konsisten, itu tanda ada bug di sistem, bukan toleransi pembulatan.

## Kesalahan Umum

- **Bingung kenapa Balance Sheet tidak balance** — cek dulu apakah semua jurnal terkait sudah tercatat lengkap; Balance Sheet yang tidak balance bukan hal normal, itu indikasi ada yang salah dan perlu ditelusuri, bukan diabaikan.
- **Membandingkan Income Statement yang dilihat kemarin dengan hari ini dan bingung angkanya beda** — laporan ini selalu dihitung ulang dari data terkini, jadi kalau ada transaksi baru masuk sejak terakhir dilihat, angkanya otomatis berubah. Itu bukan bug.
- **Mengira laporan ini juga bisa dipakai untuk menutup periode** — keempat laporan di sini murni untuk dilihat; menutup periode (nol-in Pendapatan/Beban) adalah aksi terpisah, lihat [tutup-buku-periode.md](tutup-buku-periode.md).
