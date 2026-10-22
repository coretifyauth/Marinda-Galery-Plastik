# Batalkan AP Bill

## Kapan Melakukan Ini

Saat bill yang dicatat ternyata salah total (mis. salah input, salah supplier) dan belum ada pembayaran sama sekali terhadapnya — bukan untuk kasus retur sebagian barang (itu pakai [retur-barang-ap.md](retur-barang-ap.md)).

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Bill ini **belum punya pembayaran sama sekali** — begitu ada pembayaran, tombol batalkan tidak akan tersedia.
- Tagihan **dari barang masuk** (alur baru) **boleh** dibatalkan, asal belum ada DP/tukar barang/retur dan **stok item-itemnya belum bergerak sejak tagihan dibuat** (belum ada penjualan, produksi, atau mutasi lain untuk item itu). Hasilnya: barang masuknya kembali **Belum tertagih** dan stok **tidak dibalik**. Kalau item yang sama sudah ditagih lagi oleh tagihan yang lebih baru, batalkan yang terbaru dulu.
- Tagihan lama yang dibuat bareng barang masuk (sebelum fitur Barang Masuk Belum Ditagih) **boleh** dibatalkan, asal stok barangnya masih ada (belum terpakai/terjual sampai kurang dari qty yang diterima), dan belum ada DP/tukar barang/retur. Bisa dari detail tagihan atau dari detail **Barang Masuk** (tombol **Batalkan Barang Masuk**) — hasilnya sama: stok dikurangi lagi.

## Langkah-Langkah

1. Buka detail bill (`/ap-bills/[id]`) yang mau dibatalkan.
2. Klik tombol **Batalkan** (cuma muncul kalau belum ada pembayaran).
3. Konfirmasi dialog yang muncul.

## Hasil Akhir

- Jurnal pembalik otomatis terbentuk, membalik seluruh efek jurnal bill ini — bill tetap ada sebagai record (ditandai dibatalkan), tidak dihapus.
- Status bill berubah jadi **dibatalkan** di daftar AP Bills.

## Kesalahan Umum

- **Mencari tombol Batalkan padahal bill sudah ada pembayaran** — untuk kasus ini, penyelesaiannya lewat retur ([retur-barang-ap.md](retur-barang-ap.md)), bukan pembatalan total.
- **Tagihan dari barang masuk ditolak karena "stok sudah bergerak"** — ada penjualan atau mutasi lain untuk item itu sejak ditagih, jadi kondisi sebelum ditagih tidak bisa dipulihkan persis. Solusinya pakai [retur-barang-ap.md](retur-barang-ap.md).
- **Tagihan lama (bundel) ditolak karena stok tidak cukup** — barang dari penerimaan itu sebagian sudah terjual/terpakai, jadi stok tidak bisa dikurangi penuh. Solusinya pakai [retur-barang-ap.md](retur-barang-ap.md) atau Stock Opname.
- **Yang ikut berubah saat tagihan dari barang masuk dibatalkan** — jurnal tagihan dan jurnal koreksi HPP (kalau ada) dibalik, harga rata-rata dikembalikan ke nilai sebelum ditagih, barang masuknya kembali merah "Belum tertagih". Penjualan yang sudah tercatat tidak diubah.
