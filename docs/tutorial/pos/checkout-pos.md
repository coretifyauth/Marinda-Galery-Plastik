# Checkout Penjualan di Kasir POS

## Kapan Melakukan Ini

Setiap transaksi jual-beli langsung di toko (retail, tunai atau non-tunai) — dilakukan di aplikasi kasir terpisah `apps/pos`, **bukan** di aplikasi admin `apps/erp`. Satu langkah checkout ini otomatis mencatat penjualan, mengurangi stok, dan (kalau diminta) mencetak struk.

## Prasyarat

- Login ke aplikasi **POS** (bukan aplikasi ERP admin) sebagai kasir.
- Barang yang mau dijual sudah punya harga jual (`item_units.price`) — barang tanpa harga tidak akan muncul di katalog kasir sama sekali.
- Stok barang mencukupi — sistem menolak checkout kalau qty yang diminta melebihi stok (no-oversell, dicek di sisi kasir maupun server).

## Langkah-Langkah

1. Buka halaman **Kasir** (halaman utama `apps/pos`).
2. Tambahkan barang ke **Keranjang** dengan salah satu cara:
   - Klik kartu barang di katalog (kalau barang punya lebih dari 1 satuan jual, pilih dulu satuannya di dropdown kecil pada kartu sebelum klik).
   - Ketik/scan kode barcode ke kolom **"Scan / ketik kode..."** lalu Enter — atau klik **📷 Kamera** untuk scan pakai kamera device.
   - Cari nama barang di kolom pencarian (`Ctrl+F` atau `/` untuk fokus cepat ke situ).
   - Shortcut keyboard: tombol angka **1–9** menambahkan barang sesuai posisi grid yang sedang tampil di layar.
3. Atur qty tiap baris di keranjang pakai tombol **−**/**+** atau ketik langsung angkanya.
4. (Opsional) Klik **Detail Transaksi (Biaya Tambahan, PPN)** untuk buka bagian tambahan:
   - Tambah baris **Biaya Tambahan** (mis. biaya packing) — pilih kategori dan nominal.
   - Centang **Kena PPN** kalau transaksi ini kena pajak (checkbox ini menimpa pengaturan default PPN toko, khusus untuk transaksi ini saja).
5. Klik tombol **Checkout** di bagian bawah keranjang (disabled kalau keranjang masih kosong). Modal **Selesaikan Transaksi** terbuka.
6. Di modal:
   - **Pelanggan** (opsional) — pilih dari dropdown kalau ini pelanggan terdaftar, atau biarkan **"Walk-in (tanpa nama)"** untuk pembeli umum.
   - **Metode Bayar** — pilih **Tunai** atau **Bank** (bisa juga toggle cepat pakai tombol `F2`).
   - Kalau **Tunai**, isi **Uang Diterima** — sistem otomatis menghitung dan menampilkan **Kembalian** (atau peringatan **"Kurang Rp..."** kalau uang diterima belum cukup; tombol Checkout tetap disabled sampai uang diterima ≥ total).
7. Klik **Checkout** di dalam modal untuk konfirmasi final.

## Hasil Akhir

- Transaksi tersimpan dengan Source Ref otomatis, muncul pesan sukses beserta total.
- Stok barang yang terjual langsung berkurang.
- Jurnal otomatis terbentuk: debit Kas Toko/Kas di Bank (sesuai metode) + kredit Pendapatan (+biaya tambahan/PPN), dan jurnal kedua debit HPP/kredit Persediaan Barang Jadi — sama pola dengan Goods Issue di sisi admin.
- Setelah sukses, muncul tombol **Cetak Struk** dan **Kirim WA** (kirim struk lewat WhatsApp ke kontak pelanggan, kalau ada) untuk transaksi yang baru saja selesai.
- Transaksi ini bisa dilihat lagi lewat **🕘 Riwayat Transaksi** (drawer di kiri, bisa difilter per tanggal) — dari situ juga bisa cetak ulang/kirim WA struk transaksi lama.

## Kesalahan Umum

- **Checkout dengan Uang Diterima kurang dari total** — tombol Checkout tetap disabled sampai uang diterima mencukupi; kalau butuh mencatat DP/pembayaran sebagian, itu bukan alur POS, harus lewat AR Invoice.
- **Bingung barang tidak muncul di katalog** — cek apakah barang itu sudah punya harga jual di satuan manapun; barang tanpa harga tidak akan tampil sama sekali di kasir, meski stoknya ada.
- **Scan barcode tidak ketemu** — pesan error "Kode gak ketemu" muncul kalau barcode belum didaftarkan ke satuan jual barang manapun; cari manual lewat katalog/pencarian sebagai gantinya.
- **Menekan tombol angka 1–9 tanpa sadar sedang browsing katalog hasil pencarian** — shortcut angka mengikuti posisi grid yang **sedang tampil di layar** (bisa berubah kalau sedang mencari/filter), bukan posisi tetap per barang.
- **Lupa transaksi POS beda alur dari AR Invoice** — POS selalu tunai/langsung lunas saat itu juga (walau boleh atas nama pelanggan terdaftar untuk keperluan struk), bukan tagihan bertermin. Untuk penjualan dengan termin, pakai [buat-invoice-ar.md](../accounts-receivable/buat-invoice-ar.md), bukan kasir POS.
