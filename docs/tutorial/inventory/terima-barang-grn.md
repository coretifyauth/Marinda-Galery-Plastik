# Catat Barang Masuk dari Supplier (Belum Ditagih)

## Kapan Melakukan Ini

Saat barang dari supplier sampai di gudang — **tanpa menunggu nota**. Barang masuk dicatat dulu (stok langsung bertambah dan barang bisa dijual), tagihannya dibuat belakangan setelah nota datang lewat [buat-bill-dari-barang-masuk.md](../accounts-payable/buat-bill-dari-barang-masuk.md). Barang masuk **tidak** lagi otomatis membuat tagihan.

Ada dua cara mencatatnya: **langsung** (tanpa Purchase Order) atau **dari PO**.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Supplier sudah ada (kalau belum, lihat [tambah-supplier-baru.md](../accounts-payable/tambah-supplier-baru.md)).
- Untuk cara dari PO: PO-nya sudah ada dan belum diterima penuh — lihat [buat-purchase-order.md](buat-purchase-order.md).
- Surat jalan fisik dari supplier ada di tangan (untuk field No. Surat Jalan).
- Akun **Barang Diterima Belum Ditagih** sudah terpasang di Pengaturan > Default Akun (dibuat otomatis oleh sistem).

## Langkah-Langkah

### A. Langsung, tanpa PO

1. Buka menu **Barang Masuk** (`/goods-receipts`), klik **+ Tambah**.
2. Pilih **Supplier**, isi **Tanggal Terima** dan **No. Surat Jalan**.
3. Untuk tiap barang: pilih item, lalu isi **qty per satuan** (mis. 3 dus), **harga perkiraan**, dan — kalau ada — **Diskon item** (Rupiah) di baris itu.
   - Kalau harga **belum diketahui**, isi **0**. Barangnya tetap masuk stok, tapi belum bisa dijual dan belum bisa ditagih sampai diberi harga lewat revisi.
4. (Opsional) **Diskon tambahan dokumen** — di atas diskon item. Total diskon dokumen = jumlah diskon item (otomatis, tidak bisa lebih kecil) + diskon tambahan.
5. Cek kartu **Nilai Barang Masuk** di kanan, lalu klik **Simpan Barang Masuk**.

### B. Dari Purchase Order

1. Buka detail PO, klik **Terima Barang** (`/purchase-orders/[id]/receive`).
2. Qty dan harga terisi dari sisa PO — ubah kalau yang benar-benar datang beda. Item yang belum datang: kosongkan qty-nya supaya sisanya tetap "belum diterima".
3. Isi **Tanggal Terima**, **No. Surat Jalan**, diskon (kalau ada), lalu **Simpan Barang Masuk**.

## Hasil Akhir

- Stok bertambah, tapi **harga rata-rata item belum berubah** — harga rata-rata baru dihitung saat tagihan dibuat. Selama itu barang dijual dengan harga rata-rata terakhir.
- Jurnal: **Debit Persediaan, Kredit Barang Diterima Belum Ditagih** (bukan Utang Usaha — notanya belum ada). Barang berharga 0 tidak punya jurnal.
- Di daftar Barang Masuk, barisnya **merah dengan penanda "Belum tertagih"** dan umurnya (jumlah hari). Barang berharga 0 diberi penanda **Harga 0**.
- Status PO terkait berubah jadi **PARTIALLY_RECEIVED** atau **FULLY_RECEIVED**.

## Mengubah atau Membatalkan (selama belum ditagih)

- **Revisi harga / diskon / nomor surat jalan:** buka detail barang masuk, klik **Revisi Harga / Diskon**. Jurnal lama dibalik (bertanggal hari revisi) lalu dibuat jurnal baru. Item dan qty **tidak bisa** diubah. Setelah ditagih, barang masuk terkunci. Riwayat revisi ada di tab **Riwayat Revisi**.
- **Salah item atau qty:** klik **Batalkan Barang Masuk**, lalu catat ulang. Pembatalan ditolak kalau sebagian qty-nya sudah terjual lebih dulu.
- **Nota datang dengan harga beda:** revisi harga barang masuknya ke harga nota **sebelum** membuat tagihan.

## Kesalahan Umum

- **Mengira barang masuk otomatis membuat tagihan** — tidak lagi. Buat tagihannya dari menu Tagihan setelah nota datang.
- **Mengisi harga 0 lalu heran barangnya tidak bisa dijual di kasir** — itu disengaja: biaya pokoknya belum diketahui. Revisi harganya, lalu tagih.
- **Membiarkan barang masuk berstatus "Belum tertagih" berminggu-minggu** — saldo akun Barang Diterima Belum Ditagih ikut menggantung. Cocokkan dengan daftar barang masuk yang merah.
- **Mencoba merevisi barang masuk yang sudah ditagih** — ditolak. Pembetulannya lewat retur atau, kalau tagihannya belum dibayar, batalkan tagihan.
