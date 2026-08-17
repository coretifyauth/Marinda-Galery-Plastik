# Atur Satuan Jual, Harga & Barcode Barang

## Kapan Melakukan Ini

Setelah item master dibuat ([tambah-item-master.md](tambah-item-master.md)), sebelum barang itu bisa dijual — item **tanpa satuan jual sama sekali belum bisa dipakai di Goods Issue atau kasir POS**. Juga dilakukan saat menambah satuan jual baru (mis. per lusin, per pack) atau mencetak label barcode untuk barang fisik.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Item master-nya sudah ada.
- Tahu faktor konversi tiap satuan jual ke satuan dasar item (mis. 1 lusin = 12 buah).

## Langkah-Langkah

### Tambah satuan jual

1. Buka detail item (`/items/[id]`).
2. Klik **+ Tambah Satuan** di tabel **Satuan Jual & Harga**.
3. Untuk **satuan dasar** (yang sama dengan UOM item, faktor konversi selalu 1): nama dan faktor konversi otomatis terkunci sesuai satuan dasar item.
4. Untuk satuan jual lain (mis. lusin, pack): isi **Nama Satuan** dan **Faktor Konversi (ke [UOM dasar])** — mis. isi `12` untuk satuan "lusin" kalau UOM dasarnya "buah".
5. (Opsional) Isi **Harga** — kalau kosong, satuan ini tidak akan muncul sebagai pilihan barang yang bisa dijual (harga wajib ada untuk bisa dijual, tidak ada input harga manual saat transaksi).
6. Klik **Simpan**.

### Buat & cetak kode barcode/QR (opsional, per satuan)

1. Di baris satuan yang sudah punya harga, klik **Buat Kode** — kode akan digenerate otomatis oleh sistem (bukan diketik manual).
2. Setelah kode terbentuk, klik **Cetak Label** untuk mencetak QR code fisik yang bisa ditempel di rak/barang.

## Hasil Akhir

- Satuan jual yang sudah punya harga langsung bisa dipilih di [jual-barang-goods-issue.md](jual-barang-goods-issue.md) dan kasir POS ([checkout-pos.md](../pos/checkout-pos.md)).
- Satuan yang sudah punya barcode bisa di-scan langsung di kasir POS untuk menambah ke keranjang tanpa cari manual.
- Faktor konversi dipakai otomatis oleh sistem untuk mengonversi qty ke satuan dasar tiap kali transaksi (PO, GRN, Goods Issue, POS) memakai satuan selain satuan dasar.

## Kesalahan Umum

- **Menambah item lalu lupa tambahkan satuan jual sama sekali** — item seperti itu tidak akan muncul di form Goods Issue maupun katalog kasir POS, meski stoknya ada.
- **Salah isi Faktor Konversi** — ini menentukan berapa banyak stok satuan dasar yang berkurang tiap 1 unit satuan itu terjual; faktor yang salah bikin qty stok tercatat tidak sesuai kenyataan.
- **Coba buat kode barcode untuk satuan yang belum ada harganya** — tombol **Buat Kode** cuma tersedia untuk satuan yang sudah punya harga (kode QR memang khusus untuk barang yang bisa dijual).
- **Mengedit Faktor Konversi satuan yang sudah pernah dipakai transaksi** — perubahan ini tidak retroaktif ke transaksi lama, tapi bisa membingungkan kalau dilakukan sembarangan; sebaiknya buat satuan baru daripada mengubah faktor konversi satuan yang sudah berjalan.
