# Batalkan AP Bill

## Kapan Melakukan Ini

Saat bill yang dicatat ternyata salah total (mis. salah input, salah supplier) dan belum ada pembayaran sama sekali terhadapnya — bukan untuk kasus retur sebagian barang (itu pakai [retur-barang-ap.md](retur-barang-ap.md)).

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Bill ini **belum punya pembayaran sama sekali** — begitu ada pembayaran, tombol batalkan tidak akan tersedia.
- Bill dari penerimaan barang (GRN) **boleh** dibatalkan, asal stok barangnya masih ada (belum terpakai/terjual sampai kurang dari qty yang diterima), dan belum ada DP/tukar barang/retur. Bisa dibatalkan dari detail tagihan atau dari detail **Barang Masuk** (tombol **Batalkan Barang Masuk**) — hasilnya sama.

## Langkah-Langkah

1. Buka detail bill (`/ap-bills/[id]`) yang mau dibatalkan.
2. Klik tombol **Batalkan** (cuma muncul kalau belum ada pembayaran).
3. Konfirmasi dialog yang muncul.

## Hasil Akhir

- Jurnal pembalik otomatis terbentuk, membalik seluruh efek jurnal bill ini — bill tetap ada sebagai record (ditandai dibatalkan), tidak dihapus.
- Status bill berubah jadi **dibatalkan** di daftar AP Bills.

## Kesalahan Umum

- **Mencari tombol Batalkan padahal bill sudah ada pembayaran** — untuk kasus ini, penyelesaiannya lewat retur ([retur-barang-ap.md](retur-barang-ap.md)), bukan pembatalan total.
- **Bill dari GRN ditolak karena stok tidak cukup** — barang dari GRN itu sebagian sudah terjual/terpakai, jadi stok tidak bisa dikurangi penuh. Solusinya pakai [retur-barang-ap.md](retur-barang-ap.md) atau Stock Opname.
- **Bill dari GRN dibatalkan: yang ikut berubah** — stok berkurang lagi, harga rata-rata dihitung ulang, qty Purchase Order (kalau ada) bebas lagi, dan di daftar Tagihan & Barang Masuk barisnya tampil merah bertanda DIBATALKAN. Penjualan yang sudah tercatat di antaranya tidak diubah.
