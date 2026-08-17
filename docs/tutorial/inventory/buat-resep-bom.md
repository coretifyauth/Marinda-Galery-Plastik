# Buat Resep Produksi (BOM)

## Kapan Melakukan Ini

Sebelum bisa memproduksi barang jadi rakitan (mis. paket alat makan dari beberapa komponen bahan baku) — resep ini menentukan bahan baku apa saja dan berapa banyak dibutuhkan untuk menghasilkan 1 batch barang jadi.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Barang jadi (tipe **FINISHED_GOOD**) dan semua bahan bakunya (tipe **RAW_MATERIAL**) sudah terdaftar — kalau belum, buat dulu lewat [tambah-item-master.md](tambah-item-master.md).

## Langkah-Langkah

1. Buka menu **BOM** (`/bom`).
2. Klik tombol **+ New**. Modal **Buat Resep (BOM)** terbuka.
3. Isi field:
   - **Barang Jadi** — pilih dari dropdown (hanya item tipe FINISHED_GOOD yang muncul).
   - **Output per Batch** — berapa unit barang jadi yang dihasilkan dari 1 kali proses produksi sesuai resep ini.
4. Isi baris **Bahan Baku** (minimal 1 baris): pilih item bahan baku (hanya tipe RAW_MATERIAL yang muncul) dan isi **Qty/Batch** — jumlah bahan baku itu yang dibutuhkan untuk menghasilkan 1 batch (sesuai Output per Batch di atas).
5. Klik **+ Tambah baris** untuk bahan baku lain.
6. Klik **Simpan**.

## Hasil Akhir

- Resep baru muncul di daftar BOM berstatus **Aktif**, siap dipakai untuk [buat-production-order.md](buat-production-order.md).
- **Belum ada efek stok/jurnal apa pun** — BOM murni resep/cetak biru. Konsumsi bahan baku dan penambahan stok barang jadi baru terjadi saat Production Order benar-benar dijalankan.

## Kesalahan Umum

- **Salah isi Qty/Batch tidak sesuai skala Output per Batch** — kalau Output per Batch adalah 50 unit dan resepnya butuh 10kg bahan A, isi Qty/Batch bahan A sebagai 10 (untuk 50 unit), bukan per 1 unit — nanti sistem yang menghitung skala proporsional saat Production Order dibuat dengan qty produksi berbeda dari 1 batch penuh.
- **Item yang dipilih di "Barang Jadi" ternyata bertipe RAW_MATERIAL** — tidak akan muncul di dropdown; kalau item itu memang seharusnya barang jadi rakitan, cek dulu Tipe-nya benar di [tambah-item-master.md](tambah-item-master.md).
- **Bikin resep baru untuk perubahan kecil, padahal cukup edit resep lama** — cek dulu detail resep (`/bom/[id]`) untuk lihat apakah bisa disesuaikan di situ sebelum bikin resep duplikat.
