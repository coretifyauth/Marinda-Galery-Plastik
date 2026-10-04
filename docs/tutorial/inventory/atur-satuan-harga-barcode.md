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

### Buat kode scan untuk 1 barang (cara paling praktis — cukup 1 label per barang)

Cocok untuk barang tanpa barcode pabrik (dikemas sendiri). Satu label dipakai untuk semua satuan; kasir memilih satuannya di layar.

1. Di detail item, lihat kotak **Kode Scan Barang** (di atas tabel satuan). Klik **Buat Kode Barang** — kode digenerate otomatis (format `SKU-TAHUN-nnnnn`).
2. Klik **Cetak Label** untuk mencetak QR yang ditempel di rak/kemasan barang.
3. (Disarankan) Tentukan **satuan jual default** — satuan yang otomatis masuk keranjang kasir saat kode barang discan:
   - Di tabel **Satuan Jual & Harga**, kolom **Default Jual**, klik **Jadikan default** pada satuan yang dimau (mis. "ikat" kalau barang itu paling sering dijual per ikat).
   - Hanya satuan yang sudah punya **harga** yang bisa dijadikan default.
   - Belum ada yang ditandai = scan masuk dalam **satuan dasar**. Klik **Cabut** untuk kembali ke satuan dasar.

### Kode lama per satuan

Kode scan per satuan (yang dibuat sebelum ada kode barang) **tidak bisa dibuat baru lagi dari halaman ini** — pakai kode barang di atas. Kode per satuan yang sudah ada tetap tampil di kolom **Kode Scan**, tetap bisa di-**Cetak Label**, dan tetap bekerja di kasir: scan kode itu langsung masuk keranjang dalam satuan persis itu, tanpa lewat satuan default.

## Hasil Akhir

- Satuan jual yang sudah punya harga langsung bisa dipilih di [jual-barang-goods-issue.md](jual-barang-goods-issue.md) dan kasir POS ([checkout-pos.md](../pos/checkout-pos.md)).
- Kode barang atau kode satuan yang sudah dibuat bisa di-scan langsung di kasir POS untuk menambah ke keranjang tanpa cari manual. Kode barang masuk dalam satuan default (atau satuan dasar); kode satuan masuk dalam satuan persis itu.
- Satuan default hanya mempengaruhi scan kode barang di kasir POS — form Goods Issue/Sales Order dan klik katalog POS tidak berubah.
- Faktor konversi dipakai otomatis oleh sistem untuk mengonversi qty ke satuan dasar tiap kali transaksi (PO, GRN, Goods Issue, POS) memakai satuan selain satuan dasar.

## Kesalahan Umum

- **Menambah item lalu lupa tambahkan satuan jual sama sekali** — item seperti itu tidak akan muncul di form Goods Issue maupun katalog kasir POS, meski stoknya ada.
- **Salah isi Faktor Konversi** — ini menentukan berapa banyak stok satuan dasar yang berkurang tiap 1 unit satuan itu terjual; faktor yang salah bikin qty stok tercatat tidak sesuai kenyataan.
- **Mencetak kode barang tapi satuan dasarnya belum berharga** — scan di kasir akan menolak dengan pesan "belum punya harga jual". Isi harga satuan dasar, atau tandai satuan lain yang berharga sebagai default.
- **Mengosongkan harga satuan yang sedang jadi default** — tanda default dicabut otomatis, scan kode barang kembali memakai satuan dasar.
- **Menempel label kode barang ke tiap kemasan berbeda** — tidak perlu; 1 label per barang cukup, satuannya dipilih kasir di keranjang.
- **Mengedit Faktor Konversi satuan yang sudah pernah dipakai transaksi** — perubahan ini tidak retroaktif ke transaksi lama, tapi bisa membingungkan kalau dilakukan sembarangan; sebaiknya buat satuan baru daripada mengubah faktor konversi satuan yang sudah berjalan.
