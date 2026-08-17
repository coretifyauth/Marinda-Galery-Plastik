# Jual & Keluarkan Barang Jadi (Goods Issue)

## Kapan Melakukan Ini

Saat menjual barang jadi langsung ke pelanggan (di luar alur Sales Order bertahap) — satu langkah ini sekaligus membuat **AR Invoice** dan mengeluarkan stok barang jadi (mencatat HPP-nya).

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Customer-nya sudah ada — kalau belum, buat dulu lewat [tambah-pelanggan-baru.md](../accounts-receivable/tambah-pelanggan-baru.md).
- Barang yang mau dijual **harus sudah punya harga jual** (diisi lewat satuan jual di halaman detail item, `/items/[id]`) — item yang belum punya harga di satuan manapun tidak akan muncul di dropdown pemilihan item form ini.
- Stok barang tersebut mencukupi — sistem menolak (no-oversell) kalau qty yang mau dikeluarkan melebihi stok tersedia.

## Langkah-Langkah

1. Buka menu **Goods Issues** (`/goods-issues`).
2. Klik tombol **+ New**. Modal **Jual Barang Jadi (Invoice + Goods Issue)** terbuka.
3. Cek panel preview jurnal di atas form — ada **2 kelompok jurnal**: jurnal pertama (Piutang/Pendapatan) dan jurnal kedua (HPP/Persediaan Barang Jadi) yang terbentuk sekaligus dalam 1 transaksi ini.
4. Isi field:
   - **Customer** — pilih dari dropdown.
   - **Tanggal** — tanggal invoice/pengeluaran barang.
   - **Deskripsi** — keterangan transaksi.
5. Isi baris item (minimal 1 baris):
   - Pilih **Item** — hanya barang yang sudah punya harga jual yang muncul di dropdown.
   - Isi **Qty & Satuan** — pilih satuan jual (kalau item ini punya lebih dari 1), harga per baris otomatis terhitung dari harga satuan jual itu (tidak ada input harga manual).
   - Klik **+ Tambah item** untuk baris item lain.
6. (Opsional) **Kategori Pendapatan Tambahan**, dan (kalau PPN aktif) centang **Kena PPN Keluaran** — sama seperti form AR Invoice.
7. Klik **Simpan**.

## Hasil Akhir

- AR Invoice baru otomatis terbentuk (bisa dilihat di menu AR Invoices, ditandai tipe **Goods Issue Langsung**), dengan Source Ref yang sama dipakai untuk goods issue-nya.
- Stok barang jadi yang dijual langsung berkurang, HPP-nya tercatat otomatis berdasarkan Weighted Average cost saat itu.
- Dua jurnal terbentuk sekaligus: (1) debit Piutang Usaha / kredit Pendapatan (+biaya tambahan/PPN), (2) debit HPP / kredit Persediaan Barang Jadi.
- Invoice yang terbentuk ini bisa dibayar dengan langkah yang sama seperti [terima-pembayaran-ar.md](../accounts-receivable/terima-pembayaran-ar.md).

## Kesalahan Umum

- **Item tidak muncul di dropdown padahal stoknya ada** — cek dulu apakah item itu sudah punya harga jual di satuan manapun; item tanpa harga tidak akan muncul di form ini sama sekali, terlepas dari stoknya.
- **Mencoba jual qty lebih dari stok tersedia** — ditolak sistem (no-oversell), baik dicek di sisi form maupun di server.
- **Membuat AR Invoice manual terpisah untuk penjualan barang yang sudah lewat form ini** — itu duplikat, invoice dari goods issue sudah otomatis terbentuk.
