# POS / Jualan Eceran — Penjualan Tunai di Kios

## Masalah yang Diselesaikan

Bisnis retail/grosir kecil sering punya 2 jalur jual: pelanggan langganan yang bayar termin (sudah dinaungi Accounts Receivable), dan penjualan tunai langsung di kios/toko fisik yang pelanggannya bayar tunai/QRIS di tempat. Jalur kedua ini butuh pencatatan tersendiri, karena mekanisme akuntansinya beda dari penjualan termin.

Kios bukan sekadar "AR Invoice versi lebih sederhana". Bedanya fundamental: penjualan termin mengakui piutang duluan (Kas belum masuk, baru masuk belakangan pas customer bayar), sementara penjualan kios mengakui Kas dan Pendapatan **bersamaan, di titik yang sama** — gak pernah ada tahap "piutang" sama sekali. Modul ini (POS) menutup gap itu: mencatat penjualan tunai kios sebagai kejadian akuntansi yang lengkap, bukan cuma catatan kas manual di luar sistem.

## Konsep Inti

- **Penjualan Kios (POS Sale)** — 1 transaksi kasir, boleh berisi banyak jenis barang sekaligus (misal 5 unit Barang A + 3 unit Barang B dalam 1 kali bayar). Tiap transaksi bikin 2 jurnal bersamaan:
  ```
  Debit Kas/Bank [total harga jual]        Kredit Pendapatan Penjualan Toko [total harga jual]
  Debit Harga Pokok Penjualan [biaya pokok] Kredit Persediaan Barang Jadi [biaya pokok]
  ```
  Pendapatan kios dicatat ke akun "Pendapatan Penjualan Toko" — terpisah dari "Pendapatan Penjualan Grosir" yang dipakai penjualan termin ke warung, biar dua channel jualan ini kelihatan terpisah di laporan, walau sama-sama jual barang yang sama. Biaya pokok dihitung dari Rata-Rata Tertimbang (metode yang sama dipakai di Inventory), per jenis barang, persis titik yang sama tempat Harga Pokok Penjualan diakui di penjualan termin.
- **Piutang Usaha gak pernah OUTSTANDING** — beda paling mendasar dari AR Invoice. Gak ada jatuh tempo, gak ada status lunas/sebagian, gak ada credit hold, karena pelunasan selalu terjadi penuh, seketika, di transaksi yang sama (secara mesin, penjualan kios sempat "numpang lewat" Piutang sesaat sebelum langsung dilunasi — detail teknis, gak kelihatan dari sisi pemilik usaha maupun kasir).
- **Metode bayar nentuin akun kas yang kena** — bayar tunai fisik masuk ke akun Kas, bayar QRIS masuk ke akun Bank (uangnya beneran masuk rekening, bukan laci kas) — dua akun berbeda, biar rekonsiliasi kas fisik vs rekonsiliasi bank sama-sama akurat.
- **Kaitan ke customer WAJIB ada, tapi kasir gak wajib pilih** — tiap transaksi tetap harus terhubung ke 1 customer (aturan umum semua modul). Kios biasanya jual ke pembeli yang gak perlu dicatat identitasnya, jadi kalau kasir gak pilih siapa-siapa, sistem otomatis pakai 1 customer default ("Pelanggan Umum"). Transaksi ini boleh juga dikaitkan ke customer yang sudah terdaftar di AR (misal salah satu warung langganan lagi kena Tahan Kredit, tapi tetap mau beli sekarang secara tunai) — itu tetap sah sebagai penjualan tunai biasa, sama sekali gak lewat jalur piutang yang bisa outstanding.
- **Stok wajib akurat real-time, gak ada kondisi "jual dulu, sesuaikan belakangan"** — sama seperti Penjualan & Pengakuan HPP di Inventory, penjualan gak boleh jalan kalau stok barangnya gak cukup. Ini berarti kios wajib selalu terkoneksi saat transaksi (gak ada mode kerja tanpa koneksi buat proses bayar) — kalau dilonggarkan, dua kasir yang jual barang yang sama di waktu bersamaan bisa sama-sama "berhasil" padahal stoknya cuma cukup buat satu, dan begitu tersambung lagi ketauan stok jadi minus. Kecepatan/kenyamanan kasir ditangani lewat cara lain (bukan dengan melonggarkan aturan stok ini) — biar bisa transaksi tetap terasa cepat.
- **Kios belum menerima retur barang** — beda dari penjualan termin (barang dikirim ke warung, retur karena masalah di jalan/waktu itu wajar), transaksi kios tatap muka langsung, jadi kebijakan returnya belum ditentukan. Sampai pemilik usaha eksplisit memutuskan, transaksi yang mau diretur ditangani manual di luar sistem, gak lewat mekanisme resmi.
- **Diskon Penjualan & Beli N Gratis X berlaku otomatis di checkout kios**, sama seperti sisi admin (Sales Order/Goods Issue) — kasir gak pilih apa pun, sistem yang mencocokkan. Bedanya cuma titik komputasi: karena checkout kasir lewat RPC yang gak mempercayai nilai dari aplikasi kasir sama sekali, resolusi kedua mekanisme ini dihitung ULANG di server (bukan di aplikasi kasir) tiap transaksi — lihat `docs/domain/accounts-receivable.md` submodule "Diskon Penjualan (Trade Discount)" dan "Beli N Gratis X (Bundle Promo)" buat detail lengkapnya (konsepnya dijelaskan di sana karena sama persis dengan sisi AR, bukan didobel di sini).

