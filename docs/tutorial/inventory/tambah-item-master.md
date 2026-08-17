# Tambah Item Master (Barang Baru)

## Kapan Melakukan Ini

Sebelum barang bisa dipakai di Purchase Order, Goods Receipt, BOM, Sales Order, atau Goods Issue — semua alur inventory butuh item master-nya sudah terdaftar dulu.

## Prasyarat

- Login dengan role **admin** atau **accountant** untuk menambah item. Menambah **Kategori** atau **Brand** baru butuh role **admin** khusus.
- Tentukan dulu **Tipe** item ini: `RAW_MATERIAL` (bahan baku, dibeli dari supplier) atau `FINISHED_GOOD` (barang jadi, hasil produksi/rakitan lewat BOM).
- (Opsional) Kalau mau kelompokkan barang, pastikan **Kategori**/**Brand** yang dibutuhkan sudah ada — kalau belum, bisa dibuat langsung di sub-tab yang sama sebelum lanjut.

## Langkah-Langkah

1. Buka menu **Items** (`/items`).
2. (Opsional) Kalau butuh Kategori/Brand baru dulu: klik tab **Kategori** atau **Brand** di atas tabel, klik **+ New**, isi **Nama**, klik **Simpan**.
3. Balik ke tab **Items**, klik **+ New**. Modal **Tambah Item** terbuka.
4. Isi field:
   - **Nama** — nama barang.
   - **Tipe** — pilih `RAW_MATERIAL` atau `FINISHED_GOOD`.
   - **Satuan Dasar (UOM)** — satuan hitung dasar barang ini, mis. `kg`, `buah`, `pcs`.
   - **Kategori** / **Brand** — opsional, pilih dari dropdown kalau sudah ada.
   - **Akun Persediaan** — field terkunci, otomatis mengikuti Tipe yang dipilih (RAW_MATERIAL dan FINISHED_GOOD punya akun persediaan default yang berbeda).
5. Klik **Simpan Item**.

## Hasil Akhir

- Item baru muncul di tabel Items dan siap dipakai di form transaksi inventory lain.
- **Satuan jual & harga jual belum diisi di sini** — item baru langsung setelah disimpan belum punya satuan jual (mis. per lusin, per pack) atau harga. Itu diatur belakangan di halaman detail item (`/items/[id]`), setelah item ini tersimpan.
- Stok awal masih **0** — item ini belum bisa langsung dijual/dikeluarkan sampai ada penerimaan barang (untuk RAW_MATERIAL, lewat Purchase Order+Goods Receipt) atau hasil produksi (untuk FINISHED_GOOD, lewat Production Order).

## Kesalahan Umum

- **Salah pilih Tipe** — RAW_MATERIAL vs FINISHED_GOOD menentukan akun persediaan default yang dipakai, dan menentukan alur mana yang bisa menambah stoknya (pembelian vs produksi). Barang bahan baku yang salah ditandai FINISHED_GOOD tidak akan muncul dengan benar di alur pembelian.
- **Lupa bahwa satuan jual/harga belum bisa diisi di form ini** — jangan bingung mencari field harga di modal Tambah Item; itu ada di halaman detail item setelah disimpan.
- **Menambah item duplikat karena tidak cek dulu apakah sudah ada** — pakai kolom pencarian nama di tabel Items sebelum menambah item baru.
