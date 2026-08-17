# Buat Production Order (Produksi Barang Jadi)

## Kapan Melakukan Ini

Saat benar-benar menjalankan produksi — mengubah bahan baku jadi barang jadi sesuai resep (BOM) yang sudah dibuat. Ini satu-satunya cara stok barang jadi rakitan bertambah (bukan lewat pembelian).

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Resep (BOM) untuk barang jadi ini sudah ada dan aktif — kalau belum, buat dulu lewat [buat-resep-bom.md](buat-resep-bom.md).
- Stok bahan baku mencukupi sesuai kebutuhan resep untuk qty yang mau diproduksi — sistem menolak kalau bahan baku tidak cukup.

## Langkah-Langkah

1. Buka menu **Production Orders** (`/production-orders`).
2. Klik tombol **+ New**. Modal terbuka, baca catatan: bahan baku dikonsumsi **otomatis** sesuai resep (Weighted Average cost) — tidak perlu diinput manual per bahan.
3. Isi field:
   - **Resep (BOM)** — pilih dari dropdown (menampilkan nama barang jadi + output per batch).
   - **Qty Diproduksi per Satuan** — isi qty barang jadi yang mau dihasilkan kali ini, pilih satuannya (base atau satuan jual lain kalau ada) — tidak harus kelipatan penuh dari Output per Batch, sistem menghitung proporsional.
   - **Tanggal Produksi**.
4. Klik **Simpan**.

## Hasil Akhir

- Stok bahan baku berkurang otomatis sesuai resep (proporsional terhadap qty yang diproduksi), stok barang jadi bertambah sejumlah qty yang diproduksi.
- Jurnal otomatis terbentuk: debit Akun Persediaan Barang Jadi, kredit Akun Persediaan Bahan Baku — nilainya berdasarkan cost Weighted Average bahan baku yang dipakai saat itu.

## Kesalahan Umum

- **Mencoba produksi qty yang bahan bakunya tidak cukup** — sistem menolak sebelum transaksi tercatat; cek dulu stok bahan baku (bisa lewat [lihat-stock-position.md](lihat-stock-position.md)) sebelum submit qty besar.
- **Mengira harga/biaya produksi bisa diisi manual** — costing sepenuhnya otomatis dari Weighted Average bahan baku yang dikonsumsi, tidak ada input biaya tambahan (tenaga kerja/overhead) di form ini.
- **Salah pilih Resep untuk barang jadi yang mirip namanya** — pastikan cek output per batch yang ditampilkan di dropdown sesuai ekspektasi sebelum lanjut isi qty.
