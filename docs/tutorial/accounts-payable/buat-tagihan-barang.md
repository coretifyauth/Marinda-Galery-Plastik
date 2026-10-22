# Buat Tagihan Barang (Nota Duluan, Barang Menyusul)

## Kapan Melakukan Ini

Saat **nota supplier untuk barang** sudah ada, sementara barangnya datang **sekaligus atau bertahap** sesudahnya. Nota dicatat dulu sebagai **Tagihan Barang**; tiap kiriman dicatat kemudian sebagai Barang Masuk dari tagihan itu ([terima-barang-grn.md](../inventory/terima-barang-grn.md)). Tagihan boleh dibayar kapan saja — sebelum, sesudah, atau di antara kiriman — tidak harus menunggu barangnya.

Untuk biaya atau jasa tanpa barang fisik (sewa, listrik, jasa), pakai [buat-bill-ap.md](buat-bill-ap.md) (Tagihan Langsung).

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Supplier sudah ada — lihat [tambah-supplier-baru.md](tambah-supplier-baru.md).
- Akun **Pembelian Belum Diterima** sudah terpasang di Pengaturan > Default Akun (dibuat otomatis oleh sistem).
- Nilai barang di nota diketahui. Kalau belum pasti, isi nominal perkiraan — tapi ingat: kalau notanya ternyata beda setelah barang terjual, belum ada jalur koreksinya selain batal-ulang.

## Langkah-Langkah

1. Buka menu **Tagihan** (`/ap-bills`), klik **+ Tagihan Barang**.
2. Pilih **Supplier**. Kalau supplier itu punya saldo uang muka, muncul kotak biru pengingat — uang muka diterapkan setelah tagihan dibuat.
3. Isi **Tanggal Tagihan** dan **Nilai Barang di Nota (Rp)** (maksimal 2 desimal). Angka ini menjadi batas total nilai barang masuk yang boleh dicatat dari tagihan ini; selisihnya terlihat sebagai **Belum diterima**.
4. (Opsional) **Nomor Nota Supplier** (nomor asli di kertas nota) dan **Deskripsi**.
5. (Opsional) **Kategori Debit Tambahan** — biaya di nota di luar barang, mis. ongkir. (Opsional, kalau PPN aktif) centang **Kena PPN Masukan**. Biaya tambahan dan PPN **di luar nilai barang**.
6. Cek panel jurnal dan kartu di kanan: nilai barang + biaya tambahan + PPN = **Nilai Tagihan**.
7. Klik **Simpan Tagihan**. Anda dibawa ke detail tagihan.

## Mencatat Barang yang Datang

Di detail tagihan, kartu **Barang Belum Diterima** menampilkan **Nilai barang di nota**, **Sudah diterima**, **Ditutup**, dan **Belum diterima**.

1. Klik **+ Catat Barang Masuk** (muncul selama masih ada barang yang belum diterima dan tagihan tidak dibatalkan). Tagihan ini otomatis terpilih.
2. Ikuti [terima-barang-grn.md](../inventory/terima-barang-grn.md).
3. Setelah tersimpan, barang belum diterima berkurang sebesar nilai barang masuk. Tabel **Barang Masuk dari Tagihan Ini** mencantumkan tiap kiriman.

## Menutup Sisa Barang (barang tidak akan datang)

Kalau sebagian barang batal dikirim, sisa barang yang tidak akan datang bisa ditutup lewat tombol **Tutup Sisa Barang**:

- **Pembulatan** — hanya kalau nilai **Belum diterima** kurang dari satuan pembulatan (default Rp1). Seluruh sisa ditutup ke **Beban Selisih Pembulatan**. Contoh: nota Rp10.000.000, barang masuk total Rp9.999.999,60, sisa Rp0,40.
- **Jadikan Uang Muka** — hanya **bagian yang sudah dibayar** dan belum terpakai (batasnya ditampilkan di pilihan). Sisanya menjadi **uang muka ke supplier** (lihat [uang-muka-ap.md](uang-muka-ap.md)): bisa diterapkan ke tagihan lain, direfund, atau dihanguskan.

Isi **Nominal** dan **Tanggal**, **centang konfirmasi**, lalu klik **Tutup Sisa Barang**. Penutupan **tidak bisa dibatalkan**, dan tagihan yang sudah punya pelepasan tidak bisa dibatalkan lagi.

Sisa barang yang **belum dibayar** belum punya jalur penutupan di sistem (secara bisnis itu koreksi utang lewat nota kredit dari supplier). Selama belum ada, biarkan sisanya terbuka dan catat di luar sistem.

## Hasil Akhir

- Jurnal tagihan: **Debit Pembelian Belum Diterima** (sebesar nilai barang), **Debit** biaya tambahan/PPN Masukan (kalau ada), **Kredit Utang Usaha**. Bukan Debit Persediaan — barangnya belum ada di gudang.
- Jurnal tiap barang masuk: **Debit Persediaan, Kredit Pembelian Belum Diterima**. Saldo Pembelian Belum Diterima selalu sama dengan jumlah **Belum diterima** dari semua tagihan barang aktif.
- Di daftar Tagihan, kolom **Tipe** bertuliskan **Tagihan Barang**; filter Tipe punya pilihan yang sama.
- Tagihan bisa dibayar seperti biasa ([bayar-bill-ap.md](bayar-bill-ap.md)) atau dipotong uang muka. Status bayar tidak mempengaruhi **Belum diterima**.

## Aturan yang Perlu Diingat

- Satu barang masuk dibuat dari **tepat satu** tagihan dan tidak bisa dipindah atau dibagi ke dua nota. Satu tagihan boleh punya banyak barang masuk.
- Total nilai barang masuk dari satu tagihan **tidak boleh melebihi nilai barang di nota**. Kalau kiriman nilainya lebih besar dari **Belum diterima** (mis. harga naik), kiriman itu ditolak: kirimannya dicatat dari tagihan lain, atau dipecah menjadi dua barang masuk dari dua nota.
- Tidak ada barang masuk tanpa tagihan. Kalau barang sudah tiba tapi notanya belum ada, buat dulu Tagihan Barang dari nominal perkiraan.

## Kesalahan Umum

- **Mengisi Nilai Barang dengan total nota termasuk ongkir/PPN** — nilai barang hanya bagian barangnya. Ongkir dan PPN diisi di bagian Debit Tambahan / centang PPN.
- **Menunggu tagihan dibayar dulu baru mencatat barang masuk (atau sebaliknya)** — tidak saling bergantung.
- **Mengira sisa barang yang belum diterima hilang sendiri** — yang batal datang harus ditutup lewat **Tutup Sisa Barang**, atau dibiarkan terbuka sampai ada jalur nota kredit.
- **Salah klik Tutup Sisa Barang** — tidak bisa dibatalkan; baca konfirmasinya sebelum klik.
