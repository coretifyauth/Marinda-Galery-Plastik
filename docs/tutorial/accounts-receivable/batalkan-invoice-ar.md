# Batalkan AR Invoice

## Kapan Melakukan Ini

Saat invoice yang dibuat ternyata salah total (mis. salah input, salah customer) dan belum ada pembayaran apa pun terhadapnya — bukan untuk kasus retur sebagian barang (itu pakai [retur-barang-ar.md](retur-barang-ar.md)).

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Invoice ini **belum punya pembayaran sama sekali** — begitu ada pembayaran, tombol batalkan tidak akan tersedia (piutangnya sudah "kesentuh" transaksi lain, nasibnya jadi keputusan bisnis terpisah).

## Langkah-Langkah

1. Buka detail invoice (`/ar-invoices/[id]`) yang mau dibatalkan.
2. Klik tombol **Batalkan** (cuma muncul kalau prasyarat di atas terpenuhi).
3. Konfirmasi dialog yang muncul (menampilkan Source Ref dan nominal invoice).

## Hasil Akhir

- Jurnal pembalik (reversing entry) otomatis terbentuk, membalik seluruh efek jurnal invoice ini — bukan menghapus record invoice-nya (invoice tetap ada, ditandai dibatalkan, untuk jejak audit).
- Status invoice berubah jadi **dibatalkan** di daftar AR Invoices.
- Kalau invoice ini sebelumnya juga punya `ar_deposit_applications` (DP yang sudah diterapkan ke sini), penerapan DP itu ikut otomatis di-unwind (dibalik) — DP-nya kembali jadi saldo tersedia, tidak "nyangkut" ke invoice yang dibatalkan.

## Kesalahan Umum

- **Mencari tombol Batalkan padahal invoice sudah ada pembayaran** — tombolnya memang sengaja tidak muncul; untuk kasus ini, penyelesaiannya lewat retur ([retur-barang-ar.md](retur-barang-ar.md)), bukan pembatalan total.
- **Menganggap ini bisa dibatalkan lagi (undo pembatalan)** — begitu dibatalkan, tidak ada tombol untuk mengembalikannya; kalau ternyata pembatalan itu salah, harus dicatat ulang sebagai invoice baru.
