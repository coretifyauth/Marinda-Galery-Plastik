# Terima Barang dari Supplier (Goods Receipt)

## Kapan Melakukan Ini

Saat barang pesanan dari Purchase Order benar-benar sampai (fisik diterima di gudang) — baik diterima penuh sekaligus atau bertahap (partial). Langkah ini sekaligus **otomatis membuat AP Bill**, jadi tidak perlu buat bill terpisah untuk penerimaan yang berasal dari PO.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- PO-nya sudah ada dan belum diterima penuh (status bukan `FULLY_RECEIVED`/`CANCELLED`) — kalau belum ada PO-nya, buat dulu lewat [buat-purchase-order.md](buat-purchase-order.md).
- Surat jalan fisik dari supplier ada di tangan (untuk diisi ke field No. Surat Jalan).

## Langkah-Langkah

1. Buka menu **Goods Receipts** (`/goods-receipts`).
2. Klik tombol **+ New**. Modal **Terima Barang + Bikin Bill** terbuka.
3. Pilih **Purchase Order** dari dropdown (hanya PO yang masih ada sisa qty yang muncul). Begitu dipilih, baris item dari PO itu otomatis terisi.
4. Isi field:
   - **Tanggal Terima** — tanggal barang fisik diterima.
   - **No. Surat Jalan** — nomor dari surat jalan fisik supplier.
   - **Deskripsi Bill** — keterangan untuk AP Bill yang akan otomatis terbentuk.
5. Untuk tiap baris item yang muncul, field **Qty, Satuan & Harga Riil** sudah terisi default sesuai sisa PO — **ubah kalau qty atau harga yang benar-benar diterima beda dari yang dipesan** (mis. barang datang kurang, atau harga riil di surat jalan beda dari estimasi PO). Kalau ada item yang belum datang sama sekali di pengiriman ini, kosongkan qty-nya (biarkan 0) supaya sisanya tetap tercatat "belum diterima" untuk GRN berikutnya.
6. (Opsional) **Kategori Debit Tambahan** — tambahkan kalau ada biaya lain yang menyertai penerimaan ini (mis. ongkir).
7. (Opsional, kalau PPN aktif) Centang **Kena PPN Masukan**.
8. Klik **Simpan Penerimaan**.

## Hasil Akhir

- Stok item yang diterima langsung bertambah (Weighted Average cost dihitung ulang otomatis kalau harga riil beda dari harga sebelumnya).
- **AP Bill baru otomatis terbentuk** — bisa dicek langsung di kolom **Bill** pada baris Goods Receipt ini, atau lewat menu AP Bills (ditandai tipe **Dari GRN**).
- Jurnal otomatis terbentuk: debit Akun Persediaan (+ biaya tambahan/PPN kalau diisi), kredit Akun Utang Usaha.
- Status PO terkait berubah jadi **PARTIALLY_RECEIVED** (kalau masih ada sisa qty belum diterima) atau **FULLY_RECEIVED** (kalau semua qty sudah diterima).
- Bill yang otomatis terbentuk ini bisa langsung dibayar dengan langkah yang sama seperti [bayar-bill-ap.md](../accounts-payable/bayar-bill-ap.md).

## Kesalahan Umum

- **Membuat AP Bill manual terpisah untuk penerimaan yang sudah lewat GRN** — jangan, itu duplikat. Bill dari GRN sudah otomatis terbentuk di langkah ini.
- **Tidak mengubah qty/harga default padahal barang yang datang beda dari PO** — field ini default mengikuti sisa PO, tapi harus disesuaikan manual kalau kenyataan fisiknya beda (barang kurang, harga beda). Kalau dibiarkan default padahal salah, stok dan Utang Usaha yang tercatat jadi tidak sesuai kenyataan.
- **Lupa PO yang sudah FULLY_RECEIVED tidak akan muncul lagi di dropdown** — kalau ternyata masih ada susulan barang dari PO yang sama, PO itu perlu tetap ada sisa qty; kalau statusnya sudah penuh, susulan barang harus dicatat lewat PO baru.
