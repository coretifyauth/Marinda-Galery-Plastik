# Catat Barang Masuk dari Tagihan Supplier

## Kapan Melakukan Ini

Saat barang dari supplier sampai di gudang. Barang masuk **selalu dicatat dari satu Tagihan Barang** yang sudah ada ([buat-tagihan-barang.md](../accounts-payable/buat-tagihan-barang.md)) — nilainya mengurangi **Belum diterima** pada tagihan itu. Stok langsung bertambah dan harga rata-rata item langsung dihitung dari harga nota.

Ada tiga jalan masuk ke form yang sama: dari menu **Barang Masuk**, dari tombol **+ Catat Barang Masuk** di detail tagihan, atau dari **PO**.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- **Tagihan Barang** milik supplier itu sudah ada dan masih ada barang yang belum diterima. Kalau barang sudah tiba tapi notanya belum ada, buat dulu tagihannya dari nominal perkiraan.
- Harga per item sesuai nota (harga **tidak boleh 0** dan tidak ada "harga perkiraan" di barang masuk).
- Untuk cara dari PO: PO-nya sudah ada dan belum diterima penuh — lihat [buat-purchase-order.md](buat-purchase-order.md).
- Surat jalan fisik dari supplier ada di tangan (untuk field No. Surat Jalan).
- Akun **Pembelian Belum Diterima** terpasang di Pengaturan > Default Akun.

## Langkah-Langkah

### A. Dari menu Barang Masuk atau dari detail tagihan

1. Buka menu **Barang Masuk** (`/goods-receipts`), klik **+ Tambah**. Atau, dari detail tagihan, klik **+ Catat Barang Masuk** — tagihannya sudah terpilih.
2. Pilih **Tagihan Barang** dari daftar (hanya yang masih ada barang belum diterima; tertera nomor, supplier, jumlah belum diterima, dan umur). Ringkasan **Nilai barang di tagihan / Sudah diterima / Belum diterima / Belum diterima setelah barang masuk ini** muncul. Angka terakhir berwarna merah kalau nilai barang masuk melebihi barang yang belum diterima.
3. Isi **Tanggal Terima** dan **No. Surat Jalan**.
4. Untuk tiap barang: pilih item, lalu isi **qty per satuan** (mis. 3 dus), **harga per satuan sesuai nota**, dan — kalau ada — **Diskon item** (Rupiah) di baris itu.
   - Kalau harga per satuan dasar hasil konversi berpecahan (mis. Rp10.000 per dus isi 12 → Rp833,33 per pcs), sistem membulatkan harga ke atas dan menyesuaikan diskon baris otomatis, supaya nilai barisnya tetap sama dengan nilai di nota.
5. (Opsional) **Diskon tambahan dokumen** — di atas diskon item. Total diskon dokumen = jumlah diskon item (otomatis) + diskon tambahan.
6. Cek kartu **Nilai Barang Masuk** dan panel jurnal di kanan, lalu klik **Simpan Barang Masuk**.

### B. Dari Purchase Order

1. Buka detail PO, klik **Terima Barang** (`/purchase-orders/[id]/receive`).
2. Pilih **Tagihan Barang** — yang tampil hanya tagihan milik supplier PO itu yang masih ada barang belum diterima.
3. Qty dan harga terisi dari sisa PO — ubah ke yang benar-benar datang dan harga sesuai nota. Item yang belum datang: kosongkan qty-nya.
4. Isi **Tanggal Terima**, **No. Surat Jalan**, diskon (kalau ada), lalu **Simpan Barang Masuk**.

## Hasil Akhir

- Stok bertambah dan **harga rata-rata item langsung dihitung** (rata-rata tertimbang dengan stok yang ada), termasuk untuk item yang baru pertama kali masuk. Barangnya langsung bisa dijual.
- Jurnal: **Debit Persediaan, Kredit Pembelian Belum Diterima**. Tidak ada jurnal Utang Usaha di sini — utangnya sudah dicatat saat tagihan dibuat.
- **Belum diterima** tagihan berkurang sebesar nilai barang masuk (nilai bersih setelah diskon).
- Barang masuk muncul di daftar **Barang Masuk** dengan kolom **Tagihan** (klik untuk membuka tagihannya) dan di tabel **Barang Masuk dari Tagihan Ini** pada detail tagihan.
- Status PO terkait berubah jadi **PARTIALLY_RECEIVED** atau **FULLY_RECEIVED**.

## Membatalkan

- Tidak ada revisi harga. **Salah item, qty, atau harga:** buka detail barang masuk, klik **Batalkan Barang Masuk**, lalu catat ulang dari tagihan yang sama. Jurnal dibalik, stok dan harga rata-rata dikurangi lagi, dan **nilainya kembali ke Belum diterima**.
- Pembatalan **ditolak** kalau sebagian qty-nya sudah terjual/terpakai (stok tinggal kurang dari yang diterima), atau kalau item itu sudah diretur/ditukar di tagihannya. Untuk kasus itu pakai [retur-barang-ap.md](../accounts-payable/retur-barang-ap.md).
- Barang masuk **lama** (dicatat sebelum fitur ini, nomornya mengikuti nomor tagihan) dibatalkan lewat tagihannya — tombolnya tetap **Batalkan Barang Masuk**, hasilnya stok dikurangi dan tagihan ikut dibatalkan ([batalkan-bill-ap.md](../accounts-payable/batalkan-bill-ap.md)).

## Kesalahan Umum

- **Mencari cara mencatat barang masuk tanpa nota** — sudah tidak ada. Buat Tagihan Barang dulu (boleh dari nominal perkiraan).
- **Pesan "melebihi barang yang belum diterima dari nota" (atau "melebihi sisa kolam tagihan ..." dari server)** — nilai kiriman lebih besar dari barang yang belum diterima dari nota itu (mis. harga naik). Catat kiriman dari tagihan lain, atau pecah menjadi dua barang masuk dari dua nota.
- **Mengisi harga 0** — ditolak; barang masuk wajib berharga sesuai nota.
- **Tagihan tidak muncul di daftar** — semua barangnya sudah diterima, tagihannya dibatalkan, atau supplier-nya berbeda (untuk cara dari PO, hanya tagihan supplier PO itu yang tampil).
- **Pesan "Qty maksimal 3 desimal"** — qty lebih dari 3 desimal tidak diterima.
