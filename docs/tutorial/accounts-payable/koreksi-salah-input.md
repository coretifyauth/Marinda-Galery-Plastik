# Koreksi Salah Input Tagihan, Pembayaran, dan Barang Masuk

## Kapan Melakukan Ini

Saat ada yang salah dicatat, walau tagihannya sudah dibayar atau barangnya sudah terjual. Jangan pakai retur atau stock opname untuk salah ketik: keduanya mencatat kejadian yang tidak pernah terjadi.

| Yang salah | Pakai |
|---|---|
| Pembayaran salah nominal, tagihan, tanggal, atau metode | **Batalkan Pembayaran**, lalu catat ulang |
| Barang masuk salah item, qty, atau harga | **Koreksi Barang Masuk** |
| Nilai nota salah di Tagihan Barang, atau ada nota kredit/debit supplier | **Koreksi Tagihan** |
| Tagihan salah total (mis. salah supplier) | **Batalkan Tagihan** ([batalkan-bill-ap.md](batalkan-bill-ap.md)) |

## Prasyarat

- Login dengan role **admin**.
- Periode tanggal hari ini belum ditutup.

## Langkah-Langkah

### A. Batalkan Pembayaran

1. Buka detail tagihan, tab **Pembayaran**, klik **Batalkan** di baris yang salah.
2. Isi **Alasan**, lalu jawab **apakah uangnya benar-benar berpindah**.
3. Klik **Batalkan Pembayaran**.
4. Kalau uangnya benar berpindah, klik **Bayar** dan catat ulang yang benar dengan tanggal transfer asli.

### B. Koreksi Barang Masuk

1. Buka detail barang masuk, klik **Koreksi Barang Masuk**.
2. Ubah barang, qty, satuan, atau harga menjadi yang benar, lalu isi **Alasan Koreksi**.
3. Cek **Belum diterima setelah barang masuk ini**, lalu klik **Simpan Koreksi**.

### C. Koreksi Tagihan

1. Buka detail Tagihan Barang, bagian **Barang Belum Diterima**, klik **Koreksi Tagihan**.
2. Pilih **Tagihan turun** atau **Tagihan naik**, isi **Nominal**, **Tanggal**, **Alasan**, dan nomor nota kredit/debit kalau ada.
3. Klik **Simpan Koreksi**.

## Hasil Akhir

- **Batalkan Pembayaran**: jurnal dibalik, nilainya kembali jadi sisa tagihan. Baris lama tetap tampil dengan tanda dibatalkan beserta alasannya.
- **Koreksi Barang Masuk**: dokumen lama dibatalkan dan dokumen baru dibuat, saling tertaut di halaman detailnya. Stok dan harga rata-rata menyesuaikan. Selisih harga atas barang yang sudah terjual masuk HPP periode berjalan.
- **Koreksi Tagihan**: utang dan **Belum diterima** berubah bersama, tercatat di **Riwayat Koreksi Tagihan**.

## Kesalahan Umum

- **Mengira Batalkan Pembayaran mengembalikan uang** — itu hanya membalik catatan. Kalau transfernya benar terjadi, wajib dicatat ulang supaya saldo bank cocok dengan rekening koran.
- **Pesan "kelebihan retur sudah jadi saldo"** — pembayaran itu tidak bisa dibatalkan karena saldo di supplier dihitung dari situ.
- **Pesan "uangnya sudah dilepas jadi uang muka"** — uang itu sudah keluar lewat Tutup Sisa Barang, jadi pembayarannya tidak bisa dibatalkan.
- **Penurunan tagihan ditolak karena melebihi sisa utang** — tagihannya sudah dibayar. Bagian yang sudah dibayar keluar lewat **Tutup Sisa Barang** jadi uang muka, atau batalkan pembayarannya dulu kalau catatannya yang salah.
- **Penurunan tagihan ditolak karena melebihi barang yang belum diterima** — kurangi dulu barang masuknya lewat Koreksi Barang Masuk.
- **Koreksi Barang Masuk ditolak karena nilainya melebihi nilai tagihan** — naikkan dulu lewat Koreksi Tagihan.
- **Barang masuk lama tidak punya tombol Koreksi** — barang masuk yang dibuat bareng tagihannya hanya bisa dibatalkan lewat tagihan, selama stoknya masih utuh.
