# Buat Sales Order

## Kapan Melakukan Ini

Saat pelanggan memesan barang jadi yang pengirimannya akan dilakukan bertahap atau belakangan — beda dari [jual-barang-goods-issue.md](jual-barang-goods-issue.md) yang langsung mengeluarkan barang & invoice saat itu juga. Sales Order dulu dicatat sebagai pesanan, baru dikirim (invoice terbit) belakangan lewat [kirim-penuhi-sales-order.md](kirim-penuhi-sales-order.md).

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Customer-nya sudah ada.
- Barang yang dipesan sudah punya harga jual (item_units.price) — sama seperti syarat di Goods Issue.

## Langkah-Langkah

1. Buka menu **Sales Orders** (`/sales-orders`).
2. Klik tombol **+ New**. Modal **Buat Sales Order** terbuka.
3. Isi field:
   - **Customer** — pilih dari dropdown.
   - **Tanggal Pesan**.
   - **Butuh Tanggal** (opsional) — perkiraan tanggal pelanggan butuh barangnya.
4. Isi baris item (minimal 1 baris): pilih item (hanya yang punya harga jual yang muncul), isi qty & satuan.
5. Klik **+ Tambah item** untuk item lain.
6. Klik **Simpan**.

## Hasil Akhir

- Sales Order baru muncul dengan status **OPEN**, Source Ref otomatis.
- **Belum ada stok yang berkurang atau invoice yang terbit** — SO murni catatan pesanan, sama seperti PO ke supplier.
- Siap dikirim/dipenuhi (bisa bertahap) lewat [kirim-penuhi-sales-order.md](kirim-penuhi-sales-order.md).

## Kesalahan Umum

- **Mengira SO otomatis mengurangi stok saat dibuat** — stok baru berkurang saat barangnya benar-benar dikirim (fulfillment), bukan saat SO dicatat.
- **Pakai form ini untuk penjualan yang langsung dikirim saat itu juga** — kalau tidak butuh proses pesan-lalu-kirim bertahap, langsung pakai [jual-barang-goods-issue.md](jual-barang-goods-issue.md) supaya tidak perlu 2 langkah.
