# Buat Tagihan dari Barang Masuk

## Kapan Melakukan Ini

Saat **nota supplier datang** untuk barang yang sudah dicatat masuk lebih dulu (lihat [terima-barang-grn.md](../inventory/terima-barang-grn.md)). Satu tagihan bisa menutup **beberapa barang masuk dari supplier yang sama** (mis. supplier mengantar 3 kali dalam sebulan, menagih sekali).

Untuk biaya atau jasa yang tidak ada barang masuknya, pakai [buat-bill-ap.md](buat-bill-ap.md) (Tagihan Langsung).

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Barang masuknya sudah dicatat dan berstatus **Belum tertagih**.
- Harga barang masuk sudah sesuai nota. Kalau beda, buka detail barang masuk lalu **Revisi Harga / Diskon** dulu — nominal tagihan **mengikuti nilai barang masuk**, tidak diketik ulang.
- Tidak ada baris berharga 0 di barang masuk yang mau ditagih.

## Langkah-Langkah

1. Buka menu **Tagihan** (`/ap-bills`), klik **+ Dari Barang Masuk**. (Atau dari detail barang masuk, klik **Buat Tagihan** — barang masuk itu langsung tercentang.)
2. Pilih **Supplier**. Kalau supplier itu punya saldo uang muka, muncul kotak biru pengingat — uang muka diterapkan setelah tagihan dibuat.
3. Centang **barang masuk** yang tercantum di nota. Tiap pilihan menampilkan nilainya dan umur belum ditagih. Barang masuk berharga 0 tidak bisa dicentang.
4. Isi **Tanggal Tagihan**, **Nomor Nota Supplier** (nomor asli di kertas nota), dan deskripsi (opsional).
5. (Opsional) **Kategori Debit Tambahan** — biaya yang tertera di nota di luar barang (mis. ongkir). (Opsional, kalau PPN aktif) centang **Kena PPN Masukan**.
6. Cek kartu di kanan: nilai barang masuk + biaya tambahan + PPN = **Nilai Tagihan**.
7. Klik **Simpan Tagihan**.

## Hasil Akhir

- Jurnal: **Debit Barang Diterima Belum Ditagih** (sebesar nilai barang masuk yang dipilih, plus biaya tambahan/PPN), **Kredit Utang Usaha**. Saldo Barang Diterima Belum Ditagih untuk barang-barang itu kembali nol.
- Barang masuknya berstatus **Tertagih**, barisnya tidak merah lagi, dan tidak bisa direvisi lagi.
- **Harga rata-rata** tiap item baru dihitung sekarang, dari harga barang masuk. Kalau sebagian barang sudah terjual sebelum nota datang, selisih biayanya dicatat sebagai **koreksi HPP** (jurnal terpisah di hari tagihan). HPP penjualan lama tidak diubah.
- Tagihan bisa dibayar seperti biasa ([bayar-bill-ap.md](bayar-bill-ap.md)) atau dipotong uang muka ([uang-muka-ap.md](uang-muka-ap.md)).

## Aturan yang Perlu Diingat

- Satu tagihan hanya boleh menggabungkan barang masuk dari **satu supplier**.
- Satu barang masuk ditagih **utuh** dan hanya oleh **satu** tagihan aktif — tidak bisa sebagian, tidak bisa dua kali. Kalau supplier menagih satu kiriman dalam dua nota, barang masuknya harus dicatat terpisah sejak diterima.
- Membatalkan tagihan ini mengembalikan barang masuknya jadi **Belum tertagih** (stok tidak dibalik). Pembatalan ditolak kalau stok item-itemnya sudah bergerak sejak ditagih, dan harus berurutan terbalik kalau item yang sama ditagih lagi oleh tagihan yang lebih baru.

## Kesalahan Umum

- **Mengubah nominal tagihan supaya cocok dengan nota** — tidak ada kolom nominal untuk diubah; yang benar merevisi harga barang masuknya, supaya nilai stok dan biaya ikut benar.
- **Tidak menemukan barang masuk di daftar** — cek supplier yang dipilih, dan statusnya harus **Belum tertagih** (bukan Tertagih/Dibatalkan). Barang masuk lama yang dibuat bareng tagihan (sebelum fitur ini) memang tidak muncul karena sudah punya tagihan.
- **Barang masuk tidak bisa dicentang** — ada baris berharga 0; beri harga lewat Revisi Harga / Diskon.
