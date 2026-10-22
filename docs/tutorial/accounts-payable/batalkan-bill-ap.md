# Batalkan AP Bill

## Kapan Melakukan Ini

Saat bill yang dicatat ternyata salah total (mis. salah input, salah supplier) dan belum ada pembayaran sama sekali terhadapnya — bukan untuk kasus retur sebagian barang (itu pakai [retur-barang-ap.md](retur-barang-ap.md)).

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Bill ini **belum punya pembayaran sama sekali** — begitu ada pembayaran, tombol batalkan tidak akan tersedia.
- **Tagihan Barang** ([buat-tagihan-barang.md](buat-tagihan-barang.md)) boleh dibatalkan kalau: tidak ada **barang masuk aktif** (batalkan dulu satu per satu lewat [terima-barang-grn.md](../inventory/terima-barang-grn.md), bagian Membatalkan), tidak ada **penutupan sisa barang** (Tutup Sisa Barang), dan belum ada DP/tukar barang/retur. Pembatalan tagihan hanya membalik jurnal tagihan (Pembelian Belum Diterima dan Utang Usaha).
- Tagihan **lama** yang dibuat bareng barang masuknya (sebelum fitur Tagihan Barang) boleh dibatalkan, asal stok barangnya masih ada (belum terpakai/terjual sampai kurang dari qty yang diterima), dan belum ada DP/tukar barang/retur. Bisa dari detail tagihan atau dari detail **Barang Masuk** (tombol **Batalkan Barang Masuk**) — hasilnya sama: stok dikurangi lagi.

## Langkah-Langkah

1. Buka detail bill (`/ap-bills/[id]`) yang mau dibatalkan.
2. Untuk Tagihan Barang yang sudah punya barang masuk: batalkan dulu semua barang masuknya (lihat detail tiap barang masuk, tombol **Batalkan Barang Masuk**).
3. Klik tombol **Batalkan Bill** (cuma muncul kalau belum ada pembayaran).
4. Konfirmasi dialog yang muncul.

## Hasil Akhir

- Jurnal pembalik otomatis terbentuk, membalik seluruh efek jurnal bill ini — bill tetap ada sebagai record (ditandai dibatalkan), tidak dihapus.
- Status bill berubah jadi **dibatalkan** di daftar Tagihan. Tagihan Barang yang dibatalkan hilang dari pilihan form Barang Masuk.

## Kesalahan Umum

- **Mencari tombol Batalkan padahal bill sudah ada pembayaran** — untuk kasus ini, penyelesaiannya lewat retur ([retur-barang-ap.md](retur-barang-ap.md)), bukan pembatalan total.
- **Tagihan Barang ditolak: "masih punya barang masuk aktif"** — batalkan semua barang masuknya dulu. Kalau ada barang masuk yang sudah terjual sebagian, pembatalannya ditolak; pakai retur.
- **Tagihan Barang ditolak: pesan "sudah punya pelepasan sisa kolam"** (istilah teknis di pesan sistem; artinya sisa barang sudah ditutup lewat **Tutup Sisa Barang**) — penutupan (pembulatan/uang muka) tidak bisa dibatalkan, jadi tagihannya juga tidak bisa dibatalkan lagi.
- **Tagihan lama (bundel) ditolak karena stok tidak cukup** — barang dari penerimaan itu sebagian sudah terjual/terpakai, jadi stok tidak bisa dikurangi penuh. Solusinya pakai [retur-barang-ap.md](retur-barang-ap.md) atau Stock Opname.
- **Membatalkan tagihan lalu membuat ulang karena nota beda** — ini satu-satunya cara mengoreksi nilai tagihan barang (barang masuk dibatalkan, tagihan dibatalkan, tagihan dibuat ulang). Hanya bisa selama belum ada pembayaran dan stok belum terjual.
