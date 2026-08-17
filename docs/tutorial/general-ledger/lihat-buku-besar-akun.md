# Lihat Buku Besar (General Ledger) per Akun

## Kapan Melakukan Ini

Saat butuh menelusuri riwayat transaksi dan saldo berjalan satu akun tertentu — mis. mengecek kenapa saldo Kas Toko sekarang segini, atau menelusuri satu jurnal spesifik dari akunnya.

## Prasyarat

- Login (semua role bisa akses, halaman ini murni baca).

## Langkah-Langkah

Ada 2 cara masuk ke tampilan yang sama:

1. **Lewat halaman General Ledger berdiri sendiri** (`/general-ledger`):
   - Pilih akun dari dropdown **Pilih akun** (hanya leaf account yang muncul).
   - Atur **Sampai Tanggal** kalau mau lihat saldo di titik waktu tertentu (default hari ini).
2. **Lewat halaman detail akun** (`/accounts/[id]`), tab **Ledger** — cara ini langsung menampilkan ledger akun itu tanpa perlu pilih dari dropdown lagi, karena kamu sudah "masuk" dari sisi akunnya.

## Hasil Akhir

- Tabel menampilkan tiap baris jurnal yang menyentuh akun ini: **Tanggal**, **Deskripsi**, **Source Ref**, **Debit**, **Kredit**, dan **Saldo Berjalan** (running balance, dihitung kumulatif sesuai urutan tanggal dan Normal Balance akun itu — debit atau kredit yang menambah saldo, tergantung kategori akunnya).
- Transaksi bertanggal **setelah** "Sampai Tanggal" yang diisi otomatis disembunyikan dari daftar maupun dari perhitungan saldo berjalan — supaya konsisten dengan filter yang dipakai Trial Balance/Balance Sheet di [lihat-laporan-keuangan.md](../financial-reports/lihat-laporan-keuangan.md).
- Baris terakhir kolom Saldo Berjalan harus sama persis dengan saldo akun itu di Trial Balance untuk tanggal yang sama — kalau beda, ada yang salah.

## Kesalahan Umum

- **Bingung saldo berjalan tidak berubah padahal baru saja ada transaksi baru** — cek dulu tanggal transaksi barunya, apakah masih di bawah/sama dengan "Sampai Tanggal" yang sedang dipakai; kalau tanggalnya lebih baru dari filter itu, baris itu memang sengaja disembunyikan.
- **Mengira halaman ini bisa dipakai untuk mengedit/menghapus jurnal** — ini murni baca; jurnal yang sudah tercatat tidak bisa diubah dari sini maupun dari mana pun (immutability), koreksi harus lewat entry pembalik baru.
