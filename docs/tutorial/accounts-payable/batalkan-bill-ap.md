# Batalkan AP Bill

## Kapan Melakukan Ini

Saat tagihan yang dicatat ternyata salah total (mis. salah supplier, salah nota), walau sudah dibayar atau barangnya sudah masuk. Kalau cuma nilainya yang salah, lihat [koreksi-salah-input.md](koreksi-salah-input.md). Retur sebagian barang pakai [retur-barang-ap.md](retur-barang-ap.md).

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Tagihan belum punya **retur**, **tukar barang**, atau **penutupan sisa barang** (ketiganya belum bisa dibatalkan). Pembayaran, barang masuk, dan uang muka yang diterapkan ikut dibatalkan otomatis.
- Stok barang dari tagihan ini masih utuh. Kalau sebagian sudah terjual, pakai [koreksi-salah-input.md](koreksi-salah-input.md).
- Tagihan **lama** yang dibuat bareng barang masuknya mengikuti syarat yang sama; stoknya dikurangi lagi saat dibatalkan.

## Langkah-Langkah

1. Buka detail tagihan (`/ap-bills/[id]`), klik **Batalkan Tagihan**.
2. Baca daftar yang akan ikut dibatalkan. Kalau ada penghalang, modal menjelaskan alasannya dan jalan keluarnya.
3. Isi **Alasan**. Kalau ada pembayaran, jawab **apakah uangnya benar-benar berpindah**.
4. Klik **Batalkan Semua**. Kalau uangnya benar berpindah, buat tagihan yang benar lalu catat ulang pembayarannya dengan tanggal transfer asli.

## Hasil Akhir

- Jurnal pembalik otomatis terbentuk untuk semua yang ikut dibatalkan, bertanggal hari ini. Dokumen lama tetap ada sebagai riwayat (ditandai dibatalkan), tidak dihapus. Uang muka yang tadinya diterapkan bisa dipakai lagi.
- Status bill berubah jadi **dibatalkan** di daftar Tagihan. Tagihan Barang yang dibatalkan hilang dari pilihan form Barang Masuk.

## Kesalahan Umum

- **Memakai retur untuk salah input** — retur mencatat barang yang benar-benar kembali. Untuk salah ketik pakai [koreksi-salah-input.md](koreksi-salah-input.md).
- **Lupa mencatat ulang pembayaran** — pembatalan hanya membalik catatan. Kalau transfernya benar terjadi dan tidak dicatat ulang, saldo bank di sistem lebih besar dari rekening koran.
- **Ditolak karena sisa barang sudah ditutup** — penutupan (**Tutup Sisa Barang**) tidak bisa dibatalkan, jadi tagihannya juga tidak bisa. Nilai yang salah dikoreksi lewat **Koreksi Tagihan**.
- **Tagihan lama ditolak karena stok tidak cukup** — barang masuk lama belum punya jalur koreksi; hubungi admin.
- **Membatalkan tagihan hanya karena nominal nota beda** — tidak perlu, cukup **Koreksi Tagihan**.
