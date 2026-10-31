# Batalkan AR Invoice

## Kapan Melakukan Ini

Saat invoice yang dibuat ternyata salah total (mis. salah input, salah customer) — bukan untuk kasus retur sebagian barang (itu pakai retur). Kalau sudah ada pembayaran, batalkan dulu pembayarannya.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Invoice ini **tidak punya pembayaran aktif**. Kalau ada, buka tab **Pembayaran**, klik **Batalkan** di tiap barisnya, isi alasan, dan jawab apakah uangnya benar-benar diterima. Tombol batalkan invoice muncul setelah itu.
- Invoice dari barang keluar (Goods Issue) **boleh** dibatalkan, asal belum ada retur atau penggantian barang. Bisa dibatalkan dari detail invoice atau dari detail **Barang Keluar** (tombol **Batalkan Barang Keluar**) — hasilnya sama.

## Langkah-Langkah

1. Buka detail invoice (`/ar-invoices/[id]`) yang mau dibatalkan.
2. Klik tombol **Batalkan** (cuma muncul kalau prasyarat di atas terpenuhi).
3. Konfirmasi dialog yang muncul (menampilkan Source Ref dan nominal invoice).

## Hasil Akhir

- Jurnal pembalik (reversing entry) otomatis terbentuk, membalik seluruh efek jurnal invoice ini — bukan menghapus record invoice-nya (invoice tetap ada, ditandai dibatalkan, untuk jejak audit).
- Status invoice berubah jadi **dibatalkan** di daftar AR Invoices.
- Kalau invoice ini sebelumnya juga punya `ar_deposit_applications` (DP yang sudah diterapkan ke sini), penerapan DP itu ikut otomatis di-unwind (dibalik) — DP-nya kembali jadi saldo tersedia, tidak "nyangkut" ke invoice yang dibatalkan.
- **Invoice dari barang keluar:** stok dikembalikan, jurnal HPP ikut dibalik, qty Sales Order (kalau ada) bebas lagi, dan barisnya di daftar Invoice & Barang Keluar tampil merah bertanda DIBATALKAN.

## Kesalahan Umum

- **Mencari tombol Batalkan padahal invoice masih punya pembayaran aktif** — batalkan pembayarannya dulu di tab **Pembayaran**. Kalau uangnya benar diterima, catat ulang pembayaran itu ke invoice yang benar supaya saldo kas/bank cocok.
- **Menganggap ini bisa dibatalkan lagi (undo pembatalan)** — begitu dibatalkan, tidak ada tombol untuk mengembalikannya; kalau ternyata pembatalan itu salah, harus dicatat ulang sebagai invoice baru.
