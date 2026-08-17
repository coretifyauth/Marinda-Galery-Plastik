# Buat Purchase Order (PO) ke Supplier

## Kapan Melakukan Ini

Saat memesan bahan baku dari supplier, sebelum barangnya benar-benar diterima. PO ini nanti jadi acuan pencocokan (3-way matching) saat barang diterima lewat Goods Receipt.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Supplier-nya sudah ada — kalau belum, buat dulu lewat [tambah-supplier-baru.md](../accounts-payable/tambah-supplier-baru.md).
- Item bahan baku yang mau dipesan sudah terdaftar sebagai **RAW_MATERIAL** — kalau belum, buat dulu lewat [tambah-item-master.md](tambah-item-master.md). Item dengan tipe FINISHED_GOOD tidak akan muncul di dropdown pemilihan item PO (barang jadi dihasilkan dari produksi, bukan dibeli).

## Langkah-Langkah

1. Buka menu **Purchase Orders** (`/purchase-orders`).
2. Klik tombol **+ New**. Modal **Buat Purchase Order** terbuka.
3. Isi field:
   - **Supplier** — pilih dari dropdown.
   - **Tanggal PO** — tanggal pemesanan.
   - **Estimasi Tiba** (opsional) — perkiraan tanggal barang datang.
4. Isi baris item (minimal 1 baris):
   - Pilih **Item** dari dropdown (hanya item RAW_MATERIAL yang muncul).
   - Isi **Qty, Satuan & Harga Beli** — kalau item ini punya lebih dari 1 satuan jual (mis. per pcs dan per lusin), pilih satuannya dulu di situ; sistem otomatis mengonversi ke satuan dasar item untuk disimpan.
   - Klik **+ Tambah item** untuk memesan lebih dari 1 item sekaligus dalam PO yang sama.
5. Klik **Simpan PO**.

## Hasil Akhir

- PO baru muncul di tabel Purchase Orders dengan status **OPEN**, Source Ref otomatis.
- **Belum ada efek ke stok atau jurnal apa pun** — PO murni catatan pesanan. Efek ke stok/jurnal baru terjadi saat barangnya diterima lewat [terima-barang-grn.md](terima-barang-grn.md).
- Status PO akan berubah otomatis jadi **PARTIALLY_RECEIVED** atau **FULLY_RECEIVED** begitu ada Goods Receipt yang mengacu ke PO ini.

## Kesalahan Umum

- **Bingung kenapa item FINISHED_GOOD tidak muncul di dropdown** — memang sengaja, PO cuma untuk barang yang dibeli (bahan baku); barang jadi didapat dari produksi (BOM + Production Order), bukan pembelian.
- **Berharap stok langsung bertambah setelah PO disimpan** — PO belum menyentuh stok sama sekali; stok baru bertambah setelah Goods Receipt.
- **Salah pilih satuan saat isi qty/harga** — pastikan satuan yang dipilih di field Qty sesuai dengan yang tertulis di penawaran/kesepakatan dengan supplier, karena ini menentukan konversi ke satuan dasar yang tersimpan.