### Pembatalan (Void)

**Cara Kerja**
- Kasir salah input (misal salah pilih barang/jumlah) dan baru sadar saat itu juga — transaksi bisa dibatalkan lewat jurnal pembalik, bukan dihapus. Riwayat transaksi asli tetap ada di histori, cuma dinetralkan efeknya.
- Pola yang sama dipakai buat pembatalan invoice penjualan termin — bedanya penjualan kios gak punya tahapan "sudah ada pembayaran" yang bisa menghalangi (uangnya emang udah diterima di titik yang sama transaksi dibuat), jadi guard yang berlaku cuma soal periode akuntansi: transaksi yang periodenya sudah ditutup gak bisa dibatalkan lewat jalur ini.

**Aturan Bisnis**
- Pembatalan cuma boleh lewat jurnal pembalik (reversing entry) — transaksi asli gak pernah dihapus/diedit.
- Transaksi yang masuk periode akuntansi yang sudah ditutup gak bisa dibatalkan.

**Skenario**
- Kasir salah pilih barang, sadar sebelum pelanggan pergi — transaksi dibatalkan, jurnal Kas/Pendapatan dan HPP/Persediaan sama-sama dibalik, stok balik ke posisi semula.

**Common Mistakes**
- Membatalkan transaksi dengan cara hapus/edit data asli — harus selalu jurnal pembalik, biar riwayat tetap utuh dan bisa ditelusuri.
- Menganggap pembatalan kios butuh guard "sudah ada pembayaran" seperti penjualan termin — penjualan kios gak punya tahapan itu, pembayarannya sudah selesai di titik transaksi dibuat.

### Kategori Biaya Tambahan & PPN

**Cara Kerja**
- Sebuah transaksi kasir kadang bukan cuma harga barang — bisa ada biaya packing, ongkos antar, atau (kalau kiosnya PKP) PPN yang dipungut dari pelanggan. Dulu sistem cuma bisa mencatat 1 kategori pendapatan per transaksi (Pendapatan Penjualan Toko), jadi biaya-biaya tambahan ini gak punya tempat resmi — kalau dipaksakan, harus dicatat manual terpisah, gak nempel ke transaksi kasir yang bersangkutan.
- Sekarang admin bisa menyiapkan daftar "jenis biaya tambahan" (misal "Biaya Packing", dipetakan ke akun pendapatan tertentu). Kasir tinggal pilih dari daftar itu saat checkout dan mengetik nominalnya — bukan memilih akun pembukuan secara bebas, karena kasir memang sengaja tidak diberi akses ke situ.
- PPN diperlakukan beda dari kategori bebas di atas — begitu diaktifkan admin (tarif + status "kios ini wajib pungut PPN"), sistem yang menghitung sendiri nominalnya setiap transaksi, bukan diketik kasir. Ini supaya jumlah pajak yang tercatat gak bisa keliru/sengaja dikurangi saat input.

**Aturan Bisnis**
- Kategori biaya tambahan & PPN nempel jadi bagian dari transaksi kasir yang sama (jurnal yang sama) — kalau transaksinya dibatalkan, keduanya ikut terbalik otomatis, gak ada yang tertinggal.
- Kasir tidak pernah memilih akun pembukuan secara langsung, baik untuk kategori tambahan maupun PPN.

**Skenario**
- Pelanggan beli barang borongan, minta dibungkus rapi (kena biaya packing terpisah), dan kiosnya sudah PKP jadi kena PPN — kasir pilih "Biaya Packing" dari daftar + isi nominalnya, centang "Kena PPN" kalau relevan, sistem menghitung total akhir dan mencatat semuanya dalam 1 transaksi.

**Common Mistakes**
- Membiarkan PPN dicatat manual di luar transaksi kasir — gak ada jaminan nempel ke transaksi yang benar, dan gak ikut terbalik kalau transaksinya dibatalkan.
- Memberi kasir akses memilih akun pembukuan bebas untuk biaya tambahan — bertentangan dengan prinsip kasir cuma boleh bertransaksi lewat jalur resmi, gak punya akses langsung ke pembukuan.
