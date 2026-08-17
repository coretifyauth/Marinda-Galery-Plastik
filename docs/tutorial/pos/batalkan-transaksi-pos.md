# Batalkan Transaksi POS (Void)

## Kapan Melakukan Ini

Saat transaksi kasir yang sudah selesai (checkout) ternyata perlu dibatalkan total — salah input, salah scan, atau pelanggan membatalkan pembelian setelah struk tercetak.

## Prasyarat

- Login ke **aplikasi ERP admin** (`apps/erp`) dengan role **admin** atau **accountant** — pembatalan **tidak dilakukan dari aplikasi kasir POS**, tapi dari sisi admin.
- Transaksi ini belum pernah dibatalkan sebelumnya.

## Langkah-Langkah

1. Buka menu **POS Sales** (`/pos-sales`) di aplikasi ERP admin.
2. Klik transaksi yang mau dibatalkan untuk masuk ke halaman detailnya.
3. Klik tombol **Batalkan** (di pojok kanan atas, cuma muncul kalau transaksi ini belum pernah dibatalkan).
4. Konfirmasi dialog yang muncul (menampilkan Source Ref transaksi).

## Hasil Akhir

- Jurnal pembalik otomatis terbentuk, membalik seluruh efek jurnal transaksi ini (kas/bank, pendapatan, HPP, persediaan).
- Stok barang yang tadinya keluar saat checkout **dikembalikan lagi** ke persediaan.
- Transaksi tetap ada sebagai record (untuk jejak audit), ditandai dibatalkan — tidak dihapus.

## Kesalahan Umum

- **Mencari tombol batal di aplikasi kasir POS** — pembatalan cuma tersedia di aplikasi ERP admin, kasir di kios tidak bisa membatalkan transaksinya sendiri.
- **Mencoba membatalkan transaksi yang sudah pernah dibatalkan** — tombol Batalkan tidak akan muncul lagi setelah transaksi itu dibatalkan sekali.
